import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Device } from "@prisma/client";
import { GestionService } from "./gestion.service";

/** Lo que el agente tiene que hacer en la red del edificio. La API ya resolvio toda la logica del protocolo. */
export type OrdenAgente =
  | {
      tipo: "http";
      baseUrl: string;
      method: string;
      path: string;
      headers?: Record<string, string>;
      body?: unknown;
    }
  | { tipo: "mqtt"; topic: string; payload: string }
  | {
      tipo: "bacnet";
      host: string;
      escrituras: { object: { type: number; instance: number }; valueType: "boolean" | "real" | "enum"; value: unknown }[];
    };

export interface OrdenEnviada {
  id: string;
  deviceId: string;
  dispositivo: string;
  creada: string;
  /** El agente descarta la orden si la recibe despues de esta hora. */
  vence: string;
  orden: OrdenAgente;
}

interface Pendiente {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Margen para que una orden llegue al agente, se ejecute en el equipo y vuelva el resultado. */
const ESPERA_RESULTADO_MS = 15_000;
/** Un agente que no consulta ordenes en este tiempo se considera desconectado del canal. */
const CANAL_VIVO_MS = 40_000;

/**
 * Canal de ordenes API -> Agente_Go: la orden queda en cola, el agente la toma con una consulta
 * larga (GET /agents/:key/ordenes, hasta 25 s esperando) y devuelve el resultado. El que pidio la
 * orden (boton de la vista del edificio, automatizacion) espera ese resultado: si el equipo no
 * responde, la orden queda "failed" con el motivo, igual que cuando la manda la API directo.
 */
@Injectable()
export class OrdenesAgenteService {
  private readonly logger = new Logger("OrdenesAgente");
  private readonly colas = new Map<string, OrdenEnviada[]>();
  private readonly esperando = new Map<string, Set<() => void>>();
  private readonly pendientes = new Map<string, Pendiente>();
  private readonly ultimaConsulta = new Map<string, number>();

  constructor(private readonly gestion: GestionService) {}

  canalVivo(agente: string) {
    const t = this.ultimaConsulta.get(agente);
    return t !== undefined && Date.now() - t < CANAL_VIVO_MS;
  }

  /** Encola la orden y espera a que el agente confirme que se ejecuto en el equipo. */
  async ejecutar(agente: string, device: Pick<Device, "id" | "name">, orden: OrdenAgente): Promise<void> {
    if (!this.canalVivo(agente)) {
      throw new ServiceUnavailableException(`El agente "${agente}" no esta conectado; no se pudo enviar la orden a "${device.name}"`);
    }
    const ahora = Date.now();
    const enviada: OrdenEnviada = {
      id: randomUUID(),
      deviceId: device.id,
      dispositivo: device.name,
      creada: new Date(ahora).toISOString(),
      vence: new Date(ahora + ESPERA_RESULTADO_MS).toISOString(),
      orden,
    };
    const resultado = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendientes.delete(enviada.id);
        this.quitarDeCola(agente, enviada.id);
        reject(new Error(`El agente "${agente}" no confirmo la orden a "${device.name}" en ${ESPERA_RESULTADO_MS / 1000} s`));
      }, ESPERA_RESULTADO_MS);
      this.pendientes.set(enviada.id, { resolve, reject, timer });
    });
    const cola = this.colas.get(agente) ?? [];
    cola.push(enviada);
    this.colas.set(agente, cola);
    this.despertar(agente);
    return resultado;
  }

  /** El agente pide sus ordenes; si no hay, espera hasta esperarMs a que llegue alguna. */
  async tomar(agente: string, esperarMs: number): Promise<{ ordenes: OrdenEnviada[]; versionPlan: number; respaldo: boolean }> {
    this.ultimaConsulta.set(agente, Date.now());
    await this.gestion.contacto(agente);
    if (!this.colas.get(agente)?.length && esperarMs > 0) {
      await new Promise<void>((resolve) => {
        const listos = this.esperando.get(agente) ?? new Set<() => void>();
        const listo = () => {
          clearTimeout(timer);
          listos.delete(listo);
          resolve();
        };
        const timer = setTimeout(listo, esperarMs);
        listos.add(listo);
        this.esperando.set(agente, listos);
      });
      this.ultimaConsulta.set(agente, Date.now());
    }
    const ordenes = this.colas.get(agente) ?? [];
    this.colas.set(agente, []);
    return { ordenes, versionPlan: this.gestion.version(agente), respaldo: this.gestion.enRespaldoAhora(agente) };
  }

  resultado(agente: string, id: string, ok: boolean, error?: string) {
    const p = this.pendientes.get(id);
    if (!p) return { ok: false, motivo: "orden desconocida o vencida" };
    clearTimeout(p.timer);
    this.pendientes.delete(id);
    if (ok) p.resolve();
    else {
      this.logger.warn(`Agente "${agente}": la orden ${id} fallo en el equipo: ${error ?? "sin detalle"}`);
      p.reject(new Error(error || `El agente "${agente}" no pudo ejecutar la orden`));
    }
    return { ok: true };
  }

  private despertar(agente: string) {
    for (const listo of [...(this.esperando.get(agente) ?? [])]) listo();
  }

  private quitarDeCola(agente: string, id: string) {
    const cola = this.colas.get(agente);
    if (cola) this.colas.set(agente, cola.filter((o) => o.id !== id));
  }
}
