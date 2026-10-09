import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./client";

export type EventSeverity = "info" | "warning" | "critical";

/** Evento detectado por el Agente_Go de una sede (ver docs/sedes-igss.md, "Catalogo de eventos"). */
export interface SiteEvent {
  id: string;
  type: string;
  severity: EventSeverity;
  message: string;
  value: number | null;
  data: Record<string, unknown> | null;
  occurredAt: string;
  deviceId: string | null;
  deviceName: string | null;
  externalId: string | null;
}

export interface SiteEventsResponse {
  buildingKey: string;
  counts: Partial<Record<EventSeverity, number>>;
  events: SiteEvent[];
}

export interface SiteEventsParams {
  from?: string;
  to?: string;
  deviceId?: string;
  type?: string;
  severity?: EventSeverity;
  limit?: number;
}

export function useSiteEvents(buildingKey: string | null, params: SiteEventsParams, options?: { refetchIntervalMs?: number }) {
  return useQuery({
    queryKey: ["site-events", buildingKey, params],
    queryFn: async () => {
      const { data } = await apiClient.get<SiteEventsResponse>(`/sites/${encodeURIComponent(buildingKey!)}/events`, { params });
      return data;
    },
    enabled: !!buildingKey,
    staleTime: 5_000,
    refetchInterval: options?.refetchIntervalMs ?? 15_000,
    refetchOnWindowFocus: false,
  });
}
