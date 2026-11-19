import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Role } from "@prisma/client";
import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { PrismaService } from "../prisma/prisma.service";
import { AgentsService } from "../agents/agents.service";
import { InfluxWriterService } from "../timeseries/influx-writer.service";
import { AlarmasService } from "../alarmas/alarmas.service";
import { armarTelemetria, equiposDeAgentes, tipoDe, type DeviceMeta } from "../red/telemetria";

/**
 * Gravix de sede (GRAVIX_MODO=sede): la API que consulta el Centro de mando, como hoy consulta las
 * api-SIASA de Telemetria 1. La base de esta instalacion solo tiene los equipos de su sede.
 *
 * Al arrancar crea (si no existen) las dos API keys de la sede a partir del .env que genera el
 * instalador, para que nadie tenga que copiarlas a mano:
 *  - SEDE_AGENT_KEY: rol agent, la usa el Agente Go de la sede.
 *  - SEDE_CENTRO_KEY: rol viewer (solo lectura), la usa el Centro de mando.
 */
@Injectable()
export class SedeService implements OnModuleInit {
  private readonly log = new Logger("SedeService");
  readonly codigo: string;
  readonly nombre: string;
  private readonly version: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentsService,
    private readonly config: ConfigService,
    private readonly influx: InfluxWriterService,
    private readonly alarmas: AlarmasService,
  ) {
    this.codigo = config.get<string>("SEDE_CODIGO") || "sede";
    this.nombre = config.get<string>("SEDE_NOMBRE") || this.codigo;
    this.version = config.get<string>("GRAVIX_VERSION") || "dev";
  }

  async onModuleInit() {
    await this.asegurarClave("SEDE_AGENT_KEY", `Agente Go ${this.codigo} (local)`, Role.agent);
    await this.asegurarClave("SEDE_CENTRO_KEY", "Centro de mando (consulta)", Role.viewer);
  }

  private async asegurarClave(variable: string, nombre: string, role: Role) {
    const raw = this.config.get<string>(variable);
    if (!raw) {
      this.log.warn(`${variable} no esta en el .env: no se crea la clave "${nombre}"`);
      return;
    }
    const keyHash = createHash("sha256").update(raw).digest("hex");
    const existe = await this.prisma.apiKey.findUnique({ where: { keyHash } });
    if (existe) return;
    await this.prisma.apiKey.create({ data: { name: nombre, role, keyHash, prefix: raw.slice(0, 14) } });
    this.log.log(`Clave "${nombre}" registrada desde ${variable}`);
  }

  async telemetria() {
    return armarTelemetria(await equiposDeAgentes(this.prisma, null), { nombre: this.nombre, codigo: this.codigo });
  }

  /** Resumen por equipo con la misma forma que cada sede en /api/vista del monitoreo central. */
  async vista() {
    const equipos = await equiposDeAgentes(this.prisma, null);
    const num = (r: Record<string, unknown>, ...ks: string[]) => {
      for (const k of ks) if (typeof r[k] === "number" && Number.isFinite(r[k])) return r[k] as number;
      return null;
    };
    const prom = (r: Record<string, unknown>, ks: string[]) => {
      const v = ks.map((k) => r[k]).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
      return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100 : null;
    };
    const motor = this.alarmas.estadoPorNombre();
    const dispositivos = equipos.map((d) => {
      const meta = (d.metadata as DeviceMeta | null) ?? {};
      const a = meta.attributes ?? {};
      const r = (d.state?.readings as Record<string, unknown> | null) ?? {};
      const online = d.state?.state === "online";
      const kw = num(r, "active_power_total");
      const { tipo } = tipoDe(meta);
      // Medidores vigilados por el motor de alarmas: su estado (en_cero, sin_cambio, ...); el resto, en linea o no.
      const estado = motor.get(d.name)?.estado ?? (!online
        ? "fuera_de_linea"
        : tipo === "generator"
          ? (kw ?? 0) > 0.5 ? "generador_en_marcha" : "en_espera_generador_apagado"
          : "ok");
      return {
        id: d.id,
        nombre: d.name,
        inventario: (a.code_inventory ?? a.code ?? null) as string | null,
        tipo,
        estado,
        actualizado: d.state?.updatedAt?.toISOString() ?? null,
        lectura: {
          kw,
          v_prom: num(r, "voltage_ln_avg") ?? prom(r, ["voltage_a_n", "voltage_b_n", "voltage_c_n"]),
          a_prom: num(r, "current_avg") ?? prom(r, ["current_a", "current_b", "current_c"]),
        },
      };
    });
    const ok = dispositivos.filter((d) => d.estado !== "fuera_de_linea").length;
    return {
      id: this.codigo,
      nombre: this.nombre,
      origen: "gravix",
      version: this.version,
      sin_respuesta: false,
      medidores: { total: dispositivos.length, ok, fuera: dispositivos.length - ok },
      dispositivos,
      /** Alarmas abiertas del motor de Gravix, con la forma de /api/vista (titulo incluido). */
      abiertos: this.alarmas.abiertosVista(),
      generado: new Date().toISOString(),
    };
  }

  /** Estado de la instalacion: versiones, agentes, ultima lectura, huecos abiertos y disco. */
  async salud() {
    const [agentes, equipos, ultima, huecos, disco] = await Promise.all([
      this.agents.list(),
      this.prisma.device.count({ where: { protocol: "modbus" } }),
      this.prisma.deviceState.findFirst({ where: { device: { protocol: "modbus" } }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
      this.prisma.readingGap.count({ where: { status: "open" } }),
      statfs("/").then((s) => ({ libreGb: Math.round(((s.bavail * s.bsize) / 1e9) * 10) / 10, totalGb: Math.round(((s.blocks * s.bsize) / 1e9) * 10) / 10 })).catch(() => null),
    ]);
    return {
      sede: { codigo: this.codigo, nombre: this.nombre },
      modo: "sede",
      version: this.version,
      web: { puerto: Number(this.config.get<string>("SEDE_WEB_PORT")) || null },
      hora: new Date().toISOString(),
      agentes: agentes.map((g) => ({
        buildingKey: g.buildingKey,
        configVersion: g.version,
        appliedVersion: g.appliedVersion,
        applyError: g.applyError,
        agentVersion: (g.lastSync as Record<string, unknown> | null)?.agentVersion ?? null,
        ultimoSync: (g.lastSync as Record<string, unknown> | null)?.syncedAt ?? null,
      })),
      equipos,
      ultimaLectura: ultima?.updatedAt.toISOString() ?? null,
      huecosAbiertos: huecos,
      disco,
      alarmas: (() => {
        const e = this.alarmas.obtenerEstado();
        return { motor: e.motor, estado: e.estado, abiertos: e.eventos_abiertos.length, correo: e.correo, correoActivo: e.correo_activo };
      })(),
      bases: {
        timescale: "principal",
        influx: this.influx.activo ? { ...this.influx.estado, pendientes: this.influx.pendientes } : "no configurado",
      },
    };
  }
}
