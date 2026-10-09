/**
 * Ilustraciones de los equipos de la pestaña Sedes (diseño aprobado: opcion B "equipos
 * realistas" + anillos de la opcion C). Son SVG puros y dinamicos: el generador vibra y echa humo
 * cuando el motor gira, las pantallas LCD muestran la lectura en vivo, la puerta se abre.
 * Las animaciones viven en index.css (clases sd-*) y respetan prefers-reduced-motion.
 */

const RING_C = 188.5; // 2πr con r=30

export function ringDash(pct: number, circumference = RING_C) {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return `${((p / 100) * circumference).toFixed(1)} ${circumference}`;
}

export function RingGauge({
  size,
  pct,
  color,
  label,
  sub,
  inner,
  stroke = 8,
  ariaLabel,
}: {
  size: number;
  pct: number;
  color: string;
  label: string;
  sub?: string;
  /** Segundo anillo interior (ej. combustible del generador). */
  inner?: { pct: number; color: string };
  stroke?: number;
  ariaLabel: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" role="img" aria-label={ariaLabel} className="shrink-0">
      <circle cx="40" cy="40" r="30" fill="none" stroke="#1E2A37" strokeWidth={stroke} />
      <circle
        className="sd-ring"
        cx="40"
        cy="40"
        r="30"
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={ringDash(pct)}
        transform="rotate(-90 40 40)"
      />
      {inner && (
        <>
          <circle cx="40" cy="40" r="21" fill="none" stroke="#1E2A37" strokeWidth="4" />
          <circle
            className="sd-ring"
            cx="40"
            cy="40"
            r="21"
            fill="none"
            stroke={inner.color}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={ringDash(inner.pct, 131.9)}
            transform="rotate(-90 40 40)"
          />
        </>
      )}
      <text x="40" y={sub ? 40 : 46} textAnchor="middle" fontSize={sub ? 13 : 18} className="sd-lcd" fill="#E6EDF3">
        {label}
      </text>
      {sub && (
        <text x="40" y="52" textAnchor="middle" fontSize="8" fill="#93A4B5">
          {sub}
        </text>
      )}
    </svg>
  );
}

export function GeneratorArt({ running, lcd, compact }: { running: boolean; lcd: string; compact?: boolean }) {
  const led = running ? "#FFB547" : "#4CC38A";
  if (compact) {
    return (
      <svg width="64" height="52" viewBox="0 0 64 52" aria-hidden="true" className="shrink-0">
        {running && (
          <>
            <circle className="sd-puff" cx="52" cy="5" r="3" fill="#8C96A3" />
            <circle className="sd-puff sd-puff-2" cx="52" cy="5" r="3" fill="#8C96A3" />
          </>
        )}
        <g className={running ? "sd-vib" : undefined}>
          <rect x="49" y="5" width="6" height="11" rx="1" fill="#59626E" />
          <rect x="4" y="14" width="56" height="32" rx="3" fill="#E9B949" stroke="#9C7420" />
          <rect x="34" y="19" width="22" height="22" rx="1.5" fill="#D9A73E" />
          {[22, 27, 32, 37].map((y) => (
            <rect key={y} x="36" y={y} width="18" height="2" fill="#9C7420" />
          ))}
          <rect x="8" y="19" width="22" height="22" rx="1.5" fill="#F3CB66" />
          <rect x="11" y="22" width="16" height="8" rx="1" fill="#0F1C28" />
          <circle className={running ? "sd-blink" : undefined} cx="14" cy="35" r="2.4" fill={led} />
        </g>
        <rect x="2" y="46" width="60" height="4" rx="1" fill="#2E3742" />
      </svg>
    );
  }
  return (
    <svg width="160" height="106" viewBox="0 0 120 80" aria-hidden="true" className="shrink-0">
      <rect x="4" y="70" width="112" height="6" rx="1.5" fill="#2E3742" />
      {running && (
        <>
          <circle className="sd-puff" cx="96" cy="6" r="4" fill="#8C96A3" />
          <circle className="sd-puff sd-puff-2" cx="96" cy="6" r="4" fill="#8C96A3" />
          <circle className="sd-puff sd-puff-3" cx="96" cy="6" r="4" fill="#8C96A3" />
        </>
      )}
      <g className={running ? "sd-vib" : undefined}>
        <rect x="92" y="6" width="8" height="16" rx="1" fill="#59626E" />
        <rect x="90.5" y="5" width="11" height="3" rx="1" fill="#474F5A" />
        <rect x="8" y="18" width="104" height="7" rx="2" fill="#D19A2E" />
        <rect x="10" y="24" width="100" height="46" rx="3" fill="#E9B949" stroke="#9C7420" strokeWidth="1" />
        <rect x="62" y="30" width="42" height="34" rx="2" fill="#D9A73E" />
        {[33, 38, 43, 48, 53, 58].map((y) => (
          <rect key={y} x="65" y={y} width="36" height="2.4" rx="1" fill="#9C7420" />
        ))}
        <rect x="16" y="30" width="40" height="34" rx="2" fill="#F3CB66" stroke="#9C7420" strokeWidth="0.8" />
        <rect x="21" y="34" width="30" height="13" rx="1.5" fill="#0F1C28" />
        <text x="36" y="43.5" textAnchor="middle" fontSize="7.5" className="sd-lcd" fill="#7CF0B0">
          {lcd}
        </text>
        <circle className={running ? "sd-blink" : undefined} cx="25" cy="54" r="2.6" fill={led} />
        <circle cx="33" cy="54" r="2.6" fill="#3A2A0E" />
        <rect x="40" y="51.5" width="11" height="5" rx="1" fill="#C0392B" />
      </g>
    </svg>
  );
}

