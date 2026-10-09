import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useDeviceHistory, type HistoryRange } from "../../api/devices";
import { useSiteEvents, type SiteEvent } from "../../api/siteEvents";
import { SEVERITY_META, SeverityBadge, categoryOf } from "./eventMeta";
import {
  ACCENT,
  demoSeries,
  fmt,
  isDoorOpen,
  metricValue,
  metricsFor,
  type MetricDef,
  type Readings,
  type SedeDevice,
} from "../../utils/sedes";

/**
 * Ventana de tendencias de un equipo de la pestaña Sedes: metrica + rango (1 h / 24 h / 7 dias),
 * actual/min/max/promedio, grafica con linea de limite y tooltip al pasar el mouse. Para las
 * puertas grafica barras de aperturas por intervalo. Los datos salen de GET /devices/:id/history
 * (una lectura por minuto que guarda la API con cada sync del agente); los equipos de
 * demostracion usan una serie sintetica.
 */

type Range = "1h" | "24h" | "7d";
const RANGE_LABEL: Record<Range, string> = { "1h": "Última hora", "24h": "24 horas", "7d": "7 días" };
const RANGE_MS: Record<Range, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };
// Aperturas de puerta: cantidad de barras y minutos por barra segun el rango.
const BAR_BUCKETS: Record<Range, { n: number; stepMin: number; label: string }> = {
  "1h": { n: 12, stepMin: 5, label: "cada 5 min" },
  "24h": { n: 24, stepMin: 60, label: "por hora" },
  "7d": { n: 7, stepMin: 1440, label: "por día" },
};
// Serie sintetica de demostracion: puntos y minutos entre puntos.
const DEMO_STEPS: Record<Range, { n: number; stepMin: number }> = {
  "1h": { n: 60, stepMin: 1 },
  "24h": { n: 96, stepMin: 15 },
  "7d": { n: 84, stepMin: 120 },
};

const X0 = 52;
const X1 = 628;
const Y0 = 12;
const Y1 = 226;
const MAX_POINTS = 300;

const READING_LABELS: Record<string, [string, string]> = {
  active_power_total: ["Potencia activa total", "kW"],
  apparent_power_total: ["Potencia aparente total", "kVA"],
  current_a: ["Corriente A", "A"],
  current_b: ["Corriente B", "A"],
  current_c: ["Corriente C", "A"],
  voltage_a_n: ["Voltaje A-N", "V"],
  voltage_b_n: ["Voltaje B-N", "V"],
  voltage_c_n: ["Voltaje C-N", "V"],
  voltage_a_b: ["Voltaje A-B", "V"],
  power_factor_total: ["Factor de potencia", "pf"],
  frequency: ["Frecuencia", "Hz"],
  thd_voltage_v1_high: ["THD voltaje V1", "%"],
  demand_total: ["Demanda total", "kW"],
  engine_speed_metering: ["Velocidad del motor", "RPM"],
  gen_kw_total_metering: ["kW total", "kW"],
  engine_load_metering: ["Carga del motor", "%"],
  coolant_temp_metering: ["Temp. refrigerante", "°C"],
  oil_pressure_metering: ["Presión de aceite", "psi"],
  battery_voltage_metering: ["Voltaje de batería", "V"],
  fuel_level_metering: ["Combustible", "%"],
  temperature: ["Temperatura", "°C"],
  humidity: ["Humedad", "%HR"],
  battery: ["Batería", "%"],
  co2: ["CO₂", "ppm"],
  pm2_5: ["PM2.5", "µg/m³"],
  tvoc: ["TVOC", "mg/m³"],
  magnet_status: ["Estado de puerta", ""],
  tamper_status: ["Sabotaje", ""],
};

