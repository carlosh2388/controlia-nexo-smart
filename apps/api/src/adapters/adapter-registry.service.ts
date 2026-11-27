import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { Device, DeviceProtocol } from "@prisma/client";
import type { DeviceAdapter } from "./adapter.interface";
import type { OrdenAgente } from "./agente/ordenes-agente.service";

/** Lo que necesita el registro para mandar ordenes por un Agente_Go (lo conecta AgenteConectorService). */
export interface CanalAgente {
  manejadoPor(device: Pick<Device, "metadata">): string | null;
  ejecutar(agente: string, device: Pick<Device, "id" | "name">, orden: OrdenAgente): Promise<void>;
}

/** Resuelve el adaptador correcto segun el protocolo del dispositivo. Los adaptadores se registran en AdaptersModule. */
@Injectable()
export class AdapterRegistry {
  private readonly adapters = new Map<DeviceProtocol, DeviceAdapter>();
  private agente?: CanalAgente;

  register(adapter: DeviceAdapter) {
    this.adapters.set(adapter.protocol, adapter);
  }

  conectarAgente(canal: CanalAgente) {
    this.agente = canal;
  }

  resolve(protocol: DeviceProtocol): DeviceAdapter {
    const adapter = this.adapters.get(protocol);
    if (!adapter) {
      throw new InternalServerErrorException(`No hay adaptador registrado para el protocolo ${protocol}`);
    }
    return adapter;
  }

  /**
   * Adaptador para mandar una orden a ESTE dispositivo: si lo maneja un Agente_Go, la misma orden
   * (armada por el adaptador del protocolo) sale por el agente; si no, por el adaptador de siempre.
   */
  paraDispositivo(device: Device): DeviceAdapter {
    const adapter = this.resolve(device.protocol);
    const agente = this.agente?.manejadoPor(device);
    if (!agente || !adapter.ordenPara || !this.agente) return adapter;
    const canal = this.agente;
    return {
      protocol: adapter.protocol,
      onDeviceRegistered: (d) => adapter.onDeviceRegistered(d),
      publishCommand: (d, action) => canal.ejecutar(agente, d, adapter.ordenPara!(d, action)),
    };
  }

  all(): DeviceAdapter[] {
    return Array.from(this.adapters.values());
  }
}
