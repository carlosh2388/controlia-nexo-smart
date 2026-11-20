import axios from "axios";
import { useAuthStore } from "../store/auth.store";

/**
 * Abierta por HTTPS, la web no puede pedir datos a una API "http://" (el navegador lo bloquea):
 * usa la misma direccion de la pagina y nginx pasa /api a la API (ver apps/web/https.conf.tpl).
 */
export function mismoOrigenSiHttps(url: string): string {
  if (typeof window === "undefined" || window.location.protocol !== "https:") return url;
  try {
    const u = new URL(url, window.location.href);
    if (u.protocol === "http:") return `https://${window.location.host}${u.pathname}`;
    if (u.protocol === "ws:") return `wss://${window.location.host}${u.pathname}`;
  } catch {
    /* url invalida: se deja igual */
  }
  return url;
}

export const API_BASE_URL = mismoOrigenSiHttps(import.meta.env.VITE_API_URL ?? "http://localhost:3000/api/v1");

export const apiClient = axios.create({ baseURL: API_BASE_URL });

apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const { refreshToken, clear, setAccessToken } = useAuthStore.getState();
  if (!refreshToken) {
    clear();
    throw new Error("Sesion expirada");
  }

  const { data } = await axios.post(`${API_BASE_URL}/auth/refresh`, { refreshToken });
  setAccessToken(data.accessToken);
  return data.accessToken;
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      try {
        refreshPromise ??= refreshAccessToken().finally(() => {
          refreshPromise = null;
        });
        const newToken = await refreshPromise;
        original.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(original);
      } catch (refreshError) {
        useAuthStore.getState().clear();
        return Promise.reject(refreshError);
      }
    }
    return Promise.reject(error);
  },
);
