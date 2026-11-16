import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Socket } from "node:net";
import { PrismaService } from "../prisma/prisma.service";
import { INDICADORES, METRICAS_CALIDAD, NORMAS, evaluarIntervalo, type Indicador, type Limites, type Norma } from "./normas";

const DIRECT_SUFFIX = "-directo";

interface DeviceMeta {
  agent?: { buildingKey?: string };
  model?: string;
  attributes?: Record<string, unknown>;
  umbrales?: { norma?: Norma; limites?: Partial<Limites>; actualizado?: string };
}

/**
 * Calidad de energia y prediccion (pestañas "Normas y cumplimiento" y "Predicción" del Centro de
 * mando, y "Equipos > Configuración"). Todo sale del historial en TimescaleDB; la prueba de lectura
 * hace UNA consulta Modbus de solo lectura (funcion 03) al equipo.
 */
@Injectable()
export class QualityService {
  private cache = new Map<string, { at: number; data: unknown }>();

  constructor(private readonly prisma: PrismaService) {}

  private async equipos(buildingKey: string) {
    // La calidad se evalua con la lectura directa cuando existe (el AS-P no la entrega bien).
    const directKey = buildingKey.endsWith(DIRECT_SUFFIX) ? buildingKey : `${buildingKey}${DIRECT_SUFFIX}`;
    for (const key of [directKey, buildingKey]) {
      const devs = await this.prisma.device.findMany({
        where: { protocol: "modbus", metadata: { path: ["agent", "buildingKey"], equals: key } },
        orderBy: { name: "asc" },
      });
      if (devs.length) return { key, devs };
    }
    return { key: buildingKey, devs: [] };
  }

  /** Cumplimiento por equipo e indicador: % de intervalos de 10 min dentro del limite. */
  async cumplimiento(buildingKey: string, dias: number, norma: Norma) {
    const ck = `c:${buildingKey}:${dias}:${norma}`;
    const hit = this.cache.get(ck);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
    const { key, devs } = await this.equipos(buildingKey);
    const base = NORMAS[norma].limites;
    const ids = devs.map((d) => d.id);
    const rows = ids.length
      ? await this.prisma.$queryRaw<{ deviceId: string; metric: string; t: Date; v: number }[]>`
          SELECT "deviceId", metric, time_bucket(INTERVAL '10 minutes', "time") AS t, avg("value")::float AS v
          FROM readings
          WHERE "deviceId" = ANY(${ids}) AND metric = ANY(${METRICAS_CALIDAD}) AND "time" > now() - make_interval(days => ${dias}::int)
          GROUP BY 1, 2, 3`
      : [];
    // deviceId -> t -> metric -> valor
    const porEquipo = new Map<string, Map<number, Record<string, number>>>();
    for (const r of rows) {
      const k = r.t.getTime();
      if (!porEquipo.has(r.deviceId)) porEquipo.set(r.deviceId, new Map());
      const m = porEquipo.get(r.deviceId)!;
      if (!m.has(k)) m.set(k, {});
      m.get(k)![r.metric] = r.v;
    }
    const equipos = devs
      .filter((d) => ((d.metadata as DeviceMeta | null)?.attributes?.category ?? "") !== "generator" && !/generador/i.test(d.name))
      .map((d) => {
        const meta = (d.metadata as DeviceMeta | null) ?? {};
        const limites: Limites = { ...base, ...(meta.umbrales?.limites ?? {}) };
        const cuenta = Object.fromEntries(INDICADORES.map((i) => [i, { ok: 0, n: 0 }])) as Record<Indicador, { ok: number; n: number }>;
        for (const m of porEquipo.get(d.id)?.values() ?? []) {
          const ev = evaluarIntervalo(m, limites);
          for (const i of INDICADORES) {
            if (ev[i] == null) continue;
            cuenta[i].n++;
            if (ev[i]) cuenta[i].ok++;
          }
        }
        const indicadores = Object.fromEntries(
          INDICADORES.map((i) => [i, cuenta[i].n ? { pct: Math.round((cuenta[i].ok / cuenta[i].n) * 1000) / 10, intervalos: cuenta[i].n, cumple: cuenta[i].ok / cuenta[i].n >= 0.95 } : null]),
        );
        return { id: d.id, nombre: d.name, propios: !!meta.umbrales?.limites, indicadores };
      });
    const evaluados = equipos.flatMap((e) => Object.values(e.indicadores).filter(Boolean)) as { cumple: boolean }[];
    const data = {
      buildingKey: key,
      dias,
      norma,
      normaNombre: NORMAS[norma].nombre,
      fuente: NORMAS[norma].fuente,
      limites: base,
      equipos,
      resumen: { evaluados: evaluados.length, cumplen: evaluados.filter((x) => x.cumple).length },
      calculado: new Date().toISOString(),
    };
    this.cache.set(ck, { at: Date.now(), data });
    return data;
  }

