import type { AgentProtocols, ModbusServerConfig } from "../../api/agents";
import type { PilotDevice } from "../../api/pilot";

/** Perfil de lectura directa de un equipo (por su modelo o nombre). */
export function perfilDe(d: PilotDevice | null | undefined) {
  const m = `${d?.model ?? ""} ${d?.name ?? ""} ${String(d?.attributes?.profile ?? "")}`.toLowerCase();
  if (m.includes("2130")) return "pm2130-directo";
  if (m.includes("gen")) return "generador-directo";
  return "ion7400-directo";
}

/** Servidores Modbus de la configuración del agente (formato nuevo o el antiguo de uno solo). */
export function servidores(c: AgentProtocols | undefined): ModbusServerConfig[] {
  if (!c) return [];
  if (c.modbusServers?.length) return c.modbusServers;
  return c.modbus ? [c.modbus] : [];
}

export function hace(s: string | null | undefined) {
  if (!s) return "sin datos";
  const seg = Math.max(0, Math.round((Date.now() - new Date(s).getTime()) / 1000));
  return seg < 60 ? `hace ${seg} s` : seg < 3600 ? `hace ${Math.round(seg / 60)} min` : seg < 86400 ? `hace ${Math.round(seg / 3600)} h` : `hace ${Math.round(seg / 86400)} d`;
}

export type Tipo = "ion" | "pm" | "gen";
export function tipoDe(d: PilotDevice): Tipo {
  const p = perfilDe(d);
  return p.startsWith("pm") ? "pm" : p.startsWith("gen") ? "gen" : "ion";
}
export const TIPO_COLOR: Record<Tipo, string> = { ion: "#7cc4ff", pm: "#4ade80", gen: "#fbbf24" };
export const TIPO_TXT: Record<Tipo, string> = { ion: "ION7400", pm: "PM2130", gen: "Generador" };

/** Unidad de una métrica por su clave (igual que la API en el JSON v1). */
export function unidad(k: string): string {
  if (/^harm_/.test(k)) return /^harm_v/.test(k) ? "V" : "A";
  if (/thd|load_metering|fuel_level/.test(k)) return "%";
  if (/power_factor|pf_/.test(k)) return "";
  if (/^energy_active|_kwh$/.test(k)) return "kWh";
  if (/^energy_reactive|_kvarh$/.test(k)) return "kVArh";
  if (/^energy_apparent|_kvah$/.test(k)) return "kVAh";
  if (/reactive_power/.test(k)) return "kVAr";
  if (/apparent_power|kva/.test(k)) return "kVA";
  if (/active_power|demand|_kw_|kw_total/.test(k)) return "kW";
  if (/voltage/.test(k)) return "V";
  if (/current/.test(k)) return "A";
  if (/frequency/.test(k)) return "Hz";
  if (/flicker|pst/.test(k)) return "Pst";
  if (/temp/.test(k)) return "°C";
  if (/pressure/.test(k)) return "psi";
  if (/speed/.test(k)) return "RPM";
  return "";
}

/** Registros que lee cada perfil (base 1, como los documenta Schneider). */
export const MAPA: Record<string, { r: string; v: string; t: string }[]> = {
  "ion7400-directo": [
    { r: "3000-3005", v: "Corriente A, B, C", t: "float32" }, { r: "3020-3033", v: "Voltajes L-L y L-N", t: "float32" },
    { r: "3054-3061", v: "Potencia activa por fase y total (W → kW)", t: "float32" }, { r: "3070-3077", v: "Potencia aparente (VA → kVA)", t: "float32" },
    { r: "3110", v: "Frecuencia", t: "float32" }, { r: "3144-3151", v: "Factor de potencia", t: "float32" },
    { r: "21300-21335", v: "THD de corriente y tensión", t: "float32 ×100" }, { r: "34649-34654", v: "Flicker Pst A/B/C", t: "float32" },
    { r: "30112, 30450-30479", v: "Demanda pico", t: "float32" }, { r: "411-414", v: "Estado comercial / generador y transferencias", t: "entero 16" },
  ],
  "pm2130-directo": [
    { r: "3000-3011", v: "Corrientes y promedio", t: "float32" }, { r: "3020-3037", v: "Voltajes L-L, L-N y promedios", t: "float32" },
    { r: "3054-3085", v: "Potencias activa, reactiva, aparente y FP", t: "float32" }, { r: "3110", v: "Frecuencia", t: "float32" },
    { r: "3204-3243", v: "Energías kWh, kVArh, kVAh", t: "int64" }, { r: "3764", v: "Demanda total", t: "float32" },
    { r: "21300-21338", v: "THD", t: "float32" },
  ],
  "generador-directo": [
    { r: "4770-4785", v: "kVA y kW por fase y total", t: "int32 CDAB" }, { r: "4786", v: "Factor de potencia", t: "float32 CDAB" },
    { r: "4790-4797", v: "Frecuencias, fuente de velocidad, RPM", t: "int32 CDAB" }, { r: "4798", v: "Carga del motor %", t: "int32 CDAB" },
    { r: "4800", v: "Temperatura del refrigerante", t: "int32 ×0.1 °C" }, { r: "4802", v: "Presión de aceite", t: "int32 CDAB" },
    { r: "4804", v: "Voltaje de batería", t: "int32 ×0.1 V" }, { r: "4806", v: "Nivel de combustible", t: "int32 CDAB" },
  ],
};