export function IonArt({
  lcdMain,
  lcdSub,
  phases,
  compact,
}: {
  lcdMain: string;
  lcdSub: string;
  /** Fraccion 0..1 de cada fase respecto a la mayor, para las barras de la pantalla. */
  phases: number[];
  compact?: boolean;
}) {
  if (compact) {
    return (
      <svg width="48" height="48" viewBox="0 0 52 52" aria-hidden="true" className="shrink-0">
        <rect x="1" y="1" width="50" height="50" rx="5" fill="#2B3038" stroke="#454D58" />
        <rect x="6" y="6" width="40" height="26" rx="2" fill="#9FD3F2" />
        <text x="26" y="23" textAnchor="middle" fontSize="10" className="sd-lcd" fill="#0B2233">
          {lcdMain}
        </text>
        {[8, 18, 28].map((x) => (
          <rect key={x} x={x} y="37" width="7" height="5" rx="1.5" fill="#3A414B" />
        ))}
        <circle className="sd-blink" cx="42" cy="40" r="2" fill="#4CC38A" />
      </svg>
    );
  }
  return (
    <svg width="96" height="96" viewBox="0 0 80 80" aria-hidden="true" className="shrink-0">
      <rect x="2" y="2" width="76" height="76" rx="7" fill="#2B3038" stroke="#454D58" />
      <rect x="6" y="6" width="68" height="68" rx="5" fill="#1C2026" />
      <rect x="11" y="10" width="58" height="38" rx="2" fill="#9FD3F2" />
      <rect x="11" y="10" width="58" height="7" rx="2" fill="#86C3E8" />
      <text x="14" y="15.5" fontSize="4.6" className="sd-lcd" fill="#0B2233">
        kW TOTAL
      </text>
      <text x="14" y="34" fontSize="11" className="sd-lcd" fill="#0B2233">
        {lcdMain}
      </text>
      <text x="14" y="44" fontSize="4.6" className="sd-lcd" fill="#24465E">
        {lcdSub}
      </text>
      {phases.map((f, p) => {
        const h = Math.max(1, Math.min(1, f) * 22);
        return <rect key={p} className="sd-bar" x={52 + p * 5.5} y={44 - h} width="4" height={h} fill="#0B2233" />;
      })}
      {[12, 26, 40, 54].map((x) => (
        <rect key={x} x={x} y="56" width="11" height="7" rx="2" fill="#3A414B" />
      ))}
      <text x="12" y="71" fontSize="4.2" fill="#8A93A0">
        ION7400
      </text>
      <circle className="sd-blink" cx="68" cy="69" r="1.8" fill="#4CC38A" />
    </svg>
  );
}

