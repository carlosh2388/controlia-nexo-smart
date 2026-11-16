import { useMemo, useState } from "react";
import { INDICADORES, NORMA_TXT, useCumplimiento, usePronostico, type Norma } from "../../api/calidad";
import { usePilotDevices } from "../../api/pilot";
import { extractErrorMessage } from "../../api/errors";
import InteractiveChart, { type ChartSeries } from "../charts/InteractiveChart";

/**
 * Pestañas "Normas y cumplimiento" y "Predicción" del Centro de mando (mockup aprobado
 * "Consola de energía"). Se calculan con la lectura directa (Gravix): hoy solo Escuintla.
 */

const SEDES_GRAVIX = [{ key: "igss-escuintla", nombre: "IGSS Escuintla" }];

const NORMAS_INFO = [
  { t: "NTSD Guatemala", tag: "CNEE", s: "Normas Técnicas del Servicio de Distribución: tolerancias de tensión, factor de potencia, armónicos y flicker para el servicio en Guatemala. Valores de referencia: confirmar con la resolución vigente.", c: "#86efac", bg: "rgba(34,197,94,.14)" },
  { t: "IEEE 519-2014", tag: "Armónicos", s: "Límites de distorsión armónica de tensión y corriente en el punto de conexión (≤ 1 kV: THD de tensión 8 %).", c: "#b9d6ff", bg: "rgba(59,139,255,.14)" },
  { t: "IEC 61000-4-30 / 4-15", tag: "Medición", s: "Cómo se mide la calidad (clase A, promedios de 10 min) y el flicker Pst. Los ION7400 miden con este método.", c: "#a5f3fc", bg: "rgba(34,211,238,.12)" },
  { t: "EN 50160", tag: "Evaluación", s: "Una semana de promedios de 10 min: cumple si el 95 % del tiempo está dentro del límite.", c: "#ddd6fe", bg: "rgba(167,139,250,.14)" },
  { t: "NFPA 110 / 99", tag: "Hospitales", s: "Energía de emergencia en hospitales: pruebas periódicas del generador con carga.", c: "#fde68a", bg: "rgba(234,179,8,.14)" },
];

