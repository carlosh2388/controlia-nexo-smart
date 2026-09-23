import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommandAction, Device, DeviceKind, DeviceProtocol } from "@prisma/client";
import mqtt, { MqttClient } from "mqtt";
import { PrismaService } from "../../prisma/prisma.service";
import { DeviceStateBus } from "../../state-bus/device-state-bus.service";
import type { DeviceAdapter } from "../adapter.interface";
import { AdapterRegistry } from "../adapter-registry.service";

const UPLINK_TOPIC = "application/+/device/+/event/up";

interface ChirpstackUplink {
  deviceInfo?: {
    devEui?: string;
    deviceName?: string;
    tags?: Record<string, string>;
  };
  object?: Record<string, unknown>;
}

/**
 * Mapeo manual devEui -> slug de Area, deducido al escuchar el broker real la primera vez
 * (los tags de ChirpStack no siempre traen el area y no todos los nombres son inequivocos).
 * Sensores nuevos o no listados aqui se crean sin area; se enlazan luego editando el dispositivo.
 */
const DEV_EUI_TO_AREA_SLUG: Record<string, string> = {
  "24e124710f130213": "cct", // LEO-S592-AQG0-CCT
  "24e124710f136003": "sala-reuniones", // LEO-S592-AQG0-SALA2
  "24e124710f137396": "coworking", // LEO-S592-AQG0-COWORKING-LADO-IZQUIERDO
  "24e124710f137228": "coworking", // LEO-S592-AQG0-COWORKING-LADO-DERECHO
  "24e124710f135483": "id", // LEO-S592-AQG0-SENSOR2-LABORATORIO-N10
  "24e124710f137005": "id", // LEO-S592-AQG0-SENSOR1-LABORATORIO-N10
  "24e124710f132162": "experience-center", // LEO-S592-AQG0-EC
  "24e124710e029835": "sala-presidencial", // LEO-S592-AQG0-SALA-PRESIDENCIAL
  "24e124136d180031": "telco", // EM300-TH-915M-TELCO
  "24e124136d180639": "estacion-de-cafe", // EM300-TH-915M_3-CAFETERIA
  "24e124136d180750": "recepcion", // EM300-TH-915M-RECEPCION
  "24e124710f139411": "oficina-7", // LEOS592QG0_SALA_1 ("Sala 1" = Oficina 7)
  "24e124710f137724": "oficina-6", // LEO-S592-AQG0-OFICINA-FREDY (oficina de Fredy = Oficina 6)
  "24e124126f127309": "id", // Temperature_LEOS572-TPG0 (ubicado en ID DIY)
  "24e124723f457813": "id", // Sensor de temperatura LEO S552 - Termocuplas largas (ubicado en ID DIY)
  "24e124710e023170": "noc", // LEO-S592-AQG0-NOC-N4 -> tenant "TEC 3 - Nivel 4"
  "24e124136d180912": "cuarto-electrico", // EM300-TH-915M-CUARTO-ELECTRICO
};

/** Adaptador de solo lectura para el gateway ChirpStack (LoRaWAN) de sensores de calidad de aire LEO-S592. */
@Injectable()
export class LorawanAdapterService implements DeviceAdapter, OnModuleInit, OnModuleDestroy {
  readonly protocol = DeviceProtocol.lorawan;

  private readonly logger = new Logger("LorawanAdapter");
  private client?: MqttClient;
  private readonly devEuiToDeviceId = new Map<string, string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly stateBus: DeviceStateBus,
    private readonly registry: AdapterRegistry,
  ) {}

  async onModuleInit() {
    this.registry.register(this);

    const url = this.configService.get<string>("LORAWAN_MQTT_URL");
    if (!url) {
      this.logger.warn("LORAWAN_MQTT_URL no configurado; adaptador LoRaWAN desactivado");
      return;
    }

    const username = this.configService.get<string>("LORAWAN_MQTT_USERNAME") || undefined;
    const password = this.configService.get<string>("LORAWAN_MQTT_PASSWORD") || undefined;

    this.client = mqtt.connect(url, { username, password, reconnectPeriod: 2000 });

    this.client.on("connect", () => {
      this.logger.log(`Conectado a gateway LoRaWAN ${url}`);
      this.client!.subscribe(UPLINK_TOPIC, (err) => {
        if (err) this.logger.error(`No se pudo suscribir a ${UPLINK_TOPIC}: ${err.message}`);
        else this.logger.log(`Suscrito a uplinks LoRaWAN en ${UPLINK_TOPIC}`);
      });
    });

    this.client.on("reconnect", () => this.logger.warn("Reconectando a gateway LoRaWAN..."));
    this.client.on("error", (err) => this.logger.error(`Error de conexion LoRaWAN: ${err.message}`));
    this.client.on("message", (topic, payload) => this.handleUplink(topic, payload));
  }

  async onModuleDestroy() {
    this.client?.end(true);
  }

  private async handleUplink(_topic: string, payload: Buffer) {
    let parsed: ChirpstackUplink;
    try {
      parsed = JSON.parse(payload.toString());
    } catch {
      return;
    }

    const devEui = parsed.deviceInfo?.devEui;
    const object = parsed.object;
    if (!devEui || !object) return;

    const deviceId = await this.resolveDeviceId(devEui, parsed);
    if (!deviceId) return;

    this.stateBus.emit({
      deviceId,
      state: "online",
      rawPayload: JSON.stringify(object),
      readings: object,
    });
  }

  private async resolveDeviceId(devEui: string, uplink: ChirpstackUplink): Promise<string | null> {
    const cached = this.devEuiToDeviceId.get(devEui);
    if (cached) return cached;

    const existing = await this.prisma.device.findFirst({
      where: { metadata: { path: ["devEui"], equals: devEui } },
    });
    if (existing) {
      this.devEuiToDeviceId.set(devEui, existing.id);
      return existing.id;
    }

    const name = uplink.deviceInfo?.deviceName?.trim() || `LoRaWAN ${devEui}`;
    const slug = DEV_EUI_TO_AREA_SLUG[devEui];
    const area = slug ? await this.prisma.area.findFirst({ where: { slug } }) : null;

    const created = await this.prisma.device.create({
      data: {
        name,
        protocol: DeviceProtocol.lorawan,
        kind: DeviceKind.sensor,
        areaId: area?.id,
        metadata: { devEui, tags: uplink.deviceInfo?.tags ?? {} },
      },
    });

    this.logger.log(
      `Sensor LoRaWAN descubierto: "${name}" (${devEui})${area ? ` -> area "${area.name}"` : " sin area asignada"}`,
    );
    this.devEuiToDeviceId.set(devEui, created.id);
    return created.id;
  }

  async publishCommand(_device: Device, _action: CommandAction): Promise<void> {
    throw new Error("Los sensores LoRaWAN son de solo lectura; no aceptan comandos.");
  }

  onDeviceRegistered(_device: Device): void {
    // Los sensores LoRaWAN se descubren solos por su devEui; no hay suscripcion por dispositivo.
  }
}
