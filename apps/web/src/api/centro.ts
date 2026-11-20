import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./client";

/**
 * Centro de mando (apps/api/src/centro): la vista del monitoreo central de las 10 sedes, el
 * historial que Nodivo guarda de cada medidor y las alarmas/correos de cada equipo en su sede.
 * Mismos tipos que api-SIASA/monitoreo-central/lib/tipos.ts.
 */

export type Nivel = "ok" | "advertencia" | "critico" | "sin_respuesta";

export interface CentroDispositivo {
  id: string;
  nombre: string;
  inventario: string | null;
  area: string | null;
  estado: string;
  ultimo_cambio: string | null;
  evento: string | null;
  generador: boolean;
  lectura: { kw: number | null; tipo_kw: "potencia" | "demanda" | null; fuente: "comercial" | "generador" | null; v_prom: number | null; a_prom: number | null } | null;
}

export interface CentroEventoAbierto {
  codigo: string;
  evento: string;
  titulo: string;
  severidad: "critico" | "advertencia" | "info";
  dispositivo: string | null;
  inventario: string | null;
  desde: string;
}

export interface CentroSede {
  id: string;
  nombre: string;
  ip: string;
  lat: number | null;
  lon: number | null;
  panel: string;
  nivel: Nivel;
  sin_respuesta: boolean;
  error: string | null;
  ultima_consulta_ok: string | null;
  latencia_ms: number | null;
  estado: { estado: string; motivo: string | null; antiguedad_s: number; reconexiones_ultima_hora: number; correo: string } | null;
  medidores: { total: number; ok: number; fuera: number; alerta: number; espera: number; generador: number };
  dispositivos: CentroDispositivo[];
  abiertos: CentroEventoAbierto[];
  por_dia: Record<string, { total: number; criticos: number }>;
  historial: { hora: string; nivel: Nivel | null }[];
}

export interface CentroActividad {
  id: string;
  t: string;
  tipo: "critico" | "advertencia" | "info" | "ok" | "sin_respuesta";
  sede: string;
  sede_id: string;
  titulo: string;
  detalle: string | null;
}

export interface CentroVista {
  generado: string;
  dias: string[];
  totales: { sedes: number; sedes_responden: number; sedes_ok: number; medidores: number; medidores_ok: number; medidores_fuera: number; criticos: number; abiertos: number; reconexiones: number };
  sedes: CentroSede[];
  actividad: CentroActividad[];
  recibido: string;
  atrasado: boolean;
  error: string | null;
}

/**
 * Eventos de instrumentacion: los "vigilantes" (reles que le dicen al ION si hay energia comercial o de
 * generador) desconectados no dejan sin datos al medidor ni sin energia a la sede; solo ciegan la deteccion
 * de transferencias. La sede los manda como "critico" (y asi se van sus correos, que no se tocan); en Nodivo
 * se muestran como advertencia (ambar). El rojo queda para medidores fuera de linea, voltaje en cero y sedes
 * sin respuesta.
 */
export const esInstrumentacion = (evento: string | null | undefined, titulo?: string | null) => /VIGILANTE/i.test(`${evento ?? ""} ${titulo ?? ""}`);

const CAIDO = new Set(["fuera_de_linea", "en_cero"]);

export function reclasificar(v: CentroVista): CentroVista {
  const sedes = v.sedes.map((s) => {
    const abiertos = s.abiertos.map((a) => (a.severidad === "critico" && esInstrumentacion(a.evento, a.titulo) ? { ...a, severidad: "advertencia" as const } : a));
    const quedanCriticos = abiertos.some((a) => a.severidad === "critico");
    const equiposCaidos = s.medidores.fuera > 0 || s.dispositivos.some((d) => CAIDO.has(d.estado));
    const nivel: Nivel = s.nivel === "critico" && !s.sin_respuesta && !quedanCriticos && !equiposCaidos && abiertos.some((a) => esInstrumentacion(a.evento, a.titulo)) ? "advertencia" : s.nivel;
    return { ...s, abiertos, nivel };
  });
  const actividad = v.actividad.map((a) => (a.tipo === "critico" && esInstrumentacion(a.titulo, a.detalle) ? { ...a, tipo: "advertencia" as const } : a));
  const criticos = sedes.reduce((n, s) => n + s.abiertos.filter((a) => a.severidad === "critico").length, 0);
  return { ...v, sedes, actividad, totales: { ...v.totales, criticos, sedes_ok: sedes.filter((s) => s.nivel === "ok").length } };
}

