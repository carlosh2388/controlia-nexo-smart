import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { BacnetObjectRefDto } from "../../devices/dto/bacnet-device-config.dto";

export interface BacnetDiscoveredUnit {
  unitKey: string;
  points: Record<string, BacnetObjectRefDto>;
  modeStates: string[] | null;
  fanStates: string[] | null;
  sample: { on: boolean | null; roomTemp: number | null; setRoomTemp: number | null };
}

export interface BacnetDiscoverResult {
  deviceId: number;
  vendorId: number;
  host: string;
  totalObjects: number;
  units: BacnetDiscoveredUnit[];
}

export interface BacnetReadRequest {
  key: string;
  type: number;
  instance: number;
  property?: number;
}

export interface BacnetReadResult {
  key: string;
  value: unknown;
  ok: boolean;
  error?: string;
}

/**
 * Cliente HTTP hacia el proceso bacnet-bridge (apps/bacnet-bridge), que corre nativo en el host
 * (fuera de Docker) porque Docker Desktop en Windows no puede enrutar el UDP de BACnet/IP hacia
 * la LAN real del edificio (verificado: ICMP y TCP si llegan desde el contenedor, UDP/47808 no,
 * ni siquiera con --network host). Este servicio nunca habla BACnet directamente.
 */
@Injectable()
export class BacnetBridgeClientService {
  private readonly logger = new Logger("BacnetBridgeClient");

  constructor(private readonly configService: ConfigService) {}

  private get baseUrl(): string {
    return this.configService.get<string>("BACNET_BRIDGE_URL") || "http://host.docker.internal:3099";
  }

  private get token(): string | undefined {
    return this.configService.get<string>("BACNET_BRIDGE_TOKEN") || undefined;
  }

  private async request<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.token ? { "x-bridge-token": this.token } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await response.json()) as T & { error?: string };
      if (!response.ok) {
        throw new Error(json.error || `bacnet-bridge respondio ${response.status}`);
      }
      return json;
    } catch (err) {
      this.logger.warn(`Fallo la llamada a bacnet-bridge (${path}): ${(err as Error).message}`);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  discover(host: string): Promise<BacnetDiscoverResult> {
    return this.request<BacnetDiscoverResult>("/discover", { host }, 90_000);
  }

  read(host: string, reads: BacnetReadRequest[]): Promise<BacnetReadResult[]> {
    return this.request<{ values: BacnetReadResult[] }>("/read", { host, reads }, 15_000).then((r) => r.values);
  }

  write(
    host: string,
    object: BacnetObjectRefDto,
    valueType: "boolean" | "real" | "enum",
    value: number | boolean,
    priority?: number,
  ): Promise<void> {
    return this.request("/write", { host, object, valueType, value, priority }, 10_000).then(() => undefined);
  }
}