  /**
   * Pronostico de una variable: perfil por tipo de dia (habil / fin de semana) y hora, mas la
   * tendencia de los promedios diarios. Banda = ±1.5 desviaciones del perfil.
   */
  async pronostico(deviceId: string, metric: string, dias: number, horizonte: number) {
    const d = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!d) throw new NotFoundException("Dispositivo no encontrado");
    const rows = await this.prisma.$queryRaw<{ t: Date; v: number }[]>`
      SELECT time_bucket(INTERVAL '1 hour', "time") AS t, avg("value")::float AS v
      FROM readings WHERE "deviceId" = ${deviceId} AND metric = ${metric} AND "time" > now() - make_interval(days => ${dias}::int)
      GROUP BY 1 ORDER BY 1`;
    const cap = Number((d.metadata as DeviceMeta | null)?.attributes?.capacityKva) || null;
    if (rows.length < 48) return { metric, capacidad: cap, historia: rows.map((r) => ({ t: r.t.toISOString(), v: r.v })), pronostico: [], suficiente: false };
    // Hora de Guatemala (UTC-6) para el perfil.
    const gt = (t: Date) => new Date(t.getTime() - 6 * 3600_000);
    const clave = (t: Date) => `${[0, 6].includes(gt(t).getUTCDay()) ? "f" : "h"}${gt(t).getUTCHours()}`;
    const grupos = new Map<string, number[]>();
    for (const r of rows) {
      const k = clave(r.t);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k)!.push(r.v);
    }
    const media = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
    const desv = (xs: number[]) => { const m = media(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
    // tendencia: regresion lineal de los promedios diarios (por dia transcurrido)
    const diario = new Map<number, number[]>();
    for (const r of rows) { const k = Math.floor(gt(r.t).getTime() / 86400_000); if (!diario.has(k)) diario.set(k, []); diario.get(k)!.push(r.v); }
    const pts = [...diario.entries()].filter(([, xs]) => xs.length >= 12).map(([k, xs]) => [k, media(xs)] as [number, number]);
    let pendiente = 0;
    if (pts.length >= 4) {
      const mx = media(pts.map((p) => p[0])), my = media(pts.map((p) => p[1]));
      const num = pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0), den = pts.reduce((a, [x]) => a + (x - mx) ** 2, 0);
      pendiente = den ? num / den : 0; // unidades por dia
    }
    const ultimo = rows[rows.length - 1].t.getTime();
    const pronostico = [];
    for (let h = 1; h <= horizonte * 24; h++) {
      const t = new Date(ultimo + h * 3600_000);
      const xs = grupos.get(clave(t)) ?? rows.map((r) => r.v);
      const v = media(xs) + pendiente * (h / 24);
      const s = desv(xs) * 1.5;
      pronostico.push({ t: t.toISOString(), v, min: v - s, max: v + s });
    }
    return { metric, capacidad: cap, pendienteDiaria: pendiente, historia: rows.map((r) => ({ t: r.t.toISOString(), v: r.v })), pronostico, suficiente: true };
  }

  /** Umbrales propios del equipo (si no tiene, se usan los de la norma). */
  async guardarUmbrales(deviceId: string, norma: Norma, limites: Partial<Limites>) {
    const d = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!d) throw new NotFoundException("Dispositivo no encontrado");
    const meta = { ...((d.metadata as Record<string, unknown> | null) ?? {}), umbrales: { norma, limites, actualizado: new Date().toISOString() } };
    await this.prisma.device.update({ where: { id: deviceId }, data: { metadata: meta as Prisma.InputJsonValue } });
    this.cache.clear();
    return meta.umbrales;
  }

  umbralesDe(metadata: unknown) {
    const u = (metadata as DeviceMeta | null)?.umbrales;
    const norma: Norma = u?.norma ?? "ntsd";
    return { norma, limites: { ...NORMAS[norma].limites, ...(u?.limites ?? {}) }, propios: !!u?.limites, actualizado: u?.actualizado ?? null };
  }

  /**
   * Prueba de lectura: UNA consulta Modbus TCP de solo lectura (funcion 03). ION7400/PM2130 leen la
   * frecuencia (3110) y el voltaje A-N (3028); el generador su bloque 4770-4806.
   */
  async probarLectura(ip: string, port: number, unitId: number, perfil: string) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new BadRequestException("IP inválida");
    const gen = perfil.startsWith("generador");
    const consultas: [number, number][] = gen ? [[4769, 38]] : [[3109, 2], [3027, 2]];
    const t0 = Date.now();
    const valores: Record<string, number | null> = {};
    try {
      for (const [addr, count] of consultas) {
        const regs = await modbusRead(ip, port, unitId, addr, count, 4000);
        if (gen) {
          const i32 = (i: number) => ((regs[i + 1] << 16) | regs[i]) >> 0;
          valores.bateria_v = i32(34) / 10;
          valores.refrigerante_c = i32(30) / 10;
        } else {
          const b = Buffer.alloc(4);
          b.writeUInt16BE(regs[0], 0);
          b.writeUInt16BE(regs[1], 2);
          const f = b.readFloatBE(0);
          valores[addr === 3109 ? "frecuencia_hz" : "voltaje_a_n_v"] = Number.isFinite(f) ? Math.round(f * 1000) / 1000 : null;
        }
      }
      const valido = gen ? (valores.bateria_v ?? 0) > 5 : (valores.frecuencia_hz ?? 0) > 45 && (valores.frecuencia_hz ?? 0) < 65;
      return { ok: true, valido, ms: Date.now() - t0, valores, funcion: "03 (solo lectura)" };
    } catch (e) {
      return { ok: false, valido: false, ms: Date.now() - t0, error: (e as Error).message, funcion: "03 (solo lectura)" };
    }
  }
}

