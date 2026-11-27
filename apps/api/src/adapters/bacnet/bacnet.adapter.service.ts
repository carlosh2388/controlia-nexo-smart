import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { CommandAction, Device, DeviceProtocol } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { DeviceStateBus } from "../../state-bus/device-state-bus.service";
import type { DeviceAdapter } from "../adapter.interface";
import { AdapterRegistry } from "../adapter-registry.service";
import { BacnetBridgeClientService, BacnetReadRequest } from "./bacnet-bridge-client.service";
import type { BacnetDeviceConfigDto, BacnetObjectRefDto } from "../../devices/dto/bacnet-device-config.dto";
import type { ClimateCommandDto } from "../../devices/dto/climate-command.dto";
import { GestionService } from "../agente/gestion.service";
import { OrdenesAgenteService, type OrdenAgente } from "../agente/ordenes-agente.service";

interface BacnetMetadata {
  bacnet?: BacnetDeviceConfigDto;
}

interface EscrituraBacnet {
  object: BacnetObjectRefDto;
  valueType: "boolean" | "real" | "enum";
  value: boolean | number;
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
    private readonly gestion: GestionService,
    private readonly ordenes: OrdenesAgenteService,
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
    // La escritura ya se hizo: si la relectura falla, se avisa en el log sin dar la orden por fallida.
    await this.pollOnce(device.id, config).catch((err) => {
      this.logger.warn(`Orden aplicada a "${device.name}" pero no se pudo releer: ${(err as Error).message}`);
    });
  }

  /** Control completo (modo/temperatura/ventilador/swing/rango), fuera de la interfaz DeviceAdapter comun. */
  async setClimate(device: Device, dto: ClimateCommandDto): Promise<void> {
    const config = this.readConfig(device);
    if (!config) throw new BadRequestException(`Dispositivo "${device.name}" no tiene configuracion BACnet`);
    // Se valida todo antes de escribir: un valor invalido ya no deja la orden a medias.
    const escrituras = this.escriturasClimate(device, config, dto);

    const agente = this.gestion.manejadoPor(device);
    if (agente) {
      // Lo maneja un Agente_Go: el agente escribe en el gateway y su siguiente lectura trae el estado.
      await this.ordenes.ejecutar(agente, device, { tipo: "bacnet", host: config.host, escrituras });
      return;
    }

    for (const w of escrituras) {
      await this.bridge.write(config.host, w.object, w.valueType, w.value);
    }

    // La escritura ya se hizo: si la relectura falla, se avisa en el log sin dar la orden por fallida.
    await this.pollOnce(device.id, config).catch((err) => {
      this.logger.warn(`Orden aplicada a "${device.name}" pero no se pudo releer: ${(err as Error).message}`);
    });
  }

  /** La orden on/off de publishCommand, para que la ejecute un Agente_Go. */
  ordenPara(device: Device, action: CommandAction): OrdenAgente {
    const config = this.readConfig(device);
    if (!config) throw new Error(`Dispositivo "${device.name}" no tiene configuracion BACnet`);
    return {
      tipo: "bacnet",
      host: config.host,
      escrituras: [{ object: config.points.startStopCommand, valueType: "boolean", value: action === CommandAction.on }],
    };
  }

  private escriturasClimate(device: Device, config: BacnetDeviceConfigDto, dto: ClimateCommandDto): EscrituraBacnet[] {
    const out: EscrituraBacnet[] = [];
    const p = config.points;

    if (dto.on !== undefined) out.push({ object: p.startStopCommand, valueType: "boolean", value: dto.on });
    if (dto.temperature !== undefined) out.push({ object: p.setRoomTemp, valueType: "real", value: dto.temperature });

    if (dto.mode !== undefined) {
      const index = (config.modeStates ?? []).findIndex((s) => s.toUpperCase() === dto.mode!.toUpperCase());
      if (!p.modeCommand || index < 0) throw new BadRequestException(`Modo "${dto.mode}" no valido para "${device.name}"`);
      out.push({ object: p.modeCommand, valueType: "enum", value: index + 1 });
    }

    if (dto.fanSpeed !== undefined) {
      const index = (config.fanStates ?? []).findIndex((s) => s.toUpperCase() === dto.fanSpeed!.toUpperCase());
      if (!p.fanCommand || index < 0) {
        throw new BadRequestException(`Velocidad de ventilador "${dto.fanSpeed}" no valida para "${device.name}"`);
      }
      out.push({ object: p.fanCommand, valueType: "enum", value: index + 1 });
    }

    if (dto.swing !== undefined) {
      if (!p.swingCommand) throw new BadRequestException(`"${device.name}" no soporta swing`);
      out.push({ object: p.swingCommand, valueType: "boolean", value: dto.swing });
    }

    if (dto.tempRangeLow !== undefined) {
      if (!p.tempRangeLowerCommand) throw new BadRequestException(`"${device.name}" no soporta ajustar el rango de temperatura`);
      out.push({ object: p.tempRangeLowerCommand, valueType: "real", value: dto.tempRangeLow });
    }

    if (dto.tempRangeHigh !== undefined) {
      if (!p.tempRangeUpperCommand) throw new BadRequestException(`"${device.name}" no soporta ajustar el rango de temperatura`);
      out.push({ object: p.tempRangeUpperCommand, valueType: "real", value: dto.tempRangeHigh });
    }
    return out;
  }

  private startPolling(device: Device) {
    this.stopPolling(device.id);
    // Lo lee un Agente_Go (salvo que el agente este caido: entonces la API lo retoma).
    if (this.gestion.manejadoPor(device)) return;
    const config = this.readConfig(device);
    if (!config) return;

    const poll = () => this.pollOnce(device.id, config).catch((err) => {
      this.logger.warn(`Fallo el polling BACnet de "${device.name}": ${(err as Error).message}`);
    });

    this.pollers.set(device.id, setInterval(poll, POLL_INTERVAL_MS));
    poll();
  }

  private stopPolling(deviceId: string) {
    const existing = this.pollers.get(deviceId);
    if (existing) clearInterval(existing);
    this.pollers.delete(deviceId);
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

    // Sin respuesta del equipo: no se inventa "apagado". Se deja el ultimo estado conocido y el
    // polling lo registra como falla (antes un timeout del gateway dejaba el aire en "off").
    const on = byKey.get("on");
    if (!on || on.ok === false || on.value === null || on.value === undefined) {
      throw new Error(`sin respuesta del equipo BACnet ${config.host}${on?.error ? ` (${on.error})` : ""}`);
    }
    const isOn = !!on.value;
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
