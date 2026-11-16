import { useMemo, useState } from "react";
import InteractiveChart, { type ChartSeries } from "../charts/InteractiveChart";
import { usePilotSeries, usePilotSpectrum, type PilotDevice } from "../../api/pilot";

/**
 * Armonicos del ION7400 (lectura directa, agente 0.5.4+):
 *  - Espectro: los 63 armonicos de V1-V3 e I1-I3 en % de la fundamental (H1), como la pagina web del
 *    ION. El agente lo lee cada 10 min (registros 22878/23266/23654 voltaje, 24430/24818/25206
 *    corriente; ver apps/Agente_Go/internal/discovery/modbussource/harmonics.go).
 *  - THD en el tiempo: THD total por fase (registros 21300/21330), cada 30 s.
 * Limites de referencia: NTSD en apps/api/src/timeseries/normas.ts (THD V 8 %, THD I 20 %).
 */

export const LIM_THD_V = 8;
export const LIM_THD_I = 20;
const FASES = ["A", "B", "C"] as const;
const COL = ["#e5484d", "#f5b400", "#4c8dff"];
const KEYS = {
  v: ["thd_voltage_v1_high", "thd_voltage_v2_high", "thd_voltage_v3_high"],
  i: ["thd_current_a_high", "thd_current_b_high", "thd_current_c_high"],
} as const;

export const CANALES: { k: string; t: string; unidad: string }[] = [
  { k: "v_a", t: "V1", unidad: "V" },
  { k: "v_b", t: "V2", unidad: "V" },
  { k: "v_c", t: "V3", unidad: "V" },
  { k: "i_a", t: "I1", unidad: "A" },
  { k: "i_b", t: "I2", unidad: "A" },
  { k: "i_c", t: "I3", unidad: "A" },
];
const hk = (ch: string, n: number) => `harm_${ch}_${String(n).padStart(2, "0")}`;

export interface Espectro {
  h1: number | null;
  /** [orden, % de H1, valor en V/A] de H2 a H63. */
  barras: [number, number, number][];
  thd: number | null;
  par: number | null;
  impar: number | null;
}

export function espectroDe(values: Record<string, unknown>, ch: string): Espectro {
  const g = (n: number) => (typeof values[hk(ch, n)] === "number" ? (values[hk(ch, n)] as number) : null);
  const h1 = g(1);
  const barras: [number, number, number][] = [];
  let sp = 0, si = 0;
  for (let n = 2; n <= 63; n++) {
    const v = g(n);
    if (v == null || !h1) continue;
    const pct = (v / h1) * 100;
    barras.push([n, pct, v]);
    if (n % 2 === 0) sp += pct * pct;
    else si += pct * pct;
  }
  if (!h1 || !barras.length) return { h1, barras, thd: null, par: null, impar: null };
  return { h1, barras, thd: Math.sqrt(sp + si), par: Math.sqrt(sp), impar: Math.sqrt(si) };
}

const val = (d: PilotDevice, k: string) => (typeof d.readings[k] === "number" && Number.isFinite(d.readings[k]) ? (d.readings[k] as number) : null);

/* ---------------- pantallas del ION (fondo blanco del equipo) ---------------- */

