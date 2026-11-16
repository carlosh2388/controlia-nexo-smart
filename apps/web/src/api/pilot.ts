import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";

/**
 * Pestaña Piloto Gravix (apps/api/src/timeseries): equipos de energia de una sede con su estado en
 * vivo, el historial de TimescaleDB y los huecos que detecta la API.
 */

export interface DirectConnection {
  ip: string;
  port: number;
  unitId: number | null;
  viaDeviceId: string | null;
  enabled: boolean;
  compareWithAsp: boolean;
  intervalSeconds: number;
  updatedAt?: string;
}

export interface PilotDevice {
  id: string;
  name: string;
  model: string | null;
  attributes: Record<string, unknown>;
  externalId: string | null;
  state: string | null;
  readings: Record<string, unknown>;
  updatedAt: string | null;
  directConnection: DirectConnection | null;
  historySince: string | null;
  gaps: { pending: number; openNow: number; total: number; missingMinutes: number };
  completeness: number | null;
}

export interface PilotDevicesResponse {
  buildingKey: string;
  lastSync: { agentVersion?: string; syncedAt?: string } | null;
  devices: PilotDevice[];
}

export interface PilotGap {
  id: string;
  startedAt: string;
  endedAt: string | null;
  minutes: number;
  cause: string;
  status: "open" | "closed" | "recovered" | "partial" | "estimated" | "unrecoverable";
}

export interface PilotSeries {
  metric: string;
  minutes: number;
  bucketSeconds: number;
  points: { t: string; v: number }[];
  gaps: PilotGap[];
}

/** Comparativo de una metrica: lectura directa del medidor vs la que llega por el AS-P (Fase B). */
export interface PilotCompareMetric {
  metric: string;
  intervals: number;
  avgAsp: number;
  avgDirect: number;
  lastAsp: number | null;
  lastDirect: number | null;
  meanAbsDiff: number;
  maxAbsDiff: number;
  meanPctDiff: number | null;
  tolerance: { kind: "pct" | "abs"; value: number };
  withinPct: number;
}

export interface PilotCompare {
  deviceId: string;
  /** null = el equipo todavia no tiene lectura directa (agente de prueba "<sede>-directo"). */
  directDeviceId: string | null;
  directBuildingKey: string | null;
  directUpdatedAt?: string | null;
  directState?: string | null;
  minutes: number;
  bucketSeconds: number;
  metrics: PilotCompareMetric[];
  onlyAsp: string[];
  onlyDirect: string[];
}

async function fetchPilotCompare(deviceId: string, minutes: number) {
  const { data } = await apiClient.get<PilotCompare>(`/pilot/devices/${deviceId}/compare`, { params: { minutes } });
  return data;
}

export function usePilotCompare(deviceId: string | null, minutes = 60) {
  return useQuery({
    queryKey: ["pilot", "compare", deviceId, minutes],
    queryFn: () => fetchPilotCompare(deviceId as string, minutes),
    enabled: !!deviceId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Resumen de la sede: el comparativo de cada equipo (mismo endpoint que la pestaña del equipo).
 * Ventanas largas se refrescan menos seguido: cada una agrega dias de lecturas.
 */
export function usePilotCompareMany(deviceIds: string[], minutes: number) {
  return useQueries({
    queries: deviceIds.map((id) => ({
      queryKey: ["pilot", "compare", id, minutes],
      queryFn: () => fetchPilotCompare(id, minutes),
      refetchInterval: minutes > 60 ? 300_000 : 60_000,
      refetchOnWindowFocus: false,
      staleTime: minutes > 60 ? 240_000 : 30_000,
    })),
  });
}

export function usePilotDevices(buildingKey: string) {
  return useQuery({
    queryKey: ["pilot", buildingKey, "devices"],
    queryFn: async () => {
      const { data } = await apiClient.get<PilotDevicesResponse>(`/pilot/${encodeURIComponent(buildingKey)}/devices`);
      return data;
    },
    // El agente lee cada 15 s.
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
  });
}

export function usePilotSeries(deviceId: string | null, metric: string | null, minutes = 60) {
  return useQuery({
    queryKey: ["pilot", "series", deviceId, metric, minutes],
    queryFn: async () => {
      const { data } = await apiClient.get<PilotSeries>(`/pilot/devices/${deviceId}/series`, { params: { metric, minutes } });
      return data;
    },
    enabled: !!deviceId && !!metric,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** Espectro de armonicos guardado (ION7400 directo): valores en V o A por armonico, harm_<v|i>_<a|b|c>_NN. */
export interface PilotSpectrum {
  deviceId: string;
  readAt: string | null;
  values: Record<string, number>;
}

export function usePilotSpectrum(deviceId: string | null, at: string | null) {
  return useQuery({
    queryKey: ["pilot", "espectro", deviceId, at],
    queryFn: async () => (await apiClient.get<PilotSpectrum>(`/pilot/devices/${deviceId}/espectro`, { params: at ? { at } : {} })).data,
    enabled: !!deviceId,
    refetchInterval: at ? false : 60_000,
    refetchOnWindowFocus: false,
  });
}

export function usePilotGaps(deviceId: string | null, days = 7) {
  return useQuery({
    queryKey: ["pilot", "gaps", deviceId, days],
    queryFn: async () => {
      const { data } = await apiClient.get<PilotGap[]>(`/pilot/devices/${deviceId}/gaps`, { params: { days } });
      return data;
    },
    enabled: !!deviceId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useSaveDirectConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ deviceId, connection }: { deviceId: string; connection: Omit<DirectConnection, "updatedAt"> }) => {
      const { data } = await apiClient.put<DirectConnection>(`/pilot/devices/${deviceId}/connection`, connection);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pilot"] }),
  });
}
