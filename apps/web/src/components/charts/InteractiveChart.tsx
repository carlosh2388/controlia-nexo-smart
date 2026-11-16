import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Grafica de lineas interactiva para todas las tendencias de Nodivo:
 *  - mira (crosshair) al pasar el mouse o el dedo: fecha/hora exacta y el valor de cada serie;
 *  - arrastrar sobre la grafica = zoom a ese tramo; doble clic o "Ver todo" = volver;
 *  - clic en la leyenda = mostrar / ocultar una serie;
 *  - huecos sombreados, umbral de alarma y la linea se corta donde falta un intervalo;
 *  - teclado: flechas mueven la mira, Esc la quita.
 * Se dibuja en pixeles reales (ResizeObserver), no se deforma al cambiar el ancho.
 */

export interface ChartSeries {
  name: string;
  color: string;
  dashed?: boolean;
  points: { t: number; v: number | null }[];
}
export interface ChartBand {
  from: number;
  to: number;
  label?: string;
  color?: string;
}

const PAD = { l: 52, r: 14, t: 14, b: 28 };

function niceTicks(lo: number, hi: number, n = 5) {
  const span = hi - lo || 1;
  const raw = span / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? p * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

function fmtTime(t: number, span: number) {
  const d = new Date(t);
  if (span <= 36 * 3600_000) return d.toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("es-GT", { day: "2-digit", month: "2-digit" }) + (span <= 8 * 86400_000 ? " " + d.toLocaleTimeString("es-GT", { hour: "2-digit" }) + "h" : "");
}
const fmtFull = (t: number) => new Date(t).toLocaleString("es-GT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function InteractiveChart({
  series,
  unit = "",
  dec = 1,
  height = 300,
  bands = [],
  threshold,
  emptyText = "Todavía no hay suficientes datos en este periodo",
}: {
  series: ChartSeries[];
  unit?: string;
  dec?: number;
  height?: number;
  bands?: ChartBand[];
  threshold?: { value: number; label: string } | null;
  emptyText?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(280, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const visibles = series.filter((s) => !hidden.has(s.name));
  const all = useMemo(() => series.flatMap((s) => s.points.map((p) => p.t)), [series]);
  const tMin0 = all.length ? Math.min(...all) : 0;
  const tMax0 = all.length ? Math.max(...all) : 1;
  const [t0, t1] = zoom ?? [tMin0, tMax0 === tMin0 ? tMin0 + 60_000 : tMax0];
  // cambia el periodo/datos -> se quita el zoom
  useEffect(() => setZoom(null), [tMin0, tMax0]);

  const vals = visibles.flatMap((s) => s.points.filter((p) => p.v != null && p.t >= t0 && p.t <= t1).map((p) => p.v as number));
  if (threshold) vals.push(threshold.value);
  let lo = vals.length ? Math.min(...vals) : 0;
  let hi = vals.length ? Math.max(...vals) : 1;
  if (hi - lo < 1e-9) { lo -= Math.abs(lo) * 0.05 || 1; hi += Math.abs(hi) * 0.05 || 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const ticks = niceTicks(lo, hi, 5);

  const iw = w - PAD.l - PAD.r, ih = height - PAD.t - PAD.b;
  const X = (t: number) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * iw;
  const Y = (v: number) => PAD.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const tOfX = (x: number) => t0 + ((x - PAD.l) / iw) * (t1 - t0);

  const paths = visibles.map((s) => {
    const pts = s.points.filter((p) => p.t >= t0 - (t1 - t0) * 0.02 && p.t <= t1 + (t1 - t0) * 0.02);
    const steps = pts.slice(1).map((p, i) => p.t - pts[i].t).sort((a, b) => a - b);
    const paso = steps.length ? steps[Math.floor(steps.length / 2)] : 0;
    let d = "", prev: number | null = null;
    for (const p of pts) {
      if (p.v == null) { prev = null; continue; }
      const corte = prev == null || (paso > 0 && p.t - prev > paso * 2.5);
      d += `${corte ? "M" : "L"}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)} `;
      prev = p.t;
    }
    return { s, d };
  });

  const vacio = !visibles.some((s) => s.points.filter((p) => p.v != null).length > 1);

  // valores bajo la mira
  const nearest = (s: ChartSeries, t: number) => {
    let best: { t: number; v: number | null } | null = null;
    for (const p of s.points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best;
  };
  const span = t1 - t0;
  const hover = hoverT != null && hoverT >= t0 && hoverT <= t1
    ? visibles.map((s) => ({ s, p: nearest(s, hoverT) })).filter((x) => x.p && Math.abs(x.p.t - hoverT) <= span / 40 + 60_000)
    : [];
  const hoverX = hoverT != null ? X(hover[0]?.p?.t ?? hoverT) : 0;

  const xFromEvent = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    return Math.max(PAD.l, Math.min(w - PAD.r, e.clientX - r.left));
  };
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const x = xFromEvent(e);
    setDrag({ x0: x, x1: x });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const x = xFromEvent(e);
    setHoverT(tOfX(x));
    if (drag) setDrag({ ...drag, x1: x });
  };
  const onUp = () => {
    if (drag && Math.abs(drag.x1 - drag.x0) > 12) {
      const a = tOfX(Math.min(drag.x0, drag.x1)), b = tOfX(Math.max(drag.x0, drag.x1));
      if (b - a > 30_000) setZoom([a, b]);
    }
    setDrag(null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const paso = span / 60;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setHoverT((h) => Math.max(t0, Math.min(t1, (h ?? t1) + (e.key === "ArrowRight" ? paso : -paso))));
    } else if (e.key === "Escape") setHoverT(null);
  };

  const nTicks = Math.max(2, Math.min(6, Math.floor(iw / 130)));
  const xTicks = Array.from({ length: nTicks }, (_v: unknown, i: number) => t0 + (span * i) / (nTicks - 1));
  const tipLeft = hoverX > w * 0.62;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {series.map((s) => {
          const off = hidden.has(s.name);
          return (
            <button key={s.name} type="button" aria-pressed={!off} title={off ? "Mostrar esta serie" : "Ocultar esta serie"} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(s.name)) n.delete(s.name); else n.add(s.name); return n; })} className={`flex min-h-[28px] items-center gap-1.5 rounded-md px-1.5 ${off ? "text-slate-600 line-through" : "text-slate-300 hover:bg-slate-800"}`}>
              <svg width="20" height="8" aria-hidden="true"><line x1="0" y1="4" x2="20" y2="4" stroke={s.color} strokeWidth="2.5" strokeDasharray={s.dashed ? "4 3" : undefined} /></svg>
              {s.name}
            </button>
          );
        })}
        {threshold && <span className="flex items-center gap-1.5 text-amber-300/80"><svg width="20" height="8" aria-hidden="true"><line x1="0" y1="4" x2="20" y2="4" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="6 4" /></svg>{threshold.label}</span>}
        <span className="ml-auto text-slate-500">{zoom ? "" : "Arrastre sobre la gráfica para acercar"}</span>
        {zoom && <button type="button" onClick={() => setZoom(null)} className="min-h-[28px] rounded-md border border-sky-700 bg-sky-950 px-2.5 font-semibold text-sky-200">Ver todo el periodo</button>}
      </div>
      <div ref={boxRef} className="relative select-none rounded-xl border border-slate-800 bg-slate-950/70">
        {vacio ? (
          <div className="grid place-items-center text-sm text-slate-500" style={{ height }}>{emptyText}</div>
        ) : (
          <>
            <svg
              width={w}
              height={height}
              role="img"
              aria-label={`Gráfica: ${visibles.map((s) => s.name).join(", ")}. Use las flechas para recorrerla.`}
              tabIndex={0}
              onKeyDown={onKey}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerLeave={() => { if (!drag) setHoverT(null); }}
              onDoubleClick={() => setZoom(null)}
              style={{ display: "block", cursor: drag ? "col-resize" : "crosshair", touchAction: "pan-y" }}
            >
              <defs>
                {paths.map(({ s }, i) => (
                  <linearGradient key={i} id={`ic-g-${i}-${s.color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor={s.color} stopOpacity=".22" />
                    <stop offset="1" stopColor={s.color} stopOpacity="0" />
                  </linearGradient>
                ))}
              </defs>
              {ticks.map((v) => (
                <g key={v}>
                  <line x1={PAD.l} x2={w - PAD.r} y1={Y(v)} y2={Y(v)} stroke="#16223a" />
                  <text x={PAD.l - 8} y={Y(v) + 3.5} textAnchor="end" fontSize="11" fill="#7b8aa3" fontFamily="JetBrains Mono, monospace">{v.toFixed(Math.max(0, dec - (Math.abs(v) >= 100 ? 1 : 0)))}</text>
                </g>
              ))}
              {xTicks.map((t, i) => (
                <text key={i} x={X(t)} y={height - 8} textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"} fontSize="11" fill="#7b8aa3" fontFamily="JetBrains Mono, monospace">{fmtTime(t, span)}</text>
              ))}
              {bands.filter((b) => b.to >= t0 && b.from <= t1).map((b, i) => {
                const x0 = Math.max(PAD.l, X(b.from)), x1 = Math.min(w - PAD.r, Math.max(x0 + 3, X(b.to)));
                return (
                  <g key={i}>
                    <rect x={x0} y={PAD.t} width={x1 - x0} height={ih} fill={b.color ?? "#ef4444"} opacity=".12" />
                    {b.label && x1 - x0 > 50 && <text x={(x0 + x1) / 2} y={PAD.t + 12} textAnchor="middle" fontSize="10" fontWeight="600" fill={b.color ?? "#fca5a5"}>{b.label}</text>}
                  </g>
                );
              })}
              {threshold && <line x1={PAD.l} x2={w - PAD.r} y1={Y(threshold.value)} y2={Y(threshold.value)} stroke="#f59e0b" strokeWidth="1.3" strokeDasharray="7 5" />}
              {paths.map(({ s, d }, i) => (
                <g key={s.name}>
                  {i === 0 && !s.dashed && d && <path d={`${d}L${X(Math.min(t1, s.points[s.points.length - 1]?.t ?? t1))} ${PAD.t + ih} L${X(Math.max(t0, s.points[0]?.t ?? t0))} ${PAD.t + ih} Z`} fill={`url(#ic-g-${i}-${s.color.replace("#", "")})`} />}
                  <path d={d} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.6 : 2.2} strokeDasharray={s.dashed ? "5 4" : undefined} strokeLinejoin="round" />
                </g>
              ))}
              {drag && <rect x={Math.min(drag.x0, drag.x1)} y={PAD.t} width={Math.abs(drag.x1 - drag.x0)} height={ih} fill="#3b82f6" opacity=".18" stroke="#60a5fa" />}
              {hover.length > 0 && (
                <g pointerEvents="none">
                  <line x1={hoverX} x2={hoverX} y1={PAD.t} y2={PAD.t + ih} stroke="#cbd5e1" strokeDasharray="3 3" />
                  {hover.map(({ s, p }) => p?.v != null && <circle key={s.name} cx={X(p.t)} cy={Y(p.v)} r="4.5" fill={s.color} stroke="#0b1220" strokeWidth="2" />)}
                </g>
              )}
            </svg>
            {hover.length > 0 && (
              <div className="pointer-events-none absolute z-10 min-w-[170px] rounded-lg border border-slate-700 bg-slate-900/95 px-3 py-2 text-xs shadow-xl" style={{ top: PAD.t + 6, left: tipLeft ? undefined : hoverX + 12, right: tipLeft ? w - hoverX + 12 : undefined }}>
                <div className="mb-1 font-mono text-slate-400">{fmtFull(hover[0].p!.t)}</div>
                {hover.map(({ s, p }) => (
                  <div key={s.name} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-slate-300"><span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}</span>
                    <b className="font-mono text-slate-50">{p?.v == null ? "sin dato" : `${p.v.toFixed(dec)} ${unit}`}</b>
                  </div>
                ))}
                {bands.filter((b) => hover[0].p!.t >= b.from && hover[0].p!.t <= b.to).map((b, i) => <div key={i} className="mt-1 text-rose-300">{b.label ?? "Hueco"}</div>)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
