import type { EventSeverity, SiteEvent } from "../../api/siteEvents";

/** Categorias de eventos (por prefijo de type) para filtros, iconos y etiquetas de la pestaña Eventos. */
export interface EventCategory {
  key: string;
  label: string;
  prefixes: string[];
  icon: JSX.Element;
}

const svg = (d: string) => (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

export const EVENT_CATEGORIES: EventCategory[] = [
  { key: "energy", label: "Energía", prefixes: ["energy.", "power."], icon: svg("M13 2 4 14h7l-1 8 9-12h-7l1-8Z") },
  { key: "generator", label: "Generadores", prefixes: ["generator."], icon: svg("M3 8h14v10H3zM17 11h3v5M6 8V6h6v2M10 10l-2 3h3l-2 3") },
  { key: "door", label: "Puertas", prefixes: ["door."], icon: svg("M5 21V3h11v18M16 21h3M12 12h.01") },
  { key: "env", label: "Ambiente", prefixes: ["env.", "air."], icon: svg("M14 14.8V4a2 2 0 1 0-4 0v10.8a4 4 0 1 0 4 0Z") },
  { key: "io", label: "Entradas WISE", prefixes: ["io."], icon: svg("M4 7h16M4 12h16M4 17h10") },
  { key: "coldchain", label: "Cadena de frío", prefixes: ["coldchain."], icon: svg("M12 2v20M4.9 6l14.2 12M4.9 18 19.1 6") },
  { key: "discovery", label: "Descubrimiento", prefixes: ["discovery.", "lorawan.join"], icon: svg("M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM21 21l-5-5") },
  { key: "comms", label: "Comunicación", prefixes: ["device.", "lorawan.", "sensor."], icon: svg("M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01") },
];

export function categoryOf(type: string): EventCategory {
  return EVENT_CATEGORIES.find((c) => c.prefixes.some((p) => type.startsWith(p))) ?? EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

export const SEVERITY_META: Record<EventSeverity, { label: string; color: string; bg: string; border: string }> = {
  critical: { label: "Crítico", color: "#FF8A7A", bg: "#2A1210", border: "#7A2A22" },
  warning: { label: "Advertencia", color: "#FFC979", bg: "#2A1E0C", border: "#7A4A12" },
  info: { label: "Info", color: "#A9C8FF", bg: "#13213A", border: "#22406E" },
};

export function SeverityBadge({ severity }: { severity: EventSeverity }) {
  const m = SEVERITY_META[severity];
  return (
    <span className="whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold" style={{ color: m.color, background: m.bg, borderColor: m.border }}>
      {m.label}
    </span>
  );
}

export function eventTime(e: SiteEvent) {
  return new Date(e.occurredAt).toLocaleTimeString("es-GT", { hour12: false });
}
