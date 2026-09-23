import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { CommandAction, Device, DeviceProtocol } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { DeviceStateBus } from "../../state-bus/device-state-bus.service";
import type { DeviceAdapter } from "../adapter.interface";
import { AdapterRegistry } from "../adapter-registry.service";
import { BacnetBridgeClientService, BacnetReadRequest } from "./bacnet-bridge-client.service";
import type { BacnetDeviceConfigDto, BacnetObjectRefDto } from "../../devices/dto/bacnet-device-config.dto";
import type { ClimateCommandDto } from "../../devices/dto/climate-command.dto";

interface BacnetMetadata {
  bacnet?: BacnetDeviceConfigDto;
}

const POLL_INTERVAL_MS = 10_000;

/**
 * Adaptador para unidades de AC controladas via un gateway BACnet/IP (ej. "AC Smart 5" VRF).
 * No habla BACnet directamente: delega toda la comunicacion UDP al proceso bacnet-bridge (fuera
 * de Docker) porque Docker Desktop en Windows no puede enrutar UDP/47808 hacia la LAN real
 * (ver BacnetBridgeClientService). Este servicio solo orquesta polling, DB y el estado en vivo.
 */
@Injectable()
export class BacnetAdapterService implements DeviceAdapter, OnModuleInit, OnModuleDestroy {
  readonly protocol = DeviceProtocol.bacnet;