export function NormasCumplimiento() {
  const [sede, setSede] = useState(SEDES_GRAVIX[0].key);
  const [norma, setNorma] = useState<Norma>("ntsd");
  const [dias, setDias] = useState(7);
  const q = useCumplimiento(sede, dias, norma);
  const d = q.data;
  const pctRes = d && d.resumen.evaluados ? Math.round((d.resumen.cumplen / d.resumen.evaluados) * 100) : null;
  const fuera = d ? d.equipos.flatMap((e) => INDICADORES.filter((i) => e.indicadores[i.k] && !e.indicadores[i.k]!.cumple).map((i) => `${e.nombre}: ${i.t}`)) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex max-w-3xl flex-col gap-1">
          <span className="eyebrow">Normas y cumplimiento</span>
          <h2 className="text-2xl font-bold text-slate-50">Calidad de energía medida contra la norma</h2>
          <p className="text-sm text-slate-400">Cada indicador se evalúa en promedios de 10 minutos (IEC 61000-4-30) y cumple si al menos el 95 % del tiempo está dentro del límite (EN 50160). Se calcula con la lectura directa de cada medidor.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={sede} onChange={(e) => setSede(e.target.value)} aria-label="Sede" className="min-h-[38px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100">
            {SEDES_GRAVIX.map((s) => <option key={s.key} value={s.key}>{s.nombre}</option>)}
          </select>
          <div role="group" aria-label="Norma" className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
            {(Object.keys(NORMA_TXT) as Norma[]).map((n) => (
              <button key={n} type="button" aria-pressed={norma === n} onClick={() => setNorma(n)} className={`min-h-[32px] rounded-md px-3 text-[13px] font-bold ${norma === n ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}>{NORMA_TXT[n]}</button>
            ))}
          </div>
          <div role="group" aria-label="Periodo" className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
            {[1, 7, 30].map((x) => (
              <button key={x} type="button" aria-pressed={dias === x} onClick={() => setDias(x)} className={`min-h-[32px] rounded-md px-3 text-[13px] font-bold ${dias === x ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}>{x === 1 ? "24 h" : `${x} días`}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
        {NORMAS_INFO.map((n) => (
          <div key={n.t} className="panel flex flex-col gap-1.5 p-3.5">
            <span className="flex items-center justify-between gap-2"><b className="text-sm text-slate-100">{n.t}</b><span className="mono rounded-full px-2 py-0.5 text-[10px]" style={{ background: n.bg, color: n.c }}>{n.tag}</span></span>
            <small className="text-xs text-slate-400">{n.s}</small>
          </div>
        ))}
      </div>

      {q.isLoading && <p className="py-8 text-center text-sm text-slate-500">Calculando el cumplimiento con el historial…</p>}
      {q.isError && <p className="py-8 text-center text-sm text-rose-300">{extractErrorMessage(q.error)}</p>}
      {d && (
        <>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
            <div className="panel p-3.5"><span className="eyebrow">Cumplimiento</span><b className={`mono block text-3xl ${pctRes == null ? "text-slate-500" : pctRes >= 95 ? "text-emerald-300" : pctRes >= 80 ? "text-amber-300" : "text-rose-300"}`}>{pctRes == null ? "—" : `${pctRes} %`}</b><small className="text-slate-400">de los indicadores dentro de norma</small></div>
            <div className="panel p-3.5"><span className="eyebrow">Fuera de norma</span><b className={`mono block text-3xl ${fuera.length ? "text-amber-300" : "text-emerald-300"}`}>{fuera.length}</b><small className="text-slate-400">{fuera.slice(0, 2).join(" · ") || "ninguno"}{fuera.length > 2 ? "…" : ""}</small></div>
            <div className="panel p-3.5"><span className="eyebrow">Equipos evaluados</span><b className="mono block text-3xl text-slate-100">{d.equipos.length}</b><small className="text-slate-400">leídos directo (Gravix)</small></div>
            <div className="panel p-3.5"><span className="eyebrow">Otras 9 sedes</span><b className="mono block text-3xl text-slate-500">—</b><small className="text-slate-400">el EBO no entrega calidad: se evalúan al leerlas directo</small></div>
          </div>
          <section className="panel flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="eyebrow">Matriz de cumplimiento · % del tiempo dentro del límite · {d.normaNombre}</span>
              <span className="text-[11px] text-slate-500">Calculado {new Date(d.calculado).toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit" })} · se actualiza cada 10 min</span>
            </div>
            <div className="overflow-x-auto">
              <div className="flex min-w-[880px] flex-col text-sm">
                <div className="grid grid-cols-[190px_repeat(7,minmax(0,1fr))] gap-1.5 px-1.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <span>Equipo</span>
                  {INDICADORES.map((i) => <span key={i.k} className="flex flex-col items-center text-center"><span>{i.t}</span><small className="normal-case tracking-normal text-slate-600">{i.lim(d.limites)}</small></span>)}
                </div>
                {d.equipos.map((e) => (
                  <div key={e.id} className="grid grid-cols-[190px_repeat(7,minmax(0,1fr))] items-center gap-1.5 border-t border-slate-800/80 px-1.5 py-1.5">
                    <span className="font-semibold text-slate-100">{e.nombre}{e.propios && <small className="ml-1 text-[10px] text-sky-300">umbral propio</small>}</span>
                    {INDICADORES.map((i) => {
                      const c = e.indicadores[i.k];
                      if (!c) return <span key={i.k} className="mono flex justify-center"><span className="min-w-[64px] rounded-md bg-slate-800/60 px-1.5 py-1 text-center text-xs text-slate-500" title="El equipo no mide esta variable">n/a</span></span>;
                      const cls = c.pct >= 95 ? "bg-emerald-950 text-emerald-300" : c.pct >= 85 ? "bg-amber-950 text-amber-300" : "bg-rose-950 text-rose-300";
                      return <span key={i.k} className="mono flex justify-center"><span className={`min-w-[64px] rounded-md px-1.5 py-1 text-center text-xs font-semibold ${cls}`} title={`${c.intervalos} intervalos de 10 min · ${c.cumple ? "cumple" : "no cumple"} (≥ 95 %)`}>{c.pct.toFixed(1)} %</span></span>;
                    })}
                  </div>
                ))}
                {!d.equipos.length && <p className="py-6 text-center text-slate-500">Sin equipos leídos directo en esta sede.</p>}
              </div>
            </div>
            <small className="text-xs text-amber-200/80">{d.fuente}. Los umbrales se pueden ajustar por equipo en Equipos → Configuración.</small>
          </section>
        </>
      )}
    </div>
  );
}

/* ================= prediccion ================= */
const VARIABLES = [
  { k: "apparent_power_total", t: "Carga (potencia aparente)", u: "kVA", capacidad: true },
  { k: "active_power_total", t: "Potencia activa", u: "kW", capacidad: false },
  { k: "thd_voltage_v1_high", t: "THD de tensión A-N", u: "%", capacidad: false },
  { k: "battery_voltage_metering", t: "Batería del generador", u: "V", capacidad: false },
];

export function Prediccion() {
  const pilot = usePilotDevices(`${SEDES_GRAVIX[0].key}-directo`);
  const devs = (pilot.data?.devices ?? []).filter((d) => d.updatedAt);
  const [devId, setDevId] = useState<string | null>(null);
  const [varK, setVarK] = useState(VARIABLES[0].k);
  const dev = devs.find((d) => d.id === devId) ?? devs.find((d) => d.name === "ANALIZADOR-2") ?? devs[0] ?? null;
  const vars = VARIABLES.filter((v) => (dev ? typeof dev.readings[v.k] === "number" : true));
  const variable = vars.find((v) => v.k === varK) ?? vars[0] ?? VARIABLES[0];
  const p = usePronostico(dev?.id ?? null, variable.k, 14, 7);
  const cap = p.data?.capacidad && variable.capacidad ? p.data.capacidad : null;
  const enPct = (v: number) => (cap ? (v / cap) * 100 : v);
  const unidad = cap ? "% de capacidad" : variable.u;

  const series: ChartSeries[] = useMemo(() => {
    const d = p.data;
    if (!d) return [];
    return [
      { name: "Medido", color: "#3b8bff", points: d.historia.map((x) => ({ t: new Date(x.t).getTime(), v: enPct(x.v) })) },
      { name: "Pronóstico", color: "#a78bfa", dashed: true, points: d.pronostico.map((x) => ({ t: new Date(x.t).getTime(), v: enPct(x.v) })) },
      { name: "Rango probable (alto)", color: "#6d5bb5", dashed: true, points: d.pronostico.map((x) => ({ t: new Date(x.t).getTime(), v: enPct(x.max) })) },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.data, cap]);

  const pico = p.data?.pronostico.reduce<{ t: string; v: number } | null>((a, x) => (!a || x.v > a.v ? { t: x.t, v: x.v } : a), null);
  const cruce = (lim: number) => (cap ? p.data?.pronostico.find((x) => enPct(x.v) >= lim) : null);
  const c80 = cruce(80), c90 = cruce(90);
  const tendencia = p.data?.pendienteDiaria ?? 0;
  const fmtF = (s: string) => new Date(s).toLocaleString("es-GT", { weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex max-w-3xl flex-col gap-1">
          <span className="eyebrow">Predicción</span>
          <h2 className="text-2xl font-bold text-slate-50">Lo que va a pasar, antes de que pase</h2>
          <p className="text-sm text-slate-400">Aprende el comportamiento de cada equipo por hora y tipo de día (hábil o fin de semana) con su historial en TimescaleDB, y le suma la tendencia de los últimos 14 días. Mejora con más semanas de datos.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={dev?.id ?? ""} onChange={(e) => setDevId(e.target.value)} aria-label="Equipo" className="min-h-[38px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100">
            {devs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={variable.k} onChange={(e) => setVarK(e.target.value)} aria-label="Variable" className="min-h-[38px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100">
            {vars.map((v) => <option key={v.k} value={v.k}>{v.t}</option>)}
          </select>
        </div>
      </div>
      <section className="panel flex flex-col gap-3 p-4">
        <span className="eyebrow">{dev?.name ?? "—"} · {variable.t} · 14 días medidos + 7 de pronóstico</span>
        {p.isLoading && <p className="py-10 text-center text-sm text-slate-500">Calculando el pronóstico…</p>}
        {p.isError && <p className="py-10 text-center text-sm text-rose-300">{extractErrorMessage(p.error)}</p>}
        {p.data && !p.data.suficiente && <p className="py-10 text-center text-sm text-slate-400">Todavía no hay suficiente historial (se necesitan al menos 2 días).</p>}
        {p.data?.suficiente && (
          <>
            <InteractiveChart series={series} unit={unidad} dec={1} threshold={cap ? { value: 80, label: "80 % de la capacidad" } : null} />
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
              <div className="rounded-xl border border-violet-900 bg-violet-950/30 p-3 text-sm text-violet-100">Pico pronosticado: <b className="mono">{pico ? `${enPct(pico.v).toFixed(1)} ${unidad}` : "—"}</b>{pico ? ` el ${fmtF(pico.t)}` : ""}.</div>
              {cap ? (
                <div className={`rounded-xl border p-3 text-sm ${c90 ? "border-rose-900 bg-rose-950/30 text-rose-100" : c80 ? "border-amber-900 bg-amber-950/30 text-amber-100" : "border-emerald-900 bg-emerald-950/30 text-emerald-100"}`}>
                  {c90 ? `Llegaría al 90 % de la capacidad (${cap} kVA) el ${fmtF(c90.t)}.` : c80 ? `Llegaría al 80 % de la capacidad (${cap} kVA) el ${fmtF(c80.t)}.` : `No pasaría del 80 % de su capacidad (${cap} kVA) en los próximos 7 días.`}
                </div>
              ) : (
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm text-slate-300">Sin capacidad registrada para comparar: se agrega en Equipos → Configuración.</div>
              )}
              <div className="rounded-xl border border-sky-900 bg-sky-950/30 p-3 text-sm text-sky-100">Tendencia: <b className="mono">{tendencia >= 0 ? "+" : ""}{(cap ? (tendencia / cap) * 100 : tendencia).toFixed(2)} {cap ? "puntos %" : variable.u}</b> por día{Math.abs(tendencia) < 0.01 ? " (estable)" : ""}.</div>
            </div>
          </>
        )}
      </section>
      <p className="text-xs text-slate-500">Hoy solo Escuintla tiene lectura directa con historial suficiente. Las demás sedes se suman al instalarles el Agente Go.</p>
    </div>
  );
}
