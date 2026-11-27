import { Injectable } from "@nestjs/common";
import { Device, DeviceProtocol, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { agenteAsignado, GestionService } from "./gestion.service";

/** Protocolos que un Agente_Go puede tomar de la API central (Modbus ya llega siempre por agente). */
export const PROTOCOLOS_GESTIONABLES: DeviceProtocol[] = [
  DeviceProtocol.http,
  DeviceProtocol.mqtt,
  DeviceProtocol.lorawan,
  DeviceProtocol.bacnet,
];

interface Meta {
  http?: { state?: unknown; stateJsonPath?: string; pollIntervalMs?: number };
  mqttJson?: { statePath?: string };
  devEui?: string;
  bacnet?: { host?: string; points?: unknown; modeStates?: string[] | null; fanStates?: string[] | null };
  agent?: unknown;
}

/**
 * Plan de lectura de un agente: los equipos que maneja con la MISMA configuracion que usan hoy
 * los adaptadores de la API (plantilla HTTP de estado, topico MQTT, devEui, puntos BACnet). Asi el
 * agente lee exactamente lo mismo y la API no tiene que traducir nada al recibirlo.
 */
@Injectable()
export class PlanAgenteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gestion: GestionService,
  ) {}

  async plan(agente: string) {
    const devices = await this.prisma.device.findMany({
      where: { metadata: { path: ["gestor", "agente"], equals: agente } },
      orderBy: { name: "asc" },
    });
    return {
      agente,
      version: this.gestion.version(agente),
      /** true = el agente estuvo caido y la API todavia maneja sus equipos (vuelve en el proximo sync). */
      respaldo: this.gestion.enRespaldoAhora(agente),
      equipos: devices.map((d) => this.entrada(d)).filter((e) => e !== null),
    };
  }

  /** Lista para la pantalla de gestion: equipos que la API maneja o que maneja este agente. */
  async listaGestion(agente: string, canalVivo: boolean) {
    const devices = await this.prisma.device.findMany({
      where: { protocol: { in: PROTOCOLOS_GESTIONABLES } },
      include: { area: { select: { name: true, tenant: { select: { name: true } } } }, state: { select: { state: true, updatedAt: true } } },
      orderBy: [{ protocol: "asc" }, { name: "asc" }],
    });
    const ultimo = this.gestion.ultimoContactoDe(agente);
    return {
      agente,
      conectado: canalVivo,
      respaldo: this.gestion.enRespaldoAhora(agente),
      ultimoContacto: ultimo ? new Date(ultimo).toISOString() : null,
      equipos: devices
        // Los equipos que trae otro agente (sedes con Gravix, Modbus) no se gestionan aca.
        .filter((d) => !(d.metadata as Meta | null)?.agent)
        .filter((d) => {
          const a = agenteAsignado(d);
          return !a || a === agente;
        })
        .map((d) => ({
          id: d.id,
          nombre: d.name,
          protocolo: d.protocol,
          tipo: d.kind,
          area: d.area?.name ?? null,
          nivel: d.area?.tenant?.name ?? null,
          gestor: agenteAsignado(d) ? "agente" : "api",
          estado: d.state?.state ?? null,
          actualizado: d.state?.updatedAt?.toISOString() ?? null,
        })),
    };
  }

  private entrada(d: Device) {
    const meta = (d.metadata as Meta | null) ?? {};
    const base = { id: d.id, nombre: d.name, protocolo: d.protocol, tipo: d.kind, payloadOn: d.payloadOn, payloadOff: d.payloadOff };
    switch (d.protocol) {
      case DeviceProtocol.http:
        if (!meta.http?.state || !d.httpBaseUrl) return { ...base, http: null };
        return {
          ...base,
          http: {
            baseUrl: d.httpBaseUrl,
            estado: meta.http.state as Prisma.JsonValue,
            jsonPath: meta.http.stateJsonPath ?? null,
            intervaloMs: meta.http.pollIntervalMs ?? 5000,
          },
        };
      case DeviceProtocol.mqtt:
        return { ...base, mqtt: { stateTopic: d.stateTopic, commandTopic: d.commandTopic, statePath: meta.mqttJson?.statePath ?? null } };
      case DeviceProtocol.lorawan:
        return meta.devEui ? { ...base, lorawan: { devEui: meta.devEui } } : null;
      case DeviceProtocol.bacnet:
        if (!meta.bacnet?.host || !meta.bacnet.points) return null;
        return {
          ...base,
          bacnet: {
            host: meta.bacnet.host,
            points: meta.bacnet.points as Prisma.JsonValue,
            modeStates: meta.bacnet.modeStates ?? null,
            fanStates: meta.bacnet.fanStates ?? null,
          },
        };
      default:
        return null;
    }
  }
}
