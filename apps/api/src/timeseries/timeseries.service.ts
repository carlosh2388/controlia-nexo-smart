import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { GapDetectorService } from "./gap-detector.service";
import { InfluxWriterService } from "./influx-writer.service";
import { ComparativoService } from "./comparativo.service";

interface SnapshotItem {
  protocol: string;
  state?: string;
  readings?: Record<string, unknown>;
  readAt?: string;
}

/**
 * Historial detallado (tabla readings, TimescaleDB) de los equipos de energia que leen los
 * Agente_Go por Modbus. Recibe cada snapshot del agente desde AgentSyncService.
 *
 * El agente sincroniza y lee con el mismo intervalo (15 s) pero sin coordinarse, asi que a veces
 * manda dos veces la misma lectura: si llega identica a la anterior hace menos de DUPLICATE_MS no
 * se guarda otra vez (si cuenta como "el equipo sigue vivo" para el detector de huecos). Un equipo
 * con valores constantes (un generador en espera) igual se guarda, una vez pasado ese tiempo.
 *
 * La hora es la de LECTURA si el agente la manda (0.5+, campo readAt) y la de llegada a la API si no
 * (agentes 0.4.x). Con readAt, un reenvio de la misma lectura cae en la misma llave
 * (deviceId, metric, time) y no se duplica, asi que no hace falta el filtro de DUPLICATE_MS.
 * El detector de huecos sigue usando la hora de llegada: mide si el equipo esta "vivo" ahora.
 */
