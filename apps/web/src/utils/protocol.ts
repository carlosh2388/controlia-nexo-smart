import type { StatTone } from "../components/StatTile";

/** Etiqueta legible + color por protocolo; orden fijo para que la fila de tarjetas no salte al cambiar los datos. */
export const PROTOCOL_META: Record<string, { label: string; tone: StatTone }> = {
  http: { label: "HTTP / Home Assistant", tone: "sky" },
  mqtt: { label: "MQTT", tone: "emerald" },
  bacnet: { label: "BACnet (aires)", tone: "amber" },
  lorawan: { label: "LoRaWAN", tone: "violet" },
  ewelink: { label: "eWeLink LAN", tone: "teal" },
};

export const PROTOCOL_ORDER = ["http", "mqtt", "bacnet", "lorawan", "ewelink"];
