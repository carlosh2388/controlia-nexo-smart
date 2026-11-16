import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import { useAuthStore } from "../store/auth.store";

/** Pestañas del menu (mismas claves que apps/api/src/access/access.constants.ts). */
export const TAB_DEFS = [
  { key: "centro", label: "Centro de mando", help: "Pantalla de inicio de todos los perfiles" },
  { key: "operativa", label: "Vista Operativa", help: "Panel de dispositivos" },
  { key: "edificio", label: "Vista de Edificio", help: "Plano 3D del edificio" },
  { key: "gestion", label: "Gestión Inteligente", help: "Automatizaciones" },
  { key: "sedes", label: "Sedes", help: "Cadena de frío, bombeo y calderas" },
  { key: "agente", label: "Equipos", help: "Descubrir, topología, configuración y agentes" },
  { key: "config", label: "Equipos (protocolos)", help: "Con esta o la anterior se ve la pestaña Equipos" },
  { key: "gravix", label: "Piloto Gravix", help: "Historial, huecos y directo vs EBO" },
  { key: "usuarios", label: "Usuarios y permisos", help: "Solo administradores" },
] as const;
export type TabKey = (typeof TAB_DEFS)[number]["key"];

export const ACTION_DEFS = [
  { key: "reconocer", label: "Reconocer alarmas", help: "En el panel de alarmas" },
  { key: "excel", label: "Descargar historial a Excel", help: "Pestaña Tendencias de cada equipo" },
  { key: "agentes", label: "Configurar agentes y equipos", help: "IP, ID, perfiles Modbus, lectura directa" },
  { key: "correos", label: "Editar reglas y destinatarios de correo", help: "Umbrales y a quién llega cada alarma" },
] as const;

export const ROLE_LABEL: Record<string, string> = { admin: "Administrador", operator: "Operador", viewer: "Consulta" };

export interface Access {
  role: "admin" | "operator" | "viewer";
  tabs: string[];
  actions: string[];
  /** Sedes que puede ver; vacio = todas. */
  sites: string[];
  homeTab: string;
}

export function useAccess() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ["access", "me", token ? "on" : "off"],
    queryFn: async () => (await apiClient.get<Access>("/access/me")).data,
    enabled: !!token,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export interface RoleMatrix {
  tabs: string[];
  actions: string[];
  roles: Record<"admin" | "operator" | "viewer", { tabs: string[]; actions: string[] }>;
}

export function useRoleMatrix() {
  return useQuery({ queryKey: ["access", "roles"], queryFn: async () => (await apiClient.get<RoleMatrix>("/access/roles")).data });
}

export function useSaveRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ role, tabs, actions }: { role: "operator" | "viewer"; tabs: string[]; actions: string[] }) =>
      (await apiClient.put<RoleMatrix>(`/access/roles/${role}`, { tabs, actions })).data,
    onSuccess: (data) => {
      qc.setQueryData(["access", "roles"], data);
      void qc.invalidateQueries({ queryKey: ["access", "me"] });
    },
  });
}

/** Descarga un archivo de la API con la sesion actual (la API exige el token). */
export async function downloadFile(url: string, params: Record<string, string | number>, fallbackName: string) {
  const res = await apiClient.get<Blob>(url, { params, responseType: "blob" });
  const cd = String(res.headers["content-disposition"] ?? "");
  const name = /filename="?([^"]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const href = URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
}
