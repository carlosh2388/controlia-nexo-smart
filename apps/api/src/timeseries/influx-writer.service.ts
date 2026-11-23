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

/** Un InfluxDB 2.x de destino: escribe por lotes cada 5 s y reintenta si no responde. */
class DestinoInflux {
  private pending: string[] = [];
  private flushing = false;
  private static readonly MAX_PENDING = 200_000;
  private static readonly BATCH = 5_000;
  readonly estado = { escritas: 0, ultimoOk: null as string | null, error: null as string | null };

  constructor(
    readonly nombre: string,
    private readonly url: string,
    private readonly token: string,
    private readonly org: string,
    private readonly bucket: string,
    private readonly log: Logger,
  ) {}

  get pendientes() {
    return this.pending.length;
  }

  agregar(lineas: string[]) {
    this.pending.push(...lineas);
    if (this.pending.length > DestinoInflux.MAX_PENDING) {
      const sobran = this.pending.length - DestinoInflux.MAX_PENDING;
      this.pending.splice(0, sobran);
      this.estado.error = `InfluxDB atrasado: se descartaron ${sobran} lineas antiguas (TimescaleDB las tiene)`;
    }
  }

  async flush() {
    if (this.flushing || !this.pending.length) return;
    this.flushing = true;
    try {
      while (this.pending.length) {
        const lote = this.pending.slice(0, DestinoInflux.BATCH);
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
      if (this.estado.error !== msg) this.log.warn(`InfluxDB ${this.nombre} no recibio el lote (se reintenta): ${msg}`);
      this.estado.error = msg;
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * Copia de cada lectura en InfluxDB 2.x, AL MISMO TIEMPO que se guarda en TimescaleDB (readings).
 * TimescaleDB sigue siendo la base principal: huecos, normas, comparacion y recuperacion salen de
 * ahi. InfluxDB es una copia para tableros externos (Grafana, etc.).
 *
 * Destinos:
 *  - principal: INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET.
 *  - comparativo (opcional): COMPARATIVO_INFLUX_URL, _TOKEN, _ORG, _BUCKET. Es el InfluxDB del
 *    comparativo TimescaleDB vs InfluxDB; recibe exactamente las mismas lineas.
 * Escribe por lotes cada 5 s (line protocol, precision ms). Si un InfluxDB no responde, guarda en
 * memoria hasta 200 000 lineas y reintenta; nunca frena ni hace fallar el guardado en TimescaleDB.
 *
 * Formato: measurement "lectura", tags sede/agente/equipo/device_id, un field por metrica.
 *   lectura,sede=igss-escuintla,agente=igss-escuintla-directo,equipo=ANALIZADOR-1,device_id=<uuid> voltage_a_n=127.1,... <ms>
 */
@Injectable()
export class InfluxWriterService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("InfluxWriter");
  private readonly sede: string;
  private readonly tags = new Map<string, DeviceTags>();
  private readonly principal: DestinoInflux | null;
  private readonly comparativo: DestinoInflux | null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.sede = config.get<string>("SEDE_CODIGO") || "";
    const destino = (nombre: string, prefijo: string) => {
      const url = (config.get<string>(`${prefijo}_URL`) || "").replace(/\/$/, "");
      const token = config.get<string>(`${prefijo}_TOKEN`) || "";
      const org = config.get<string>(`${prefijo}_ORG`) || "";
      const bucket = config.get<string>(`${prefijo}_BUCKET`) || "";
      return url && token && org && bucket ? new DestinoInflux(nombre, url, token, org, bucket, this.log) : null;
    };
    this.principal = destino("principal", "INFLUX");
    this.comparativo = destino("comparativo", "COMPARATIVO_INFLUX");
  }

  get activo() {
    return Boolean(this.principal);
  }

  /** Estado del destino principal (lo muestra /sede/salud). */
  get estado() {
    return this.principal?.estado ?? { escritas: 0, ultimoOk: null, error: null };
  }

  get pendientes() {
    return this.principal?.pendientes ?? 0;
  }

  /** Estado del InfluxDB del comparativo (null si no esta configurado). */
  get estadoComparativo() {
    return this.comparativo ? { ...this.comparativo.estado, pendientes: this.comparativo.pendientes } : null;
  }

  private get destinos() {
    return [this.principal, this.comparativo].filter((d): d is DestinoInflux => d !== null);
  }

  onModuleInit() {
    for (const d of this.destinos) this.log.log(`Copia en InfluxDB activa (${d.nombre})`);
    if (this.destinos.length) this.timer = setInterval(() => void Promise.all(this.destinos.map((d) => d.flush())), 5_000);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await Promise.all(this.destinos.map((d) => d.flush()));
  }

  /** Encola las lecturas que ya se guardaron en TimescaleDB. No espera a InfluxDB. */
  async enqueue(rows: ReadingRow[]) {
    if (!this.destinos.length || !rows.length) return;
    try {
      const porPunto = new Map<string, ReadingRow[]>();
      for (const r of rows) {
        const k = `${r.deviceId}|${r.time.getTime()}`;
        (porPunto.get(k) ?? porPunto.set(k, []).get(k)!).push(r);
      }
      const lineas: string[] = [];
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
        lineas.push(`lectura,${tagSet} ${fields} ${time.getTime()}`);
      }
      for (const d of this.destinos) d.agregar(lineas);
    } catch (err) {
      this.log.warn(`No se pudo preparar la copia para InfluxDB: ${(err as Error).message}`);
    }
  }

  /**
   * Lineas ya armadas (line protocol) para el InfluxDB de la sede: alarmas y correos de Gravix
   * (measurements "alarma" y "correo"). Viajan al InfluxDB central con la misma replica que las lecturas.
   */
  escribir(lineas: string[]) {
    if (this.principal && lineas.length) this.principal.agregar(lineas);
  }

  /** Ajusta la retencion del bucket principal (dias). La usa el Gravix de sede al arrancar (SEDE_RETENCION_DIAS). */
  async asegurarRetencion(dias: number) {
    const url = (this.config.get<string>("INFLUX_URL") || "").replace(/\/$/, "");
    const token = this.config.get<string>("INFLUX_TOKEN") || "";
    const org = this.config.get<string>("INFLUX_ORG") || "";
    const bucket = this.config.get<string>("INFLUX_BUCKET") || "";
    if (!url || !token || !org || !bucket) return null;
    const h = { Authorization: `Token ${token}`, "Content-Type": "application/json" };
    const r = await fetch(`${url}/api/v2/buckets?org=${encodeURIComponent(org)}&name=${encodeURIComponent(bucket)}`, { headers: h, signal: AbortSignal.timeout(5000) });
    const b = ((await r.json()) as { buckets?: { id: string; retentionRules?: { everySeconds: number }[] }[] }).buckets?.[0];
    if (!b) return null;
    const segundos = dias * 86400;
    if (b.retentionRules?.[0]?.everySeconds === segundos) return dias;
    const p = await fetch(`${url}/api/v2/buckets/${b.id}`, { method: "PATCH", headers: h, body: JSON.stringify({ retentionRules: [{ type: "expire", everySeconds: segundos }] }), signal: AbortSignal.timeout(5000) });
    if (!p.ok) throw new Error(`HTTP ${p.status}`);
    this.log.log(`Retencion del bucket ${bucket} ajustada a ${dias} dias`);
    return dias;
  }

  /** Estado de las replicas del InfluxDB de la sede hacia el central (cola en disco, ultimo envio). */
  async estadoReplicas() {
    const url = (this.config.get<string>("INFLUX_URL") || "").replace(/\/$/, "");
    const token = this.config.get<string>("INFLUX_TOKEN") || "";
    const org = this.config.get<string>("INFLUX_ORG") || "";
    if (!url || !token || !org) return null;
    try {
      const h = { Authorization: `Token ${token}` };
      const ro = await fetch(`${url}/api/v2/orgs?org=${encodeURIComponent(org)}`, { headers: h, signal: AbortSignal.timeout(5000) });
      const orgId = ((await ro.json()) as { orgs?: { id: string }[] }).orgs?.[0]?.id;
      if (!orgId) return null;
      const r = await fetch(`${url}/api/v2/replications?orgID=${orgId}`, { headers: h, signal: AbortSignal.timeout(5000) });
      const lista = ((await r.json()) as { replications?: Record<string, unknown>[] }).replications ?? [];
      return lista.map((x) => ({
        nombre: x.name,
        colaBytes: x.currentQueueSizeBytes,
        colaMaxBytes: x.maxQueueSizeBytes,
        ultimoCodigo: x.latestResponseCode ?? null,
        ultimoError: x.latestErrorMessage || null,
      }));
    } catch {
      return null;
    }
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
}

/** Escapa tags, claves de field y measurement del line protocol (coma, espacio, igual). */
export function esc(s: string) {
  return s.replace(/[,= ]/g, (c) => `\\${c}`);
}

/** Valor de field de texto en line protocol: entre comillas, escapando comillas y barras. */
export function texto(s: unknown) {
  return `"${String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}
