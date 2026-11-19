import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import type { PilotDevicesResponse } from "./pilot";

/**
 * Red del centro de mando (apps/api/src/red): grupos por fase (Telemetría 1, 2, 3...) y sedes nuevas
 * que se leen con Agentes Go. Las 10 sedes del monitoreo central siguen viniendo de /centro/vista; aquí
 * solo se guarda en qué grupo están (sin fila = Telemetría 1).
 */
export interface RedGrupo {
  id: string;
  nombre: string;
  color: string;
  orden: number;
}

export interface RedSede {
  id: string;
  nombre: string;
  origen: "central" | "nodivo";
  grupoId: string | null;
  agentes: string[];
  lat: number | null;
  lon: number | null;
  plantilla: string | null;
  orden: number;
}

export interface RedConfig {
  grupos: RedGrupo[];
  sedes: RedSede[];
}

/** Grupo por defecto de las sedes del monitoreo central sin fila propia. */
export const GRUPO_INICIAL = "t1";

export function useRed() {
  return useQuery({
    queryKey: ["red"],
    queryFn: async () => (await apiClient.get<RedConfig>("/red")).data,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

function useInvalidar() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["red"] });
}

export function useGuardarSede() {
  const inv = useInvalidar();
  return useMutation({
    mutationFn: async ({ id, ...body }: Omit<RedSede, "orden"> & { orden?: number }) => (await apiClient.put<RedSede>(`/red/sedes/${encodeURIComponent(id)}`, body)).data,
    onSuccess: inv,
  });
}

export function useBorrarSede() {
  const inv = useInvalidar();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.delete(`/red/sedes/${encodeURIComponent(id)}`)).data,
    onSuccess: inv,
  });
}

export function useCrearGrupo() {
  const inv = useInvalidar();
  return useMutation({
    mutationFn: async (body: { nombre: string; color: string }) => (await apiClient.post<RedGrupo>("/red/grupos", body)).data,
    onSuccess: inv,
  });
}

export function useEditarGrupo() {
  const inv = useInvalidar();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string; nombre?: string; color?: string; orden?: number }) => (await apiClient.patch<RedGrupo>(`/red/grupos/${encodeURIComponent(id)}`, body)).data,
    onSuccess: inv,
  });
}

export function useBorrarGrupo() {
  const inv = useInvalidar();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.delete(`/red/grupos/${encodeURIComponent(id)}`)).data,
    onSuccess: inv,
  });
}

/** Agentes de Escuintla (piloto Gravix): la sede del monitoreo central "escuintla". */
const AGENTES_ESCUINTLA = ["igss-escuintla", "igss-escuintla-directo"];

export interface SedeDeAgente { id: string; nombre: string; grupo: RedGrupo | null }

/** Sede a la que pertenece cada agente (un agente lee una sola sede); null = sin sede asignada. */
export function useSedeDeAgente() {
  const red = useRed();
  return (bk: string | null | undefined): SedeDeAgente | null => {
    if (!bk || !red.data) return null;
    const { grupos, sedes } = red.data;
    const grupoDe = (gid: string | null) => grupos.find((g) => g.id === gid) ?? null;
    // Los agentes de Escuintla son siempre de Escuintla, aunque otra sede los tenga asignados por error.
    if (AGENTES_ESCUINTLA.includes(bk)) {
      const esc = sedes.find((s) => s.id === "escuintla");
      return { id: "escuintla", nombre: "Escuintla", grupo: grupoDe(esc ? esc.grupoId : GRUPO_INICIAL) };
    }
    const fila = sedes.find((s) => s.origen === "nodivo" && s.agentes.includes(bk));
    return fila ? { id: fila.id, nombre: fila.nombre, grupo: grupoDe(fila.grupoId) } : null;
  };
}

/** Respuesta v1 (formato Telemetría 1) de una sede nueva. */
export function useTelemetriaV1(id: string | null) {
  return useQuery({
    queryKey: ["red", "telemetria", id],
    queryFn: async () => (await apiClient.get<{ devices: Record<string, unknown>[]; lectura: Record<string, unknown> }>(`/red/sedes/${encodeURIComponent(id!)}/telemetria`)).data,
    enabled: !!id,
    refetchInterval: 30_000,
  });
}

/** Equipos de varios agentes a la vez (sedes nuevas): misma consulta y cache que usePilotDevices. */
export function usePilotDevicesMany(keys: string[]) {
  return useQueries({
    queries: keys.map((k) => ({
      queryKey: ["pilot", k, "devices"],
      queryFn: async () => (await apiClient.get<PilotDevicesResponse>(`/pilot/${encodeURIComponent(k)}/devices`)).data,
      refetchInterval: 15_000,
      refetchOnWindowFocus: false,
    })),
  });
}
