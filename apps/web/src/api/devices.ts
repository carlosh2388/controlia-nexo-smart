import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";

export interface SensorReadings {
  temperature?: number;
  humidity?: number;
  battery?: number;
  voltage?: number;
  linkquality?: number;
  [key: string]: number | string | boolean | undefined;
}

export interface DeviceState {
  state: string;
  rawPayload: string | null;
  readings: SensorReadings | null;
  updatedAt: string;
}

export type HttpMethod = "GET" | "POST" | "PUT";

export interface HttpActionTemplate {
  method: HttpMethod;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpDeviceConfig {
  on: HttpActionTemplate;
  off: HttpActionTemplate;
  state?: HttpActionTemplate;
  pollIntervalMs?: number;
  stateJsonPath?: string;
}

export interface DeviceGroup {
  key: string;
  label?: string;
}

export interface EwelinkDeviceConfig {
  deviceId: string;
  devicekey: string;
  host: string;
  port?: number;
  channel?: number;
}

export type DeviceProtocol = "mqtt" | "http" | "ewelink";
export type DeviceKind = "switch" | "sensor";

export interface Device {
  id: string;
  name: string;
  protocol: DeviceProtocol;
  kind: DeviceKind;
  commandTopic: string | null;
  stateTopic: string | null;
  httpBaseUrl: string | null;
  payloadOn: string;
  payloadOff: string;
  metadata: { http?: HttpDeviceConfig; group?: DeviceGroup; hidden?: boolean; ewelink?: EwelinkDeviceConfig } | null;
  state: DeviceState | null;
}

export interface CreateDevicePayload {
  name: string;
  protocol: DeviceProtocol;
  payloadOn?: string;
  payloadOff?: string;
  commandTopic?: string;
  stateTopic?: string;
  httpBaseUrl?: string;
  httpConfig?: HttpDeviceConfig;
  group?: DeviceGroup;
  hidden?: boolean;
  ewelinkConfig?: EwelinkDeviceConfig;
}

export type UpdateDevicePayload = Partial<CreateDevicePayload>;

/** Oculta o vuelve a mostrar un dispositivo en el panel principal sin eliminarlo. */
export function useSetDeviceHidden() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, hidden }: { id: string; hidden: boolean }) => {
      const { data } = await apiClient.patch<Device>(`/devices/${id}`, { hidden });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });
}

export function useDevices() {
  return useQuery({
    queryKey: ["devices"],
    queryFn: async () => {
      const { data } = await apiClient.get<Device[]>("/devices");
      return data;
    },
    staleTime: 5_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useCreateDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateDevicePayload) => {
      const { data } = await apiClient.post<Device>("/devices", payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });
}

export function useUpdateDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: UpdateDevicePayload }) => {
      const { data } = await apiClient.patch<Device>(`/devices/${id}`, payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });
}

export function useDeleteDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/devices/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });
}

export interface HomeAssistantEntity {
  entityId: string;
  name: string;
  domain: string;
  state: string;
}

export function useDiscoverHomeAssistant() {
  return useMutation({
    mutationFn: async (params: { baseUrl: string; token: string }) => {
      const { data } = await apiClient.post<HomeAssistantEntity[]>("/devices/home-assistant/discover", params);
      return data;
    },
  });
}

export function useImportHomeAssistant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      baseUrl: string;
      token: string;
      entities: { entityId: string; name: string }[];
    }) => {
      const { data } = await apiClient.post<{ created: Device[]; failed: { entityId: string; error: string }[] }>(
        "/devices/home-assistant/import",
        params,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });
}

export interface ZigbeeEntity {
  friendlyName: string;
  name: string;
  model?: string;
  ieeeAddress?: string;
  kind: DeviceKind;
}

export interface MqttBrokerParams {
  brokerUrl?: string;
  username?: string;
  password?: string;
  baseTopic?: string;
}

export function useDiscoverZigbee2Mqtt() {
  return useMutation({
    mutationFn: async (params: MqttBrokerParams) => {
      const { data } = await apiClient.post<ZigbeeEntity[]>("/devices/zigbee2mqtt/discover", params);
      return data;
    },
  });
}

export function useImportZigbee2Mqtt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: MqttBrokerParams & { entities: { friendlyName: string; name: string }[] }) => {
      const { data } = await apiClient.post<{ created: Device[]; failed: { friendlyName: string; error: string }[] }>(
        "/devices/zigbee2mqtt/import",
        params,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });
}

/**
 * Aplica el nuevo estado al toggle de inmediato (optimista) en vez de esperar la respuesta
 * del backend: el comando real se despacha async via BullMQ y el estado confirmado llega
 * poco despues por WebSocket (useDeviceSocket) o el poll de 30s, que sobreescriben este valor.
 * Si el comando falla, se revierte al valor anterior.
 */
export function useSendDeviceCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ deviceId, action }: { deviceId: string; action: "on" | "off" }) => {
      const { data } = await apiClient.post(`/devices/${deviceId}/command`, { action });
      return data;
    },
    onMutate: async ({ deviceId, action }) => {
      await queryClient.cancelQueries({ queryKey: ["devices"] });
      const previous = queryClient.getQueryData<Device[]>(["devices"]);

      queryClient.setQueryData<Device[]>(["devices"], (old) =>
        old?.map((device) =>
          device.id === deviceId
            ? {
                ...device,
                state: {
                  state: action,
                  rawPayload: device.state?.rawPayload ?? null,
                  readings: device.state?.readings ?? null,
                  updatedAt: new Date().toISOString(),
                },
              }
            : device,
        ),
      );

      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["devices"], context.previous);
      }
    },
  });
}
