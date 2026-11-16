import { useEffect, useId, useState } from "react";
import type { PilotDevice } from "../../api/pilot";
import { ArmonicosPantalla, EspectroPantalla, espectroDe, LIM_THD_I, LIM_THD_V } from "./Armonicos";

/**
 * Equipos de energia en 3D (ION7400, medidor de circuito con frente EM6400NG+ y generador) con sus
 * botones funcionando sobre las lecturas reales que manda el agente. Solo se muestran las
 * variables que de verdad llegan: a traves del AS-P el ION7400 no entrega kWh ni armonicos
 * individuales, y el medidor de circuito solo V, A, Hz y demanda.
 */

export type DeviceKind = "ion" | "pm" | "gen";

export function kindOf(d: PilotDevice): DeviceKind {
  const cat = d.attributes.category;
  if (cat === "generator" || d.model === "generator") return "gen";
  if (cat === "circuit_meter" || d.model === "PM2130") return "pm";
  return "ion";
}

/** Variable que se usa para la grafica de potencia de cada tipo. */
export const POWER_METRIC: Record<DeviceKind, string> = {
  ion: "active_power_total",
  pm: "demand_total",
  gen: "gen_kw_total_metering",
};

export const DIM: Record<DeviceKind, { w: number; h: number; d: number }> = {
  ion: { w: 380, h: 400, d: 130 },
  pm: { w: 380, h: 380, d: 110 },
  gen: { w: 560, h: 300, d: 230 },
};

type R = Record<string, unknown>;
export const num = (r: R, k: string): number | null => (typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : null);
export const fx = (v: number | null, d = 1) => (v == null ? "--" : v.toFixed(d));
const avg = (vals: (number | null)[]) => {
  const ok = vals.filter((v): v is number => v != null && v !== 0);
  return ok.length ? ok.reduce((s, v) => s + v, 0) / ok.length : null;
};
const ph3 = (r: R, p: string, s = "") => ["a", "b", "c"].map((x) => num(r, `${p}${x}${s}`));

/* ---------------- estado de la pantalla de cada equipo ---------------- */

export type IonScreen = "menu" | "summary" | "volt" | "amp" | "power" | "phasor" | "quality" | "harm" | "spectrum" | "demand";
/** Pantallas del ION que abren el panel grande de armonicos debajo del equipo. */
export const ION_HARM_SCREENS: IonScreen[] = ["harm", "spectrum"];
export const ION_MENU: [IonScreen, string][] = [
  ["summary", "Resumen"],
  ["volt", "Voltaje"],
  ["amp", "Corriente"],
  ["power", "Potencia"],
  ["phasor", "Fasores"],
  ["quality", "Calidad"],
  ["harm", "Armónicos"],
  ["spectrum", "Espectro"],
  ["demand", "Demanda"],
];

export interface Phasor {
  name: string;
  mag: number | null;
  /** Grados; null si no hay FP para calcularlo. */
  angle: number | null;
  color: string;
  current: boolean;
}

/**
 * Diagrama fasorial con lo que llega por el AS-P: magnitudes reales, pero el AS-P no manda
 * angulos. Los voltajes se dibujan en sus angulos nominales (0, -120, 120) y cada corriente se
 * desfasa de su voltaje acos(|FP|) de esa fase, en atraso (carga inductiva). Los angulos medidos
 * llegan con la lectura directa del ION7400 (Fase B).
 */
export function phasors(r: Record<string, unknown>): Phasor[] {
  const v = ph3(r, "voltage_", "_n");
  const a = ph3(r, "current_");
  const COLORS = ["#1aa3e0", "#f0a000", "#c2185b"];
  const vAng = [0, -120, 120];
  const out: Phasor[] = [];
  ["a", "b", "c"].forEach((x, i) => {
    const pf = num(r, `power_factor_${x}`);
    out.push({ name: `V${x}`, mag: v[i], angle: v[i] ? vAng[i] : null, color: COLORS[i], current: false });
    const lag = pf == null || !a[i] ? null : (Math.acos(Math.min(1, Math.abs(pf))) * 180) / Math.PI;
    out.push({ name: `I${x}`, mag: a[i], angle: lag == null ? null : vAng[i] - lag, color: COLORS[i], current: true });
  });
  return out;
}
export const EM_PARAMS = ["VL-N", "VL-L", "I", "kVA", "kW", "kVAR", "PF", "VTHD%", "ITHD%", "DM", "PrsDM", "PrdDM", "MD", "RTC"];
/** Parametros del medidor de circuito que si llegan por el AS-P (los demas no se pueden mostrar). */
export const EM_AVAILABLE = ["VL-N", "VL-L", "I", "DM", "RTC"];
export const GEN_PAGES = ["MOT", "ELE", "BAT", "ALM"];

