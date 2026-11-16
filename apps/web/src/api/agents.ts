import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import type { AgentSyncStatus } from "./devices";

/**
 * Configuracion remota de los Agente_Go (apps/api/src/agents). Las claves son las mismas que las
 * del config.yaml del agente (ver apps/Agente_Go/config.example.yaml): el agente la descarga y la
 * aplica sin reiniciar.
 */

/** Lo que la API manda en lugar de una contraseña o llave guardada. Si se devuelve igual, se conserva. */
export const SECRET_MASK = "********";

export interface BrokerConfig {
  enabled: boolean;
  brokerUrl: string;
  username?: string;
  password?: string;
  /** Solo Zigbee2MQTT. */
  baseTopic?: string;
}

export interface BacnetConfig {
  enabled: boolean;
  bridgeUrl: string;
  bridgeToken?: string;
  pollIntervalSeconds?: number;
  devices: { name: string; host: string }[];
}

export interface ModbusDeviceConfig {
  name: string;
  profile: string;
  start: number;
  startCandidates?: number[];
  extra?: { key: string; register: number }[];
  attributes?: Record<string, unknown>;
}

export interface ModbusServerConfig {
  enabled: boolean;
  name?: string;
  host: string;
  port?: number;
  unitId?: number;
  pollIntervalSeconds?: number;
  timeoutMs?: number;
  readDelayMs?: number;
  devices?: ModbusDeviceConfig[];
}

export interface LoraGatewayConfig {
  enabled: boolean;
  listen?: string;
  gatewayTimeoutSeconds?: number;
  maxRadioDevices?: number;
  keys?: unknown[];
}

export interface DiscoveryConfig {
  modbus?: { targets: string[]; unitIds?: string };
  bacnet?: { targets: string[] };
}

export interface AgentProtocols {
  mqtt?: BrokerConfig | null;
  lorawan?: BrokerConfig | null;
  bacnet?: BacnetConfig | null;
  /** Formato viejo de un solo servidor; la pantalla lo pasa a modbusServers al cargar. */
  modbus?: ModbusServerConfig | null;
  modbusServers?: ModbusServerConfig[];
  loraGateway?: LoraGatewayConfig | null;
  discovery?: DiscoveryConfig;
}

export interface AgentConfigResponse {
  buildingKey: string;
  version: number;
  appliedVersion: number | null;
  appliedAt: string | null;
  applyError: string | null;
  updatedAt: string;
  config: AgentProtocols;
}

export interface AgentSummary {
  buildingKey: string;
  hasConfig: boolean;
  version: number | null;
  appliedVersion: number | null;
  appliedAt: string | null;
  applyError: string | null;
  updatedAt: string | null;
  lastSync: (AgentSyncStatus & { total?: number }) | null;
}

export type ScanProtocol = "modbus" | "bacnet" | "mqtt" | "lorawan";

export interface ScanItem {
  protocol: ScanProtocol;
  targets: string[];
  port?: number;
  unitIds?: string;
}

export interface ScanResultRow {
  protocol: ScanProtocol;
  host: string;
  port: number;
  status: "ok" | "unreachable";
  detail: string;
  unitIds?: number[];
  deviceId?: number;
  vendorId?: number;
  /** Agente 0.5.3+: que equipo es cada unit ID (ION7400 / PM2130 / generador) y por que. */
  devices?: ScanIdentity[];
}

export interface ScanIdentity {
  unitId: number;
  model: "ION7400" | "PM2130" | "generator" | "";
  profile?: string;
  confidence: number;
  name?: string;
  evidence: string;
}

export interface ScanState {
  id: string;
  status: "pending" | "running" | "done" | "error";
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  results: ScanResultRow[];
  progress?: Record<string, { done: number; total: number }>;
  error?: string;
}

export function useAgents(options?: { fast?: boolean }) {
  return useQuery({
    queryKey: ["agents"],
    queryFn: async () => {
      const { data } = await apiClient.get<AgentSummary[]>("/agents");
      return data;
    },
    // Mientras se espera que el agente aplique una version, se consulta seguido.
    refetchInterval: options?.fast ? 2_000 : 15_000,
    refetchOnWindowFocus: false,
  });
}

export function useAgentConfig(buildingKey: string | null) {
  return useQuery({
    queryKey: ["agents", buildingKey, "config"],
    queryFn: async () => {
      const { data } = await apiClient.get<AgentConfigResponse>(`/agents/${encodeURIComponent(buildingKey!)}/config`);
      return data;
    },
    enabled: !!buildingKey,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useSaveAgentConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ buildingKey, config, baseVersion }: { buildingKey: string; config: AgentProtocols; baseVersion?: number }) => {
      const { data } = await apiClient.put<AgentConfigResponse>(`/agents/${encodeURIComponent(buildingKey)}/config`, {
        config,
        baseVersion,
      });
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["agents", data.buildingKey, "config"], data);
      queryClient.invalidateQueries({ queryKey: ["agents"], exact: true });
    },
  });
}

export function useRequestScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ buildingKey, items }: { buildingKey: string; items: ScanItem[] }) => {
      const { data } = await apiClient.post<ScanState>(`/agents/${encodeURIComponent(buildingKey)}/scan`, { items });
      return data;
    },
    onSuccess: (data, { buildingKey }) => {
      queryClient.setQueryData(["agents", buildingKey, "scan"], data);
    },
  });
}

export function useAgentScan(buildingKey: string | null) {
  return useQuery({
    queryKey: ["agents", buildingKey, "scan"],
    queryFn: async () => {
      const { data } = await apiClient.get<ScanState | null>(`/agents/${encodeURIComponent(buildingKey!)}/scan`);
      return data ?? null;
    },
    enabled: !!buildingKey,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "running" ? 2_000 : false;
    },
    refetchOnWindowFocus: false,
  });
}