export function PmArt({ lines, compactValue, compact }: { lines: string[]; compactValue: string; compact?: boolean }) {
  if (compact) {
    return (
      <svg width="44" height="44" viewBox="0 0 46 46" aria-hidden="true" className="shrink-0">
        <rect x="1" y="1" width="44" height="44" rx="3" fill="#D5DAE0" stroke="#A8B0BA" />
        <rect x="6" y="6" width="34" height="20" rx="1.5" fill="#C8E6A0" />
        <text x="23" y="20" textAnchor="middle" fontSize="8.5" className="sd-lcd" fill="#24331A">
          {compactValue}
        </text>
        {[12, 20, 28].map((x) => (
          <circle key={x} cx={x} cy="34" r="2.6" fill="#5A636E" />
        ))}
        <circle className="sd-blink" cx="37" cy="38" r="1.6" fill="#2E9E62" />
      </svg>
    );
  }
  return (
    <svg width="84" height="84" viewBox="0 0 80 80" aria-hidden="true" className="shrink-0">
      <rect x="2" y="2" width="76" height="76" rx="4" fill="#D5DAE0" stroke="#A8B0BA" />
      <rect x="6" y="6" width="68" height="68" rx="3" fill="#C3C9D1" />
      <rect x="12" y="11" width="56" height="36" rx="2" fill="#C8E6A0" />
      {lines.slice(0, 3).map((l, i) => (
        <text key={i} x="15" y={21 + i * 10} fontSize="6.6" className="sd-lcd" fill="#24331A">
          {l}
        </text>
      ))}
      {[18, 32, 46, 60].map((x) => (
        <circle key={x} cx={x} cy="58" r="4" fill="#5A636E" />
      ))}
      <text x="12" y="71" fontSize="4.4" fill="#4A535E">
        PM2130
      </text>
      <circle className="sd-blink" cx="66" cy="70" r="1.8" fill="#2E9E62" />
    </svg>
  );
}

export function DoorArt({ open, label }: { open: boolean; label: string }) {
  return (
    <svg width="44" height="50" viewBox="0 0 44 50" role="img" aria-label={label} className="shrink-0">
      <rect x="4" y="3" width="26" height="44" rx="1.5" fill="#0B1117" stroke="#4A5868" strokeWidth="1.5" />
      <g className={open ? "sd-open" : undefined}>
        <rect className="sd-door-panel" x="5" y="4" width="24" height="42" fill={open ? "#F2A33A" : "#5B6B7C"} />
      </g>
      <circle cx="25" cy="26" r="1.5" fill="#1C2026" />
      <rect x="32" y="16" width="6" height="14" rx="1.5" fill="#E6EDF3" />
      <circle cx="35" cy="20" r="1.4" fill={open ? "#FFB547" : "#4CC38A"} />
    </svg>
  );
}

export function EvaArt({ lcd }: { lcd: string }) {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
      <rect x="8" y="5" width="48" height="54" rx="9" fill="#E9EDF1" stroke="#B5BEC8" />
      <rect x="14" y="13" width="36" height="22" rx="3" fill="#18232E" />
      <text x="32" y="29" textAnchor="middle" fontSize="11" className="sd-lcd" fill="#9FE6C8">
        {lcd}
      </text>
      {[20, 26, 32, 38, 44].map((x) => (
        <circle key={x} cx={x} cy="45" r="1.3" fill="#9AA5B1" />
      ))}
      <circle className="sd-blink" cx="48" cy="52" r="1.6" fill="#2E9E62" />
    </svg>
  );
}

export function WiseArt({ active }: { active: boolean[] }) {
  return (
    <svg width="64" height="60" viewBox="0 0 64 60" aria-hidden="true" className="shrink-0">
      <rect x="48" y="2" width="5" height="18" rx="2.5" fill="#2B3038" />
      <rect x="6" y="14" width="50" height="40" rx="4" fill="#C9CFD6" stroke="#8C96A3" />
      <rect x="10" y="18" width="42" height="9" rx="1.5" fill="#1F4E8C" />
      <text x="31" y="24.5" textAnchor="middle" fontSize="5" fill="#E6EDF3">
        WISE
      </text>
      {active.slice(0, 4).map((on, k) => (
        <circle key={k} cx={16 + k * 8} cy="34" r="2" fill={on ? "#4CC38A" : "#3A414B"} />
      ))}
      <rect x="10" y="42" width="42" height="8" rx="1" fill="#2E9E62" />
      {[15, 23, 31, 39, 47].map((x) => (
        <circle key={x} cx={x} cy="46" r="1.6" fill="#1B5E3A" />
      ))}
    </svg>
  );
}

export function AirArt() {
  return (
    <svg width="60" height="60" viewBox="0 0 60 60" aria-hidden="true" className="shrink-0">
      <circle cx="30" cy="30" r="26" fill="#E9EDF1" stroke="#B5BEC8" />
      <circle cx="30" cy="30" r="16" fill="none" stroke="#C3CAD3" strokeWidth="2" />
      <path d="M22 24h16M20 30h20M22 36h16" stroke="#9AA5B1" strokeWidth="2" strokeLinecap="round" />
      <circle className="sd-blink" cx="30" cy="48" r="1.8" fill="#2E9E62" />
    </svg>
  );
}

export function TrendIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3v18h18" />
      <path d="m7 15 4-5 3 3 5-7" />
    </svg>
  );
}
