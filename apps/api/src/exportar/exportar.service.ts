import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { GravixService } from "../red/gravix.service";
import { PilotService } from "../timeseries/pilot.service";
import { buildXlsx, type XlsxCell, type XlsxSheet } from "../common/xlsx";
import type { ExportarHistorialDto } from "./exportar.dto";

/** Metricas del monitoreo central (Telemetria 1): promedio de kW, voltaje y corriente por intervalo. */
const EBO: Record<string, { col: "kw" | "v" | "a"; label: string }> = {
  "ebo:kw": { col: "kw", label: "Potencia (kW)" },
  "ebo:v": { col: "v", label: "Voltaje promedio (V)" },
  "ebo:a": { col: "a", label: "Corriente promedio (A)" },
};
const PASOS = [60, 300, 900, 3600, 86400];
const MAX_FILAS = 100_000;
const MAX_EQUIPOS = 40;
const MAX_METRICAS = 60;

type Filas = Map<number, Map<string, { v: number; q: string }>>;
interface Resultado {
  nombre: string;
  sede: string;
  origen: string;
  columnas: { key: string; label: string }[];
  filas: Filas;
  conCalidad: boolean;
  error: string | null;
  /** Espectro de armonicos (ION7400 leido directo), en su propia hoja. */
  armonicos?: { columnas: { key: string; label: string }[]; filas: Filas };
}

/** Columna de armonico: valor en V/A o % contra la fundamental (H1) de la misma señal y fase. */
interface ColArmonico {
  key: string;
  label: string;
  src: string;
  h1: string | null;
}

/** Arma las columnas de armonicos pedidas (señales v/i, fases a/b/c, ordenes 1..63). */
function columnasArmonicos(senales: string, fases: string, ordenes: string, modo: "pct" | "valor" | "ambos"): ColArmonico[] {
  const ss = senales.split(",").map((x) => x.trim()).filter((x) => x === "v" || x === "i");
  const ff = fases.split(",").map((x) => x.trim()).filter((x) => x === "a" || x === "b" || x === "c");
  const nn = new Set<number>();
  for (const parte of ordenes.split(",")) {
    const m = /^\s*(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*$/.exec(parte);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = Math.max(1, Math.min(a, b)); n <= Math.min(63, Math.max(a, b)); n++) nn.add(n);
  }
  const out: ColArmonico[] = [];
  for (const s of ss)
    for (const f of ff)
      for (const n of [...nn].sort((x, y) => x - y)) {
        const src = `harm_${s}_${f}_${String(n).padStart(2, "0")}`;
        const base = `${s === "v" ? "Voltaje" : "Corriente"} ${f.toUpperCase()} · H${n}`;
        if (modo !== "pct") out.push({ key: src, label: `${base} (${s === "v" ? "V" : "A"})`, src, h1: null });
        if (modo !== "valor") out.push({ key: `${src}%`, label: `${base} (% de H1)`, src, h1: `harm_${s}_${f}_01` });
      }
  return out;
}

/**
 * Exportacion del historial de varias sedes y equipos a un solo Excel, por rango de fechas.
 *  - Equipos de Agente Go en este servidor: se leen de su TimescaleDB.
 *  - Equipos de un Gravix de sede: se piden a la sede (GET /pilot/devices/:id/historial).
 *  - Medidores de Telemetria 1: de la foto por minuto del monitoreo central (centro_lecturas).
 * Una hoja por equipo, una hoja "Comparativo" con todo alineado por fecha, "Resumen" e "Información".
 */
@Injectable()
export class ExportarService {
  private readonly log = new Logger("ExportarService");

  constructor(
    private readonly prisma: PrismaService,
    private readonly gravix: GravixService,
    private readonly pilot: PilotService,
  ) {}

