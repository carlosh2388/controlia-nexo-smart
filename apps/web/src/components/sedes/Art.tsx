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

const FRIDGE_TONE = { ok: "#7CF0B4", warn: "#FF8A5C", fault: "#FFC979" } as const;

/**
 * Refrigerador / congelador de cadena de frio. Las puertas (1 o 2, una por sensor LEO S595 con el
 * mismo codigo de equipo) se abren en el dibujo cuando su sensor reporta "abierta": se ve el
 * interior iluminado con sus repisas. El display de la puerta muestra la temperatura del WISE.
 */
export function FridgeArt({
  variant,
  open,
  lcd,
  tone,
  label,
  lifted = false,
}: {
  /** Resaltado en 3D: se dibujan el costado y el techo del gabinete (volumen). */
  lifted?: boolean;
  variant: "fridge" | "freezer";
  /** Un elemento por puerta; si no hay sensor de puerta, [false]. */
  open: boolean[];
  lcd: string;
  tone: keyof typeof FRIDGE_TONE;
  label: string;
}) {
  const two = open.length >= 2;
  const anyOpen = open.some(Boolean);
  const body = variant === "freezer" ? ["#E3EEF7", "#A9BED2"] : ["#F1F4F7", "#C3CBD4"];
  const gid = `fr-${variant}`;
  const door = (x: number, w: number, isOpen: boolean, right: boolean, k: number) => (
    <g key={k} className={isOpen ? "sd-open" : undefined}>
      <g className={right ? "sd-fdoor-r" : "sd-fdoor-l"}>
        <rect x={x} y="13" width={w} height="60" rx="1.5" fill={`url(#${gid}-door)`} stroke="#9AA6B3" strokeWidth="0.6" />
        <rect x={right ? x + 2.2 : x + w - 4.2} y="30" width="2" height="16" rx="1" fill="#7D8896" />
      </g>
    </g>
  );
  return (
    <svg width="58" height="78" viewBox="0 0 64 84" role="img" aria-label={label} className="shrink-0">
      <defs>
        <linearGradient id={`${gid}-body`} x1="0" x2="1">
          <stop offset="0" stopColor={body[0]} />
          <stop offset="1" stopColor={body[1]} />
        </linearGradient>
        <linearGradient id={`${gid}-door`} x1="0" x2="1">
          <stop offset="0" stopColor={body[0]} />
          <stop offset="0.85" stopColor={body[1]} />
          <stop offset="1" stopColor="#9DA8B4" />
        </linearGradient>
      </defs>
      <ellipse cx="32" cy="80" rx="24" ry="2.6" fill="#05090D" opacity={lifted ? 0 : 0.6} className="sd-fade" />
      {/* volumen 3D: costado derecho y techo, solo cuando el equipo esta resaltado */}
      <g className="sd-fade" style={{ opacity: lifted ? 1 : 0 }}>
        <path d="M56 4 L62.5 1 L62.5 73.5 L56 77 Z" fill={variant === "freezer" ? "#7F98AF" : "#9AA5B1"} stroke="#6B7684" strokeWidth="0.6" />
        <path d="M8 4 L14.5 1 L62.5 1 L56 4 Z" fill={variant === "freezer" ? "#F4FAFF" : "#FFFFFF"} stroke="#8C96A3" strokeWidth="0.6" />
        <path d="M58 20 L61.5 18.3 M58 40 L61.5 38.3 M58 60 L61.5 58.3" stroke="#6B7684" strokeWidth="0.6" />
      </g>
      <rect x="6" y="3" width="52" height="74" rx="4" fill={`url(#${gid}-body)`} stroke="#7F8B98" />
      {/* interior: oscuro cerrado, iluminado al abrir */}
      <rect x="9" y="13" width="46" height="60" rx="1.5" fill="#0C1620" />
      <rect x="9" y="13" width="46" height="60" rx="1.5" fill="#DCF2FF" className="sd-fade" style={{ opacity: anyOpen ? 1 : 0 }} />
      {[28, 43, 58].map((y) => (
        <line key={y} x1="10" x2="54" y1={y} y2={y} stroke={anyOpen ? "#8FB3CC" : "#1E2A36"} strokeWidth="1.2" />
      ))}
      {/* insumos en las repisas (se ven solo con la puerta abierta) */}
      <g className="sd-fade" style={{ opacity: anyOpen ? 0.9 : 0 }}>
        {(
          [
            [12, 21, 7, "#E05D5D"],
            [19, 23, 5, "#5B9BFF"],
            [25, 22, 6, "#E05D5D"],
            [35, 37, 6, "#F2A33A"],
            [42, 38, 5, "#4CC38A"],
            [48, 36, 7, "#5B9BFF"],
            [14, 52, 6, "#A99BFF"],
            [21, 53, 5, "#F2A33A"],
            [40, 51, 7, "#E05D5D"],
          ] as const
        ).map(([x, y, h, c], i) => (
          <rect key={i} x={x} y={y} width="4.5" height={h} rx="1" fill={c} />
        ))}
      </g>
      {two ? [door(9, 23, open[0], false, 0), door(32, 23, open[1], true, 1)] : door(9, 46, open[0], false, 0)}
      {/* panel superior con display */}
      <rect x="9" y="5.5" width="46" height="6" rx="1.2" fill="#141C25" />
      <text x="29" y="10.4" textAnchor="middle" fontSize="5.2" className="sd-lcd" fill={FRIDGE_TONE[tone]}>
        {lcd}
      </text>
      <circle className={tone === "ok" && !anyOpen ? "sd-blink" : undefined} cx="51.5" cy="8.5" r="1.3" fill={anyOpen || tone !== "ok" ? "#FFB547" : "#4CC38A"} />
      {variant === "freezer" && (
        <path d="M14 18v6M11.4 19.5l5.2 3M16.6 19.5l-5.2 3" stroke="#5B9BFF" strokeWidth="0.9" strokeLinecap="round" opacity={anyOpen ? 0 : 0.9} />
      )}
      <rect x="10" y="77" width="5" height="3" rx="1" fill="#4A5563" />
      <rect x="49" y="77" width="5" height="3" rx="1" fill="#4A5563" />
    </svg>
  );
}

