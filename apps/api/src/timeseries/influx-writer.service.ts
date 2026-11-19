import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";

export interface ReadingRow {
  time: Date;
  deviceId: string;
  metric: string;
  value: number;
}

interface DeviceTags {
  equipo: string;
  agente: string;
}

/**
 * Copia de cada lectura en InfluxDB 2.x, AL MISMO TIEMPO que se guarda en TimescaleDB (readings).
 * TimescaleDB sigue siendo la base principal: huecos, normas, comparacion y recuperacion salen de
 * ahi. InfluxDB es una copia para tableros externos (Grafana, etc.).
 *
 * Se activa solo si estan INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG e INFLUX_BUCKET. Escribe por lotes
 * cada 5 s (line protocol, precision ms). Si InfluxDB no responde, guarda en memoria hasta
 * MAX_PENDING lineas y reintenta; nunca frena ni hace fallar el guardado en TimescaleDB.
 *
 * Formato: measurement "lectura", tags sede/agente/equipo/device_id, un field por metrica.
 *   lectura,sede=igss-escuintla,agente=igss-escuintla-directo,equipo=ANALIZADOR-1,device_id=<uuid> voltage_a_n=127.1,... <ms>
 */
@Injectable()
export class InfluxWriterService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("InfluxWriter");
  private readonly url: string;
  private readonly token: string;
  private readonly org: string;
  private readonly bucket: string;
  private readonly sede: string;
  private pending: string[] = [];
  private readonly tags = new Map<string, DeviceTags>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private static readonly MAX_PENDING = 200_000;
  private static readonly BATCH = 5_000;
  readonly estado = { escritas: 0, ultimoOk: null as string | null, error: null as string | null };

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.url = (config.get<string>("INFLUX_URL") || "").replace(/\/$/, "");
    this.token = config.get<string>("INFLUX_TOKEN") || "";
    this.org = config.get<string>("INFLUX_ORG") || "";
    this.bucket = config.get<string>("INFLUX_BUCKET") || "";
    this.sede = config.get<string>("SEDE_CODIGO") || "";
  }

  get activo() {
    return Boolean(this.url && this.token && this.org && this.bucket);
  }

  onModuleInit() {
    if (!this.activo) return;
    this.log.log(`Copia en InfluxDB activa: ${this.url} org=${this.org} bucket=${this.bucket}`);
    this.timer = setInterval(() => void this.flush(), 5_000);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  /** Encola las lecturas que ya se guardaron en TimescaleDB. No espera a InfluxDB. */
  async enqueue(rows: ReadingRow[]) {
    if (!this.activo || !rows.length) return;
    try {
      const porPunto = new Map<string, ReadingRow[]>();
      for (const r of rows) {
        const k = `${r.deviceId}|${r.time.getTime()}`;
        (porPunto.get(k) ?? porPunto.set(k, []).get(k)!).push(r);
      }
      for (const grupo of porPunto.values()) {
        const { deviceId, time } = grupo[0];
        const t = await this.tagsDe(deviceId);
        const tagSet = [
          this.sede ? `sede=${esc(this.sede)}` : null,
          t.agente ? `agente=${esc(t.agente)}` : null,
          `equipo=${esc(t.equipo || deviceId)}`,
          `device_id=${esc(deviceId)}`,
        ].filter(Boolean).join(",");
        const fields = grupo.map((r) => `${esc(r.metric)}=${r.value}`).join(",");
        this.pending.push(`lectura,${tagSet} ${fields} ${time.getTime()}`);
      }
      if (this.pending.length > InfluxWriterService.MAX_PENDING) {
        const sobran = this.pending.length - InfluxWriterService.MAX_PENDING;
        this.pending.splice(0, sobran);
        this.estado.error = `InfluxDB atrasado: se descartaron ${sobran} lineas antiguas (TimescaleDB las tiene)`;
      }
    } catch (err) {
      this.log.warn(`No se pudo preparar la copia para InfluxDB: ${(err as Error).message}`);
    }
  }

  /** Lineas que esperan ser enviadas a InfluxDB. */
  get pendientes() {
    return this.pending.length;
  }

  private async tagsDe(deviceId: string): Promise<DeviceTags> {
    const c = this.tags.get(deviceId);
    if (c) return c;
    const d = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { name: true, metadata: true } });
    const meta = (d?.metadata as { agent?: { buildingKey?: string } } | null) ?? {};
    const t = { equipo: d?.name ?? "", agente: meta.agent?.buildingKey ?? "" };
    this.tags.set(deviceId, t);
    return t;
  }

  private async flush() {
    if (!this.activo || this.flushing || !this.pending.length) return;
    this.flushing = true;
    try {
      while (this.pending.length) {
        const lote = this.pending.slice(0, InfluxWriterService.BATCH);
        const q = new URLSearchParams({ org: this.org, bucket: this.bucket, precision: "ms" });
        const r = await fetch(`${this.url}/api/v2/write?${q}`, {
          method: "POST",
          headers: { Authorization: `Token ${this.token}`, "Content-Type": "text/plain; charset=utf-8" },
          body: lote.join("\n"),
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        this.pending.splice(0, lote.length);
        this.estado.escritas += lote.length;
        this.estado.ultimoOk = new Date().toISOString();
        this.estado.error = null;
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (this.estado.error !== msg) this.log.warn(`InfluxDB no recibio el lote (se reintenta): ${msg}`);
      this.estado.error = msg;
    } finally {
      this.flushing = false;
    }
  }
}

/** Escapa tags, claves de field y measurement del line protocol (coma, espacio, igual). */
function esc(s: string) {
  return s.replace(/[,= ]/g, (c) => `\\${c}`);
}
