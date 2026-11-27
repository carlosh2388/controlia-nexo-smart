import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommandAction, Device, DeviceKind, DeviceProtocol } from "@prisma/client";
import mqtt, { MqttClient } from "mqtt";
import { PrismaService } from "../../prisma/prisma.service";
import { DeviceStateBus } from "../../state-bus/device-state-bus.service";
import type { DeviceAdapter } from "../adapter.interface";
import { AdapterRegistry } from "../adapter-registry.service";
import type { MqttJsonConfigDto } from "../../devices/dto/mqtt-json-config.dto";
import { GestionService } from "../agente/gestion.service";
import type { OrdenAgente } from "../agente/ordenes-agente.service";

interface MqttJsonMetadata {
  mqttJson?: MqttJsonConfigDto;
}

function getByPath(value: unknown, path: string): unknown {
  const segments = path.split(/[.[\]]+/).filter(Boolean);
  return segments.reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, value);
}

@Injectable()
export class MqttAdapterService implements DeviceAdapter, OnModuleInit, OnModuleDestroy {
  readonly protocol = DeviceProtocol.mqtt;

  private readonly logger = new Logger("MqttAdapter");
  private client?: MqttClient;
  private readonly topicToDeviceId = new Map<string, string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly stateBus: DeviceStateBus,
    private readonly registry: AdapterRegistry,
    private readonly gestion: GestionService,
  ) {}

  async onModuleInit() {
    this.registry.register(this);

    const url = this.configService.get<string>("MQTT_URL", "mqtt://localhost:1883");
    const username = this.configService.get<string>("MQTT_USERNAME") || undefined;
    const password = this.configService.get<string>("MQTT_PASSWORD") || undefined;

    this.client = mqtt.connect(url, {
      username,
      password,
      reconnectPeriod: 2000,
    });

    this.client.on("connect", async () => {
      this.logger.log(`Conectado a broker MQTT ${url}`);
      await this.resubscribeAll();
    });

    this.client.on("reconnect", () => this.logger.warn("Reconectando a broker MQTT..."));
    this.client.on("error", (err) => this.logger.error(`Error de conexion MQTT: ${err.message}`));

    this.client.on("message", (topic, payload) => this.handleMessage(topic, payload));
  }

  async onModuleDestroy() {
    this.client?.end(true);
  }

  private async resubscribeAll() {
    const devices = await this.prisma.device.findMany({
      where: { protocol: DeviceProtocol.mqtt, stateTopic: { not: null } },
    });
    for (const device of devices) {
      this.subscribeToState(device);
    }
  }

  private subscribeToState(device: Device) {
    if (!device.stateTopic || !this.client) return;
    this.topicToDeviceId.set(device.stateTopic, device.id);
    this.client.subscribe(device.stateTopic, (err) => {
      if (err) {
        this.logger.error(`No se pudo suscribir a ${device.stateTopic}: ${err.message}`);
      } else {
        this.logger.log(`Suscrito a estado de "${device.name}" en topic ${device.stateTopic}`);
      }
    });
  }

  private async handleMessage(topic: string, payload: Buffer) {
    const deviceId = this.topicToDeviceId.get(topic);
    if (!deviceId) return;

    const raw = payload.toString().trim();
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) return;
    // Lo reporta un Agente_Go: no se duplica el estado (salvo que el agente este caido).
    if (this.gestion.manejadoPor(device)) return;

    const mqttJson = (device.metadata as MqttJsonMetadata | null)?.mqttJson;
    let extracted = raw;
    if (mqttJson?.statePath) {
      try {
        const parsed = JSON.parse(raw);
        const value = getByPath(parsed, mqttJson.statePath);
        extracted = value === undefined || value === null ? raw : String(value);
      } catch {
        // payload no era JSON valido, se usa el texto plano tal cual
      }
    }

    let state = extracted;
    if (extracted === device.payloadOn) state = "on";
    else if (extracted === device.payloadOff) state = "off";

    let readings: Record<string, unknown> | undefined;
    if (device.kind === DeviceKind.sensor) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          readings = parsed as Record<string, unknown>;
        }
      } catch {
        // payload no era JSON valido; el sensor no reporto lecturas estructuradas esta vez
      }
    }

    this.stateBus.emit({ deviceId, state, rawPayload: raw, readings });
  }

  async publishCommand(device: Device, action: CommandAction): Promise<void> {
    if (!this.client || !device.commandTopic) {
      throw new Error(`Dispositivo "${device.name}" no tiene commandTopic configurado`);
    }
    const payload = this.payloadDe(device, action);

    await new Promise<void>((resolve, reject) => {
      this.client!.publish(device.commandTopic!, payload, { qos: 1 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** La misma publicacion de publishCommand, para que la haga un Agente_Go. */
  ordenPara(device: Device, action: CommandAction): OrdenAgente {
    if (!device.commandTopic) throw new Error(`Dispositivo "${device.name}" no tiene commandTopic configurado`);
    return { tipo: "mqtt", topic: device.commandTopic, payload: this.payloadDe(device, action) };
  }

  private payloadDe(device: Device, action: CommandAction): string {
    const mqttJson = (device.metadata as MqttJsonMetadata | null)?.mqttJson;
    const jsonPayload = action === CommandAction.on ? mqttJson?.onPayload : mqttJson?.offPayload;
    return jsonPayload !== undefined
      ? JSON.stringify(jsonPayload)
      : action === CommandAction.on
        ? device.payloadOn
        : device.payloadOff;
  }

  onDeviceRegistered(device: Device): void {
    if (device.protocol === DeviceProtocol.mqtt) {
      this.subscribeToState(device);
    }
  }
}
