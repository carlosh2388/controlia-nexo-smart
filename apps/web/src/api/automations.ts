import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";

export type ComparisonOperator = "eq" | "ne";
export type CommandAction = "on" | "off";
export type RuleTriggerType = "device_state" | "schedule";
export type RuleExecutionStatus = "success" | "failed" | "condition_not_met";

interface DeviceRef {
  id: string;
  name: string;
}

export interface RuleTrigger {
  id: string;
  type: RuleTriggerType;
  deviceId: string | null;
  device: DeviceRef | null;
  operator: ComparisonOperator;
  value: string | null;
  scheduleTime: string | null;
  scheduleDays: number[];
}

export interface RuleCondition {
  id: string;
  deviceId: string | null;
  device: DeviceRef | null;
  operator: ComparisonOperator;
  value: string | null;
}

export interface RuleAction {
  id: string;
  deviceId: string;
  device: DeviceRef | null;
  action: CommandAction;
  delayMs: number;
  order: number;
}

export interface AutomationRule {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  triggers: RuleTrigger[];
  conditions: RuleCondition[];
  actions: RuleAction[];
}

export interface RuleExecution {
  id: string;
  ruleId: string;
  status: RuleExecutionStatus;
  message: string | null;
  createdAt: string;
}

export interface TriggerInput {
  type: RuleTriggerType;
  deviceId?: string;
  operator?: ComparisonOperator;
  value?: string;
  scheduleTime?: string;
  scheduleDays?: number[];
}

export interface ConditionInput {
  deviceId: string;
  operator?: ComparisonOperator;
  value: string;
}

export interface ActionInput {
  deviceId: string;
  action: CommandAction;
  delayMs?: number;
  order?: number;
}

export interface SaveAutomationPayload {
  name: string;
  description?: string;
  enabled?: boolean;
  triggers: TriggerInput[];
  conditions?: ConditionInput[];
  actions: ActionInput[];
}

export function useAutomations() {
  return useQuery({
    queryKey: ["automations"],
    queryFn: async () => {
      const { data } = await apiClient.get<AutomationRule[]>("/automations");
      return data;
    },
    refetchInterval: 15_000,
  });
}

export function useAutomationExecutions(ruleId: string | null) {
  return useQuery({
    queryKey: ["automations", ruleId, "executions"],
    queryFn: async () => {
      const { data } = await apiClient.get<RuleExecution[]>(`/automations/${ruleId}/executions`);
      return data;
    },
    enabled: !!ruleId,
  });
}

export function useCreateAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: SaveAutomationPayload) => {
      const { data } = await apiClient.post<AutomationRule>("/automations", payload);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
}

export function useUpdateAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: Partial<SaveAutomationPayload> }) => {
      const { data } = await apiClient.patch<AutomationRule>(`/automations/${id}`, payload);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
}

export function useDeleteAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/automations/${id}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
}
