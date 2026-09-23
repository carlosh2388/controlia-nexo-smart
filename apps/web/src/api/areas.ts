import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient, API_BASE_URL } from "./client";
import type { Device } from "./devices";

/** Origen (sin /api/v1) donde vive el backend; ahi se sirven las imagenes de area subidas (/uploads/areas/...). */
const API_ORIGIN = new URL(API_BASE_URL).origin;

/**
 * Resuelve la URL real de la foto de un area: las subidas nuevas vienen como "/uploads/areas/x.jpg"
 * (servidas por la API) y las precargadas del proyecto como un nombre de archivo simple, ej.
 * "cct.jpg" (servidas como estatico por la propia app web, carpeta public/areas/).
 */
export function resolveAreaImageSrc(imageFile: string): string {
  return imageFile.startsWith("/uploads/") ? `${API_ORIGIN}${imageFile}` : `/areas/${imageFile}`;
}

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

/** Version ligera de un area (sin dispositivos), para selectores globales entre todos los niveles. */
export interface AreaFlat {
  id: string;
  name: string;
  tenantId: string;
  tenant: { level: string };
}

export interface CreateTenantPayload {
  name: string;
  building: string;
  level: string;
}

export interface CreateAreaPayload {
  tenantId: string;
  name: string;
  imageFile?: string;
  order?: number;
}

export function useTenants() {
  return useQuery({
    queryKey: ["areas", "tenants"],
    queryFn: async () => {
      const { data } = await apiClient.get<Tenant[]>("/areas/tenants");
      return data;
    },
    staleTime: 60_000,
  });
}

export function useAreas(tenantId?: string) {
  return useQuery({
    queryKey: ["areas", tenantId ?? "default"],
    queryFn: async () => {
      const { data } = await apiClient.get<AreasResponse>("/areas", { params: tenantId ? { tenantId } : undefined });
      return data;
    },
    staleTime: 5_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** Todas las areas de todos los niveles, para el selector "Area" del formulario de dispositivo. */
export function useAllAreas() {
  return useQuery({
    queryKey: ["areas", "all"],
    queryFn: async () => {
      const { data } = await apiClient.get<AreaFlat[]>("/areas/all");
      return data;
    },
    staleTime: 30_000,
  });
}

export function useCreateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateTenantPayload) => {
      const { data } = await apiClient.post<Tenant>("/areas/tenants", payload);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["areas"] }),
  });
}

/** Sube la foto de un area; devuelve el valor listo para usar como `imageFile` al crear/editar el area. */
export function useUploadAreaImage() {
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const { data } = await apiClient.post<{ imageFile: string }>("/areas/upload-image", formData);
      return data.imageFile;
    },
  });
}

export function useCreateArea() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateAreaPayload) => {
      const { data } = await apiClient.post<Area>("/areas", payload);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["areas"] }),
  });
}