/** Cliente Modbus TCP minimo, solo funcion 03 (lectura de holding registers). */
function modbusRead(host: string, port: number, unit: number, addr: number, count: number, timeoutMs: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    let buf = Buffer.alloc(0);
    const fin = (err: Error | null, v?: number[]) => { s.destroy(); if (err) reject(err); else resolve(v!); };
    s.setTimeout(timeoutMs, () => fin(new Error(`sin respuesta en ${timeoutMs / 1000} s`)));
    s.on("error", (e) => fin(new Error(`no se pudo conectar: ${(e as NodeJS.ErrnoException).code ?? e.message}`)));
    s.connect(port, host, () => {
      const q = Buffer.alloc(12);
      q.writeUInt16BE(1, 0); q.writeUInt16BE(0, 2); q.writeUInt16BE(6, 4);
      q[6] = unit; q[7] = 3; q.writeUInt16BE(addr, 8); q.writeUInt16BE(count, 10);
      s.write(q);
    });
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 9) return;
      if (buf[7] & 0x80) return fin(new Error(`el equipo respondió excepción Modbus ${buf[8]}`));
      if (buf.length < 9 + buf[8]) return;
      const out: number[] = [];
      for (let i = 0; i < buf[8] / 2; i++) out.push(buf.readUInt16BE(9 + i * 2));
      fin(null, out);
    });
  });
}