export interface ScreenState {
  ion: { scr: IonScreen; menu: number };
  pm: { p: number; avg: boolean };
  gen: { page: number };
}
export const initialScreen = (): ScreenState => ({ ion: { scr: "summary", menu: 0 }, pm: { p: 0, avg: false }, gen: { page: 0 } });

export function pressKey(kind: DeviceKind, s: ScreenState, key: string): ScreenState {
  if (kind === "ion") {
    const ion = { ...s.ion };
    const order = ION_MENU.map((m) => m[0]);
    if (key === "home") ion.scr = "menu";
    else if (ion.scr === "menu") {
      if (key === "sk0") ion.menu = (ion.menu + order.length - 1) % order.length;
      if (key === "sk1") ion.menu = (ion.menu + 1) % order.length;
      if (key === "sk2") ion.scr = order[ion.menu];
    } else {
      const i = order.indexOf(ion.scr);
      if (key === "sk0") ion.scr = order[(i + order.length - 1) % order.length];
      if (key === "sk1") ion.scr = order[(i + 1) % order.length];
      if (key === "sk3") ion.scr = "menu";
      if (ion.scr !== "menu") ion.menu = order.indexOf(ion.scr);
    }
    return { ...s, ion };
  }
  if (kind === "pm") {
    const idx = EM_AVAILABLE.indexOf(EM_PARAMS[s.pm.p]);
    if (key === "em-down") return { ...s, pm: { avg: false, p: EM_PARAMS.indexOf(EM_AVAILABLE[(idx + 1) % EM_AVAILABLE.length]) } };
    if (key === "em-up") return { ...s, pm: { avg: false, p: EM_PARAMS.indexOf(EM_AVAILABLE[(idx + EM_AVAILABLE.length - 1) % EM_AVAILABLE.length]) } };
    if (key === "em-ok") return { ...s, pm: { ...s.pm, avg: !s.pm.avg } };
    return s;
  }
  if (key.startsWith("gp")) return { ...s, gen: { page: Number(key.slice(2)) } };
  return s;
}

/* ---------------- metricas de la pantalla actual (panel lateral) ---------------- */

export interface MetricRow {
  label: string;
  value: number | null;
  text: string;
  /** 0..1 para la barra. */
  frac: number;
  tone?: "warn" | "bad";
}

const row = (label: string, value: number | null, unit: string, dec: number, max: number, tone?: MetricRow["tone"]): MetricRow => ({
  label,
  value,
  text: value == null ? "sin dato" : `${value.toFixed(dec)}${unit ? " " + unit : ""}`,
  frac: value == null || !max ? 0 : Math.max(0, Math.min(1, Math.abs(value) / max)),
  tone,
});

export function screenTitle(kind: DeviceKind, s: ScreenState) {
  if (kind === "ion") return s.ion.scr === "menu" ? "Menú (Resumen)" : ION_MENU.find((m) => m[0] === s.ion.scr)![1];
  if (kind === "pm") return s.pm.avg ? "Promedios (Vavg · Iavg · F)" : EM_PARAMS[s.pm.p];
  return ["Motor", "Eléctrico", "Batería", "Alarmas"][s.gen.page];
}