/** Barras de THD por fase. */
export function ArmonicosPantalla({ r }: { r: Record<string, unknown> }) {
  const g = (k: string) => (typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : null);
  const grupos: { t: string; keys: readonly string[]; lim: number; max: number }[] = [
    { t: "THD V %", keys: KEYS.v, lim: LIM_THD_V, max: 12 },
    { t: "THD I %", keys: KEYS.i, lim: LIM_THD_I, max: 30 },
  ];
  const W = 220, H = 92, top = 12, base = 74, bw = 16;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Armónicos: THD de voltaje y corriente por fase">
      {grupos.map((gr, gi) => {
        const x0 = 10 + gi * 110;
        const y = (v: number) => base - (Math.min(v, gr.max) / gr.max) * (base - top);
        return (
          <g key={gr.t}>
            <text x={x0 + 45} y={9} textAnchor="middle" fontSize="8" fontWeight="700" fill="#24324a">{gr.t}</text>
            <line x1={x0} x2={x0 + 92} y1={base} y2={base} stroke="#8a97ab" strokeWidth="0.8" />
            <line x1={x0} x2={x0 + 92} y1={y(gr.lim)} y2={y(gr.lim)} stroke="#d23b2f" strokeWidth="0.8" strokeDasharray="3 2" />
            <text x={x0 + 92} y={y(gr.lim) - 2} textAnchor="end" fontSize="6" fill="#d23b2f">lím. {gr.lim}</text>
            {gr.keys.map((k, i) => {
              const v = g(k);
              const x = x0 + 8 + i * 28;
              const alto = v == null ? 0 : base - y(v);
              return (
                <g key={k}>
                  <rect x={x} y={base - alto} width={bw} height={alto} rx="1.5" fill={v != null && v > gr.lim ? "#d23b2f" : COL[i]} />
                  <text x={x + bw / 2} y={base - alto - 2} textAnchor="middle" fontSize="7" fontWeight="700" fill="#1c2638">{v == null ? "--" : v.toFixed(1)}</text>
                  <text x={x + bw / 2} y={base + 9} textAnchor="middle" fontSize="7" fill="#4a5870">{FASES[i]}</text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

/** Espectro de V1 (H2-H31) en la pantalla del equipo. */
export function EspectroPantalla({ r, canal = "v_a" }: { r: Record<string, unknown>; canal?: string }) {
  const e = espectroDe(r, canal);
  const W = 220, H = 96, l = 14, base = 80, top = 14;
  const bars = e.barras.filter(([n]) => n <= 31);
  const max = Math.max(2, ...bars.map(([, p]) => p)) * 1.15;
  const bw = (W - l - 4) / 30;
  if (!bars.length) return <div style={{ fontSize: 10, color: "#4a5870", padding: 8 }}>Sin espectro todavía: el agente lo lee cada 10 minutos (lectura directa).</div>;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Espectro de armónicos ${CANALES.find((c) => c.k === canal)?.t}`}>
      <text x={l} y={9} fontSize="8" fontWeight="700" fill="#24324a">{CANALES.find((c) => c.k === canal)?.t} · THD {e.thd?.toFixed(1)} % · par {e.par?.toFixed(1)} · impar {e.impar?.toFixed(1)}</text>
      <line x1={l} x2={W - 2} y1={base} y2={base} stroke="#8a97ab" strokeWidth="0.8" />
      {bars.map(([n, p]) => {
        const h = (p / max) * (base - top);
        const x = l + (n - 2) * bw;
        return <rect key={n} x={x + 0.6} y={base - h} width={Math.max(1, bw - 1.2)} height={h} fill={n % 2 ? "#2aa7e0" : "#e0a400"} />;
      })}
      {[3, 5, 7, 9, 11, 13, 15, 21, 25, 31].map((n) => (
        <text key={n} x={l + (n - 2) * bw + bw / 2} y={base + 8} textAnchor="middle" fontSize="6" fill="#4a5870">{n}</text>
      ))}
      <text x={2} y={top + 4} fontSize="6" fill="#4a5870">{max.toFixed(0)}%</text>
    </svg>
  );
}

/* ---------------- grafica grande del espectro ---------------- */

function EspectroChart({ e, unidad, sel, onSel }: { e: Espectro; unidad: string; sel: number | null; onSel: (n: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 760, H = 260, l = 40, r = 10, top = 14, base = 226;
  const max = Math.max(1, ...e.barras.map(([, p]) => p)) * 1.12;
  const paso = max > 20 ? 5 : max > 8 ? 2 : max > 4 ? 1 : 0.5;
  // Algunos ION7400 miden solo hasta el 31 (ej. ANALIZADOR-5): el eje llega al ultimo que hay.
  const nMax = Math.max(31, ...e.barras.map(([n]) => n));
  const bw = (W - l - r) / nMax;
  const y = (p: number) => base - (p / max) * (base - top);
  const hb = e.barras.find(([n]) => n === hover);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Espectro de armónicos en % de la fundamental" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: Math.floor(max / paso) + 1 }, (_, i) => i * paso).map((g) => (
          <g key={g}>
            <line x1={l} x2={W - r} y1={y(g)} y2={y(g)} stroke="#1e293b" strokeWidth="1" />
            <text x={l - 6} y={y(g) + 3} textAnchor="end" fontSize="10" fill="#94a3b8">{g}</text>
          </g>
        ))}
        <text x={10} y={(top + base) / 2} fontSize="10" fill="#94a3b8" transform={`rotate(-90 10 ${(top + base) / 2})`} textAnchor="middle">% de la fundamental</text>
        {e.barras.map(([n, p]) => {
          const x = l + (n - 1) * bw;
          const activo = n === sel || n === hover;
          return (
            <g key={n} onMouseEnter={() => setHover(n)} onClick={() => onSel(n)} style={{ cursor: "pointer" }}>
              <rect x={x} y={top} width={bw} height={base - top} fill={activo ? "#1e3a5f55" : "transparent"} />
              <rect x={x + bw * 0.15} y={y(p)} width={bw * 0.7} height={Math.max(0.5, base - y(p))} rx="1" fill={n % 2 ? "#38bdf8" : "#f59e0b"} stroke={n === sel ? "#fff" : "none"} strokeWidth="1" />
            </g>
          );
        })}
        <line x1={l} x2={W - r} y1={base} y2={base} stroke="#64748b" />
        {Array.from({ length: Math.ceil(nMax / 2) }, (_, i) => 1 + i * 2).map((n) => (
          <text key={n} x={l + (n - 1) * bw + bw / 2} y={base + 14} textAnchor="middle" fontSize="9" fill="#94a3b8">{n}</text>
        ))}
        <text x={(l + W) / 2} y={H - 4} textAnchor="middle" fontSize="10" fill="#94a3b8">Orden del armónico</text>
      </svg>
      {hb && (
        <div className="pointer-events-none absolute rounded-lg border border-slate-700 bg-slate-950/95 px-2.5 py-1.5 text-xs text-slate-100 shadow-lg" style={{ left: `${((l + (hb[0] - 1) * bw) / W) * 100}%`, top: 4, transform: hb[0] > nMax * 0.6 ? "translateX(-100%)" : "translateX(12px)" }}>
          <b>H{hb[0]}</b> ({hb[0] % 2 ? "impar" : "par"}) · <b>{hb[1].toFixed(2)} %</b> · {hb[2].toFixed(3)} {unidad}
          <br />
          <span className="text-slate-400">Clic para ver su tendencia</span>
        </div>
      )}
    </div>
  );
}

const RANGOS: [number, string][] = [[60, "1 h"], [1440, "24 h"], [10080, "7 días"]];
const btn = (on: boolean) => `min-h-[34px] rounded-lg px-3 text-[13px] font-bold ${on ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`;

/** Tendencia de un armonico en % de la fundamental (cada espectro guardado = un punto cada 10 min). */
function TendenciaArmonico({ deviceId, canal, orden }: { deviceId: string; canal: string; orden: number }) {
  const [min, setMin] = useState(1440);
  const hn = usePilotSeries(deviceId, hk(canal, orden), min);
  const h1 = usePilotSeries(deviceId, hk(canal, 1), min);
  const puntos = useMemo(() => {
    const base = new Map((h1.data?.points ?? []).map((p) => [p.t, p.v]));
    return (hn.data?.points ?? []).map((p) => {
      const f = base.get(p.t);
      return { t: new Date(p.t).getTime(), v: f && p.v != null ? (p.v / f) * 100 : null };
    });
  }, [hn.data, h1.data]);
  const c = CANALES.find((x) => x.k === canal)!;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b className="text-sm text-slate-100">Tendencia de H{orden} en {c.t} (% de la fundamental)</b>
        <div role="tablist" aria-label="Periodo" className="flex gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
          {RANGOS.map(([m, t]) => <button key={m} type="button" role="tab" aria-selected={min === m} className={btn(min === m)} onClick={() => setMin(m)}>{t}</button>)}
        </div>
      </div>
      <InteractiveChart height={200} unit="%" dec={2} series={[{ name: `H${orden} ${c.t}`, color: orden % 2 ? "#38bdf8" : "#f59e0b", points: puntos }]} emptyText={hn.isLoading ? "Cargando…" : "Todavía no hay espectros guardados en este periodo."} />
    </div>
  );
}

function VistaEspectro({ device }: { device: PilotDevice }) {
  const [canal, setCanal] = useState("v_a");
  const [momento, setMomento] = useState<string>("");
  const [orden, setOrden] = useState<number | null>(null);
  const at = momento ? new Date(momento).toISOString() : null;
  const q = usePilotSpectrum(device.id, at);
  const e = espectroDe(q.data?.values ?? {}, canal);
  const c = CANALES.find((x) => x.k === canal)!;
  const top = [...e.barras].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const campo = "min-h-[34px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div role="tablist" aria-label="Canal" className="flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
          {CANALES.map((x) => <button key={x.k} type="button" role="tab" aria-selected={canal === x.k} className={btn(canal === x.k)} onClick={() => setCanal(x.k)}>{x.t}</button>)}
        </div>
        {([["THD", e.thd], ["THD par", e.par], ["THD impar", e.impar]] as [string, number | null][]).map(([t, v]) => (
          <div key={t} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-1.5">
            <span className="block text-[11px] text-slate-400">{t}</span>
            <b className="mono text-base text-slate-100">{v == null ? "—" : `${v.toFixed(1)} %`}</b>
          </div>
        ))}
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-1.5">
          <span className="block text-[11px] text-slate-400">Fundamental (H1)</span>
          <b className="mono text-base text-slate-100">{e.h1 == null ? "—" : `${e.h1.toFixed(1)} ${c.unidad}`}</b>
        </div>
        <label className="ml-auto flex flex-col gap-1 text-xs text-slate-400">
          Momento
          <span className="flex gap-1">
            <input type="datetime-local" value={momento} onChange={(ev) => setMomento(ev.target.value)} className={campo} aria-label="Ver el espectro de una fecha y hora" />
            {momento && <button type="button" className={`${campo} font-bold text-sky-300`} onClick={() => setMomento("")}>Último</button>}
          </span>
        </label>
      </div>
      {q.isLoading ? (
        <p className="py-8 text-center text-sm text-slate-500">Cargando espectro…</p>
      ) : !e.barras.length ? (
        <p className="rounded-lg border border-slate-800 p-4 text-sm text-slate-400">
          {momento ? "No hay un espectro guardado antes de ese momento (se guardan desde que el agente 0.5.4 empezó a leerlos)." : "Todavía no hay espectro de este equipo: el agente 0.5.4 lo lee cada 10 minutos por lectura directa. Si el equipo se acaba de agregar, espere unos minutos."}
        </p>
      ) : (
        <>
          <EspectroChart e={e} unidad={c.unidad} sel={orden} onSel={setOrden} />
          <p className="text-xs text-slate-400">
            Espectro leído el <b className="text-slate-200">{q.data?.readAt ? new Date(q.data.readAt).toLocaleString("es-GT") : "—"}</b> · azul = impares, ámbar = pares · Mayores: {top.map(([n, p]) => `H${n} ${p.toFixed(2)} %`).join(", ")}
          </p>
          {orden != null && <TendenciaArmonico deviceId={device.id} canal={canal} orden={orden} />}
        </>
      )}
    </div>
  );
}

/* ---------------- THD en el tiempo ---------------- */

function VistaThd({ src }: { src: PilotDevice }) {
  const [tipo, setTipo] = useState<"v" | "i">("v");
  const [min, setMin] = useState(1440);
  const keys = KEYS[tipo];
  const lim = tipo === "v" ? LIM_THD_V : LIM_THD_I;
  const s0 = usePilotSeries(src.id, keys[0], min);
  const s1 = usePilotSeries(src.id, keys[1], min);
  const s2 = usePilotSeries(src.id, keys[2], min);
  const series: ChartSeries[] = [s0, s1, s2].map((q, i) => ({
    name: `${tipo === "v" ? "THD voltaje" : "THD corriente"} fase ${FASES[i]}`,
    color: COL[i],
    points: (q.data?.points ?? []).map((p) => ({ t: new Date(p.t).getTime(), v: p.v })),
  }));
  const cargando = s0.isLoading || s1.isLoading || s2.isLoading;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
        {(["v", "i"] as const).map((t) => {
          const l = t === "v" ? LIM_THD_V : LIM_THD_I;
          const max = t === "v" ? 12 : 30;
          return (
            <div key={t} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <b className="text-sm text-slate-100">{t === "v" ? "Voltaje" : "Corriente"} · ahora</b>
              <div className="mt-2 flex flex-col gap-2">
                {KEYS[t].map((k, i) => {
                  const v = val(src, k);
                  const malo = v != null && v > l;
                  return (
                    <div key={k} className="grid grid-cols-[52px_1fr_64px] items-center gap-2 text-sm">
                      <span className="text-slate-400">Fase {FASES[i]}</span>
                      <span className="relative h-3 overflow-hidden rounded bg-slate-800">
                        <span className="absolute inset-y-0 left-0 rounded transition-[width] duration-500" style={{ width: `${v == null ? 0 : Math.min(100, (v / max) * 100)}%`, background: malo ? "#ef4444" : COL[i] }} />
                        <span className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${(l / max) * 100}%` }} title={`Límite ${l} %`} />
                      </span>
                      <b className={`mono text-right ${malo ? "text-rose-300" : "text-slate-100"}`}>{v == null ? "—" : `${v.toFixed(2)} %`}</b>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Voltaje o corriente" className="flex gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
          <button type="button" role="tab" aria-selected={tipo === "v"} className={btn(tipo === "v")} onClick={() => setTipo("v")}>THD voltaje</button>
          <button type="button" role="tab" aria-selected={tipo === "i"} className={btn(tipo === "i")} onClick={() => setTipo("i")}>THD corriente</button>
        </div>
        <div role="tablist" aria-label="Periodo" className="flex gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
          {RANGOS.map(([m, t]) => <button key={m} type="button" role="tab" aria-selected={min === m} className={btn(min === m)} onClick={() => setMin(m)}>{t}</button>)}
        </div>
      </div>
      <InteractiveChart height={240} unit="%" dec={2} series={series} threshold={{ value: lim, label: `Límite NTSD ${lim} %` }} emptyText={cargando ? "Cargando historial…" : "Todavía no hay lecturas de THD guardadas en este periodo."} />
    </div>
  );
}

/** Panel completo de armonicos de un ION7400: espectro + THD en el tiempo. */
export function ArmonicosPanel({ device, direct }: { device: PilotDevice; direct?: PilotDevice | null }) {
  const src = direct ?? device;
  const [vista, setVista] = useState<"espectro" | "thd">(direct ? "espectro" : "thd");
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4" aria-label="Armónicos">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="eyebrow">Armónicos</span>
          <span className="text-xs text-slate-400">
            {direct ? "Lectura directa del ION7400 (Gravix)" : "Lectura por el AS-P: sin espectro y con el THD de corriente de la fase A en 0"} · límite de referencia NTSD: voltaje {LIM_THD_V} %, corriente {LIM_THD_I} %
          </span>
        </div>
        <div role="tablist" aria-label="Vista de armónicos" className="flex gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
          <button type="button" role="tab" aria-selected={vista === "espectro"} className={btn(vista === "espectro")} onClick={() => setVista("espectro")}>Espectro</button>
          <button type="button" role="tab" aria-selected={vista === "thd"} className={btn(vista === "thd")} onClick={() => setVista("thd")}>THD en el tiempo</button>
        </div>
      </div>
      {vista === "espectro" ? (direct ? <VistaEspectro device={direct} /> : <p className="rounded-lg border border-slate-800 p-4 text-sm text-slate-400">El espectro solo existe en los ION7400 leídos directo (Gravix).</p>) : <VistaThd src={src} />}
    </section>
  );
}
