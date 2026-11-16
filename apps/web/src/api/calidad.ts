import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";

/** Normas, cumplimiento, pronostico, umbrales y prueba de lectura (apps/api/src/timeseries/quality.service.ts). */

export type Norma = "ntsd" | "ieee519" | "en50160";
export interface Limites { tension: number; nominal: number; desbalance: number; thdV: number; thdI: number; pst: number; fp: number; freq: number; carga: number }
export const INDICADORES = [
  { k: "tension", t: "Tensión", lim: (l: Limites) => `±${l.tension} % de ${l.nominal} V` },
  { k: "desbalance", t: "Desbalance V", lim: (l: Limites) => `≤ ${l.desbalance} %` },
  { k: "thdV", t: "THD de tensión", lim: (l: Limites) => `≤ ${l.thdV} %` },
  { k: "thdI", t: "THD de corriente", lim: (l: Limites) => `≤ ${l.thdI} % (ref.)` },
  { k: "pst", t: "Flicker Pst", lim: (l: Limites) => `≤ ${l.pst}` },
  { k: "fp", t: "Factor de potencia", lim: (l: Limites) => `≥ ${l.fp}` },
  { k: "freq", t: "Frecuencia", lim: (l: Limites) => `60 ± ${l.freq} Hz` },
] as const;
export const NORMA_TXT: Record<Norma, string> = { ntsd: "NTSD Guatemala", ieee519: "IEEE 519", en50160: "EN 50160" };

export interface Cumplimiento {
  buildingKey: string;
  dias: number;
  norma: Norma;
  normaNombre: string;
  fuente: string;
  limites: Limites;
  equipos: { id: string; nombre: string; propios: boolean; indicadores: Record<string, { pct: number; intervalos: number; cumple: boolean } | null> }[];
  resumen: { evaluados: number; cumplen: number };
  calculado: string;
}

export function useCumplimiento(buildingKey: string, dias: number, norma: Norma) {
  return useQuery({
    queryKey: ["calidad", "cumplimiento", buildingKey, dias, norma],
    queryFn: async () => (await apiClient.get<Cumplimiento>(`/pilot/${encodeURIComponent(buildingKey)}/cumplimiento`, { params: { dias, norma } })).data,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export interface Pronostico {
  metric: string;
  capacidad: number | null;
  pendienteDiaria?: number;
  historia: { t: string; v: number }[];
  pronostico: { t: string; v: number; min: number; max: number }[];
  suficiente: boolean;
}

export function usePronostico(deviceId: string | null, metric: string, dias = 14, horizonte = 7) {
  return useQuery({
    queryKey: ["calidad", "pronostico", deviceId, metric, dias, horizonte],
    queryFn: async () => (await apiClient.get<Pronostico>(`/pilot/devices/${deviceId}/pronostico`, { params: { metric, dias, horizonte } })).data,
    enabled: !!deviceId,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useUmbrales(deviceId: string | null) {
  return useQuery({
    queryKey: ["calidad", "umbrales", deviceId],
    queryFn: async () => (await apiClient.get<{ norma: Norma; limites: Limites; propios: boolean; actualizado: string | null }>(`/pilot/devices/${deviceId}/umbrales`)).data,
    enabled: !!deviceId,
  });
}

export function useGuardarUmbrales() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ deviceId, norma, limites }: { deviceId: string; norma: Norma; limites: Partial<Limites> }) =>
      (await apiClient.put(`/pilot/devices/${deviceId}/umbrales`, { norma, limites })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["calidad"] }),
  });
}

export interface PruebaLectura { ok: boolean; valido: boolean; ms: number; valores?: Record<string, number | null>; error?: string; funcion: string }

export function useProbarLectura() {
  return useMutation({
    mutationFn: async ({ deviceId, ip, port, unitId, perfil }: { deviceId: string; ip: string; port: number; unitId: number; perfil: string }) =>
      (await apiClient.post<PruebaLectura>(`/pilot/devices/${deviceId}/probar`, { ip, port, unitId, perfil })).data,
  });
}