/**
 * Dial de aguja (manometro / termometro de proceso) para canales 4-20 mA que no son cadena de frio.
 * Escala = rango del transmisor segun su formula (valor a 4 y a 20 mA); franja verde = rango permitido.
 */
export function DialGauge({
  value,
  scaleMin,
  scaleMax,
  lo,
  hi,
  unit,
  fault,
  accent,
  label,
}: {
  value: number | null;
  scaleMin: number;
  scaleMax: number;
  lo: number | null;
  hi: number | null;
  unit: string;
  fault: boolean;
  accent: string;
  label: string;
}) {
  const cx = 70;
  const cy = 60;
  const r = 47;
  const A0 = 150;
  const SPAN = 240;
  const span = scaleMax - scaleMin || 1;
  const ang = (v: number) => A0 + (Math.max(0, Math.min(1, (v - scaleMin) / span)) * SPAN);
  const pt = (a: number, rr = r) => [cx + rr * Math.cos((a * Math.PI) / 180), cy + rr * Math.sin((a * Math.PI) / 180)] as const;
  const arc = (a1: number, a2: number, rr = r) => {
    const [x1, y1] = pt(a1, rr);
    const [x2, y2] = pt(a2, rr);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${rr} ${rr} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };
  const out = !fault && value != null && ((lo != null && value < lo) || (hi != null && value > hi));
  const needleAngle = fault || value == null ? A0 : ang(value);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => scaleMin + f * span);
  const color = fault ? "#FFC979" : out ? "#FF8A5C" : "#E6EDF3";
  return (
    <svg width="150" height="128" viewBox="0 0 140 120" role="img" aria-label={label} className="shrink-0">
      <circle cx={cx} cy={cy} r={r + 9} fill="#0B1117" stroke="#2A3746" strokeWidth="1.5" />
      <circle cx={cx} cy={cy} r={r + 5} fill="none" stroke="#18222D" strokeWidth="1" />
      <path d={arc(A0, A0 + SPAN)} fill="none" stroke="#1E2A36" strokeWidth="7" strokeLinecap="round" />
      {lo != null && hi != null && hi > lo && (
        <path d={arc(ang(lo), ang(hi))} fill="none" stroke="#2E9E62" strokeWidth="7" opacity="0.85" />
      )}
      {ticks.map((t, i) => {
        const a = ang(t);
        const [x1, y1] = pt(a, r - 6);
        const [x2, y2] = pt(a, r - 12);
        const [tx, ty] = pt(a, r - 21);
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#5A6B7C" strokeWidth="1.4" />
            <text x={tx} y={ty + 2.5} textAnchor="middle" fontSize="7" fill="#7D8FA1" className="sd-num">
              {Math.round(t)}
            </text>
          </g>
        );
      })}
      <g style={{ transform: `rotate(${needleAngle}deg)`, transformOrigin: `${cx}px ${cy}px` }} className="sd-needle">
        <path d={`M${cx - 6} ${cy - 2} L${cx + r - 8} ${cy} L${cx - 6} ${cy + 2} Z`} fill={fault ? "#5A6B7C" : accent} />
      </g>
      <circle cx={cx} cy={cy} r="5" fill="#1B2633" stroke={fault ? "#5A6B7C" : accent} strokeWidth="1.5" />
      <rect x={cx - 26} y={cy + 23} width="52" height="25" rx="5" fill="#141C25" stroke="#22303E" />
      <text x={cx} y={cy + 37.5} textAnchor="middle" fontSize={fault ? 9 : 13} fontWeight="600" className="sd-num" fill={color}>
        {fault ? "Sin señal" : value == null ? "—" : value.toFixed(1)}
      </text>
      {!fault && (
        <text x={cx} y={cy + 45.5} textAnchor="middle" fontSize="6.5" fill="#93A4B5">
          {unit}
        </text>
      )}
    </svg>
  );
}

