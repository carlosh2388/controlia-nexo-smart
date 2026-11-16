/**
 * Limites de calidad de energia por norma (los que usa "Normas y cumplimiento" y los umbrales por
 * equipo). Los de la NTSD (CNEE, Guatemala) son valores de REFERENCIA: confirmar con la resolucion
 * vigente antes de usarlos para alarmas; quedan editables por equipo.
 *
 * Evaluacion: promedios de 10 minutos (metodo IEC 61000-4-30) y "cumple" si al menos el 95 % de los
 * intervalos esta dentro del limite (criterio EN 50160).
 */
export type Norma = "ntsd" | "ieee519" | "en50160";

export interface Limites {
  /** Tolerancia de tension respecto de la nominal, en %. */
  tension: number;
  /** Tension nominal fase-neutro (V). */
  nominal: number;
  /** Desbalance de tension maximo (%). */
  desbalance: number;
  /** THD de tension maximo (%). */
  thdV: number;
  /** THD/TDD de corriente de referencia (%); IEEE 519 lo fija segun Icc/IL de cada acometida. */
  thdI: number;
  /** Flicker de corta duracion Pst maximo. */
  pst: number;
  /** Factor de potencia minimo. */
  fp: number;
  /** Desviacion de frecuencia maxima (Hz) sobre 60 Hz. */
  freq: number;
  /** Carga maxima del transformador (% de su capacidad) - criterio de operacion. */
  carga: number;
}

export const NORMAS: Record<Norma, { nombre: string; fuente: string; limites: Limites }> = {
  ntsd: {
    nombre: "NTSD Guatemala (CNEE)",
    fuente: "Normas Técnicas del Servicio de Distribución · valores de referencia, confirmar con la resolución vigente",
    limites: { tension: 8, nominal: 120, desbalance: 2, thdV: 8, thdI: 20, pst: 1, fp: 0.9, freq: 0.5, carga: 80 },
  },
  ieee519: {
    nombre: "IEEE 519-2014",
    fuente: "Barras de hasta 1 kV: THD de tensión 8 %, armónico individual 5 %; TDD de corriente según Icc/IL",
    limites: { tension: 8, nominal: 120, desbalance: 2, thdV: 8, thdI: 15, pst: 1, fp: 0.9, freq: 0.5, carga: 80 },
  },
  en50160: {
    nombre: "EN 50160",
    fuente: "Semana de promedios de 10 min: 95 % del tiempo dentro de ±10 % de tensión, THD 8 %, desbalance 2 %",
    limites: { tension: 10, nominal: 120, desbalance: 2, thdV: 8, thdI: 20, pst: 1, fp: 0.9, freq: 0.6, carga: 80 },
  },
};

export const INDICADORES = ["tension", "desbalance", "thdV", "thdI", "pst", "fp", "freq"] as const;
export type Indicador = (typeof INDICADORES)[number];

/** Metricas de readings que se necesitan para evaluar la calidad. */
export const METRICAS_CALIDAD = [
  "voltage_a_n", "voltage_b_n", "voltage_c_n",
  "thd_voltage_v1_high", "thd_voltage_v2_high", "thd_voltage_v3_high",
  "thd_current_a_high", "thd_current_b_high", "thd_current_c_high",
  "short_term_flicker_pst_a_n", "short_term_flicker_pst_b_n", "short_term_flicker_pst_c_n",
  "power_factor_total", "frequency",
];

const fases = (m: Record<string, number>, ks: string[]) => ks.map((k) => m[k]).filter((x) => x != null && Number.isFinite(x) && x > 0);

/**
 * Evalua un intervalo de 10 min (promedios por metrica). Devuelve true/false por indicador, o null
 * si el equipo no mide esa variable.
 */
export function evaluarIntervalo(m: Record<string, number>, l: Limites): Record<Indicador, boolean | null> {
  const vs = fases(m, ["voltage_a_n", "voltage_b_n", "voltage_c_n"]);
  const thdV = fases(m, ["thd_voltage_v1_high", "thd_voltage_v2_high", "thd_voltage_v3_high"]);
  const thdI = fases(m, ["thd_current_a_high", "thd_current_b_high", "thd_current_c_high"]);
  const pst = fases(m, ["short_term_flicker_pst_a_n", "short_term_flicker_pst_b_n", "short_term_flicker_pst_c_n"]);
  const prom = vs.length ? vs.reduce((a, x) => a + x, 0) / vs.length : 0;
  const pf = m.power_factor_total;
  const hz = m.frequency;
  return {
    tension: vs.length ? vs.every((v) => Math.abs(v - l.nominal) / l.nominal * 100 <= l.tension) : null,
    desbalance: vs.length >= 2 && prom > 0 ? (Math.max(...vs.map((v) => Math.abs(v - prom))) / prom) * 100 <= l.desbalance : null,
    thdV: thdV.length ? Math.max(...thdV) <= l.thdV : null,
    thdI: thdI.length ? Math.max(...thdI) <= l.thdI : null,
    pst: pst.length ? Math.max(...pst) <= l.pst : null,
    fp: pf != null && Number.isFinite(pf) && pf !== 0 ? Math.abs(pf) >= l.fp : null,
    freq: hz != null && hz > 0 ? Math.abs(hz - 60) <= l.freq : null,
  };
}
