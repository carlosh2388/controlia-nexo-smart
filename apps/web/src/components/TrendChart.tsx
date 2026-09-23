import { useMemo, useRef, useState } from "react";

export interface TrendPoint {
  t: number;
  v: number;
}

const VIEW_W = 600;
const VIEW_H = 170;
const PAD_L = 40;
const PAD_R = 12;
const PAD_T = 10;
const PAD_B = 22;

function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) return [min];
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const err = (span / count) / step;
  const niceStep = err >= 7.5 ? step * 10 : err >= 3 ? step * 5 : err >= 1.5 ? step * 2 : step;
  const start = Math.ceil(min / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let v = start; v <= max + niceStep * 0.001; v += niceStep) ticks.push(Math.round(v * 100) / 100);
  return ticks.length ? ticks : [min, max];
}

function formatTick(range: "today" | "7d" | "15d" | "30d", t: number): string {
  const d = new Date(t);
  if (range === "today") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
}

/**
 * Grafica de linea de una sola serie (small multiple), estilo dataviz skill: linea 2px,
 * relleno de area al 10%, marcador final con anillo de superficie, crosshair+tooltip al hover,
 * ejes con pocas marcas limpias. Un solo color por metrica (fijo, del set categorico validado).
 */
export default function TrendChart({
  title,
  unit,
  color,
  points,
  range,
  latest,
}: {
  title: string;
  unit: string;
  color: string;
  points: TrendPoint[];
  range: "today" | "7d" | "15d" | "30d";
  latest?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const { path, areaPath, xOf, yOf, yTicks } = useMemo(() => {
    if (points.length === 0) {
      return { path: "", areaPath: "", xOf: () => PAD_L, yOf: () => VIEW_H - PAD_B, yTicks: [] as number[], minV: 0, maxV: 0 };
    }
    const ts = points.map((p) => p.t);
    const vs = points.map((p) => p.v);
    const tMin = Math.min(...ts);
    const tMax = Math.max(...ts);
    let vMin = Math.min(...vs);
    let vMax = Math.max(...vs);
    if (vMin === vMax) {
      vMin -= 1;
      vMax += 1;
    } else {
      const pad = (vMax - vMin) * 0.1;
      vMin -= pad;
      vMax += pad;
    }

    const xOf = (t: number) => (tMax === tMin ? PAD_L : PAD_L + ((t - tMin) / (tMax - tMin)) * (VIEW_W - PAD_L - PAD_R));
    const yOf = (v: number) => VIEW_H - PAD_B - ((v - vMin) / (vMax - vMin)) * (VIEW_H - PAD_T - PAD_B);

    const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(" ");
    const areaPath = `${path} L${xOf(points[points.length - 1].t).toFixed(1)},${VIEW_H - PAD_B} L${xOf(points[0].t).toFixed(1)},${VIEW_H - PAD_B} Z`;

    return { path, areaPath, xOf, yOf, yTicks: niceTicks(vMin, vMax, 4), minV: tMin, maxV: tMax };
  }, [points]);

  function handleMove(e: React.PointerEvent<SVGSVGElement>) {
    if (points.length === 0 || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const svgX = relX * VIEW_W;
    let nearest = 0;
    let best = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(xOf(p.t) - svgX);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    setHoverIdx(nearest);
  }

  const hovered = hoverIdx !== null ? points[hoverIdx] : null;
  const xTicks = points.length > 1 ? [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]] : points;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</p>
        {latest !== undefined && (
          <p className="text-sm font-semibold text-slate-100">
            {latest}
            <span className="ml-0.5 text-xs font-normal text-slate-500">{unit}</span>
          </p>
        )}
      </div>

      {points.length === 0 ? (
        <div className="flex h-[110px] items-center justify-center text-xs text-slate-600">Sin datos en este periodo</div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="h-[110px] w-full touch-none"
          onPointerMove={handleMove}
          onPointerLeave={() => setHoverIdx(null)}
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={VIEW_W - PAD_R} y1={yOf(t)} y2={yOf(t)} stroke="#2c2c2a" strokeWidth={1} />
              <text x={PAD_L - 5} y={yOf(t) + 3} textAnchor="end" fontSize={9} fill="#898781">
                {t}
              </text>
            </g>
          ))}

          <path d={areaPath} fill={color} opacity={0.1} />
          <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {xTicks.map((p, i) => (
            <text key={i} x={xOf(p.t)} y={VIEW_H - 6} textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"} fontSize={9} fill="#898781">
              {formatTick(range, p.t)}
            </text>
          ))}

          <circle
            cx={xOf(points[points.length - 1].t)}
            cy={yOf(points[points.length - 1].v)}
            r={4}
            fill={color}
            stroke="#1a1a19"
            strokeWidth={2}
          />

          {hovered && (
            <g>
              <line x1={xOf(hovered.t)} x2={xOf(hovered.t)} y1={PAD_T} y2={VIEW_H - PAD_B} stroke="#c3c2b7" strokeWidth={1} strokeDasharray="2,2" />
              <circle cx={xOf(hovered.t)} cy={yOf(hovered.v)} r={4} fill={color} stroke="#1a1a19" strokeWidth={2} />
            </g>
          )}
        </svg>
      )}

      {hovered && (
        <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
          <span>{new Date(hovered.t).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
          <span className="font-semibold text-slate-200">
            {hovered.v} {unit}
          </span>
        </div>
      )}

      {points.length > 0 && (
        <button
          onClick={() => setShowTable((v) => !v)}
          className="mt-1 text-[11px] text-slate-600 hover:text-slate-400"
        >
          {showTable ? "Ocultar tabla" : "Ver tabla"}
        </button>
      )}

      {showTable && (
        <div className="mt-2 max-h-32 overflow-y-auto rounded-md border border-slate-800 text-[11px]">
          <table className="w-full">
            <tbody>
              {[...points].reverse().map((p, i) => (
                <tr key={i} className="border-b border-slate-800/70 last:border-b-0">
                  <td className="px-2 py-1 text-slate-500">{new Date(p.t).toLocaleString()}</td>
                  <td className="px-2 py-1 text-right font-medium text-slate-300">
                    {p.v} {unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