function readingRows(d: SedeDevice) {
  const rows: { label: string; value: string; unit: string }[] = [];
  for (const [k, v] of Object.entries(d.readings)) {
    if (v === undefined || v === null || typeof v === "object") continue;
    const meta = READING_LABELS[k];
    if (!meta && rows.length >= 10) continue;
    const value = typeof v === "number" ? fmt(v, Math.abs(v) >= 100 ? 1 : 2) : String(v);
    rows.push({ label: meta?.[0] ?? k, value, unit: meta?.[1] ?? "" });
  }
  return rows.slice(0, 14);
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function fmtTime(t: Date, range: Range, bar = false) {
  if (range === "7d") return `${pad(t.getDate())}/${pad(t.getMonth() + 1)}${bar ? "" : ` ${pad(t.getHours())}h`}`;
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** Reduce una serie larga a MAX_POINTS promediando por intervalos de tiempo iguales. */
function downsample(points: { t: Date; v: number }[], from: number, to: number) {
  if (points.length <= MAX_POINTS) return points;
  const size = (to - from) / MAX_POINTS;
  const buckets = new Map<number, { sum: number; n: number }>();
  for (const p of points) {
    const b = Math.min(MAX_POINTS - 1, Math.floor((p.t.getTime() - from) / size));
    const acc = buckets.get(b) ?? { sum: 0, n: 0 };
    acc.sum += p.v;
    acc.n += 1;
    buckets.set(b, acc);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([b, acc]) => ({ t: new Date(from + (b + 0.5) * size), v: acc.sum / acc.n }));
}

export default function SedeTrendModal({
  device,
  buildingKey,
  outage,
  tick,
  demoEvents,
  onClose,
}: {
  device: SedeDevice;
  buildingKey: string;
  outage: boolean;
  tick: number;
  demoEvents?: SiteEvent[];
  onClose: () => void;
}) {
  const metrics = metricsFor(device);
  const [metricKey, setMetricKey] = useState(metrics[0]?.key ?? "");
  const [range, setRange] = useState<Range>("24h");
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const m: MetricDef = metrics.find((x) => x.key === metricKey) ?? metrics[0];
  const accent = ACCENT[device.kind];

  const history = useDeviceHistory(device.demo ? null : device.id, range as HistoryRange, {
    refetchIntervalMs: range === "1h" ? 30_000 : 120_000,
  });

  // onClose llega como funcion nueva en cada render de la pagina (cada pocos segundos): se guarda
  // en un ref para que el foco y el listener de Escape se configuren una sola vez al abrir.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const now = Date.now();
  const from = now - RANGE_MS[range];

  // Eventos del equipo en el rango: marcas sobre la grafica + lista debajo.
  const eventsFrom = useMemo(() => new Date(Date.now() - RANGE_MS[range]).toISOString(), [range]);
  const deviceEventsQuery = useSiteEvents(device.demo ? null : buildingKey, { deviceId: device.id, from: eventsFrom, limit: 200 }, {
    refetchIntervalMs: 30_000,
  });
  const deviceEvents = (device.demo ? (demoEvents ?? []).filter((e) => e.deviceId === device.id) : deviceEventsQuery.data?.events ?? []).filter(
    (e) => new Date(e.occurredAt).getTime() >= from,
  );

  // ---- serie ----
  const series = useMemo(() => {
    if (!m) return [] as { t: Date; v: number }[];
    if (m.bar) {
      const { n, stepMin } = BAR_BUCKETS[range];
      if (device.demo) return demoSeries(device, m, n, stepMin, outage, tick);
      const start = now - n * stepMin * 60000;
      const counts = new Array(n).fill(0) as number[];
      let prevOpen: boolean | null = null;
      for (const p of history.data?.points ?? []) {
        const open = isDoorOpen(p as Readings);
        const t = new Date(p.t).getTime();
        if (open && prevOpen === false && t >= start) {
          counts[Math.min(n - 1, Math.floor((t - start) / (stepMin * 60000)))] += 1;
        }
        prevOpen = open;
      }
      return counts.map((v, i) => ({ t: new Date(start + i * stepMin * 60000), v }));
    }
    if (device.demo) {
      const { n, stepMin } = DEMO_STEPS[range];
      return demoSeries(device, m, n, stepMin, outage, tick);
    }
    const pts: { t: Date; v: number }[] = [];
    for (const p of history.data?.points ?? []) {
      const v = metricValue(device, m.key, p as Readings);
      if (v != null) pts.push({ t: new Date(p.t), v });
    }
    const current = metricValue(device, m.key, device.readings);
    if (current != null && device.online) pts.push({ t: new Date(now), v: current });
    return downsample(pts, from, now);
    // `now`/`from` cambian en cada render a proposito fuera de las deps: la serie se recalcula
    // cuando cambian los datos, el rango o el tick de la pagina (cada pocos segundos).
  }, [m, range, device, history.data, outage, tick]);

  const isBar = !!m?.bar;
  const n = series.length;
  const vals = series.map((p) => p.v);

  let lo = n ? Math.min(...vals) : 0;
  let hi = n ? Math.max(...vals) : 1;
  for (const lim of [m?.limit, m?.limitMin]) {
    if (lim != null) {
      lo = Math.min(lo, lim);
      hi = Math.max(hi, lim);
    }
  }
  if (isBar) lo = 0;
  if (hi - lo < 1e-6) hi = lo + 1;
  const padY = (hi - lo) * 0.12;
  if (!isBar) lo = lo >= 0 ? Math.max(0, lo - padY) : lo - padY;
  hi += padY;

  const slot = isBar && n ? (X1 - X0) / n : 0;
  const xAt = (i: number) => {
    if (isBar) return X0 + (i + 0.5) * slot;
    if (device.demo) return n <= 1 ? X1 : X0 + (i / (n - 1)) * (X1 - X0);
    return X0 + ((series[i].t.getTime() - from) / (now - from)) * (X1 - X0);
  };
  const yAt = (v: number) => Y1 - ((v - lo) / (hi - lo)) * (Y1 - Y0);
  const pts = series.map((p, i) => [xAt(i), yAt(p.v)] as const);
  const lineD = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const areaD = n ? `${lineD} L${pts[n - 1][0].toFixed(1)} ${Y1} L${pts[0][0].toFixed(1)} ${Y1} Z` : "";

  const dec = m?.dec ?? 1;
  const tickDec = dec > 1 ? dec : hi - lo < 5 ? 1 : 0;
  const yTicks = [0, 1, 2, 3].map((k) => lo + (k * (hi - lo)) / 3);
  const xTickTimes = isBar
    ? [0, Math.floor(n / 2), n - 1].filter((i) => i >= 0 && i < n).map((i) => ({ x: xAt(i), label: fmtTime(series[i].t, range, true) }))
    : [0, 1, 2, 3].map((k) => {
        const t = new Date(from + (k * (now - from)) / 3);
        return { x: X0 + (k * (X1 - X0)) / 3, label: k === 3 ? "ahora" : fmtTime(t, range) };
      });

  function onMove(e: MouseEvent<SVGSVGElement>) {
    if (!svgRef.current || !n) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 640;
    let best = 0;
    let bestDist = Infinity;
    pts.forEach((p, i) => {
      const dist = Math.abs(p[0] - x);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    });
    setHover(best);
  }

  const hv = hover != null && hover < n ? hover : null;
  const unitTxt = m?.unit ? ` ${m.unit}` : "";
  const sum = vals.reduce((s, v) => s + v, 0);
  const stats = isBar
    ? [
        { label: "Total del periodo", value: String(sum), unit: "aperturas" },
        { label: "Intervalo más activo", value: n && sum > 0 ? fmtTime(series[vals.indexOf(Math.max(...vals))].t, range, true) : "—", unit: "" },
        { label: "Máximo por intervalo", value: n ? String(Math.max(...vals)) : "—", unit: "" },
        { label: "Estado actual", value: isDoorOpen(device.readings) ? "Abierta" : "Cerrada", unit: "" },
      ]
    : [
        { label: "Actual", value: n ? fmt(vals[n - 1], dec) : "—", unit: m?.unit ?? "" },
        { label: "Mínimo", value: n ? fmt(Math.min(...vals), dec) : "—", unit: m?.unit ?? "" },
        { label: "Máximo", value: n ? fmt(Math.max(...vals), dec) : "—", unit: m?.unit ?? "" },
        { label: "Promedio", value: n ? fmt(sum / n, dec) : "—", unit: m?.unit ?? "" },
      ];

  const loading = !device.demo && history.isLoading;
  const empty = !loading && (n === 0 || (!isBar && n < 2));
  const subtitle = [device.model, device.area, device.attrs.code ? String(device.attrs.code) : ""].filter(Boolean).join(" · ");

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(5,8,12,0.74)] px-4 py-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sd-trend-title"
        className="flex w-full max-w-[1040px] flex-col gap-4 rounded-[18px] border border-[#2C3D50] bg-[#121A23] p-5 text-[#E6EDF3] shadow-[0_30px_80px_rgba(0,0,0,0.5)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="h-3 w-3 shrink-0 rounded" style={{ background: accent }} />
            <div className="min-w-0">
              <h2 id="sd-trend-title" className="text-xl font-semibold">
                Tendencias · {device.name}
              </h2>
              <div className="text-[13px] text-[#93A4B5]">
                {subtitle}
                {device.demo ? " · datos de demostración" : ""}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 text-xs text-[#8FE0B5]">
              <span className="sd-glow h-2 w-2 rounded-full bg-[#4CC38A]" />
              En vivo
            </span>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Cerrar tendencias"
              className="inline-flex h-11 w-11 items-center justify-center rounded-[10px] border border-[#2C3D50] bg-[#182330] text-[#E6EDF3] hover:bg-[#1F2D3D]"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div role="group" aria-label="Métrica" className="flex flex-wrap gap-1.5">
            {metrics.map((x) => {
              const on = x.key === m?.key;
              return (
                <button
                  key={x.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setMetricKey(x.key);
                    setHover(null);
                  }}
                  className="min-h-[40px] rounded-full border px-3.5 py-2 text-sm"
                  style={
                    on
                      ? { background: accent, borderColor: accent, color: "#0B1117", fontWeight: 600 }
                      : { background: "#0E151D", borderColor: "#2C3D50", color: "#E6EDF3" }
                  }
                >
                  {x.label}
                </button>
              );
            })}
          </div>
          <div role="group" aria-label="Rango de tiempo" className="flex gap-1 rounded-xl border border-[#243243] bg-[#0E151D] p-1">
            {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={r === range}
                onClick={() => {
                  setRange(r);
                  setHover(null);
                }}
                className={`min-h-[36px] rounded-[9px] px-3.5 py-1.5 text-sm ${r === range ? "bg-[#2C3D50] font-semibold text-[#E6EDF3]" : "text-[#93A4B5]"}`}
              >
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="rounded-xl bg-[#0E151D] px-3 py-2.5">
              <div className="text-xs text-[#93A4B5]">{s.label}</div>
              <div className="sd-num text-xl font-semibold">
                {s.value} <span className="text-xs font-normal text-[#93A4B5]">{s.unit}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-[999_1_560px] rounded-[14px] bg-[#0E151D] px-3 pb-1.5 pt-3">
            <div className="flex justify-between gap-2 px-1 pb-1.5 text-xs text-[#93A4B5]">
              <span>
                {m?.label}
                {m?.unit ? ` (${m.unit})` : ""} · {RANGE_LABEL[range]}
                {isBar ? ` · ${BAR_BUCKETS[range].label}` : ""}
              </span>
              {m?.limit != null && <span className="text-[#FFB089]">- - {m.limitLabel}</span>}
            </div>
            <div className="relative">
              <svg
                ref={svgRef}
                viewBox="0 0 640 250"
                role="img"
                aria-label={`Gráfica de ${m?.label} en ${RANGE_LABEL[range]}. Actual ${stats[0].value}${unitTxt}`}
                className="block h-auto w-full"
                onMouseMove={onMove}
                onMouseLeave={() => setHover(null)}
              >
                {yTicks.map((v, k) => {
                  const y = yAt(v);
                  return (
                    <g key={k}>
                      <line x1={X0} x2={X1} y1={y} y2={y} stroke="#1E2A37" strokeWidth="1" />
                      <text x="46" y={y + 4} textAnchor="end" fontSize="11" fill="#93A4B5" className="sd-num">
                        {fmt(v, tickDec)}
                      </text>
                    </g>
                  );
                })}
                {xTickTimes.map((t, k) => (
                  <text
                    key={k}
                    x={t.x}
                    y="246"
                    textAnchor={k === 0 ? "start" : k === xTickTimes.length - 1 ? "end" : "middle"}
                    fontSize="11"
                    fill="#93A4B5"
                    className="sd-num"
                  >
                    {t.label}
                  </text>
                ))}
                {m?.limit != null && (
                  <line x1={X0} x2={X1} y1={yAt(m.limit)} y2={yAt(m.limit)} stroke="#FF8A5C" strokeWidth="1.5" strokeDasharray="6 5" />
                )}
                {m?.limitMin != null && (
                  <line x1={X0} x2={X1} y1={yAt(m.limitMin)} y2={yAt(m.limitMin)} stroke="#FF8A5C" strokeWidth="1.5" strokeDasharray="6 5" />
                )}
                {deviceEvents.map((ev) => {
                  const x = X0 + ((new Date(ev.occurredAt).getTime() - from) / (now - from)) * (X1 - X0);
                  if (x < X0 || x > X1) return null;
                  const c = SEVERITY_META[ev.severity].color;
                  return (
                    <g key={ev.id}>
                      <title>{`${new Date(ev.occurredAt).toLocaleString("es-GT")} · ${ev.message}`}</title>
                      <line x1={x} x2={x} y1={Y0 + 8} y2={Y1} stroke={c} strokeWidth="1" strokeOpacity="0.55" strokeDasharray="2 3" />
                      <path d={`M${x - 5} ${Y0} L${x + 5} ${Y0} L${x} ${Y0 + 8} Z`} fill={c} />
                    </g>
                  );
                })}
                {!empty && !isBar && (
                  <>
                    <path d={areaD} fill={accent} fillOpacity="0.12" />
                    <path d={lineD} fill="none" stroke={accent} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                    <circle className="sd-glow" cx={pts[n - 1][0]} cy={pts[n - 1][1]} r="5" fill={accent} stroke="#0E151D" strokeWidth="2" />
                  </>
                )}
                {!empty &&
                  isBar &&
                  series.map((p, i) => {
                    const y = yAt(p.v);
                    return (
                      <rect
                        key={i}
                        x={X0 + i * slot + 1}
                        y={y}
                        width={Math.max(1, slot - 2)}
                        height={Math.max(0, Y1 - y)}
                        rx="2"
                        fill={i === hv ? "#FFC979" : accent}
                      />
                    );
                  })}
                {hv != null && !isBar && (
                  <>
                    <line x1={pts[hv][0]} x2={pts[hv][0]} y1={Y0} y2={Y1} stroke="#93A4B5" strokeWidth="1" strokeDasharray="3 3" />
                    <circle cx={pts[hv][0]} cy={pts[hv][1]} r="5" fill={accent} stroke="#E6EDF3" strokeWidth="2" />
                  </>
                )}
              </svg>
              {hv != null && (
                <div
                  className="pointer-events-none absolute whitespace-nowrap rounded-lg bg-[#E6EDF3] px-2.5 py-1.5 text-xs text-[#0B1117] shadow-[0_6px_20px_rgba(0,0,0,.35)]"
                  style={{
                    left: `${(pts[hv][0] / 640) * 100}%`,
                    top: `${(pts[hv][1] / 250) * 100}%`,
                    transform: "translate(-50%, calc(-100% - 12px))",
                  }}
                >
                  <div className="text-[#4A5868]">
                    {isBar ? (range === "7d" ? "Día " : "Desde ") : ""}
                    {fmtTime(series[hv].t, range, isBar)}
                  </div>
                  <div className="sd-num text-sm font-semibold">
                    {fmt(series[hv].v, isBar ? 0 : dec)}
                    {unitTxt}
                  </div>
                </div>
              )}
              {(loading || empty) && (
                <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-[#93A4B5]">
                  {loading
                    ? "Cargando historial…"
                    : "Todavía no hay historial suficiente para este rango. La API guarda una lectura por minuto de cada equipo que reporta el Agente Go."}
                </div>
              )}
            </div>
            <div className="mt-2 border-t border-[#1B2633] px-1 pt-2">
              <div className="flex items-center justify-between pb-1.5 text-xs text-[#93A4B5]">
                <span>Eventos de este equipo · {RANGE_LABEL[range]}</span>
                <span className="sd-num">{deviceEvents.length}</span>
              </div>
              {deviceEvents.length === 0 ? (
                <div className="pb-1.5 text-xs text-[#7D8FA1]">Sin eventos en este rango.</div>
              ) : (
                <ol className="flex max-h-[168px] flex-col overflow-y-auto">
                  {deviceEvents.slice(0, 50).map((ev) => (
                    <li key={ev.id} className="flex flex-wrap items-center gap-2 border-b border-[#1B2633] py-1.5 text-xs last:border-b-0">
                      <span className="sd-num w-[110px] shrink-0 text-[#93A4B5]">
                        {new Date(ev.occurredAt).toLocaleString("es-GT", { hour12: false, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <SeverityBadge severity={ev.severity} />
                      <span className="text-[#7D8FA1]">{categoryOf(ev.type).label}</span>
                      <span className="min-w-0 flex-1 text-[#E6EDF3]">{ev.message}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
          <div className="flex min-w-0 flex-[1_1_260px] flex-col">
            <div className="pb-1.5 text-[11px] uppercase tracking-wider text-[#93A4B5]">Lecturas actuales</div>
            {readingRows(device).map((r) => (
              <div key={r.label} className="flex justify-between gap-3 border-b border-[#1B2633] py-[7px] text-[13px]">
                <span className="text-[#B4C2D0]">{r.label}</span>
                <span className="sd-num">
                  {r.value} <span className="text-[11px] text-[#93A4B5]">{r.unit}</span>
                </span>
              </div>
            ))}
            {device.updatedAt && (
              <div className="pt-2 text-[11px] text-[#93A4B5]">
                Última lectura: {new Date(device.updatedAt).toLocaleString("es-GT")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
