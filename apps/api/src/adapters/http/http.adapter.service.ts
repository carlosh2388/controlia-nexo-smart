import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { CommandAction, Device, DeviceProtocol } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { DeviceStateBus } from "../../state-bus/device-state-bus.service";
import type { DeviceAdapter } from "../adapter.interface";
import { AdapterRegistry } from "../adapter-registry.service";
import type { HttpActionTemplateDto, HttpDeviceConfigDto } from "../../devices/dto/http-device-config.dto";
import { GestionService } from "../agente/gestion.service";
import type { OrdenAgente } from "../agente/ordenes-agente.service";

interface HttpMetadata {
  http?: HttpDeviceConfigDto;
}

function getByPath(value: unknown, path: string): unknown {
  const segments = path.split(/[.[\]]+/).filter(Boolean);
  return segments.reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, value);
}

@Injectable()
export class HttpAdapterService implements DeviceAdapter, OnModuleInit, OnModuleDestroy {
  readonly protocol = DeviceProtocol.http;

  private readonly logger = new Logger("HttpAdapter");
  private readonly pollers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateBus: DeviceStateBus,
    private readonly registry: AdapterRegistry,
    private readonly gestion: GestionService,
  ) {}

  async onModuleInit() {
    this.registry.register(this);
    const devices = await this.prisma.device.findMany({ where: { protocol: DeviceProtocol.http } });
    for (const device of devices) {
      this.startPolling(device);
    }
  }

  onModuleDestroy() {
    for (const timer of this.pollers.values()) clearInterval(timer);
    this.pollers.clear();
  }

  onDeviceRegistered(device: Device): void {
    if (device.protocol === DeviceProtocol.http) {
      this.startPolling(device);
    }
  }

  async publishCommand(device: Device, action: CommandAction): Promise<void> {
    const config = this.readConfig(device);
    if (!config) {
      throw new Error(`Dispositivo "${device.name}" no tiene configuracion HTTP (httpConfig)`);
    }
    const template = action === CommandAction.on ? config.on : config.off;
    await this.request(device, template);
  }

  /** La misma peticion de publishCommand, para que la haga un Agente_Go en la red del edificio. */
  ordenPara(device: Device, action: CommandAction): OrdenAgente {
    const config = this.readConfig(device);
    if (!config) throw new Error(`Dispositivo "${device.name}" no tiene configuracion HTTP (httpConfig)`);
    if (!device.httpBaseUrl) throw new Error(`Dispositivo "${device.name}" no tiene httpBaseUrl configurado`);
    const t = action === CommandAction.on ? config.on : config.off;
    return { tipo: "http", baseUrl: device.httpBaseUrl, method: t.method, path: t.path, headers: t.headers, body: t.body };
  }

  private startPolling(device: Device) {
    this.stopPolling(device.id);
    // Lo lee un Agente_Go (salvo que el agente este caido: entonces la API lo retoma).
    if (this.gestion.manejadoPor(device)) return;
    const config = this.readConfig(device);
    if (!config?.state || !config.pollIntervalMs) return;

    const poll = async () => {
      try {
        const raw = await this.request(device, config.state!);
        const extracted = config.stateJsonPath ? this.extractJson(raw, config.stateJsonPath) : raw.trim();
        let state = extracted;
        if (extracted === device.payloadOn) state = "on";
        else if (extracted === device.payloadOff) state = "off";
        this.stateBus.emit({ deviceId: device.id, state, rawPayload: raw });
      } catch (err) {
        this.logger.warn(`Fallo el polling de estado de "${device.name}": ${(err as Error).message}`);
      }
    };

    this.pollers.set(device.id, setInterval(poll, config.pollIntervalMs));
    poll();
  }

  private stopPolling(deviceId: string) {
    const existing = this.pollers.get(deviceId);
    if (existing) clearInterval(existing);
    this.pollers.delete(deviceId);
  }

  private extractJson(raw: string, path: string): string {
    try {
      const parsed = JSON.parse(raw);
      const value = getByPath(parsed, path);
      return value === undefined || value === null ? "" : String(value);
    } catch {
      return raw.trim();
    }
  }

  private readConfig(device: Device): HttpDeviceConfigDto | undefined {
    const metadata = device.metadata as HttpMetadata | null;
    return metadata?.http;
  }

  private async request(device: Device, template: HttpActionTemplateDto): Promise<string> {
    if (!device.httpBaseUrl) {
      throw new Error(`Dispositivo "${device.name}" no tiene httpBaseUrl configurado`);
    }

    const url = new URL(template.path, device.httpBaseUrl).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const hasBody = template.body !== undefined && template.method !== "GET";
      const response = await fetch(url, {
        method: template.method,
        headers: {
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          ...template.headers,
        },
        body: hasBody ? JSON.stringify(template.body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} en ${url}: ${text.slice(0, 200)}`);
      }
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }
}
