import { useMemo, useState } from "react";
import { useCentroAnalitica, type HallazgoRiesgo, type MetricasSede, type Sede24h } from "../../api/centro";
import { TarjetaRiesgo } from "../asistente/Gravix";

/**
 * Pestaña "Analítica" del Centro de mando: lo que calcula /centro/analitica con el historial por minuto
 * de cada medidor (centro_lecturas), sin servicios externos.
 *  - Métricas por sede de los últimos 14 días (una gráfica pequeña por sede, misma escala de tiempo;
 *    o tabla con los valores exactos).
 *  - Lo ocurrido en las últimas 24 horas por sede.
 *  - Riesgos de los próximos 7 días, con filtros.
 */

type Metrica = "kwProm" | "kwMax" | "vProm" | "minSinDatos";
const METRICAS: { k: Metrica; titulo: string; unidad: string; dec: number; ayuda: string }[] = [
  { k: "kwProm", titulo: "Demanda promedio", unidad: "kW", dec: 0, ayuda: "Promedio del día, suma de los analizadores ION7400 de la sede (o de sus medidores si no tiene ION)." },
  { k: "kwMax", titulo: "Demanda máxima", unidad: "kW", dec: 0, ayuda: "Máximo del día de esos mismos medidores, sumados." },
  { k: "vProm", titulo: "Voltaje promedio", unidad: "V", dec: 1, ayuda: "Voltaje L-N promedio del día de todos los medidores de la sede." },
  { k: "minSinDatos", titulo: "Minutos sin datos", unidad: "min", dec: 0, ayuda: "Minutos del día con medidores fuera de línea o en voltaje cero." },
];
const SERIE = "#38bdf8";
const NIVEL24: Record<Sede24h["nivel"], { txt: string; color: string }> = {
  critico: { txt: "Crítico", color: "#ef4444" },
  advertencia: { txt: "Advertencia", color: "#f59e0b" },
  estable: { txt: "Estable", color: "#22c55e" },
};
const TIPO_TXT: Record<HallazgoRiesgo["tipo"], string> = {
  desconexion: "Desconexión",
  voltaje: "Voltaje",
  carga: "Demanda",
  comunicacion: "Comunicación",
  lectura: "Lectura congelada",
  generador: "Generador",
};
const diaCorto = (iso: string) => new Date(iso).toLocaleDateString("es-GT", { timeZone: "America/Guatemala", day: "2-digit", month: "2-digit" });
const num = (v: number | null, dec: number) => (v == null ? "—" : v.toLocaleString("es-GT", { maximumFractionDigits: dec, minimumFractionDigits: dec }));

