import { useState } from "react";
import { useDeviceHistory, type HistoryRange } from "../api/devices";
import TrendChart, { type TrendPoint } from "./TrendChart";
import ThinkingIndicator from "./ThinkingIndicator";

const RANGES: { value: HistoryRange; label: string }[] = [
  { value: "today", label: "Hoy" },
  { value: "7d", label: "7 dias" },
  { value: "15d", label: "15 dias" },
  { value: "30d", label: "1 mes" },
];

// Paleta categorica validada (dataviz skill, pasos "dark"): una tonalidad fija por metrica,
// consistente entre paneles - la identidad la da el titulo de cada panel, no el color.
const METRICS: { key: string; title: string; unit: string; color: string; digits: number }[] = [
  { key: "co2", title: "CO2", unit: "ppm", color: "#3987e5", digits: 0 },
  { key: "temperature", title: "Temperatura", unit: "°C", color: "#d95926", digits: 1 },
  { key: "humidity", title: "Humedad", unit: "%", color: "#199e70", digits: 0 },
  { key: "pm2_5", title: "PM2.5", unit: "µg/m³", color: "#c98500", digits: 0 },
  { key: "pm10", title: "PM10", unit: "µg/m³", color: "#d55181", digits: 0 },
  { key: "tvoc", title: "TVOC", unit: "mg/m³", color: "#008300", digits: 2 },
];

export default function DeviceTrendModal({
  deviceId,
  deviceName,
  onClose,
}: {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}) {
  const [range, setRange] = useState<HistoryRange>("today");
  const { data, isLoading, isError } = useDeviceHistory(deviceId, range);

  const metricsWithData = METRICS.filter((m) => data?.points.some((p) => typeof p[m.key] === "number"));

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="font-semibold text-slate-100">Tendencias · {deviceName}</h2>
            <p className="text-xs text-slate-500">Historico de lecturas por fecha</p>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200">
            ✕
          </button>
        </div>

        <div className="flex items-center gap-1 border-b border-slate-800 px-5 py-3">
          {RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                range === r.value ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              }`}
            >
              {r.label}
            </button>
          ))}
          {isLoading && (
            <span className="ml-2 flex items-center gap-1.5 text-xs text-slate-500">
              <ThinkingIndicator size={14} />
              Cargando...
            </span>
          )}
        </div>

        <div className="overflow-y-auto p-5">
          {isError && <p className="text-sm text-red-400">No se pudo cargar el historico.</p>}

          {!isLoading && !isError && (data?.points.length ?? 0) === 0 && (
            <p className="text-sm text-slate-500">
              Aun no hay lecturas guardadas en este periodo. El historico se empezo a registrar recien, dale tiempo a
              que se acumulen datos (cada lectura que llegue del sensor se guarda desde ahora).
            </p>
          )}

          {!isError && metricsWithData.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {metricsWithData.map((m) => {
                const points: TrendPoint[] = (data?.points ?? [])
                  .filter((p) => typeof p[m.key] === "number")
                  .map((p) => ({ t: new Date(p.t).getTime(), v: Number((p[m.key] as number).toFixed(m.digits)) }));
                const latest = points.length ? points[points.length - 1].v : undefined;
                return (
                  <TrendChart key={m.key} title={m.title} unit={m.unit} color={m.color} points={points} range={range} latest={latest} />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
