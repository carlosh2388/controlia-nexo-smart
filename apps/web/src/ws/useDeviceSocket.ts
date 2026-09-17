import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../store/auth.store";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3000/ws";

interface DeviceStateMessage {
  type: "device.state";
  deviceId: string;
  state: string;
  rawPayload?: string;
}

/** Se conecta al WebSocket del backend y refresca la cache de dispositivos cuando llega un cambio de estado. */
export function useDeviceSocket() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  const refreshTimer = useRef<number | null>(null);
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    if (!accessToken) return;

    const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(accessToken)}`);
    const refreshDelayMs = 1_500;

    const refreshDeviceData = () => {
      lastRefreshAt.current = Date.now();
      refreshTimer.current = null;
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      queryClient.invalidateQueries({ queryKey: ["areas"] });
    };

    const scheduleRefresh = () => {
      if (refreshTimer.current !== null) return;

      const elapsedMs = Date.now() - lastRefreshAt.current;
      if (elapsedMs >= refreshDelayMs) {
        refreshDeviceData();
        return;
      }

      refreshTimer.current = window.setTimeout(refreshDeviceData, refreshDelayMs - elapsedMs);
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as DeviceStateMessage;
        if (message.type === "device.state") {
          scheduleRefresh();
        }
      } catch {
        // mensaje no reconocido, se ignora
      }
    };

    return () => {
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
      socket.close();
    };
  }, [accessToken, queryClient]);
}
