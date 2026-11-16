import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AgentsService } from "../agents/agents.service";
import type { DirectConnectionDto } from "./dto/pilot.dto";

const WINDOW_DAYS = 7;

/** Sede del agente de prueba que lee cada medidor directo (Fase B): "<sede>-directo". */
const DIRECT_SUFFIX = "-directo";

export interface Tolerance {
  /** pct = % del valor del AS-P; abs = diferencia absoluta en la unidad de la metrica. */
  kind: "pct" | "abs";
  value: number;
}

/**
 * Tolerancia directo vs AS-P por tipo de metrica. El AS-P lee el medidor con su propio ciclo, asi
 * que en cargas que cambian rapido (corriente, potencia) siempre hay algo de diferencia.
 */
export function toleranceFor(metric: string): Tolerance {
  if (metric === "frequency") return { kind: "abs", value: 0.05 };
  if (metric.startsWith("power_factor")) return { kind: "abs", value: 0.02 };
  if (metric.startsWith("thd_")) return { kind: "abs", value: 0.5 };
  if (metric.startsWith("short_term_flicker")) return { kind: "abs", value: 0.1 };
  if (metric.endsWith("_status") || metric.endsWith("_count")) return { kind: "abs", value: 0 };
  if (metric.startsWith("voltage")) return { kind: "pct", value: 1 };
  return { kind: "pct", value: 3 };
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

interface DeviceMeta {
  agent?: { buildingKey?: string; externalId?: string };
  model?: string;
  attributes?: Record<string, unknown>;
  directConnection?: Record<string, unknown>;
}

/**
 * Consultas de la pestaña Piloto Gravix: equipos de energia de una sede (los que su Agente_Go lee
 * por Modbus) con su estado en vivo, huecos y completitud del historial, mas las series para las
 * graficas.
 */
@Injectable()
export class PilotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentsService,
  ) {}

  async devices(buildingKey: string) {
    const devices = await this.prisma.device.findMany({
      where: {
        protocol: "modbus",
        metadata: { path: ["agent", "buildingKey"], equals: buildingKey },
      },
      include: { state: true },
      orderBy: { name: "asc" },
    });
    const ids = devices.map((d) => d.id);
    const [gaps, firsts, sync] = await Promise.all([
      ids.length ? this.gapStats(ids) : [],
      ids.length ? this.firstReadings(ids) : [],
      this.agents.latestSyncs().then((all) => all.find((s) => s.buildingKey === buildingKey) ?? null),
    ]);

    const now = Date.now();
    const windowStart = now - WINDOW_DAYS * 86_400_000;
    return {
      buildingKey,
      lastSync: sync,
      devices: devices.map((d) => {
        const meta = (d.metadata as DeviceMeta | null) ?? {};
        const g = gaps.find((x) => x.deviceId === d.id);
        const first = firsts.find((x) => x.deviceId === d.id)?.first ?? null;
        // Completitud desde que hay historial (o los ultimos 7 dias, lo que sea mas corto).
        const from = first ? Math.max(first.getTime(), windowStart) : null;
        const spanSeconds = from ? (now - from) / 1000 : 0;
        const missing = g?.missingSeconds ?? 0;
        return {
          id: d.id,
          name: d.name,
          model: meta.model ?? null,
          attributes: meta.attributes ?? {},
          externalId: meta.agent?.externalId ?? null,
          state: d.state?.state ?? null,
          readings: (d.state?.readings as Record<string, unknown> | null) ?? {},
          updatedAt: d.state?.updatedAt.toISOString() ?? null,
          directConnection: meta.directConnection ?? null,
          historySince: first?.toISOString() ?? null,
          gaps: {
            pending: g?.pending ?? 0,
            openNow: g?.openNow ?? 0,
            total: g?.total ?? 0,
            missingMinutes: Math.round(missing / 60),
          },
          completeness: spanSeconds > 0 ? Math.max(0, Math.min(100, 100 - (missing / spanSeconds) * 100)) : null,
        };
      }),
    };
  }

  async series(deviceId: string, metric: string, minutes: number) {
    await this.ensureDevice(deviceId);
    // Unos 240 puntos por grafica, nunca menos de una lectura (15 s) por punto.
    const bucket = Math.max(15, Math.round((minutes * 60) / 240));
    const points = await this.prisma.$queryRaw<{ t: Date; v: number }[]>`
      SELECT time_bucket(make_interval(secs => ${bucket}::int), "time") AS t, avg("value")::float AS v
      FROM readings
      WHERE "deviceId" = ${deviceId} AND metric = ${metric} AND "time" > now() - make_interval(mins => ${minutes}::int)
      GROUP BY t ORDER BY t`;
    const gaps = await this.prisma.readingGap.findMany({
      where: {
        deviceId,
        OR: [{ endedAt: null }, { endedAt: { gt: new Date(Date.now() - minutes * 60_000) } }],
      },
      orderBy: { startedAt: "asc" },
    });
    return {
      metric,
      minutes,
      bucketSeconds: bucket,
      points: points.map((p) => ({ t: p.t.toISOString(), v: p.v })),
      gaps: gaps.map((g) => this.gapDto(g)),
    };
  }

  /**
   * Fase B: compara, metrica por metrica, el equipo leido a traves del AS-P (`deviceId`) contra el
   * mismo equipo leido directo por su IP (mismo nombre en la sede "<sede>-directo", ver el agente
   * de prueba ~/agente-go-escuintla-directo). Promedia por minuto (o 15 min en ventanas largas) y
   * cuenta en cuantos intervalos la diferencia queda dentro de la tolerancia de esa metrica.
   */
  async compare(deviceId: string, minutes: number) {
    const device = await this.ensureDevice(deviceId);
    const meta = (device.metadata as DeviceMeta | null) ?? {};
    const buildingKey = meta.agent?.buildingKey ?? "";
    const directKey = buildingKey.endsWith(DIRECT_SUFFIX) ? null : `${buildingKey}${DIRECT_SUFFIX}`;
    const pair = directKey
      ? await this.prisma.device.findFirst({
          where: { name: device.name, protocol: "modbus", metadata: { path: ["agent", "buildingKey"], equals: directKey } },
          include: { state: true },
        })
      : null;
    if (!pair) {
      return { deviceId, directDeviceId: null, directBuildingKey: directKey, minutes, bucketSeconds: 0, metrics: [], onlyAsp: [], onlyDirect: [] };
    }

    const bucket = minutes <= 24 * 60 ? 60 : 900;
    const rows = await this.prisma.$queryRaw<{ metric: string; t: Date; asp: number | null; dir: number | null }[]>`
      SELECT metric, time_bucket(make_interval(secs => ${bucket}::int), "time") AS t,
        avg("value") FILTER (WHERE "deviceId" = ${deviceId})::float AS asp,
        avg("value") FILTER (WHERE "deviceId" = ${pair.id})::float AS dir
      FROM readings
      WHERE "deviceId" = ANY(${[deviceId, pair.id]}) AND "time" > now() - make_interval(mins => ${minutes}::int)
        AND metric NOT LIKE 'harm\\_%'
      GROUP BY metric, t
      ORDER BY metric, t`;

    const byMetric = new Map<string, { asp: number; dir: number }[]>();
    const seenAsp = new Set<string>();
    const seenDir = new Set<string>();
    for (const r of rows) {
      if (r.asp != null) seenAsp.add(r.metric);
      if (r.dir != null) seenDir.add(r.metric);
      if (r.asp == null || r.dir == null) continue;
      const list = byMetric.get(r.metric) ?? [];
      list.push({ asp: r.asp, dir: r.dir });
      byMetric.set(r.metric, list);
    }

    const aspState = await this.prisma.deviceState.findUnique({ where: { deviceId } });
    const lastAsp = (aspState?.readings as Record<string, unknown> | null) ?? {};
    const lastDir = (pair.state?.readings as Record<string, unknown> | null) ?? {};

    const metrics = [...byMetric.entries()].map(([metric, list]) => {
      const tol = toleranceFor(metric);
      let within = 0;
      let sumAbs = 0;
      let sumPct = 0;
      let pctCount = 0;
      let maxAbs = 0;
      for (const p of list) {
        const d = Math.abs(p.dir - p.asp);
        sumAbs += d;
        maxAbs = Math.max(maxAbs, d);
        if (Math.abs(p.asp) > 1e-6) {
          sumPct += (d / Math.abs(p.asp)) * 100;
          pctCount++;
        }
        const limit = tol.kind === "pct" ? (Math.abs(p.asp) * tol.value) / 100 : tol.value;
        if (d <= limit + 1e-9) within++;
      }
      const avg = (k: "asp" | "dir") => list.reduce((s, p) => s + p[k], 0) / list.length;
      return {
        metric,
        intervals: list.length,
        avgAsp: avg("asp"),
        avgDirect: avg("dir"),
        lastAsp: num(lastAsp[metric]),
        lastDirect: num(lastDir[metric]),
        meanAbsDiff: sumAbs / list.length,
        maxAbsDiff: maxAbs,
        meanPctDiff: pctCount ? sumPct / pctCount : null,
        tolerance: tol,
        withinPct: (within / list.length) * 100,
      };
    });

    return {
      deviceId,
      directDeviceId: pair.id,
      directBuildingKey: directKey,
      directUpdatedAt: pair.state?.updatedAt.toISOString() ?? null,
      directState: pair.state?.state ?? null,
      minutes,
      bucketSeconds: bucket,
      metrics,
      onlyAsp: [...seenAsp].filter((m) => !seenDir.has(m)).sort(),
      onlyDirect: [...seenDir].filter((m) => !seenAsp.has(m)).sort(),
    };
  }

  /**
   * Espectro de armonicos (ION7400 leido directo, agente 0.5.4+): el ultimo guardado hasta `at`
   * (default ahora), dentro de los 2 dias anteriores. Valores en V o A por armonico (harm_<v|i>_<a|b|c>_NN);
   * la web calcula el % contra H1. `horas` = cuantos espectros hay guardados en las ultimas 24 h.
   */
  async spectrum(deviceId: string, at?: Date) {
    await this.ensureDevice(deviceId);
    const hasta = at && !Number.isNaN(at.getTime()) ? at : new Date();
    const desde = new Date(hasta.getTime() - 2 * 86_400_000);
    const last = await this.prisma.$queryRaw<{ t: Date | null }[]>`
      SELECT max("time") AS t FROM readings
      WHERE "deviceId" = ${deviceId} AND metric = 'harm_v_a_01' AND "time" <= ${hasta} AND "time" > ${desde}`;
    const t = last[0]?.t ?? null;
    if (!t) return { deviceId, readAt: null, values: {} as Record<string, number> };
    const rows = await this.prisma.$queryRaw<{ metric: string; value: number }[]>`
      SELECT metric, value FROM readings
      WHERE "deviceId" = ${deviceId} AND "time" = ${t} AND metric LIKE 'harm\\_%'`;
    return { deviceId, readAt: t.toISOString(), values: Object.fromEntries(rows.map((r) => [r.metric, r.value])) };
  }

  async gaps(deviceId: string, days: number) {
    await this.ensureDevice(deviceId);
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.readingGap.findMany({
      where: { deviceId, OR: [{ endedAt: null }, { endedAt: { gt: since } }] },
      orderBy: { startedAt: "desc" },
      take: 500,
    });
    return rows.map((g) => this.gapDto(g));
  }

  async saveConnection(deviceId: string, dto: DirectConnectionDto) {
    const device = await this.ensureDevice(deviceId);
    if (dto.viaDeviceId) {
      if (dto.viaDeviceId === deviceId) throw new BadRequestException("Un equipo no puede ser su propio puente");
      if (dto.unitId == null) throw new BadRequestException("Detras de un puente el ID Modbus es obligatorio");
      const via = await this.prisma.device.findUnique({ where: { id: dto.viaDeviceId } });
      if (!via) throw new BadRequestException("El equipo puente no existe");
    }
    const meta = (device.metadata as DeviceMeta | null) ?? {};
    const directConnection = {
      ip: dto.ip,
      port: dto.port,
      unitId: dto.unitId ?? null,
      viaDeviceId: dto.viaDeviceId ?? null,
      enabled: dto.enabled,
      compareWithAsp: dto.compareWithAsp,
      intervalSeconds: dto.intervalSeconds,
      updatedAt: new Date().toISOString(),
    };
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { metadata: { ...meta, directConnection } as Prisma.InputJsonValue },
    });
    return directConnection;
  }

  /**
   * Datos para el Excel del historial: varias variables por intervalo. Si el equipo tiene pareja
   * (mismo nombre leido directo / por el AS-P), agrega la columna de la otra lectura.
   */
  async exportRows(deviceId: string, metrics: string[], minutes: number, step: number) {
    const device = await this.ensureDevice(deviceId);
    const meta = (device.metadata as DeviceMeta | null) ?? {};
    const buildingKey = meta.agent?.buildingKey ?? "";
    const isDirect = buildingKey.endsWith(DIRECT_SUFFIX);
    const otherKey = isDirect ? buildingKey.slice(0, -DIRECT_SUFFIX.length) : `${buildingKey}${DIRECT_SUFFIX}`;
    const pair = buildingKey
      ? await this.prisma.device.findFirst({ where: { name: device.name, protocol: "modbus", metadata: { path: ["agent", "buildingKey"], equals: otherKey } } })
      : null;
    const ids = pair ? [device.id, pair.id] : [device.id];
    const rows = await this.prisma.$queryRaw<{ t: Date; deviceId: string; metric: string; v: number; q: string }[]>`
      SELECT time_bucket(make_interval(secs => ${step}::int), "time") AS t, "deviceId", metric, avg("value")::float AS v,
             min(quality::text) AS q
      FROM readings
      WHERE "deviceId" = ANY(${ids}) AND metric = ANY(${metrics}) AND "time" > now() - make_interval(mins => ${minutes}::int)
      GROUP BY t, "deviceId", metric ORDER BY t`;
    const gaps = await this.prisma.readingGap.findMany({
      where: { deviceId: device.id, startedAt: { lt: new Date() }, OR: [{ endedAt: null }, { endedAt: { gt: new Date(Date.now() - minutes * 60_000) } }] },
      orderBy: { startedAt: "asc" },
    });
    return { device, pairId: pair?.id ?? null, isDirect, rows, gaps: gaps.map((g) => this.gapDto(g)) };
  }

  async metadataOf(deviceId: string) {
    return (await this.ensureDevice(deviceId)).metadata;
  }

  private async ensureDevice(deviceId: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new NotFoundException("Dispositivo no encontrado");
    return device;
  }

  private gapDto(g: { id: string; startedAt: Date; endedAt: Date | null; cause: string; status: string }) {
    const end = g.endedAt?.getTime() ?? Date.now();
    return {
      id: g.id,
      startedAt: g.startedAt.toISOString(),
      endedAt: g.endedAt?.toISOString() ?? null,
      minutes: Math.max(0, Math.round((end - g.startedAt.getTime()) / 60_000)),
      cause: g.cause,
      status: g.status,
    };
  }

  private gapStats(ids: string[]) {
    return this.prisma.$queryRaw<
      { deviceId: string; pending: number; openNow: number; total: number; missingSeconds: number }[]
    >`
      SELECT "deviceId",
        count(*) FILTER (WHERE status IN ('open', 'closed'))::int AS pending,
        count(*) FILTER (WHERE status = 'open')::int AS "openNow",
        count(*)::int AS total,
        coalesce(sum(extract(epoch FROM (coalesce("endedAt", now()) - greatest("startedAt", now() - interval '7 days'))))
          FILTER (WHERE status IN ('open', 'closed')), 0)::float AS "missingSeconds"
      FROM reading_gaps
      WHERE "deviceId" = ANY(${ids}) AND coalesce("endedAt", now()) > now() - interval '7 days'
      GROUP BY "deviceId"`;
  }

  /** Primera lectura de cada equipo (usa la llave primaria: deviceId, metric, time). */
  private firstReadings(ids: string[]) {
    return this.prisma.$queryRaw<{ deviceId: string; first: Date }[]>`
      SELECT d.id AS "deviceId", f.first
      FROM unnest(${ids}::text[]) AS d(id)
      CROSS JOIN LATERAL (
        SELECT r."time" AS first FROM readings r
        WHERE r."deviceId" = d.id
        ORDER BY r."deviceId", r.metric, r."time"
        LIMIT 1
      ) f`;
  }
}
