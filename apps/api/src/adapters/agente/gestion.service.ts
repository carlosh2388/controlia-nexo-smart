import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import type { Device } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AdapterRegistry } from "../adapter-registry.service";

const GESTIONABLES = new Set<string>(["http", "mqtt", "lorawan", "bacnet"]);

/** Un agente que no sincroniza en este tiempo pasa a "respaldo": la API vuelve a manejar sus equipos. */
const SIN_AGENTE_MS = 90_000;

interface GestorMeta {
  gestor?: { agente?: unknown; desde?: unknown };
}

/** Agente que maneja un dispositivo segun su metadata (metadata.gestor.agente), o null. */
export function agenteAsignado(device: Pick<Device, "metadata">): string | null {
  const a = (device.metadata as GestorMeta | null)?.gestor?.agente;
  return typeof a === "string" && a.trim() ? a : null;
}

/**
 * Quien maneja cada dispositivo: la API central (adaptadores en proceso, como siempre) o un
 * Agente_Go (metadata.gestor.agente = buildingKey). Se pasa equipo por equipo desde la web.
 *
 * Respaldo: si un agente deja de sincronizar por mas de SIN_AGENTE_MS, sus equipos vuelven solos
 * a la API (polling, suscripciones y ordenes) hasta que el agente reaparece. Asi una caida del
 * agente nunca deja equipos sin leer ni sin control.
 */
@Injectable()
export class GestionService {
  private readonly logger = new Logger("GestionAgente");
  private readonly ultimoContacto = new Map<string, number>();
  /** Agentes caidos cuyos equipos maneja temporalmente la API. */
  private readonly enRespaldo = new Set<string>();
  /** Sube con cada cambio de gestion: el agente vuelve a pedir su plan cuando cambia. */
  private readonly versionPlan = new Map<string, number>();
  private revisando = false;
  /** Al arrancar la API se le da al agente el mismo margen para reconectarse. */
  private readonly arranque = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AdapterRegistry,
  ) {}

  /** Agente que maneja HOY el dispositivo (null si es la API, o si su agente esta en respaldo). */
  manejadoPor(device: Pick<Device, "metadata">): string | null {
    const agente = agenteAsignado(device);
    if (!agente || this.enRespaldo.has(agente)) return null;
    return agente;
  }

  enRespaldoAhora(agente: string) {
    return this.enRespaldo.has(agente);
  }

  version(agente: string) {
    return this.versionPlan.get(agente) ?? 0;
  }

  /** Llamado en cada sync y en cada consulta de ordenes del agente. */
  async contacto(agente: string) {
    this.ultimoContacto.set(agente, Date.now());
    if (this.enRespaldo.delete(agente)) {
      this.logger.log(`Agente "${agente}" volvio: retoma sus equipos (la API deja de manejarlos)`);
      await this.reasignar(agente);
    }
  }

  ultimoContactoDe(agente: string): number | null {
    return this.ultimoContacto.get(agente) ?? null;
  }

  /** Cambia quien maneja estos dispositivos y reinicia sus adaptadores en la API. */
  async asignar(deviceIds: string[], agente: string | null) {
    // Solo se entregan equipos a un agente que esta conectado: nunca quedan sin quien los lea.
    if (agente && (this.enRespaldo.has(agente) || Date.now() - (this.ultimoContacto.get(agente) ?? 0) > 60_000)) {
      throw new BadRequestException(`El agente "${agente}" no esta conectado; no se le pueden pasar equipos`);
    }
    const devices = await this.prisma.device.findMany({ where: { id: { in: deviceIds } } });
    const afectados = new Set<string>();
    let cambiados = 0;
    for (const d of devices) {
      const meta = { ...((d.metadata as Record<string, unknown> | null) ?? {}) };
      // Equipos que ya trae otro agente (Modbus, sedes con Gravix) o protocolos sin soporte: no se tocan.
      if (agente && (meta.agent || !GESTIONABLES.has(d.protocol))) continue;
      const antes = agenteAsignado(d);
      if (antes) afectados.add(antes);
      if (agente) {
        meta.gestor = { agente, desde: new Date().toISOString() };
        afectados.add(agente);
      } else {
        delete meta.gestor;
      }
      const actualizado = await this.prisma.device.update({ where: { id: d.id }, data: { metadata: meta as object } });
      this.reiniciarAdaptadores(actualizado);
      cambiados += 1;
    }
    for (const a of afectados) this.versionPlan.set(a, this.version(a) + 1);
    if (cambiados) {
      this.logger.log(`${cambiados} equipo(s) pasan a ${agente ? `el agente "${agente}"` : "la API central"}`);
    }
    return cambiados;
  }

  @Interval(30_000)
  async revisarAgentes() {
    if (this.revisando) return;
    this.revisando = true;
    try {
      const agentes = await this.prisma.$queryRaw<{ agente: string }[]>`
        SELECT DISTINCT metadata->'gestor'->>'agente' AS agente FROM devices WHERE metadata->'gestor'->>'agente' IS NOT NULL`;
      const ahora = Date.now();
      for (const { agente } of agentes) {
        const ultimo = this.ultimoContacto.get(agente) ?? this.arranque;
        if (ahora - ultimo > SIN_AGENTE_MS && !this.enRespaldo.has(agente)) {
          this.enRespaldo.add(agente);
          this.logger.warn(`Agente "${agente}" sin contacto: la API toma sus equipos en respaldo hasta que vuelva`);
          await this.reasignar(agente);
        }
      }
    } catch (err) {
      this.logger.warn(`No se pudo revisar los agentes: ${(err as Error).message}`);
    } finally {
      this.revisando = false;
    }
  }

  private async reasignar(agente: string) {
    const devices = await this.prisma.device.findMany({
      where: { metadata: { path: ["gestor", "agente"], equals: agente } },
    });
    for (const d of devices) this.reiniciarAdaptadores(d);
    this.versionPlan.set(agente, this.version(agente) + 1);
  }

  /** Cada adaptador decide con manejadoPor() si arranca o detiene su polling/suscripcion. */
  private reiniciarAdaptadores(device: Device) {
    for (const adapter of this.registry.all()) {
      try {
        void adapter.onDeviceRegistered(device);
      } catch (err) {
        this.logger.warn(`Adaptador ${adapter.protocol} con "${device.name}": ${(err as Error).message}`);
      }
    }
  }
}
