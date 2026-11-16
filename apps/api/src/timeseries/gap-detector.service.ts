import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";

/** Cada cuanto lee el agente los equipos Modbus (pollIntervalSeconds del agente de la sede). */
const EXPECTED_MS = 15_000;
/** Sin lectura nueva por mas de 3 ciclos = hueco. */
const GAP_AFTER_MS = 45_000;
/** Un hueco cuenta como recuperado si, ya con las lecturas atrasadas, no queda ningun salto mayor (3 ciclos de 30 s). */
const RECOVERED_MAX_STEP_MS = 90_000;

interface Track {
  buildingKey: string;
  /** Hora de la ultima lectura guardada. */
  lastAt: number;
  /** Desde cuando el agente lo reporta "offline" (lectura Modbus fallida). */
  offlineSince?: number;
  openGapId?: string;
}

/**
 * Detector de huecos de la Fase A del piloto Gravix: lleva la hora de la ultima lectura de cada
 * equipo Modbus de un agente y, si pasan mas de GAP_AFTER_MS sin una nueva, abre un hueco en
 * reading_gaps con su causa. Lo cierra en cuanto llega la siguiente lectura.
 *
 * Al arrancar la API reconstruye el estado desde la base (ultima lectura por equipo y huecos
 * abiertos), asi un reinicio de la API tambien queda registrado como hueco.
 */
@Injectable()
export class GapDetectorService implements OnModuleInit {
  private readonly logger = new Logger(GapDetectorService.name);
  private readonly tracks = new Map<string, Track>();
  private readonly agentLastSeen = new Map<string, number>();
  private scanning = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const last = await this.prisma.$queryRaw<{ deviceId: string; last: Date }[]>`
      SELECT "deviceId", max("time") AS last FROM readings
      WHERE "time" > now() - interval '2 days'
      GROUP BY "deviceId"`;
    if (!last.length) return;

    const devices = await this.prisma.device.findMany({
      where: { id: { in: last.map((r) => r.deviceId) } },
      select: { id: true, metadata: true },
    });
    const open = await this.prisma.readingGap.findMany({ where: { status: "open" }, select: { id: true, deviceId: true } });

    for (const row of last) {
      const device = devices.find((d) => d.id === row.deviceId);
      const buildingKey = (device?.metadata as { agent?: { buildingKey?: string } } | null)?.agent?.buildingKey;
      if (!buildingKey) continue;
      this.tracks.set(row.deviceId, {
        buildingKey,
        lastAt: row.last.getTime(),
        openGapId: open.find((g) => g.deviceId === row.deviceId)?.id,
      });
    }
    this.logger.log(`Detector de huecos: ${this.tracks.size} equipo(s) en seguimiento`);
  }

  agentSeen(buildingKey: string, at: Date) {
    this.agentLastSeen.set(buildingKey, at.getTime());
  }

  markOffline(deviceId: string, buildingKey: string) {
    const track = this.tracks.get(deviceId);
    if (!track) return; // nunca dio una lectura: no hay desde donde medir el hueco
    track.buildingKey = buildingKey;
    track.offlineSince ??= Date.now();
  }

  async readingArrived(deviceId: string, buildingKey: string, at: Date) {
    const track = this.tracks.get(deviceId) ?? { buildingKey, lastAt: at.getTime() };
    track.buildingKey = buildingKey;
    track.lastAt = at.getTime();
    track.offlineSince = undefined;
    this.tracks.set(deviceId, track);

    if (track.openGapId) {
      const id = track.openGapId;
      track.openGapId = undefined;
      await this.prisma.readingGap.update({ where: { id }, data: { endedAt: at, status: "closed" } });
    }
  }

  /**
   * Revisa los huecos ya cerrados de un equipo que se cruzan con [from, to] despues de recibir
   * lecturas atrasadas (backlog del agente). Si dentro del hueco ya no queda ningun salto entre
   * lecturas mayor a RECOVERED_MAX_STEP_MS, queda "recovered"; si se lleno solo una parte, "partial".
   */
  async reconcile(deviceId: string, from: Date, to: Date) {
    const gaps = await this.prisma.readingGap.findMany({
      where: {
        deviceId,
        status: { in: ["closed", "partial"] },
        startedAt: { lte: new Date(to.getTime() + RECOVERED_MAX_STEP_MS) },
        endedAt: { gte: new Date(from.getTime() - RECOVERED_MAX_STEP_MS) },
      },
    });
    for (const g of gaps) {
      if (!g.endedAt) continue;
      const s = new Date(g.startedAt.getTime() - RECOVERED_MAX_STEP_MS);
      const e = new Date(g.endedAt.getTime() + RECOVERED_MAX_STEP_MS);
      const [row] = await this.prisma.$queryRaw<{ n: number; maxStep: number | null }[]>`
        SELECT count(*)::int AS n, max(step)::float AS "maxStep" FROM (
          SELECT extract(epoch FROM t - lag(t) OVER (ORDER BY t)) * 1000 AS step
          FROM (SELECT DISTINCT "time" AS t FROM readings WHERE "deviceId" = ${deviceId} AND "time" BETWEEN ${s} AND ${e}) x
        ) y`;
      const inside = await this.prisma.reading.count({
        where: { deviceId, time: { gt: g.startedAt, lt: g.endedAt } },
      });
      if (!inside) continue;
      const status = row && row.maxStep != null && row.maxStep <= RECOVERED_MAX_STEP_MS ? "recovered" : "partial";
      if (status !== g.status) {
        await this.prisma.readingGap.update({ where: { id: g.id }, data: { status } });
        this.logger.log(`Hueco ${g.id} de ${deviceId}: ${status} con lecturas atrasadas del agente`);
      }
    }
  }

  @Interval(EXPECTED_MS)
  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const now = Date.now();
      for (const [deviceId, track] of this.tracks) {
        if (track.openGapId || now - track.lastAt <= GAP_AFTER_MS) continue;
        const gap = await this.prisma.readingGap.create({
          data: { deviceId, startedAt: new Date(track.lastAt + EXPECTED_MS), cause: this.cause(track, now) },
        });
        track.openGapId = gap.id;
      }
    } catch (err) {
      this.logger.warn(`No se pudo revisar huecos: ${(err as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  private cause(track: Track, now: number) {
    const agent = this.agentLastSeen.get(track.buildingKey);
    if (!agent || now - agent > GAP_AFTER_MS) return "El agente no reporta (agente, enlace o API sin servicio)";
    if (track.offlineSince) return "El equipo no responde (AS-P o Modbus)";
    return "Sin lecturas nuevas del equipo";
  }
}