  async historial(q: ExportarHistorialDto, usuario: string) {
    const desde = new Date(q.desde);
    const hasta = new Date(q.hasta);
    if (!(hasta > desde)) throw new BadRequestException("La fecha final debe ser mayor que la inicial");
    const rangoS = (hasta.getTime() - desde.getTime()) / 1000;
    if (rangoS > 400 * 86400) throw new BadRequestException("El rango máximo es de 400 días");

    const equipos = q.equipos.split(",").map((e) => e.trim()).filter(Boolean);
    if (!equipos.length) throw new BadRequestException("Elija al menos un equipo");
    if (equipos.length > MAX_EQUIPOS) throw new BadRequestException(`Máximo ${MAX_EQUIPOS} equipos por archivo`);
    const metricas = (q.metricas ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    const armCols = q.armSenales && q.armFases && q.armOrdenes ? columnasArmonicos(q.armSenales, q.armFases, q.armOrdenes, q.armModo ?? "pct") : [];
    if (!metricas.length && !armCols.length) throw new BadRequestException("Elija al menos una métrica o los armónicos");
    if (metricas.length > MAX_METRICAS) throw new BadRequestException(`Máximo ${MAX_METRICAS} métricas por archivo`);
    const etiquetas = (q.etiquetas ?? "").split("|");
    const etiqueta = (m: string) => etiquetas[metricas.indexOf(m)] || EBO[m]?.label || m;
    const nombres = (q.nombres ?? "").split("|");
    const sedes = (q.sedes ?? "").split("|");

    // Si el rango es grande, un dato cada mas tiempo (maximo MAX_FILAS filas por hoja).
    let step = q.step;
    while (rangoS / step > MAX_FILAS && step < 86400) step = PASOS[PASOS.indexOf(step) + 1] ?? 86400;

    const deAgente = metricas.filter((m) => !EBO[m]);
    const deEbo = metricas.filter((m) => EBO[m]);
    const resultados: Resultado[] = [];
    for (let i = 0; i < equipos.length; i++) {
      const ref = equipos[i];
      const base = { nombre: nombres[i] || ref, sede: sedes[i] || "" };
      try {
        if (ref.startsWith("p:")) resultados.push(await this.deAgente(ref.slice(2), deAgente, armCols, desde, hasta, step, base, etiqueta));
        else if (ref.startsWith("c:")) {
          // Telemetria 1 solo tiene kW, V y A: si solo se pidieron armonicos, no aplica.
          if (!deEbo.length && !deAgente.length) resultados.push({ ...base, origen: "Monitoreo central (EBO → api-SIASA)", columnas: [], filas: new Map(), conCalidad: false, error: "El monitoreo central no tiene armónicos (solo los ION7400 leídos directo)" });
          else resultados.push(await this.deCentral(ref.slice(2), deEbo.length ? deEbo : Object.keys(EBO), desde, hasta, step, base));
        }
        else resultados.push({ ...base, origen: "—", columnas: [], filas: new Map(), conCalidad: false, error: "Referencia de equipo no válida" });
      } catch (e) {
        resultados.push({ ...base, origen: "—", columnas: [], filas: new Map(), conCalidad: false, error: (e as Error).message });
      }
    }

    const hojas: XlsxSheet[] = [];
    const usados = new Set<string>(["Resumen", "Comparativo", "Información"]);
    const nombreHoja = (s: string) => {
      const limpio = s.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 28) || "Equipo";
      let n = limpio;
      for (let k = 2; usados.has(n); k++) n = `${limpio.slice(0, 26)} ${k}`;
      usados.add(n);
      return n;
    };

    // Resumen
    const resumen: XlsxCell[][] = [["Sede", "Equipo", "Origen de los datos", "Métricas", "Filas", "Primer dato", "Último dato", "Espectros de armónicos", "Observación"]];
    for (const r of resultados) {
      const ts = [...r.filas.keys()].sort((a, b) => a - b);
      const nArm = r.armonicos?.filas.size ?? 0;
      const obs = r.error
        ?? (r.columnas.length === 0 && !nArm
          ? armCols.length && !metricas.length ? "Este equipo no tiene armónicos guardados en el rango (solo ION7400 leídos directo)" : "Ninguna de las métricas elegidas aplica a este equipo"
          : ts.length || nArm ? "" : "Sin datos en el rango (la sede guarda 60 días de detalle)");
      resumen.push([
        r.sede, r.nombre, r.origen, r.columnas.map((c) => c.label).join(", ") || "—", ts.length,
        ts.length ? new Date(ts[0]) : null, ts.length ? new Date(ts[ts.length - 1]) : null,
        armCols.length ? nArm : "—", obs,
      ]);
    }
    hojas.push({ name: "Resumen", rows: resumen, widths: [18, 30, 28, 46, 9, 18, 18, 14, 46] });

    // Una hoja por equipo
    for (const r of resultados) {
      if (!r.columnas.length) continue;
      const head: XlsxCell[] = ["Fecha y hora (Guatemala)", ...r.columnas.map((c) => c.label)];
      if (r.conCalidad) head.push("Calidad");
      const filas: XlsxCell[][] = [head];
      for (const t of [...r.filas.keys()].sort((a, b) => a - b)) {
        const vals = r.filas.get(t)!;
        let calidad = "real";
        const fila: XlsxCell[] = [new Date(t)];
        for (const c of r.columnas) {
          const x = vals.get(c.key);
          fila.push(x ? x.v : null);
          if (x && x.q !== "real") calidad = x.q;
        }
        if (r.conCalidad) fila.push(calidad);
        filas.push(fila);
      }
      hojas.push({ name: nombreHoja(`${r.sede ? `${r.sede} ` : ""}${r.nombre}`), rows: filas, widths: [22, ...r.columnas.map(() => 18), 11] });
    }

    // Armonicos: una hoja por ION7400 (solo las horas en que el equipo guardo su espectro)
    for (const r of resultados) {
      const a = r.armonicos;
      if (!a || !a.filas.size || !a.columnas.length) continue;
      const filas: XlsxCell[][] = [["Fecha y hora (Guatemala)", ...a.columnas.map((c) => c.label)]];
      for (const t of [...a.filas.keys()].sort((x, y) => x - y)) {
        const vals = a.filas.get(t)!;
        filas.push([new Date(t), ...a.columnas.map((c) => vals.get(c.key)?.v ?? null)]);
      }
      hojas.push({ name: nombreHoja(`Armónicos ${r.nombre}`), rows: filas, widths: [22, ...a.columnas.map(() => 22)] });
    }

    // Comparativo: todos los equipos y metricas en columnas, alineados por fecha
    const conDatos = resultados.filter((r) => r.columnas.length && r.filas.size);
    const totalCols = conDatos.reduce((n, r) => n + r.columnas.length, 0);
    const tiempos = [...new Set(conDatos.flatMap((r) => [...r.filas.keys()]))].sort((a, b) => a - b);
    if (conDatos.length > 1 && totalCols <= 250 && tiempos.length <= MAX_FILAS) {
      const head: XlsxCell[] = ["Fecha y hora (Guatemala)"];
      for (const r of conDatos) for (const c of r.columnas) head.push(`${r.sede ? `${r.sede} · ` : ""}${r.nombre} · ${c.label}`);
      const filas: XlsxCell[][] = [head];
      for (const t of tiempos) {
        const fila: XlsxCell[] = [new Date(t)];
        for (const r of conDatos) for (const c of r.columnas) fila.push(r.filas.get(t)?.get(c.key)?.v ?? null);
        filas.push(fila);
      }
      hojas.splice(1, 0, { name: "Comparativo", rows: filas, widths: [22, ...head.slice(1).map(() => 24)] });
    }

    hojas.push({
      name: "Información",
      rows: [
        ["Dato", "Valor"],
        ["Desde", desde],
        ["Hasta", hasta],
        ["Un dato cada", step >= 3600 ? `${step / 3600} h (promedio)` : `${step / 60} min (promedio)`],
        ...(step !== q.step ? [["Nota", `El intervalo pedido daba más de ${MAX_FILAS.toLocaleString("es-GT")} filas; se usó un dato cada ${step / 60} min`] as XlsxCell[]] : []),
        ["Equipos", resultados.length],
        ["Calidad", "real = leído del equipo; recuperada = de la memoria del equipo; estimada = calculada"],
        ...(armCols.length
          ? [["Armónicos", "El ION7400 leído directo guarda su espectro (H1 a H63) cada 10 min; % de H1 = valor del armónico / fundamental × 100, como en la página del ION"] as XlsxCell[]]
          : []),
        ["Retención", "Cada sede Gravix guarda 60 días de detalle; lo anterior está en el InfluxDB central"],
        ["Generado por", usuario],
        ["Generado", new Date()],
      ],
      widths: [22, 90],
    });

    const fecha = (d: Date) => d.toISOString().slice(0, 10);
    const archivo = `historial_${fecha(desde)}_a_${fecha(hasta)}.xlsx`;
    this.log.log(`exportacion de ${usuario}: ${resultados.length} equipos, ${metricas.length} métricas, ${fecha(desde)} a ${fecha(hasta)}, paso ${step} s`);
    return { buf: buildXlsx(hojas), archivo };
  }

