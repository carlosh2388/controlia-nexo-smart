import type { AgentProtocols, ModbusServerConfig } from "../api/agents";

/** Perfiles Modbus que sabe leer el agente (modbussource/profiles.go: via AS-P; direct.go: directo al medidor). */
export const MODBUS_PROFILES = [
  { value: "ion7400", label: "ION7400 (medidor principal)" },
  { value: "ion7400-b", label: "ION7400 (bloque B)" },
  { value: "pm2130", label: "PM2130 (circuito)" },
  { value: "generator", label: "Generador" },
  { value: "ion7400-directo", label: "ION7400 · lectura directa" },
  { value: "pm2130-directo", label: "PM2130 · lectura directa" },
  { value: "generador-directo", label: "Generador · lectura directa (controlador por RS-485)" },
];

/** Secciones que se comparan para contar cambios sin guardar. */
export const SECTIONS: { key: keyof AgentProtocols; label: string }[] = [
  { key: "modbusServers", label: "Modbus TCP" },
  { key: "bacnet", label: "BACnet/IP" },
  { key: "loraGateway", label: "LoRaWAN directo" },
  { key: "lorawan", label: "LoRaWAN por ChirpStack" },
  { key: "mqtt", label: "Zigbee2MQTT" },
  { key: "discovery", label: "Rangos de busqueda" },
];

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? null));

/** Copia editable de la config: el formato viejo "modbus" (un servidor) pasa a "modbusServers", como hace el agente. */
export function toDraft(config: AgentProtocols): AgentProtocols {
  const draft = clone(config);
  const servers = [...(draft.modbus ? [draft.modbus] : []), ...(draft.modbusServers ?? [])];
  delete draft.modbus;
  draft.modbusServers = servers;
  draft.discovery ??= {};
  return draft;
}

/** Secciones que cambiaron entre la config guardada y el borrador. */
export function changedSections(saved: AgentProtocols, draft: AgentProtocols): string[] {
  const base = toDraft(saved);
  return SECTIONS.filter((s) => JSON.stringify(base[s.key] ?? null) !== JSON.stringify(draft[s.key] ?? null)).map((s) => s.label);
}

export function splitBrokerUrl(url: string | undefined): { scheme: string; host: string; port: number } {
  const m = /^([a-z]+):\/\/([^:/]+)(?::(\d+))?/i.exec(url ?? "");
  if (!m) return { scheme: "tcp", host: "", port: 1883 };
  return { scheme: m[1], host: m[2], port: m[3] ? Number(m[3]) : 1883 };
}

export function joinBrokerUrl(scheme: string, host: string, port: number): string {
  return host ? `${scheme || "tcp"}://${host}:${port}` : "";
}

/** ":1700" o "0.0.0.0:1700" -> partes editables. */
export function splitListen(listen: string | undefined): { ip: string; port: number } {
  const m = /^([0-9.]*):(\d+)$/.exec(listen ?? ":1700");
  return m ? { ip: m[1], port: Number(m[2]) } : { ip: "", port: 1700 };
}

function ipToInt(ip: string): number | null {
  const p = ip.trim().split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((acc, x) => acc * 256 + Number(x), 0);
}

export function isValidIp(ip: string) {
  return ipToInt(ip) !== null;
}

/**
 * Misma regla que apps/Agente_Go/internal/scan/targets.go: IP, rango "10.0.6.1-50" o
 * "10.0.6.1-10.0.7.20", o red "10.0.6.0/24" (de /16 a /32). Devuelve null si no es valido.
 */
export function describeTarget(raw: string): { kind: "IP" | "Rango" | "Red"; hosts: number } | null {
  const t = raw.trim();
  if (t.includes("/")) {
    const [ip, bits] = t.split("/");
    const n = Number(bits);
    if (ipToInt(ip) === null || !/^\d+$/.test(bits) || n < 16 || n > 32) return null;
    const size = 2 ** (32 - n);
    return { kind: "Red", hosts: size > 2 ? size - 2 : size };
  }
  if (t.includes("-")) {
    const [a, b] = t.split("-");
    const end = b.includes(".") ? b : `${a.split(".").slice(0, 3).join(".")}.${b}`;
    const ia = ipToInt(a);
    const ib = ipToInt(end);
    if (ia === null || ib === null || ib < ia) return null;
    return { kind: "Rango", hosts: ib - ia + 1 };
  }
  return ipToInt(t) === null ? null : { kind: "IP", hosts: 1 };
}

export function countHosts(targets: string[]): number {
  return targets.reduce((n, t) => n + (describeTarget(t)?.hosts ?? 0), 0);
}

/** "1-10" o "1,2,5", unit IDs de 0 a 255. */
export function isValidUnitIds(s: string) {
  if (!s.trim()) return true;
  return s.split(",").every((part) => {
    const m = /^\s*(\d{1,3})\s*(?:-\s*(\d{1,3})\s*)?$/.exec(part);
    if (!m) return false;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    return a <= b && b <= 255;
  });
}

export function newModbusServer(host: string, unitId = 1): ModbusServerConfig {
  return { enabled: true, name: host, host, port: 502, unitId, pollIntervalSeconds: 15, devices: [] };
}

/** El agente esta en linea si su ultimo sync fue hace menos de 2 minutos (sync normal: cada 30 s). */
export function isOnline(syncedAt: string | undefined) {
  return !!syncedAt && Date.now() - new Date(syncedAt).getTime() < 120_000;
}

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return "nunca";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 10) return "recien";
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}