export function metricRows(d: PilotDevice, kind: DeviceKind, s: ScreenState): MetricRow[] {
  const r = d.readings;
  const cap = Number(d.attributes.capacityKva) || 0;
  if (kind === "ion") {
    const scr = s.ion.scr === "menu" ? "summary" : s.ion.scr;
    const vn = ph3(r, "voltage_", "_n");
    if (scr === "summary") {
      const kva = num(r, "apparent_power_total");
      const pf = num(r, "power_factor_total");
      return [
        row("kW total", num(r, "active_power_total"), "kW", 1, cap),
        row("kVA total", kva, "kVA", 1, cap, cap && kva != null && kva / cap > 0.8 ? "warn" : undefined),
        row("V prom.", avg(vn), "V", 1, 140),
        row("FP", pf == null ? null : Math.abs(pf), "", 2, 1, pf != null && Math.abs(pf) < 0.9 ? "warn" : undefined),
        row("Frecuencia", num(r, "frequency"), "Hz", 2, 61),
      ];
    }
    if (scr === "volt") return vn.map((v, i) => row(`V${i + 1}-N`, v, "V", 1, 140, v != null && v > 0 && (v < 108 || v > 132) ? "warn" : undefined));
    if (scr === "amp") {
      const a = ph3(r, "current_");
      const mx = Math.max(1, ...a.map((x) => x ?? 0));
      return a.map((x, i) => row(`I${i + 1}`, x, "A", 1, mx));
    }
    if (scr === "power") {
      const kw = ph3(r, "active_power_");
      const mx = Math.max(1, ...kw.map((x) => x ?? 0));
      return [...kw.map((x, i) => row(`kW ${"ABC"[i]}`, x, "kW", 1, mx)), row("kW total", num(r, "active_power_total"), "kW", 1, cap)];
    }
    if (scr === "phasor") {
      return phasors(r).map((p) => ({
        label: p.name,
        value: p.mag,
        text: p.mag == null ? "sin dato" : `${p.mag.toFixed(p.current ? 1 : 1)} ${p.current ? "A" : "V"} ∠ ${p.angle == null ? "--" : p.angle.toFixed(1)}°`,
        frac: p.angle == null ? 0 : (((p.angle % 360) + 360) % 360) / 360,
      }));
    }
    if (scr === "quality") {
      const thd = [1, 2, 3].map((i) => num(r, `thd_voltage_v${i}_high`));
      return [
        ...thd.map((v, i) => row(`THD V${i + 1}`, v, "%", 2, 8, v != null && v > 5 ? "warn" : undefined)),
        row("Flicker A", num(r, "short_term_flicker_pst_a_n"), "Pst", 2, 1),
      ];
    }
    if (scr === "harm") {
      const tv = [1, 2, 3].map((i) => num(r, `thd_voltage_v${i}_high`));
      const ti = ph3(r, "thd_current_", "_high");
      return [
        ...tv.map((v, i) => row(`THD V fase ${"ABC"[i]}`, v, "%", 2, LIM_THD_V, v != null && v > LIM_THD_V ? "bad" : v != null && v > 5 ? "warn" : undefined)),
        ...ti.map((v, i) => row(`THD I fase ${"ABC"[i]}`, v, "%", 2, LIM_THD_I, v != null && v > LIM_THD_I ? "bad" : undefined)),
      ];
    }
    if (scr === "spectrum") {
      const e = espectroDe(r, "v_a");
      if (!e.barras.length) return [{ label: "Espectro", value: null, text: "sin espectro (lectura directa, cada 10 min)", frac: 0 }];
      const top = [...e.barras].sort((a, b) => b[1] - a[1]).slice(0, 4);
      return [
        row("THD V1", e.thd, "%", 2, LIM_THD_V),
        row("THD par V1", e.par, "%", 2, LIM_THD_V),
        row("THD impar V1", e.impar, "%", 2, LIM_THD_V),
        ...top.map(([n, p]) => row(`H${n} V1`, p, "%", 2, Math.max(1, top[0][1]))),
      ];
    }
    return [
      ...ph3(r, "apparent_power_del_", "_peak_demand").map((v, i) => row(`Pico ${"ABC"[i]}`, v, "kVA", 1, cap / 3 || 1)),
      row("Pico total", num(r, "apparent_power_total_peak_demand"), "kVA", 1, cap),
    ];
  }
  if (kind === "pm") {
    if (s.pm.avg) {
      return [
        row("V prom.", avg(ph3(r, "voltage_", "_n")), "V", 1, 140),
        row("I prom.", avg(ph3(r, "current_")), "A", 1, 100),
        row("Frecuencia", num(r, "frequency"), "Hz", 2, 61),
      ];
    }
    const p = EM_PARAMS[s.pm.p];
    if (p === "VL-N") return ph3(r, "voltage_", "_n").map((v, i) => row(`L${i + 1}-N`, v, "V", 1, 140, v === 0 ? "bad" : undefined));
    if (p === "VL-L") return ["a_b", "b_c", "c_a"].map((k, i) => row(`L${i + 1}-L${((i + 1) % 3) + 1}`, num(r, `voltage_${k}`), "V", 1, 240));
    if (p === "I") {
      const a = ph3(r, "current_");
      const mx = Math.max(1, ...a.map((x) => x ?? 0));
      return a.map((x, i) => row(`I L${i + 1}`, x, "A", 1, mx));
    }
    if (p === "DM") return [row("Demanda", num(r, "demand_total"), "kW", 2, 20)];
    return [{ label: "Hora", value: null, text: new Date().toLocaleTimeString("es-GT"), frac: 1 }];
  }
  const g = s.gen.page;
  if (g === 0)
    return [
      row("RPM", num(r, "engine_speed_metering"), "rpm", 0, 1800),
      row("Aceite", num(r, "oil_pressure_metering"), "psi", 0, 80),
      row("Refrigerante", num(r, "coolant_temp_metering"), "°C", 0, 110, (num(r, "coolant_temp_metering") ?? 0) > 95 ? "bad" : undefined),
      row("Carga motor", num(r, "engine_load_metering"), "%", 0, 100),
    ];
  if (g === 1)
    return [
      row("Frecuencia", num(r, "gen_frequency_metering"), "Hz", 2, 61),
      row("kW total", num(r, "gen_kw_total_metering"), "kW", 1, 500),
      row("kVA total", num(r, "gen_kva_total_metering"), "kVA", 1, 500),
      row("Hz barra", num(r, "bus_frequency_metering"), "Hz", 2, 61),
    ];
  if (g === 2)
    return [
      row("Batería", num(r, "battery_voltage_metering"), "V", 1, 30),
      row("Combustible", num(r, "fuel_level_metering"), "%", 1, 100, (num(r, "fuel_level_metering") ?? 100) < 25 ? "warn" : undefined),
    ];
  return [{ label: "Alarmas", value: null, text: "el perfil no las trae", frac: 0 }];
}