  /** Equipo de Agente Go: local o, si vive en un Gravix de sede, pedido a la sede. */
  private async deAgente(id: string, metricas: string[], armCols: ColArmonico[], desde: Date, hasta: Date, step: number, base: { nombre: string; sede: string }, etiqueta: (m: string) => string): Promise<Resultado> {
    type Resp = { device: { name: string }; rows: { t: string; m: string; v: number; q: string }[] };
    const sedeGravix = this.gravix.sedeDeEquipo(id);
    let data: Resp;
    // Claves de armonicos a pedir: las elegidas y la fundamental (H1) de cada una para el %.
    const armClaves = [...new Set(armCols.flatMap((c) => (c.h1 ? [c.src, c.h1] : [c.src])))];
    const pedir = [...metricas, ...armClaves];
    if (!pedir.length) return { ...base, origen: sedeGravix ? `Gravix de sede (${sedeGravix})` : "Agente Go en este servidor", columnas: [], filas: new Map(), conCalidad: true, error: null };
    if (sedeGravix) {
      const qs = new URLSearchParams({ metrics: pedir.join(","), desde: desde.toISOString(), hasta: hasta.toISOString(), step: String(step) });
      const r = await this.gravix.reenviar(sedeGravix, `/api/v1/pilot/devices/${encodeURIComponent(id)}/historial?${qs}`);
      if (r.status >= 400) {
        let msg = `La sede respondió HTTP ${r.status}`;
        try {
          const j = JSON.parse(r.body.toString("utf8")) as { message?: string | string[] };
          if (j.message) msg = Array.isArray(j.message) ? j.message.join("; ") : j.message;
        } catch {
          /* mensaje generico */
        }
        if (r.status === 404 && /Cannot GET/i.test(msg)) msg = "El Gravix de la sede todavía no tiene la exportación por rango (actualice su versión)";
        throw new Error(msg);
      }
      data = JSON.parse(r.body.toString("utf8")) as Resp;
    } else {
      data = await this.pilot.historialRango(id, pedir, desde, hasta, step);
    }
    const filas: Filas = new Map();
    const espectro = new Map<number, Map<string, number>>();
    const presentes = new Set<string>();
    for (const row of data.rows) {
      const t = new Date(row.t).getTime();
      if (row.m.startsWith("harm_")) {
        if (!espectro.has(t)) espectro.set(t, new Map());
        espectro.get(t)!.set(row.m, row.v);
        continue;
      }
      if (!filas.has(t)) filas.set(t, new Map());
      filas.get(t)!.set(row.m, { v: row.v, q: row.q });
      presentes.add(row.m);
    }
    // Solo las metricas que el equipo tiene (un generador no tiene armonicos, por ejemplo).
    const columnas = metricas.filter((m) => presentes.has(m)).map((m) => ({ key: m, label: etiqueta(m) }));

    // Armonicos: valor tal cual o % contra la fundamental del mismo instante.
    let armonicos: Resultado["armonicos"];
    if (armCols.length && espectro.size) {
      const tiene = new Set([...espectro.values()].flatMap((m) => [...m.keys()]));
      const cols = armCols.filter((c) => tiene.has(c.src));
      const af: Filas = new Map();
      for (const [t, m] of espectro) {
        const fila = new Map<string, { v: number; q: string }>();
        for (const c of cols) {
          const v = m.get(c.src);
          if (v == null) continue;
          if (!c.h1) fila.set(c.key, { v, q: "real" });
          else {
            const h1 = m.get(c.h1);
            if (h1 && h1 > 0) fila.set(c.key, { v: Math.round((v / h1) * 100_000) / 1000, q: "real" });
          }
        }
        af.set(t, fila);
      }
      armonicos = { columnas: cols.map((c) => ({ key: c.key, label: c.label })), filas: af };
    }
    return {
      ...base,
      nombre: base.nombre || data.device.name,
      origen: sedeGravix ? `Gravix de sede (${sedeGravix})` : "Agente Go en este servidor",
      columnas: columnas.length ? columnas : metricas.map((m) => ({ key: m, label: etiqueta(m) })),
      filas,
      conCalidad: true,
      error: null,
      armonicos,
    };
  }