/**
 * Milesight LEO S592 (calidad de aire) dibujado como el equipo real: carcasa blanca cuadrada y
 * pantalla de tinta electronica con fecha/hora, CO2 con su grafica 200-1500 ppm, carita de confort,
 * PM2.5/PM10, temperatura y humedad; abajo el sensor de luz, el boton y el LED. Cuando cambia el
 * CO2 la pantalla hace el "refresco" tipico del e-ink. Con lifted se dibujan costado y techo (3D).
 */
export function Leo592Art({
  co2,
  temperature,
  humidity,
  pm25,
  pm10,
  bars,
  alert,
  lifted = false,
  label,
}: {
  co2: number | null;
  temperature: number | null;
  humidity: number | null;
  pm25: number | null;
  pm10: number | null;
  /** Historial de CO2 (ppm), el mas reciente al final. */
  bars: number[];
  alert: boolean;
  lifted?: boolean;
  label: string;
}) {
  const ink = "#1E2226";
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const date = `${p2(now.getMonth() + 1)}/${p2(now.getDate())}/${now.getFullYear()}`;
  const face = co2 == null ? "neutral" : alert ? "sad" : co2 > 1000 ? "neutral" : "happy";
  const SLOTS = 34;
  const shown = bars.slice(-SLOTS);
  const yOf = (v: number) => 104 - (Math.max(0, Math.min(1, (v - 200) / 1300)) * 32);
  const f = (v: number | null, dec: number) => (v == null || !Number.isFinite(v) ? "--" : v.toFixed(dec));
  return (
    <svg width="176" height="176" viewBox="0 0 200 200" role="img" aria-label={label} className="shrink-0">
      <defs>
        <linearGradient id="leo-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#DDE2E7" />
        </linearGradient>
      </defs>
      <ellipse cx="100" cy="194" rx="80" ry="4" fill="#05090D" opacity={lifted ? 0 : 0.55} className="sd-fade" />
      <g className="sd-fade" style={{ opacity: lifted ? 1 : 0 }}>
        <path d="M186 15 L196 8 L196 181 L186 189 Z" fill="#BCC4CC" stroke="#A3ACB6" strokeWidth="0.8" />
        <path d="M18 15 L28 8 L196 8 L186 15 Z" fill="#FFFFFF" stroke="#C5CCD3" strokeWidth="0.8" />
      </g>
      <rect x="12" y="14" width="176" height="176" rx="18" fill="url(#leo-body)" stroke="#C3CAD2" />
      <circle cx="166" cy="20.5" r="3" fill="#F2F4F6" stroke="#CDD3D9" strokeWidth="0.8" />
      {/* marco y pantalla e-ink */}
      <rect x="23" y="26" width="154" height="122" rx="7" fill="#F4F6F7" stroke="#D3D8DD" />
      <rect x="28" y="30" width="144" height="113" rx="2" fill="#D9DDD7" />
      <g key={co2 ?? "x"} className="sd-eink" fill={ink}>
        {/* barra superior: fecha y hora */}
        <text x="31.5" y="38" fontSize="6.4" className="sd-lcd">
          {date}
        </text>
        <text x="78" y="38" fontSize="6.4" className="sd-lcd">
          {p2(now.getHours())}
          <tspan className="sd-blink">:</tspan>
          {p2(now.getMinutes())}
        </text>
        <rect x="161" y="32.5" width="5" height="4" fill="none" stroke={ink} strokeWidth="0.7" />
        <rect x="163" y="34.5" width="5" height="4" fill="#D9DDD7" stroke={ink} strokeWidth="0.7" />
        <line x1="28" x2="172" y1="41" y2="41" stroke={ink} strokeWidth="0.8" />
        <line x1="112" x2="112" y1="41" y2="143" stroke={ink} strokeWidth="0.8" />
        {/* CO2 */}
        <text x="31.5" y="50" fontSize="6" className="sd-lcd">
          CO<tspan fontSize="4" dy="1">2</tspan>
        </text>
        {alert && (
          <g>
            <rect x="45" y="44" width="8" height="7" rx="1" fill={ink} />
            <text x="49" y="50" fontSize="6" textAnchor="middle" fill="#D9DDD7" fontWeight="700">
              !
            </text>
          </g>
        )}
        <text x="72" y="64" fontSize="15" textAnchor="middle" className="sd-lcd">
          {f(co2, 0)}
        </text>
        <text x="91" y="64" fontSize="5">
          ppm
        </text>
        <text x="30.5" y="74" fontSize="4.2" className="sd-lcd">
          1500
        </text>
        <text x="32" y="105" fontSize="4.2" className="sd-lcd">
          200
        </text>
        <polyline points="43,70 43,105 108,105 108,70" fill="none" stroke={ink} strokeWidth="0.7" />
        {shown.map((v, i) => {
          const x = 106.5 - (shown.length - 1 - i) * 1.88;
          const y = yOf(v);
          return <rect key={i} className="sd-bar" x={x} y={y} width="1.05" height={105 - y} fill={ink} />;
        })}
        {/* temperatura y humedad */}
        <path d="M33 111 v7 a2 2 0 1 0 2 0 v-7 a1 1 0 0 0 -2 0 Z" fill="none" stroke={ink} strokeWidth="0.8" />
        <text x="38" y="129" fontSize="11" className="sd-lcd">
          {f(temperature, 1)}
        </text>
        <text x="62" y="120" fontSize="4">
          °C
        </text>
        <path d="M76 110 c-2 3 -3 4.5 -3 6 a3 3 0 0 0 6 0 c0 -1.5 -1 -3 -3 -6 Z" fill={ink} />
        <text x="76" y="129" fontSize="11" className="sd-lcd">
          {f(humidity, 1)}
        </text>
        <text x="101" y="129" fontSize="4.5">
          %
        </text>
        {/* carita de confort */}
        <circle cx="142" cy="70" r="15" fill="none" stroke={ink} strokeWidth="1.3" />
        {face === "happy" ? (
          <>
            <path d="M134.5 66 q2.5 -3 5 0 M144.5 66 q2.5 -3 5 0" fill="none" stroke={ink} strokeWidth="1.3" strokeLinecap="round" />
            <path d="M134 73 q8 9 16 0 Z" fill={ink} />
          </>
        ) : face === "neutral" ? (
          <>
            <circle cx="137" cy="66" r="1.6" fill={ink} />
            <circle cx="147" cy="66" r="1.6" fill={ink} />
            <line x1="135" x2="149" y1="76" y2="76" stroke={ink} strokeWidth="1.4" strokeLinecap="round" />
          </>
        ) : (
          <>
            <circle cx="137" cy="66" r="1.6" fill={ink} />
            <circle cx="147" cy="66" r="1.6" fill={ink} />
            <path d="M135 79 q7 -7 14 0" fill="none" stroke={ink} strokeWidth="1.4" strokeLinecap="round" />
          </>
        )}
        <line x1="112" x2="172" y1="100" y2="100" stroke={ink} strokeWidth="0.8" />
        {/* PM2.5 / PM10 */}
        <text x="116" y="109" fontSize="5.4" className="sd-lcd">
          PM2.5
        </text>
        <text x="145" y="109" fontSize="5.4" className="sd-lcd">
          PM10
        </text>
        <text x="126" y="128" fontSize="12" textAnchor="middle" className="sd-lcd">
          {f(pm25, 0)}
        </text>
        <text x="153" y="128" fontSize="12" textAnchor="middle" className="sd-lcd">
          {f(pm10, 0)}
        </text>
        <text x="158" y="139" fontSize="4">
          µg/m³
        </text>
      </g>
      {/* parte inferior: sensor de luz, boton y LED */}
      <circle cx="100" cy="160" r="2.8" fill="#8E99A5" />
      <rect x="94.5" y="169" width="11" height="10" rx="2.2" fill="#ECEFF2" stroke="#C3CAD2" />
      <rect x="97.5" y="172" width="5" height="1.2" rx="0.6" fill="#B5BEC8" />
      <rect x="97.5" y="174.8" width="5" height="1.2" rx="0.6" fill="#B5BEC8" />
      <rect className="sd-glow" x="173" y="156" width="3" height="13" rx="1.5" fill={alert ? "#FFB547" : "#4CC38A"} />
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
