import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./client";
import type { Device } from "./devices";

export interface Tenant {
  id: string;
  name: string;
  building: string;
  level: string;
}

export interface Area {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  imageFile: string;
  boxLeft: number | null;
  boxTop: number | null;
  boxWidth: number | null;
  boxHeight: number | null;
  /** Contorno real del area sobre imageFile, en pixeles nativos de la imagen (no porcentaje). */
  points: [number, number][] | null;
  order: number;
  devices: Device[];
}

/** Tamaño nativo (px) de isometrico-general-1.jpg; los `points` de cada area estan medidos en este espacio. */
export const GENERAL_IMAGE_WIDTH = 1400;
export const GENERAL_IMAGE_HEIGHT = 788;

export interface AreasResponse {
  tenant: Tenant;
  areas: Area[];
}

export function useAreas() {
  return useQuery({
    queryKey: ["areas"],
    queryFn: async () => {
      const { data } = await apiClient.get<AreasResponse>("/areas");
      return data;
    },
    staleTime: 5_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}
