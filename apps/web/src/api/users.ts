import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";

export interface AppUser {
  id: string;
  username: string;
  role: "admin" | "operator" | "viewer";
  fullName: string | null;
  email: string | null;
  sites: string[];
  homeTab: string;
  active: boolean;
  receivesAlarmEmails: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export type UserInput = Partial<Omit<AppUser, "id" | "lastLoginAt" | "createdAt">> & { password?: string };

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: async () => (await apiClient.get<AppUser[]>("/users")).data });
}

export function useSaveUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string | null; data: UserInput }) => {
      if (id) return (await apiClient.patch<AppUser>(`/users/${id}`, data)).data;
      return (await apiClient.post<AppUser>("/users", data)).data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useSetPassword() {
  return useMutation({
    mutationFn: async ({ id, password }: { id: string; password: string }) => {
      await apiClient.post(`/users/${id}/password`, { password });
    },
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/users/${id}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["users"] }),
  });
}