  private readonly logger = new Logger("BacnetAdapter");
  private readonly pollers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateBus: DeviceStateBus,
    private readonly registry: AdapterRegistry,
    private readonly bridge: BacnetBridgeClientService,
  ) {}

  async onModuleInit() {
    this.registry.register(this);
    const devices = await this.prisma.device.findMany({ where: { protocol: DeviceProtocol.bacnet } });
    for (const device of devices) this.startPolling(device);
  }

  onModuleDestroy() {
    for (const timer of this.pollers.values()) clearInterval(timer);
    this.pollers.clear();
  }

  onDeviceRegistered(device: Device): void {
    if (device.protocol === DeviceProtocol.bacnet) this.startPolling(device);
  }

  /** on/off generico (interfaz DeviceAdapter): usa el mismo punto que el control de climatizacion. */
  async publishCommand(device: Device, action: CommandAction): Promise<void> {
    const config = this.readConfig(device);
    if (!config) throw new Error(`Dispositivo "${device.name}" no tiene configuracion BACnet`);
    await this.bridge.write(config.host, config.points.startStopCommand, "boolean", action === CommandAction.on);
    await this.pollOnce(device.id, config);
  }

  /** Control completo (modo/temperatura/ventilador/swing/rango), fuera de la interfaz DeviceAdapter comun. */
  async setClimate(device: Device, dto: ClimateCommandDto): Promise<void> {
    const config = this.readConfig(device);
    if (!config) throw new BadRequestException(`Dispositivo "${device.name}" no tiene configuracion BACnet`);

    if (dto.on !== undefined) {
      await this.bridge.write(config.host, config.points.startStopCommand, "boolean", dto.on);
    }

    if (dto.temperature !== undefined) {
      await this.bridge.write(config.host, config.points.setRoomTemp, "real", dto.temperature);
    }

    if (dto.mode !== undefined) {
      const point = config.points.modeCommand;
      const index = (config.modeStates ?? []).findIndex((s) => s.toUpperCase() === dto.mode!.toUpperCase());
      if (!point || index < 0) {
        throw new BadRequestException(`Modo "${dto.mode}" no valido para "${device.name}"`);
      }
      await this.bridge.write(config.host, point, "enum", index + 1);
    }

    if (dto.fanSpeed !== undefined) {
      const point = config.points.fanCommand;
      const index = (config.fanStates ?? []).findIndex((s) => s.toUpperCase() === dto.fanSpeed!.toUpperCase());
      if (!point || index < 0) {
        throw new BadRequestException(`Velocidad de ventilador "${dto.fanSpeed}" no valida para "${device.name}"`);
      }
      await this.bridge.write(config.host, point, "enum", index + 1);
    }

    if (dto.swing !== undefined) {
      if (!config.points.swingCommand) throw new BadRequestException(`"${device.name}" no soporta swing`);
      await this.bridge.write(config.host, config.points.swingCommand, "boolean", dto.swing);
    }

    if (dto.tempRangeLow !== undefined) {
      if (!config.points.tempRangeLowerCommand) {
        throw new BadRequestException(`"${device.name}" no soporta ajustar el rango de temperatura`);
      }
      await this.bridge.write(config.host, config.points.tempRangeLowerCommand, "real", dto.tempRangeLow);
    }

    if (dto.tempRangeHigh !== undefined) {
      if (!config.points.tempRangeUpperCommand) {
        throw new BadRequestException(`"${device.name}" no soporta ajustar el rango de temperatura`);
      }
      await this.bridge.write(config.host, config.points.tempRangeUpperCommand, "real", dto.tempRangeHigh);
    }

    await this.pollOnce(device.id, config);
  }

  private startPolling(device: Device) {
    const config = this.readConfig(device);
    if (!config) return;

    this.stopPolling(device.id);
    const poll = () => this.pollOnce(device.id, config).catch((err) => {
      this.logger.warn(`Fallo el polling BACnet de "${device.name}": ${(err as Error).message}`);
    });

    this.pollers.set(device.id, setInterval(poll, POLL_INTERVAL_MS));
    poll();
  }

  private stopPolling(deviceId: string) {
    const existing = this.pollers.get(deviceId);
    if (existing) clearInterval(existing);
  }

  private async pollOnce(deviceId: string, config: BacnetDeviceConfigDto) {
    const p = config.points;
    const reads: BacnetReadRequest[] = [
      this.readOf("on", p.startStopStatus ?? p.startStopCommand),
      this.readOf("roomTemp", p.roomTemp),
      this.readOf("setRoomTemp", p.setRoomTemp),
    ];
    if (p.modeStatus ?? p.modeCommand) reads.push(this.readOf("mode", p.modeStatus ?? p.modeCommand));
    if (p.fanStatus ?? p.fanCommand) reads.push(this.readOf("fanSpeed", p.fanStatus ?? p.fanCommand));
    if (p.swingStatus ?? p.swingCommand) reads.push(this.readOf("swing", p.swingStatus ?? p.swingCommand));
    if (p.tempRangeLowerStatus ?? p.tempRangeLowerCommand) {
      reads.push(this.readOf("tempRangeLow", p.tempRangeLowerStatus ?? p.tempRangeLowerCommand));
    }
    if (p.tempRangeUpperStatus ?? p.tempRangeUpperCommand) {
      reads.push(this.readOf("tempRangeHigh", p.tempRangeUpperStatus ?? p.tempRangeUpperCommand));
    }

    const values = await this.bridge.read(config.host, reads);
    const byKey = new Map(values.map((v) => [v.key, v]));

    const isOn = !!byKey.get("on")?.value;
    const modeIndex = byKey.get("mode")?.value as number | undefined;
    const fanIndex = byKey.get("fanSpeed")?.value as number | undefined;

    const readings: Record<string, unknown> = {
      roomTemp: byKey.get("roomTemp")?.value ?? null,
      setRoomTemp: byKey.get("setRoomTemp")?.value ?? null,
      mode: modeIndex !== undefined ? config.modeStates?.[modeIndex - 1] ?? null : null,
      fanSpeed: fanIndex !== undefined ? config.fanStates?.[fanIndex - 1] ?? null : null,
      swing: byKey.has("swing") ? !!byKey.get("swing")?.value : undefined,
      tempRangeLow: byKey.get("tempRangeLow")?.value ?? null,
      tempRangeHigh: byKey.get("tempRangeHigh")?.value ?? null,
    };

    this.stateBus.emit({ deviceId, state: isOn ? "on" : "off", readings });
  }

  private readOf(key: string, point?: BacnetObjectRefDto): BacnetReadRequest {
    if (!point) throw new Error(`Punto BACnet requerido "${key}" no configurado`);
    return { key, type: point.type, instance: point.instance };
  }

  private readConfig(device: Device): BacnetDeviceConfigDto | undefined {
    const metadata = device.metadata as BacnetMetadata | null;
    return metadata?.bacnet;
  }
}