/* ---------------- dibujo 3D ---------------- */

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}
const pad = (x: number) => String(x).padStart(2, "0");

interface FrontProps {
  device: PilotDevice;
  screen: ScreenState;
  onKey: (key: string) => void;
}

function Key({ cls, k, label, onKey, children, pressed }: { cls: string; k: string; label: string; onKey: (k: string) => void; children?: React.ReactNode; pressed?: boolean }) {
  return (
    <button type="button" className={cls} aria-label={label} aria-pressed={pressed} onClick={() => onKey(k)}>
      {children}
    </button>
  );
}

function IonFront({ device, screen, onKey }: FrontProps) {
  const r = device.readings;
  const now = useClock();
  const st = screen.ion;
  const soft = st.scr === "menu" ? ["▲", "▼", "OK", ""] : ["◀", "▶", "", "≡"];
  const COL = ["#d23b2f", "#e0a400", "#2457a6"];
  const bar = (pct: number, col: string) => (
    <span className="tb">
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: col }} />
    </span>
  );
  const kva = num(r, "apparent_power_total");
  const thdHigh = [1, 2, 3].some((i) => (num(r, `thd_voltage_v${i}_high`) ?? 0) > 5);

  let body: React.ReactNode;
  switch (st.scr) {
    case "menu":
      body = ION_MENU.map(([, t], i) => (
        <div key={t} className={`menu-item${i === st.menu ? " sel" : ""}`}>
          <span>{t}</span>
          <span>›</span>
        </div>
      ));
      break;
    case "summary":
      body = (
        <div className="tgrid">
          {[
            ["kW total", fx(num(r, "active_power_total"), 2), "kW"],
            ["kVA total", fx(kva, 2), "kVA"],
            ["V L-N prom.", fx(avg(ph3(r, "voltage_", "_n"))), "V"],
            ["I prom.", fx(avg(ph3(r, "current_"))), "A"],
            ["Factor pot.", fx(num(r, "power_factor_total") == null ? null : Math.abs(num(r, "power_factor_total")!), 2), ""],
            ["Frecuencia", fx(num(r, "frequency"), 2), "Hz"],
          ].map(([l, v, u]) => (
            <div key={l} className="tcell">
              <span>{l}</span>
              <b>
                {v} <small>{u}</small>
              </b>
            </div>
          ))}
        </div>
      );
      break;
    case "volt":
      body = (
        <>
          {ph3(r, "voltage_", "_n").map((v, i) => (
            <div key={i} className="trow">
              <span>V{i + 1}</span>
              {bar(((v ?? 0) / 140) * 100, COL[i])}
              <b>{fx(v)} V</b>
            </div>
          ))}
          <div style={{ height: 4 }} />
          {["a_b", "b_c", "c_a"].map((k, i) => (
            <div key={k} className="trow">
              <span>
                V{i + 1}
                {((i + 1) % 3) + 1}
              </span>
              {bar(((num(r, `voltage_${k}`) ?? 0) / 240) * 100, COL[i])}
              <b>{fx(num(r, `voltage_${k}`))} V</b>
            </div>
          ))}
        </>
      );
      break;
    case "amp": {
      const a = ph3(r, "current_");
      const mx = Math.max(1, ...a.map((x) => x ?? 0));
      body = a.map((x, i) => (
        <div key={i} className="trow">
          <span>I{i + 1}</span>
          {bar(((x ?? 0) / mx) * 100, COL[i])}
          <b>{fx(x)} A</b>
        </div>
      ));
      break;
    }
    case "power": {
      const kw = ph3(r, "active_power_");
      const kv = ph3(r, "apparent_power_");
      body = (
        <table className="tt">
          <tbody>
            <tr>
              <th />
              <th>kW</th>
              <th>kVA</th>
              <th>FP</th>
            </tr>
            {kw.map((k, i) => (
              <tr key={i}>
                <td>{"ABC"[i]}</td>
                <td>{fx(k, 2)}</td>
                <td>{fx(kv[i], 2)}</td>
                <td>{fx(num(r, `power_factor_${"abc"[i]}`) == null ? null : Math.abs(num(r, `power_factor_${"abc"[i]}`)!), 2)}</td>
              </tr>
            ))}
            <tr>
              <td>
                <b>Total</b>
              </td>
              <td>
                <b>{fx(num(r, "active_power_total"), 2)}</b>
              </td>
              <td>
                <b>{fx(kva, 2)}</b>
              </td>
              <td>
                <b>{fx(num(r, "power_factor_total") == null ? null : Math.abs(num(r, "power_factor_total")!), 2)}</b>
              </td>
            </tr>
          </tbody>
        </table>
      );
      break;
    }
    case "phasor":
      body = <PhasorScreen r={r} />;
      break;
    case "quality":
      body = (
        <table className="tt">
          <tbody>
            <tr>
              <th />
              <th>A / V1</th>
              <th>B / V2</th>
              <th>C / V3</th>
            </tr>
            <tr>
              <td>THD V %</td>
              {[1, 2, 3].map((i) => (
                <td key={i}>{fx(num(r, `thd_voltage_v${i}_high`), 2)}</td>
              ))}
            </tr>
            <tr>
              <td>THD I %</td>
              {ph3(r, "thd_current_", "_high").map((v, i) => (
                <td key={i}>{fx(v, 2)}</td>
              ))}
            </tr>
            <tr>
              <td>Flicker Pst</td>
              {ph3(r, "short_term_flicker_pst_", "_n").map((v, i) => (
                <td key={i}>{fx(v, 2)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      );
      break;
    case "harm":
      body = <ArmonicosPantalla r={r} />;
      break;
    case "spectrum":
      body = <EspectroPantalla r={r} />;
      break;
    case "demand":
      body = (
        <div className="tgrid">
          {[...ph3(r, "apparent_power_del_", "_peak_demand").map((v, i) => [`Pico fase ${"ABC"[i]}`, v] as const), ["Pico total", num(r, "apparent_power_total_peak_demand")] as const].map(
            ([l, v]) => (
              <div key={l} className="tcell">
                <span>{l}</span>
                <b>
                  {fx(v)} <small>kVA</small>
                </b>
              </div>
            ),
          )}
        </div>
      );
      break;
  }
  const kw = num(r, "active_power_total") ?? 0;
  return (
    <>
      <div className="ion-model">
        <b>PowerLogic</b> ION7400
      </div>
      <div className="tft">
        <div className="bar">
          <span>
            {pad(now.getDate())}/{pad(now.getMonth() + 1)}/{now.getFullYear()} {pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}
          </span>
          <span>
            <i className={thdHigh ? "al" : ""} />
            <i />
            <i />
          </span>
        </div>
        <div className="ttl">
          {st.scr === "menu" ? "Menú principal" : ION_MENU.find((m) => m[0] === st.scr)![1]}
          <small>{device.name}</small>
        </div>
        <div className="body">{body}</div>
        <div className="soft">
          {soft.map((s, i) => (
            <span key={i}>{s}</span>
          ))}
        </div>
      </div>
      <div className="ion-keys">
        {[0, 1, 2, 3].map((i) => (
          <Key key={i} cls="hk" k={`sk${i}`} label={`Tecla ${i + 1}${soft[i] ? ` (${soft[i]})` : ""}`} onKey={onKey} />
        ))}
      </div>
      <span className="ion-led alarm" style={thdHigh ? { background: "#ff4a3a", boxShadow: "0 0 8px #ff4a3a" } : undefined} />
      <span className="ion-sym" style={{ left: 120, top: 332 }}>
        ALARMA
      </span>
      <Key cls="ion-home" k="home" label="Inicio (menú)" onKey={onKey}>
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M3 11l9-7 9 7" />
          <path d="M5 10v10h14V10" />
        </svg>
      </Key>
      <span className="ion-led comm" style={device.state === "offline" ? { background: "#3a1a1a", boxShadow: "none", animation: "none" } : undefined} />
      <span className="ion-sym" style={{ left: 244, top: 332 }}>
        COM
      </span>
      <span className="ion-led var" style={{ ["--p" as string]: "1.8s" }} />
      <span className="ion-sym" style={{ left: 121, top: 374 }}>
        VAR
      </span>
      <span className="ion-led watt" style={{ ["--p" as string]: `${(2.2 - Math.min(1.9, kw / 60)).toFixed(2)}s` }} />
      <span className="ion-sym" style={{ left: 240, top: 374 }}>
        WATT
      </span>
      <span className="ion-port" />
      <span className="ion-blk" />
    </>
  );
}

/** Pantalla "Fasores" del ION7400: diagrama y tabla magnitud / angulo, como la del equipo. */
function PhasorScreen({ r }: { r: Record<string, unknown> }) {
  const uid = useId().replace(/:/g, "");
  const ps = phasors(r);
  const vMax = Math.max(1, ...ps.filter((p) => !p.current).map((p) => p.mag ?? 0));
  const iMax = Math.max(1, ...ps.filter((p) => p.current).map((p) => p.mag ?? 0));
  const C = 68,
    R = 62;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "136px 1fr", gap: 6, alignItems: "center" }}>
      <svg width="136" height="136" viewBox="0 0 136 136" aria-label="Diagrama fasorial">
        <defs>
          {ps.map((p) => (
            <marker key={p.name} id={`${uid}-${p.name}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill={p.color} />
            </marker>
          ))}
        </defs>
        <circle cx={C} cy={C} r={R} fill="#eeeeee" stroke="#777" strokeWidth="0.8" />
        <line x1={C - R - 2} y1={C} x2={C + R + 2} y2={C} stroke="#888" strokeWidth="0.6" />
        <line x1={C} y1={C - R - 2} x2={C} y2={C + R + 2} stroke="#888" strokeWidth="0.6" />
        <text x={C} y={6} textAnchor="middle" fontSize="6" fill="#333">
          90
        </text>
        {ps.map((p) => {
          if (p.angle == null || !p.mag) return null;
          const len = p.current ? (p.mag / iMax) * R * 0.55 : (p.mag / vMax) * R * 0.95;
          const rad = (p.angle * Math.PI) / 180;
          const x = C + len * Math.cos(rad),
            y = C - len * Math.sin(rad);
          return (
            <g key={p.name}>
              <line x1={C} y1={C} x2={x} y2={y} stroke={p.color} strokeWidth="1.4" strokeDasharray={p.current ? "3 2" : undefined} markerEnd={`url(#${uid}-${p.name})`} />
              <text x={x + (Math.cos(rad) >= 0 ? 2 : -10)} y={y + (Math.sin(rad) > 0 ? -2 : 7)} fontSize="7" fill={p.color} fontWeight="700">
                {p.name}
              </text>
            </g>
          );
        })}
      </svg>
      <table className="tt" style={{ fontSize: 9.5 }}>
        <tbody>
          <tr>
            <th>Fasor</th>
            <th>Mag.</th>
            <th>Áng.</th>
          </tr>
          {ps.map((p) => (
            <tr key={p.name}>
              <td style={{ color: p.color, fontWeight: 700 }}>{p.name}</td>
              <td>{fx(p.mag, p.current ? 1 : 1)}</td>
              <td>{p.angle == null ? "--" : p.angle.toFixed(1)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={3} style={{ fontSize: 7.5, color: "#5c6b78", textAlign: "left" }}>
              Ángulos: V nominal, I calculado con el FP
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/* 7 segmentos del medidor de circuito */
const SEGS: Record<string, string> = { "0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg", "5": "acdfg", "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg", "-": "g", " ": "" };
const hS = (x: number, y: number, l: number, t: number) => `${x},${y} ${x + t / 2},${y - t / 2} ${x + l - t / 2},${y - t / 2} ${x + l},${y} ${x + l - t / 2},${y + t / 2} ${x + t / 2},${y + t / 2}`;
const vS = (x: number, y: number, l: number, t: number) => `${x},${y} ${x + t / 2},${y + t / 2} ${x + t / 2},${y + l - t / 2} ${x},${y + l} ${x - t / 2},${y + l - t / 2} ${x - t / 2},${y + t / 2}`;
const GEOM: Record<string, string> = { a: hS(5, 4, 24, 6), g: hS(5, 31, 24, 6), d: hS(5, 58, 24, 6), f: vS(5, 4, 27, 6), b: vS(29, 4, 27, 6), e: vS(5, 31, 27, 6), c: vS(29, 31, 27, 6) };
function Seg7({ text, n = 4 }: { text: string; n?: number }) {
  const cells: { ch: string; dp: boolean }[] = [];
  for (const ch of text) {
    if (ch === "." && cells.length) cells[cells.length - 1].dp = true;
    else cells.push({ ch, dp: false });
  }
  while (cells.length < n) cells.unshift({ ch: " ", dp: false });
  return (
    <svg className="seg7" width={n * 40} height="66" viewBox={`0 0 ${n * 40} 66`} aria-hidden="true">
      {cells.slice(-n).map((c, i) => {
        const on = SEGS[c.ch] ?? "";
        return (
          <g key={i} transform={`translate(${i * 40 + 2},0) skewX(-6)`}>
            {Object.entries(GEOM).map(([s, p]) => (
              <polygon key={s} points={p} fill={on.includes(s) ? "#ff3b30" : "#2a0d0b"} />
            ))}
            <circle cx="35" cy="59" r="3.2" fill={c.dp ? "#ff3b30" : "#2a0d0b"} />
          </g>
        );
      })}
    </svg>
  );
}
function f4(v: number | null) {
  if (v == null) return "----";
  const a = Math.abs(v);
  return a < 10 ? v.toFixed(3) : a < 100 ? v.toFixed(2) : a < 1000 ? v.toFixed(1) : v.toFixed(0);
}
const EM_RIGHT = [
  ["Vavg", "kVA", "F"],
  ["Iavg", "kW", "In"],
  ["PFavg", "kVAR", "Iunb%"],
];

function PmFront({ device, screen, onKey }: FrontProps) {
  const r = device.readings;
  const now = useClock();
  const s = screen.pm;
  const p = EM_PARAMS[s.p];
  let rows: string[];
  if (s.avg) rows = [f4(avg(ph3(r, "voltage_", "_n"))), f4(avg(ph3(r, "current_"))), f4(num(r, "frequency"))];
  else if (p === "VL-N") rows = ph3(r, "voltage_", "_n").map(f4);
  else if (p === "VL-L") rows = ["a_b", "b_c", "c_a"].map((k) => f4(num(r, `voltage_${k}`)));
  else if (p === "I") rows = ph3(r, "current_").map(f4);
  else if (p === "DM") rows = [f4(num(r, "demand_total")), "----", "----"];
  else rows = [`${pad(now.getHours())}.${pad(now.getMinutes())}`, `${pad(now.getDate())}.${pad(now.getMonth() + 1)}`, String(now.getFullYear())];
  const lit = s.avg ? ["Vavg", "Iavg", "F"] : [];
  return (
    <>
      <span className="em-model">EM6400NG+</span>
      <div className="em-lbl l">
        {EM_PARAMS.map((t, i) => (
          <div key={t} style={EM_AVAILABLE.includes(t) ? undefined : { opacity: 0.45 }}>
            <span>{t}</span>
            <span className={`em-dot${!s.avg && i === s.p ? " on" : ""}`} />
          </div>
        ))}
      </div>
      <div className="em-win">
        {rows.map((t, i) => (
          <div key={i} className="em-row">
            <span className="ph">L{i + 1}</span>
            <span className={`dash${!s.avg && p !== "RTC" && p !== "DM" ? " on" : ""}`} />
            <Seg7 text={t} />
          </div>
        ))}
      </div>
      <div className="em-lbl r">
        {EM_RIGHT.map((g, gi) => (
          <div key={gi} style={{ display: "contents" }}>
            {g.map((t) => (
              <div key={t}>
                <span className={`em-tri${lit.includes(t) ? " on" : ""}`} />
                <span>{t}</span>
              </div>
            ))}
            <div>
              <span className="em-x">x1000</span>
            </div>
          </div>
        ))}
      </div>
      <div className="em-en">
        {["kWh", "kVAh", "kVARh"].map((t) => (
          <span key={t}>
            <span className="em-tri" style={{ borderLeftWidth: 6 }} />
            {t}
          </span>
        ))}
      </div>
      <div className="em-btns">
        <Key cls="eb" k="em-down" label="Bajar parámetro" onKey={onKey}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </Key>
        <Key cls="eb" k="em-up" label="Subir parámetro" onKey={onKey}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true">
            <path d="M6 15l6-6 6 6" />
          </svg>
        </Key>
        <Key cls="eb" k="em-ok" label="OK: promedios" onKey={onKey}>
          <b>OK</b>
        </Key>
      </div>
      <div className="em-pled" style={{ ["--p" as string]: `${(2.2 - Math.min(1.8, (num(r, "demand_total") ?? 0) / 5)).toFixed(2)}s` }}>
        <span>
          <i className="r" />
          kWh
        </span>
        <span>
          <i className="g" style={device.state === "offline" ? { background: "#3a1a1a", boxShadow: "none" } : undefined} />
          COM
        </span>
      </div>
    </>
  );
}

function GenFront({ device, screen, onKey }: FrontProps) {
  const r = device.readings;
  const page = screen.gen.page;
  const rpm = num(r, "engine_speed_metering") ?? 0;
  const running = rpm > 0 || (num(r, "gen_kw_total_metering") ?? 0) > 0;
  let lcd: React.ReactNode;
  if (page === 0)
    lcd = (
      <>
        <div className="t">
          <span>MOTOR</span>
          <span>{running ? "MARCHA" : "ESPERA"}</span>
        </div>
        <div className="big">{fx(rpm, 0)} rpm</div>
        <div className="r">
          <span>Aceite</span>
          <span>{fx(num(r, "oil_pressure_metering"), 0)} psi</span>
        </div>
        <div className="r">
          <span>Refrigerante</span>
          <span>{fx(num(r, "coolant_temp_metering"), 0)} °C</span>
        </div>
      </>
    );
  else if (page === 1)
    lcd = (
      <>
        <div className="t">
          <span>GENERADOR</span>
          <span>{running ? "EN CARGA" : "SIN CARGA"}</span>
        </div>
        <div className="r">
          <span>Frecuencia</span>
          <span>{fx(num(r, "gen_frequency_metering"), 2)} Hz</span>
        </div>
        <div className="r">
          <span>Potencia</span>
          <span>{fx(num(r, "gen_kw_total_metering"))} kW</span>
        </div>
        <div className="r">
          <span>Aparente</span>
          <span>{fx(num(r, "gen_kva_total_metering"))} kVA</span>
        </div>
        <div className="r">
          <span>Carga</span>
          <span>{fx(num(r, "engine_load_metering"), 0)} %</span>
        </div>
      </>
    );
  else if (page === 2)
    lcd = (
      <>
        <div className="t">
          <span>BATERÍA</span>
          <span>DC</span>
        </div>
        <div className="big">{fx(num(r, "battery_voltage_metering"))} V</div>
        <div className="r">
          <span>Combustible</span>
          <span>{fx(num(r, "fuel_level_metering"))} %</span>
        </div>
      </>
    );
  else
    lcd = (
      <>
        <div className="t">
          <span>ALARMAS</span>
          <span>--</span>
        </div>
        <div className="r">
          <span>El perfil del AS-P no trae alarmas</span>
        </div>
      </>
    );
  return (
    <>
      <span className="gen-stack" />
      <span className="gen-grill" />
      <div className="gen-ctrl">
        <div className="lbl">
          <span>CONTROLADOR</span>
          <span
            className="ion-led"
            style={{ position: "static", background: running ? "#ffb547" : "#3fe08f", boxShadow: `0 0 6px ${running ? "#ffb547" : "#3fe08f"}` }}
          />
        </div>
        <div className="glcd">{lcd}</div>
        <div className="gkeys">
          {GEN_PAGES.map((t, i) => (
            <Key key={t} cls="gk" k={`gp${i}`} label={`Pantalla ${t}`} onKey={onKey} pressed={page === i}>
              {t}
            </Key>
          ))}
        </div>
        <div className="gmode" title="Solo lectura: el agente no envía comandos">
          <span className="stop">STOP</span>
          <span>MAN</span>
          <span className="on">AUTO</span>
          <span>START</span>
        </div>
      </div>
      <span className="gen-base" />
    </>
  );
}

export function DeviceBox({ device, kind, screen, onKey, rot }: FrontProps & { kind: DeviceKind; rot: { x: number; y: number } }) {
  const m = DIM[kind];
  const cls = kind === "pm" ? "em" : kind;
  return (
    <div className="scene" style={{ ["--w" as string]: `${m.w}px`, ["--h" as string]: `${m.h}px`, ["--d" as string]: `${m.d}px` }}>
      <div className={`box ${cls}`} style={{ transform: `rotateX(${rot.x}deg) rotateY(${rot.y}deg)` }}>
        <div className="f back" />
        <div className="f right" />
        <div className="f left" />
        <div className="f top" />
        <div className="f bottom" />
        <div className="f front">
          {kind === "ion" ? (
            <IonFront device={device} screen={screen} onKey={onKey} />
          ) : kind === "pm" ? (
            <PmFront device={device} screen={screen} onKey={onKey} />
          ) : (
            <GenFront device={device} screen={screen} onKey={onKey} />
          )}
        </div>
      </div>
    </div>
  );
}