@Injectable()
export class TimeseriesService {
  private readonly logger = new Logger(TimeseriesService.name);
  private readonly last = new Map<string, { key: string; at: number }>();
  /** Hora del ultimo espectro de armonicos guardado por equipo. */
  private readonly lastHarm = new Map<string, number>();
  private static readonly DUPLICATE_MS = 20_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gaps: GapDetectorService,
    private readonly influx: InfluxWriterService,
    private readonly comparativo: ComparativoService,
  ) {}

  agentSeen(buildingKey: string, at: Date) {
    this.gaps.agentSeen(buildingKey, at);
  }

  async recordSnapshot(buildingKey: string, deviceId: string, item: SnapshotItem, at: Date) {
    if (item.protocol !== "modbus") return;
    if (item.state === "offline" || !item.readings) {
      this.gaps.markOffline(deviceId, buildingKey);
      return;
    }

    const { values, harm } = splitHarmonics(numericValues(item.readings));
    if (harm) await this.recordHarmonics(deviceId, harm, at);
    if (!values.length) return;

    const readAt = validReadAt(item.readAt, at, LIVE_MAX_AGE_MS);
    const key = JSON.stringify(values);
    const prev = this.last.get(deviceId);
    const duplicate = !readAt && prev && prev.key === key && at.getTime() - prev.at < TimeseriesService.DUPLICATE_MS;
    if (!duplicate) {
      const time = readAt ?? at;
      try {
        const data = values.map(([metric, value]) => ({ time, deviceId, metric, value }));
        await this.prisma.reading.createMany({ data, skipDuplicates: true });
        this.last.set(deviceId, { key, at: at.getTime() });
        void this.influx.enqueue(data);
        this.comparativo.guardar(data);
      } catch (err) {
        this.logger.warn(`No se pudo guardar el historial de ${deviceId}: ${(err as Error).message}`);
        return;
      }
    }
    await this.gaps.readingArrived(deviceId, buildingKey, at);
  }

  /**
   * Lecturas atrasadas que el agente guardo en disco mientras la API no respondia. Se guardan con
   * su hora real (son lecturas reales, solo llegaron tarde) y despues se revisa si cubren algun
   * hueco registrado de ese equipo para marcarlo como recuperado. Devuelve cuantas se guardaron.
   */
  async recordBacklog(deviceId: string, entries: { readAt?: string; readings?: Record<string, unknown> }[], receivedAt: Date) {
    const rows: { time: Date; deviceId: string; metric: string; value: number }[] = [];
    let from: number | null = null;
    let to: number | null = null;
    for (const e of entries) {
      const time = validReadAt(e.readAt, receivedAt, BACKLOG_MAX_AGE_MS);
      if (!time || !e.readings) continue;
      const { values, harm } = splitHarmonics(numericValues(e.readings));
      if (harm) await this.recordHarmonics(deviceId, harm, receivedAt, BACKLOG_MAX_AGE_MS);
      for (const [metric, value] of values) rows.push({ time, deviceId, metric, value });
      from = Math.min(from ?? time.getTime(), time.getTime());
      to = Math.max(to ?? time.getTime(), time.getTime());
    }
    if (!rows.length || from == null || to == null) return 0;
    try {
      const res = await this.prisma.reading.createMany({ data: rows, skipDuplicates: true });
      void this.influx.enqueue(rows);
      this.comparativo.guardar(rows);
      await this.gaps.reconcile(deviceId, new Date(from), new Date(to));
      return res.count;
    } catch (err) {
      this.logger.warn(`No se pudieron guardar lecturas atrasadas de ${deviceId}: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Espectro de armonicos (agente 0.5.4+, ION7400 directo): el agente lo lee cada 10 min y lo reenvia
   * en cada sync con su hora de lectura (harm_read_at). Se guarda con ESA hora, una sola vez: los
   * reenvios caen en la misma llave (deviceId, metric, time) y ademas se saltan aca sin ir a la base.
   */
  private async recordHarmonics(deviceId: string, harm: { readAt: number; values: [string, number][] }, now: Date, maxAgeMs = LIVE_MAX_AGE_MS * 4) {
    const time = new Date(harm.readAt * 1000);
    const diff = now.getTime() - time.getTime();
    if (!harm.values.length || Number.isNaN(time.getTime()) || diff < -60_000 || diff > maxAgeMs) return;
    if (this.lastHarm.get(deviceId) === time.getTime()) return;
    try {
      const data = harm.values.map(([metric, value]) => ({ time, deviceId, metric, value }));
      await this.prisma.reading.createMany({ data, skipDuplicates: true });
      this.lastHarm.set(deviceId, time.getTime());
      void this.influx.enqueue(data);
      this.comparativo.guardar(data);
    } catch (err) {
      this.logger.warn(`No se pudo guardar el espectro de armonicos de ${deviceId}: ${(err as Error).message}`);
    }
  }
}

/** Separa el espectro de armonicos (harm_*) del resto de las lecturas. harm_read_at no se guarda. */
function splitHarmonics(all: [string, number][]) {
  const values: [string, number][] = [];
  const hv: [string, number][] = [];
  let readAt: number | null = null;
  for (const e of all) {
    if (e[0] === "harm_read_at") readAt = e[1];
    else if (e[0].startsWith("harm_")) hv.push(e);
    else values.push(e);
  }
  return { values, harm: readAt != null && hv.length ? { readAt, values: hv } : null };
}

/** Una lectura en vivo no puede ser de hace mas de esto (si no, se usa la hora de llegada). */
const LIVE_MAX_AGE_MS = 10 * 60_000;
/** El agente guarda como mucho 3 dias en disco; se acepta un poco mas por si el reloj difiere. */
const BACKLOG_MAX_AGE_MS = 4 * 86_400_000;

function numericValues(readings: Record<string, unknown>) {
  return Object.entries(readings).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));
}

/** Hora de lectura del agente si es valida: no del futuro (1 min de margen de reloj) ni demasiado vieja. */
function validReadAt(readAt: string | undefined, now: Date, maxAgeMs: number): Date | null {
  if (!readAt) return null;
  const t = new Date(readAt);
  const diff = now.getTime() - t.getTime();
  if (Number.isNaN(t.getTime()) || diff < -60_000 || diff > maxAgeMs) return null;
  return t;
}