export function useCentroVista() {
  return useQuery({
    queryKey: ["centro", "vista"],
    queryFn: async () => (await apiClient.get<CentroVista>("/centro/vista")).data,
    select: reclasificar,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/** Alarma guardada en la base de la sede (api_eventos), con la hora de sus correos. */
export interface CentroEvento {
  codigo: string;
  sede: string;
  evento: string;
  severidad: "critico" | "advertencia" | "info";
  dispositivo: string | null;
  inventario: string | null;
  inicio: string;
  fin: string | null;
  duracion_s: number | null;
  detalle: Record<string, unknown> | null;
  notificado_en: string | null;
  cierre_notificado_en: string | null;
}

export function useCentroEventos(sede: string | null, dispositivo: string | null, dias = 30) {
  return useQuery({
    queryKey: ["centro", "eventos", sede, dispositivo, dias],
    queryFn: async () =>
      (await apiClient.get<{ eventos: CentroEvento[]; origen: string | null }>(`/centro/sedes/${sede}/eventos`, { params: { dispositivo, dias } })).data,
    select: (d) => ({ ...d, eventos: d.eventos.map((e) => (e.severidad === "critico" && esInstrumentacion(e.evento) ? { ...e, severidad: "advertencia" as const } : e)) }),
    enabled: !!sede && !!dispositivo,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export interface CentroHistorial {
  minutes: number;
  bucketSeconds: number;
  desde: string | null;
  points: { t: string; kw: number | null; v: number | null; a: number | null; fuera: boolean }[];
}

export function useCentroHistorial(sede: string | null, medidor: string | null, minutes: number) {
  return useQuery({
    queryKey: ["centro", "historial", sede, medidor, minutes],
    queryFn: async () => (await apiClient.get<CentroHistorial>(`/centro/sedes/${sede}/medidores/${encodeURIComponent(medidor ?? "")}/historial`, { params: { minutes } })).data,
    enabled: !!sede && !!medidor,
    refetchInterval: minutes > 1440 ? 300_000 : 60_000,
    refetchOnWindowFocus: false,
  });
}

/* ---------------- analitica predictiva (asistente Gravix) ---------------- */
export type NivelRiesgo = "alto" | "medio" | "bajo";
export interface HallazgoRiesgo {
  id: string;
  tipo: "desconexion" | "voltaje" | "carga" | "comunicacion" | "lectura" | "generador";
  nivel: NivelRiesgo;
  puntaje: number;
  /** Probabilidad estimada (0-1) en los proximos 7 dias, cuando aplica. */
  probabilidad: number | null;
  sedeId: string;
  sedeNombre: string;
  equipo: string | null;
  inventario: string | null;
  titulo: string;
  detalle: string;
  recomendacion: string;
  serie: { etiqueta: string; dias: string[]; valores: (number | null)[]; unidad: string } | null;
}
export interface CentroAnalitica {
  generado: string;
  diasAnalizados: number;
  equiposAnalizados: number;
  resumen: { alto: number; medio: number; bajo: number };
  hallazgos: HallazgoRiesgo[];
  sedes24h: Sede24h[];
  metricas: { dias: string[]; sedes: MetricasSede[] };
}

/** Riesgos calculados en el servidor con el historial de centro_lecturas (se recalcula cada 10 min). */
export function useCentroAnalitica() {
  return useQuery({
    queryKey: ["centro", "analitica"],
    queryFn: async () => (await apiClient.get<CentroAnalitica>("/centro/analitica")).data,
    refetchInterval: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
export interface Sede24h {
  sedeId: string;
  sedeNombre: string;
  nivel: "critico" | "advertencia" | "estable";
  caidas: number;
  minSinDatos: number;
  cortesComunicacion: number;
  caidasTension: string[];
  criticas: number;
  advertencias: number;
  cambioConsumo: number | null;
  riesgo: { titulo: string; nivel: NivelRiesgo; probabilidad: number | null } | null;
}
/** Metricas diarias por sede (ultimos 14 dias) para la pestaña Analitica. */
export interface MetricasSede {
  sedeId: string;
  sedeNombre: string;
  /** Demanda promedio del dia (suma de los analizadores ION7400; sin ION, de sus medidores), kW. */
  kwProm: (number | null)[];
  /** Demanda maxima del dia (suma de los maximos de esos medidores), kW. */
  kwMax: (number | null)[];
  /** Voltaje promedio L-N del dia, V. */
  vProm: (number | null)[];
  /** Minutos sin datos de sus medidores (fuera de linea / voltaje en cero). */
  minSinDatos: (number | null)[];
}