export function Analitica({
  grupos,
  grupoDe,
  onAbrirSede,
  onAbrirHallazgo,
}: {
  grupos: { id: string; nombre: string }[];
  grupoDe: (sedeId: string) => string | null;
  onAbrirSede: (sedeId: string) => void;
  onAbrirHallazgo: (h: HallazgoRiesgo) => void;
}) {
  const an = useCentroAnalitica();
  const [alcance, setAlcance] = useState<string>("todas");
  const [metrica, setMetrica] = useState<Metrica>("kwProm");
  const [comoTabla, setComoTabla] = useState(false);
  const [nivel, setNivel] = useState<"todos" | HallazgoRiesgo["nivel"]>("todos");
  const [tipo, setTipo] = useState<"todos" | HallazgoRiesgo["tipo"]>("todos");
  const [abierto, setAbierto] = useState<string | null>(null);

  const enAlcance = (sedeId: string) => alcance === "todas" || grupoDe(sedeId) === alcance;
  const d = an.data;
  const hallazgos = useMemo(
    () => (d?.hallazgos ?? []).filter((h) => enAlcance(h.sedeId) && (nivel === "todos" || h.nivel === nivel) && (tipo === "todos" || h.tipo === tipo)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d, alcance, nivel, tipo],
  );

  if (an.isLoading) return <div className="panel p-8 text-center text-sm text-slate-400">Calculando la analítica con el historial de los medidores…</div>;
  if (an.isError || !d) return <div className="panel p-8 text-center text-sm text-rose-300">No se pudo calcular la analítica. Intente de nuevo en unos minutos.</div>;

  const sedesM = d.metricas.sedes.filter((s) => enAlcance(s.sedeId));
  const s24 = d.sedes24h.filter((s) => enAlcance(s.sedeId));
  const todos = d.hallazgos.filter((h) => enAlcance(h.sedeId));
  const cuenta = (n: HallazgoRiesgo["nivel"]) => todos.filter((h) => h.nivel === n).length;
  const m = METRICAS.find((x) => x.k === metrica)!;
  const sel = "min-h-[34px] rounded-lg px-3 text-[12.5px] font-bold";
  const on = "bg-sky-600 text-white";
  const off = "text-slate-300 hover:bg-slate-800";

  return (
    <div className="flex flex-col gap-4">
      {/* ---- filtros (una fila) e indicadores ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[12.5px] text-slate-400">
          Alcance
          <select value={alcance} onChange={(e) => setAlcance(e.target.value)} className="min-h-[34px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-[12.5px] text-slate-100">
            <option value="todas">Toda la red</option>
            {grupos.map((g) => (
              <option key={g.id} value={g.id}>{g.nombre}</option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-[11.5px] text-slate-500">
          Calculado {new Date(d.generado).toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit" })} · se actualiza cada 10 min · {d.diasAnalizados} días de historia
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Indicador titulo="Equipos analizados" valor={String(d.equiposAnalizados)} />
        <Indicador titulo="Riesgos altos" valor={String(cuenta("alto"))} marca="#ef4444" />
        <Indicador titulo="Riesgos medios" valor={String(cuenta("medio"))} marca="#f59e0b" />
        <Indicador titulo="Riesgos bajos" valor={String(cuenta("bajo"))} marca="#38bdf8" />
        <Indicador titulo="Sedes con novedades (24 h)" valor={`${s24.filter((s) => s.nivel !== "estable").length} de ${s24.length}`} />
      </div>

      {/* ---- metricas por sede ---- */}
      <section className="panel flex flex-col gap-3 p-4" aria-labelledby="an-metricas">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="an-metricas" className="mr-auto text-[15px] font-bold text-slate-50">Métricas por sede · últimos 14 días</h3>
          <div role="tablist" aria-label="Métrica" className="flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
            {METRICAS.map((x) => (
              <button key={x.k} type="button" role="tab" aria-selected={metrica === x.k} onClick={() => setMetrica(x.k)} className={`${sel} ${metrica === x.k ? on : off}`}>{x.titulo}</button>
            ))}
          </div>
          <div className="flex gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
            <button type="button" aria-pressed={!comoTabla} onClick={() => setComoTabla(false)} className={`${sel} ${!comoTabla ? on : off}`}>Gráficas</button>
            <button type="button" aria-pressed={comoTabla} onClick={() => setComoTabla(true)} className={`${sel} ${comoTabla ? on : off}`}>Tabla</button>
          </div>
        </div>
        <p className="text-[12px] text-slate-500">{m.ayuda}</p>
        {comoTabla ? (
          <TablaMetrica dias={d.metricas.dias} sedes={sedesM} k={metrica} dec={m.dec} unidad={m.unidad} onAbrirSede={onAbrirSede} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {sedesM.map((s) => (
              <MiniSede key={s.sedeId} s={s} dias={d.metricas.dias} k={metrica} dec={m.dec} unidad={m.unidad} onAbrir={() => onAbrirSede(s.sedeId)} />
            ))}
          </div>
        )}
      </section>

      {/* ---- ultimas 24 horas ---- */}
      <section className="panel flex flex-col gap-3 p-4" aria-labelledby="an-24">
        <h3 id="an-24" className="text-[15px] font-bold text-slate-50">Últimas 24 horas por sede</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[12.5px]">
            <thead className="text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="py-2 pr-3 font-semibold">Sede</th>
                <th className="py-2 pr-3 font-semibold">Estado</th>
                <th className="py-2 pr-3 text-right font-semibold">Desconexiones</th>
                <th className="py-2 pr-3 text-right font-semibold">Cortes de comunicación</th>
                <th className="py-2 pr-3 font-semibold">Caídas de tensión</th>
                <th className="py-2 pr-3 text-right font-semibold">Alarmas</th>
                <th className="py-2 pr-3 text-right font-semibold">Consumo vs. día anterior</th>
                <th className="py-2 font-semibold">Riesgo principal</th>
              </tr>
            </thead>
            <tbody>
              {s24.map((s) => (
                <tr key={s.sedeId} className="border-t border-slate-800 hover:bg-slate-900/60">
                  <td className="py-2 pr-3">
                    <button type="button" onClick={() => onAbrirSede(s.sedeId)} className="font-semibold text-sky-300 hover:underline">{s.sedeNombre}</button>
                  </td>
                  <td className="py-2 pr-3">
                    <span className="inline-flex items-center gap-1.5 text-slate-200">
                      <span className="h-2 w-2 rounded-full" style={{ background: NIVEL24[s.nivel].color }} aria-hidden="true" />
                      {NIVEL24[s.nivel].txt}
                    </span>
                  </td>
                  <td className="mono py-2 pr-3 text-right text-slate-200">{s.caidas ? `${s.caidas} (${Math.round(s.minSinDatos)} min)` : "0"}</td>
                  <td className="mono py-2 pr-3 text-right text-slate-200">{s.cortesComunicacion}</td>
                  <td className="py-2 pr-3 text-slate-300">{s.caidasTension.length ? s.caidasTension.join(", ") : "—"}</td>
                  <td className="mono py-2 pr-3 text-right text-slate-200">{s.criticas || s.advertencias ? `${s.criticas} crít. · ${s.advertencias} adv.` : "0"}</td>
                  <td className="mono py-2 pr-3 text-right text-slate-200">{s.cambioConsumo == null ? "—" : `${s.cambioConsumo > 0 ? "+" : ""}${num(s.cambioConsumo, 1)} %`}</td>
                  <td className="py-2 text-slate-300">{s.riesgo ? `${s.riesgo.titulo}${s.riesgo.probabilidad != null ? ` (${Math.round(s.riesgo.probabilidad * 100)} %)` : ""}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- riesgos ---- */}
      <section className="panel flex flex-col gap-3 p-4" aria-labelledby="an-riesgos">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="an-riesgos" className="mr-auto text-[15px] font-bold text-slate-50">Riesgos · próximos 7 días</h3>
          <select value={nivel} onChange={(e) => setNivel(e.target.value as typeof nivel)} aria-label="Nivel" className="min-h-[34px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-[12.5px] text-slate-100">
            <option value="todos">Todos los niveles</option>
            <option value="alto">Riesgo alto</option>
            <option value="medio">Riesgo medio</option>
            <option value="bajo">Riesgo bajo</option>
          </select>
          <select value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)} aria-label="Tipo" className="min-h-[34px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-[12.5px] text-slate-100">
            <option value="todos">Todos los tipos</option>
            {Object.entries(TIPO_TXT).map(([k, t]) => (
              <option key={k} value={k}>{t}</option>
            ))}
          </select>
        </div>
        {hallazgos.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">Sin riesgos con estos filtros.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {hallazgos.map((h, i) => (
              <div key={h.id}>
                <TarjetaRiesgo h={h} n={i + 1} onAbrir={() => onAbrirHallazgo(h)} onDetalle={() => setAbierto((x) => (x === h.id ? null : h.id))} />
                {abierto === h.id && (
                  <div className="mt-1 rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-[12.5px] leading-relaxed text-slate-300">
                    <p>{h.detalle}</p>
                    <p className="mt-2"><b className="text-slate-100">Recomendación:</b> {h.recomendacion}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="text-[11.5px] text-slate-500">
          Estimación estadística con el historial guardado ({d.diasAnalizados} días): orienta el mantenimiento, no lo reemplaza. Con más días de historia, más confiable.
        </p>
      </section>
    </div>
  );
}

function Indicador({ titulo, valor, marca }: { titulo: string; valor: string; marca?: string }) {
  return (
    <div className="panel flex flex-col gap-1 px-4 py-3">
      <span className="flex items-center gap-1.5 text-[11.5px] text-slate-400">
        {marca && <span className="h-2 w-2 rounded-full" style={{ background: marca }} aria-hidden="true" />}
        {titulo}
      </span>
      <b className="mono text-2xl text-slate-50">{valor}</b>
    </div>
  );
}

/** Una sede: valor del ultimo dia, cambio contra el promedio de los dias anteriores y su linea. */
function MiniSede({ s, dias, k, dec, unidad, onAbrir }: { s: MetricasSede; dias: string[]; k: Metrica; dec: number; unidad: string; onAbrir: () => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const vals = s[k];
  const nums = vals.filter((v): v is number => v != null);
  const ultimoI = vals.reduce<number>((a, v, i) => (v != null ? i : a), -1);
  const ultimo = ultimoI >= 0 ? (vals[ultimoI] as number) : null;
  const previos = vals.slice(0, Math.max(0, ultimoI)).filter((v): v is number => v != null);
  const base = previos.length ? previos.reduce((a, x) => a + x, 0) / previos.length : null;
  const cambio = ultimo != null && base ? ((ultimo - base) / base) * 100 : null;
  const W = 280;
  const H = 70;
  const min = nums.length ? Math.min(...nums) : 0;
  const max = nums.length ? Math.max(...nums) : 1;
  const X = (i: number) => (dias.length > 1 ? (i / (dias.length - 1)) * (W - 8) + 4 : W / 2);
  const Y = (v: number) => H - 6 - ((v - min) / (max - min || 1)) * (H - 14);
  const path = vals
    .map((v, i) => (v == null ? null : `${X(i)},${Y(v)}`))
    .filter(Boolean)
    .join(" ");
  const hv = hover != null ? vals[hover] : null;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="flex items-baseline gap-2">
        <button type="button" onClick={onAbrir} className="mr-auto truncate text-left text-[13px] font-semibold text-slate-100 hover:text-sky-300">{s.sedeNombre}</button>
        <b className="mono text-[15px] text-slate-50">{num(hover != null ? hv : ultimo, dec)}</b>
        <span className="text-[11px] text-slate-400">{unidad}</span>
      </div>
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>{hover != null ? diaCorto(dias[hover]) : "hoy"}</span>
        {cambio != null && hover == null && (
          <span className="text-slate-300">
            {cambio > 0 ? "▲" : cambio < 0 ? "▼" : "="} {num(Math.abs(cambio), 1)} % vs. promedio
          </span>
        )}
      </div>
      {nums.length > 1 ? (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="mt-1 h-[70px] w-full"
          role="img"
          aria-label={`${s.sedeNombre}: de ${num(nums[0], dec)} a ${num(nums[nums.length - 1], dec)} ${unidad}`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const i = Math.round((((e.clientX - r.left) / r.width) * W - 4) / ((W - 8) / Math.max(1, dias.length - 1)));
            setHover(Math.max(0, Math.min(dias.length - 1, i)));
          }}
        >
          <line x1="0" x2={W} y1={H - 6} y2={H - 6} stroke="#1e293b" strokeWidth="1" />
          <polyline points={path} fill="none" stroke={SERIE} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {hover != null && <line x1={X(hover)} x2={X(hover)} y1="2" y2={H - 6} stroke="#475569" strokeWidth="1" />}
          {hover != null && hv != null && <circle cx={X(hover)} cy={Y(hv)} r="4" fill={SERIE} stroke="#0b1220" strokeWidth="2" />}
          {hover == null && ultimo != null && <circle cx={X(ultimoI)} cy={Y(ultimo)} r="3.5" fill={SERIE} stroke="#0b1220" strokeWidth="2" />}
        </svg>
      ) : (
        <p className="py-6 text-center text-[11.5px] text-slate-500">Sin datos suficientes</p>
      )}
    </div>
  );
}

function TablaMetrica({ dias, sedes, k, dec, unidad, onAbrirSede }: { dias: string[]; sedes: MetricasSede[]; k: Metrica; dec: number; unidad: string; onAbrirSede: (id: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead className="text-[11px] text-slate-500">
          <tr>
            <th className="sticky left-0 bg-[#0d1626] py-2 pr-3 text-left font-semibold">Sede ({unidad})</th>
            {dias.map((x) => (
              <th key={x} className="mono px-2 py-2 text-right font-medium">{diaCorto(x)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sedes.map((s) => (
            <tr key={s.sedeId} className="border-t border-slate-800">
              <td className="sticky left-0 bg-[#0d1626] py-1.5 pr-3">
                <button type="button" onClick={() => onAbrirSede(s.sedeId)} className="font-semibold text-sky-300 hover:underline">{s.sedeNombre}</button>
              </td>
              {s[k].map((v, i) => (
                <td key={i} className="mono px-2 py-1.5 text-right text-slate-200">{num(v, dec)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