  /** Medidor de Telemetria 1: foto por minuto del monitoreo central. ref = "<sede>:<medidor>". */
  private async deCentral(ref: string, metricas: string[], desde: Date, hasta: Date, step: number, base: { nombre: string; sede: string }): Promise<Resultado> {
    const i = ref.indexOf(":");
    const sede = ref.slice(0, i);
    const medidor = ref.slice(i + 1);
    if (i < 1 || !medidor) throw new Error("Referencia de medidor no válida");
    const rows = await this.prisma.$queryRaw<{ t: Date; kw: number | null; v: number | null; a: number | null }[]>`
      SELECT time_bucket(make_interval(secs => ${step}::int), "time") AS t,
             avg(kw)::float AS kw, avg("vProm")::float AS v, avg("aProm")::float AS a
      FROM centro_lecturas
      WHERE sede = ${sede} AND medidor = ${medidor} AND "time" >= ${desde} AND "time" < ${hasta}
      GROUP BY t ORDER BY t`;
    const filas = new Map<number, Map<string, { v: number; q: string }>>();
    for (const r of rows) {
      const m = new Map<string, { v: number; q: string }>();
      for (const k of metricas) {
        const v = r[EBO[k].col];
        if (typeof v === "number") m.set(k, { v: Math.round(v * 1000) / 1000, q: "real" });
      }
      filas.set(r.t.getTime(), m);
    }
    return { ...base, origen: "Monitoreo central (EBO → api-SIASA)", columnas: metricas.map((k) => ({ key: k, label: EBO[k].label })), filas, conCalidad: false, error: null };
  }
}
