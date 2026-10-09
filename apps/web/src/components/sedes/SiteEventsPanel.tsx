import { useMemo, useState } from "react";
import { useSiteEvents, type EventSeverity, type SiteEvent } from "../../api/siteEvents";
import { EVENT_CATEGORIES, SEVERITY_META, SeverityBadge, categoryOf, eventTime } from "./eventMeta";

/**
 * Pestaña Sedes > Eventos: historial de todo lo que detecto el Agente_Go de la sede (transferencias
 * del ATS, arranques de generador, alarmas por umbral y su normalizacion, puertas, sensores sin
 * comunicacion...), agrupado por dia, con filtros por categoria, severidad y rango.
 */

type Range = "24h" | "7d" | "30d";
const RANGE_MS: Record<Range, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const RANGE_LABEL: Record<Range, string> = { "24h": "24 horas", "7d": "7 días", "30d": "30 días" };

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Hoy";
  if (d.toDateString() === yesterday.toDateString()) return "Ayer";
  return d.toLocaleDateString("es-GT", { weekday: "long", day: "numeric", month: "long" });
}

export default function SiteEventsPanel({
  buildingKey,
  demoEvents,
  onOpenDevice,
}: {
  buildingKey: string;
  /** Eventos de demostracion cuando la sede todavia no tiene agente reportando. */
  demoEvents?: SiteEvent[];
  onOpenDevice?: (deviceId: string) => void;
}) {
  const [range, setRange] = useState<Range>("24h");
  const [category, setCategory] = useState<string>("all");
  const [severity, setSeverity] = useState<EventSeverity | "all">("all");
  // La ventana se recalcula al cambiar de rango; el refetch periodico trae lo nuevo.
  const from = useMemo(() => new Date(Date.now() - RANGE_MS[range]).toISOString(), [range]);

  const { data, isLoading, isError } = useSiteEvents(demoEvents ? null : buildingKey, {
    from,
    limit: 1000,
    ...(severity !== "all" ? { severity } : {}),
  });

  const all = demoEvents ?? data?.events ?? [];
  const inRange = all.filter((e) => new Date(e.occurredAt).getTime() >= Date.now() - RANGE_MS[range]);
  const bySeverity = severity === "all" ? inRange : inRange.filter((e) => e.severity === severity);
  const shown = category === "all" ? bySeverity : bySeverity.filter((e) => categoryOf(e.type).key === category);

  const counts = { critical: 0, warning: 0, info: 0 } as Record<EventSeverity, number>;
  for (const e of inRange) counts[e.severity] += 1;

  const groups: { day: string; events: SiteEvent[] }[] = [];
  for (const e of shown) {
    const day = dayLabel(e.occurredAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.events.push(e);
    else groups.push({ day, events: [e] });
  }

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Resumen de eventos" className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        {(["critical", "warning", "info"] as EventSeverity[]).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={severity === s}
            onClick={() => setSeverity(severity === s ? "all" : s)}
            className="rounded-[14px] border bg-[#121A23] p-4 text-left transition-colors hover:border-[#3A4E64]"
            style={{ borderColor: severity === s ? SEVERITY_META[s].color : "#243243" }}
          >
            <div className="text-[13px] text-[#93A4B5]">
              {SEVERITY_META[s].label} · {RANGE_LABEL[range]}
            </div>
            <div className="sd-num text-[26px] font-semibold" style={{ color: counts[s] > 0 ? SEVERITY_META[s].color : "#E6EDF3" }}>
              {counts[s]}
            </div>
          </button>
        ))}
        <div className="rounded-[14px] border border-[#243243] bg-[#121A23] p-4">
          <div className="text-[13px] text-[#93A4B5]">Detectados por</div>
          <div className="text-lg font-semibold">Agente Go · en tiempo real</div>
          <div className="text-xs text-[#93A4B5]">Cada lectura Modbus y cada uplink LoRaWAN</div>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Categoría" className="flex flex-wrap gap-2">
          {[{ key: "all", label: "Todos", icon: null as JSX.Element | null }, ...EVENT_CATEGORIES].map((c) => {
            const on = category === c.key;
            const n = c.key === "all" ? bySeverity.length : bySeverity.filter((e) => categoryOf(e.type).key === c.key).length;
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={on}
                onClick={() => setCategory(c.key)}
                className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm ${
                  on ? "border-[#E6EDF3] bg-[#E6EDF3] font-semibold text-[#0B1117]" : "border-[#2C3D50] bg-[#121A23] text-[#E6EDF3] hover:border-[#3A4E64]"
                }`}
              >
                {c.icon}
                {c.label} <span className="sd-num opacity-75">{n}</span>
              </button>
            );
          })}
        </div>
        <div role="group" aria-label="Rango" className="flex gap-1 rounded-xl border border-[#243243] bg-[#0E151D] p-1">
          {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={r === range}
              onClick={() => setRange(r)}
              className={`min-h-[36px] rounded-[9px] px-3.5 py-1.5 text-sm ${r === range ? "bg-[#2C3D50] font-semibold text-[#E6EDF3]" : "text-[#93A4B5]"}`}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      <section aria-label="Historial de eventos" aria-live="polite" className="flex flex-col gap-4">
        {isLoading && !demoEvents && <div className="text-sm text-[#93A4B5]">Cargando eventos…</div>}
        {isError && !demoEvents && <div className="text-sm text-[#FF8A7A]">No se pudieron cargar los eventos.</div>}
        {!isLoading && shown.length === 0 && (
          <div className="rounded-[14px] border border-dashed border-[#2C3D50] bg-[#121A23] p-8 text-center text-[#93A4B5]">
            Sin eventos en este rango. El Agente Go registra aquí cada cambio de estado y cada alarma en cuanto ocurre.
          </div>
        )}
        {groups.map((g) => (
          <div key={g.day} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#93A4B5]">
              {g.day} <span className="sd-num font-normal">· {g.events.length}</span>
            </h3>
            <ol className="flex flex-col overflow-hidden rounded-[14px] border border-[#243243] bg-[#121A23]">
              {g.events.map((e) => {
                const cat = categoryOf(e.type);
                const sev = SEVERITY_META[e.severity];
                return (
                  <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#1B2633] px-4 py-2.5 last:border-b-0">
                    <span className="sd-num w-[68px] shrink-0 text-xs text-[#93A4B5]">{eventTime(e)}</span>
                    <span
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                      style={{ color: sev.color, background: sev.bg }}
                      title={cat.label}
                    >
                      {cat.icon}
                    </span>
                    <SeverityBadge severity={e.severity} />
                    <span className="min-w-0 flex-[1_1_320px] text-sm text-[#E6EDF3]">{e.message}</span>
                    {e.deviceId && onOpenDevice ? (
                      <button
                        type="button"
                        onClick={() => onOpenDevice(e.deviceId!)}
                        className="shrink-0 rounded-md px-2 py-1 text-xs text-[#8FB8FF] hover:bg-[#182330] hover:text-[#B9D2FF]"
                      >
                        Ver tendencias
                      </button>
                    ) : null}
                    <span className="sd-num shrink-0 text-[11px] text-[#7D8FA1]">{e.type}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </section>
    </div>
  );
}
