import { useMemo, useState } from "react";
import {
  useAutomations,
  useAutomationExecutions,
  useCreateAutomation,
  useUpdateAutomation,
  useDeleteAutomation,
  type AutomationRule,
  type RuleTriggerType,
  type ComparisonOperator,
  type CommandAction,
} from "../api/automations";
import { useDevices } from "../api/devices";
import ToggleSwitch from "../components/ToggleSwitch";
import { extractErrorMessage } from "../api/errors";
import { useToasts, ToastContainer } from "../components/Toast";

const inputClass = "w-full rounded-md bg-slate-800 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500";
const labelClass = "mb-1 block text-xs text-slate-400";
const DAY_LABELS = ["Dom", "Lun", "Mar", "Mie", "Jue", "Vie", "Sab"];

function formatDays(days: number[]): string {
  if (days.length === 0) return "todos los dias";
  return [...days].sort().map((d) => DAY_LABELS[d]).join(", ");
}

function valueLabel(value: string | null): string {
  if (value === "on") return "Encendido";
  if (value === "off") return "Apagado";
  return value ?? "";
}

function triggerSummary(rule: AutomationRule): string {
  const t = rule.triggers[0];
  if (!t) return "Sin disparador";
  if (t.type === "schedule") return `Horario · ${formatDays(t.scheduleDays)} a las ${t.scheduleTime}`;
  const name = t.device?.name ?? "dispositivo eliminado";
  return `${name} ${t.operator === "eq" ? "es" : "no es"} "${valueLabel(t.value)}"`;
}

function actionSummary(rule: AutomationRule): string {
  return rule.actions
    .map((a) => `${a.device?.name ?? "dispositivo eliminado"} → ${a.action === "on" ? "encender" : "apagar"}`)
    .join(" · ");
}

interface ConditionRow {
  deviceId: string;
  operator: ComparisonOperator;
  value: string;
}

interface ActionRow {
  deviceId: string;
  action: CommandAction;
  delayMs: string;
}

function emptyForm() {
  return {
    name: "",
    enabled: true,
    triggerType: "device_state" as RuleTriggerType,
    triggerDeviceId: "",
    triggerOperator: "eq" as ComparisonOperator,
    triggerValue: "on",
    scheduleTime: "22:00",
    scheduleDays: [] as number[],
    conditions: [] as ConditionRow[],
    actions: [{ deviceId: "", action: "on" as CommandAction, delayMs: "" }] as ActionRow[],
  };
}

export default function Automations() {
  const { data: rules, isLoading, isError } = useAutomations();
  const { data: devices } = useDevices();
  const createRule = useCreateAutomation();
  const updateRule = useUpdateAutomation();
  const deleteRule = useDeleteAutomation();
  const { toasts, push } = useToasts();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [error, setError] = useState<string | null>(null);

  const executions = useAutomationExecutions(editingId && editingId !== "new" ? editingId : null);

  const switchDevices = useMemo(() => (devices ?? []).filter((d) => d.kind !== "sensor"), [devices]);

  const stats = useMemo(() => {
    const list = rules ?? [];
    const active = list.filter((r) => r.enabled).length;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    let next: { name: string; time: string; diff: number } | null = null;
    for (const rule of list) {
      if (!rule.enabled) continue;
      for (const t of rule.triggers) {
        if (t.type !== "schedule" || !t.scheduleTime) continue;
        const [h, m] = t.scheduleTime.split(":").map(Number);
        let diff = h * 60 + m - nowMinutes;
        if (diff < 0) diff += 24 * 60;
        if (!next || diff < next.diff) next = { name: rule.name, time: t.scheduleTime, diff };
      }
    }
    return { total: list.length, active, paused: list.length - active, next };
  }, [rules]);

  function startNew() {
    setForm(emptyForm());
    setEditingId("new");
    setError(null);
  }

  function startEdit(rule: AutomationRule) {
    const t = rule.triggers[0];
    setForm({
      name: rule.name,
      enabled: rule.enabled,
      triggerType: t?.type ?? "device_state",
      triggerDeviceId: t?.deviceId ?? "",
      triggerOperator: t?.operator ?? "eq",
      triggerValue: t?.value ?? "on",
      scheduleTime: t?.scheduleTime ?? "22:00",
      scheduleDays: t?.scheduleDays ?? [],
      conditions: rule.conditions.map((c) => ({ deviceId: c.deviceId ?? "", operator: c.operator, value: c.value ?? "on" })),
      actions: rule.actions.length
        ? rule.actions.map((a) => ({ deviceId: a.deviceId, action: a.action, delayMs: a.delayMs ? String(a.delayMs) : "" }))
        : emptyForm().actions,
    });
    setEditingId(rule.id);
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setError(null);
  }

  function toggleDay(day: number) {
    setForm((f) => ({
      ...f,
      scheduleDays: f.scheduleDays.includes(day) ? f.scheduleDays.filter((d) => d !== day) : [...f.scheduleDays, day].sort(),
    }));
  }

  function addCondition() {
    setForm((f) => ({ ...f, conditions: [...f.conditions, { deviceId: "", operator: "eq", value: "on" }] }));
  }
  function removeCondition(index: number) {
    setForm((f) => ({ ...f, conditions: f.conditions.filter((_, i) => i !== index) }));
  }
  function addAction() {
    setForm((f) => ({ ...f, actions: [...f.actions, { deviceId: "", action: "on", delayMs: "" }] }));
  }
  function removeAction(index: number) {
    setForm((f) => ({ ...f, actions: f.actions.filter((_, i) => i !== index) }));
  }

  async function handleSave() {
    setError(null);
    if (!form.name.trim()) {
      setError("Ponle un nombre a la rutina.");
      return;
    }
    if (form.triggerType === "device_state" && !form.triggerDeviceId) {
      setError("Elige el dispositivo que dispara la rutina.");
      return;
    }
    if (form.actions.some((a) => !a.deviceId)) {
      setError("Cada accion necesita un dispositivo.");
      return;
    }

    const payload = {
      name: form.name.trim(),
      enabled: form.enabled,
      triggers: [
        form.triggerType === "schedule"
          ? { type: "schedule" as const, scheduleTime: form.scheduleTime, scheduleDays: form.scheduleDays }
          : { type: "device_state" as const, deviceId: form.triggerDeviceId, operator: form.triggerOperator, value: form.triggerValue },
      ],
      conditions: form.conditions.filter((c) => c.deviceId).map((c) => ({ deviceId: c.deviceId, operator: c.operator, value: c.value })),
      actions: form.actions.map((a) => ({ deviceId: a.deviceId, action: a.action, delayMs: a.delayMs ? Number(a.delayMs) : undefined })),
    };

    try {
      if (editingId && editingId !== "new") {
        await updateRule.mutateAsync({ id: editingId, payload });
        push(`Rutina "${payload.name}" actualizada`, "success");
      } else {
        await createRule.mutateAsync(payload);
        push(`Rutina "${payload.name}" creada`, "success");
      }
      setEditingId(null);
    } catch (err) {
      setError(extractErrorMessage(err, "No se pudo guardar la rutina."));
    }
  }

  async function handleDelete() {
    if (!editingId || editingId === "new") return;
    if (!confirm("Eliminar esta rutina? Esta accion no se puede deshacer.")) return;
    await deleteRule.mutateAsync(editingId);
    push("Rutina eliminada", "success");
    setEditingId(null);
  }

  async function handleToggleEnabled(rule: AutomationRule, next: boolean) {
    try {
      await updateRule.mutateAsync({ id: rule.id, payload: { enabled: next } });
    } catch (err) {
      push(extractErrorMessage(err, "No se pudo actualizar la rutina"), "error");
    }
  }

  const isSaving = createRule.isPending || updateRule.isPending;

  if (isLoading) {
    return <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-slate-500">Cargando rutinas...</div>;
  }
  if (isError) {
    return (
      <p className="rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-400">
        No se pudieron cargar las rutinas.
      </p>
    );
  }

  if (editingId) {
    const isNew = editingId === "new";
    return (
      <div className="max-w-3xl">
        <button onClick={cancelEdit} className="mb-4 flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
          &larr; Volver a rutinas
        </button>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6">
          <div className="mb-5 flex items-center gap-4">
            <div className="flex-1">
              <label className={labelClass}>Nombre de la rutina</label>
              <input
                className={inputClass}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Ej. Apagado nocturno CCT"
              />
            </div>
            <div>
              <label className={labelClass}>Estado</label>
              <ToggleSwitch checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
            </div>
          </div>

          <div className="mb-5 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4">
            <div className="mb-3 flex items-center gap-3">
              <span className="text-[10px] font-bold uppercase tracking-wide text-sky-300">Cuando</span>
              <select
                className={`${inputClass} w-auto`}
                value={form.triggerType}
                onChange={(e) => setForm((f) => ({ ...f, triggerType: e.target.value as RuleTriggerType }))}
              >
                <option value="device_state">Cambia el estado de un dispositivo</option>
                <option value="schedule">Llega una hora programada</option>
              </select>
            </div>

            {form.triggerType === "device_state" ? (
              <div className="grid grid-cols-3 gap-3">
                <select
                  className={inputClass}
                  value={form.triggerDeviceId}
                  onChange={(e) => setForm((f) => ({ ...f, triggerDeviceId: e.target.value }))}
                >
                  <option value="">Elegir dispositivo...</option>
                  {(devices ?? []).map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
                <select
                  className={inputClass}
                  value={form.triggerOperator}
                  onChange={(e) => setForm((f) => ({ ...f, triggerOperator: e.target.value as ComparisonOperator }))}
                >
                  <option value="eq">es</option>
                  <option value="ne">no es</option>
                </select>
                <select className={inputClass} value={form.triggerValue} onChange={(e) => setForm((f) => ({ ...f, triggerValue: e.target.value }))}>
                  <option value="on">Encendido</option>
                  <option value="off">Apagado</option>
                </select>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="time"
                  className={`${inputClass} w-auto`}
                  value={form.scheduleTime}
                  onChange={(e) => setForm((f) => ({ ...f, scheduleTime: e.target.value }))}
                />
                <div className="flex gap-1.5">
                  {DAY_LABELS.map((label, day) => (
                    <button
                      key={day}
                      onClick={() => toggleDay(day)}
                      className={`h-8 w-10 rounded-md text-xs font-medium transition-colors ${
                        form.scheduleDays.includes(day) ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-400 hover:bg-slate-700"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-slate-500">(sin marcar = todos los dias)</span>
              </div>
            )}
          </div>

          <div className="mb-5 rounded-xl border border-dashed border-slate-700 bg-slate-800/20 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Si (opcional)</span>
              <button onClick={addCondition} className="text-xs text-sky-400 hover:text-sky-300">+ Agregar condicion</button>
            </div>
            {form.conditions.length === 0 && <p className="text-xs text-slate-500">Sin condiciones — se ejecuta siempre.</p>}
            <div className="space-y-2">
              {form.conditions.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] gap-2">
                  <select className={inputClass} value={c.deviceId} onChange={(e) => setForm((f) => ({ ...f, conditions: f.conditions.map((row, idx) => (idx === i ? { ...row, deviceId: e.target.value } : row)) }))}>
                    <option value="">Dispositivo...</option>
                    {(devices ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                  <select className={inputClass} value={c.operator} onChange={(e) => setForm((f) => ({ ...f, conditions: f.conditions.map((row, idx) => (idx === i ? { ...row, operator: e.target.value as ComparisonOperator } : row)) }))}>
                    <option value="eq">es</option>
                    <option value="ne">no es</option>
                  </select>
                  <select className={inputClass} value={c.value} onChange={(e) => setForm((f) => ({ ...f, conditions: f.conditions.map((row, idx) => (idx === i ? { ...row, value: e.target.value } : row)) }))}>
                    <option value="on">Encendido</option>
                    <option value="off">Apagado</option>
                  </select>
                  <button onClick={() => removeCondition(i)} className="text-slate-500 hover:text-red-400">&times;</button>
                </div>
              ))}
            </div>
          </div>

          <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wide text-amber-300">Entonces</span>
              <button onClick={addAction} className="text-xs text-sky-400 hover:text-sky-300">+ Agregar accion</button>
            </div>
            <div className="space-y-2">
              {form.actions.map((a, i) => (
                <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] gap-2">
                  <select className={inputClass} value={a.deviceId} onChange={(e) => setForm((f) => ({ ...f, actions: f.actions.map((row, idx) => (idx === i ? { ...row, deviceId: e.target.value } : row)) }))}>
                    <option value="">Dispositivo...</option>
                    {switchDevices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                  <select className={inputClass} value={a.action} onChange={(e) => setForm((f) => ({ ...f, actions: f.actions.map((row, idx) => (idx === i ? { ...row, action: e.target.value as CommandAction } : row)) }))}>
                    <option value="on">Encender</option>
                    <option value="off">Apagar</option>
                  </select>
                  <input
                    className={`${inputClass} w-24`}
                    placeholder="delay ms"
                    value={a.delayMs}
                    onChange={(e) => setForm((f) => ({ ...f, actions: f.actions.map((row, idx) => (idx === i ? { ...row, delayMs: e.target.value } : row)) }))}
                  />
                  <button onClick={() => removeAction(i)} className="text-slate-500 hover:text-red-400">&times;</button>
                </div>
              ))}
            </div>
          </div>

          {!isNew && executions.data && executions.data.length > 0 && (
            <div className="mb-6 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Historial reciente</p>
              {executions.data.slice(0, 5).map((ex) => (
                <div key={ex.id} className="flex items-center gap-2 py-1 text-xs text-slate-400">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      ex.status === "success" ? "bg-emerald-400" : ex.status === "condition_not_met" ? "bg-amber-400" : "bg-red-400"
                    }`}
                  />
                  {ex.message}
                  <span className="ml-auto text-slate-600">{new Date(ex.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}

          {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-md bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {isSaving ? "Guardando..." : "Guardar rutina"}
            </button>
            <button onClick={cancelEdit} className="rounded-md bg-slate-800 px-5 py-2 text-sm text-slate-300 hover:bg-slate-700">
              Cancelar
            </button>
            {!isNew && (
              <button onClick={handleDelete} className="ml-auto rounded-md bg-red-950/50 px-4 py-2 text-sm text-red-400 hover:bg-red-900/60">
                Eliminar rutina
              </button>
            )}
          </div>
        </div>
        <ToastContainer toasts={toasts} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 grid grid-cols-4 gap-3 max-w-2xl">
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3">
          <div className="text-2xl font-semibold text-slate-100">{stats.total}</div>
          <div className="text-xs text-slate-500">Rutinas</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3">
          <div className="text-2xl font-semibold text-emerald-300">{stats.active}</div>
          <div className="text-xs text-slate-500">Activas</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3">
          <div className="text-2xl font-semibold text-slate-400">{stats.paused}</div>
          <div className="text-xs text-slate-500">Pausadas</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3">
          <div className="truncate text-sm font-semibold text-sky-300">{stats.next ? stats.next.time : "--"}</div>
          <div className="truncate text-xs text-slate-500">{stats.next ? stats.next.name : "Sin horarios"}</div>
        </div>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-300">Rutinas</h2>
        <button onClick={startNew} className="flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500">
          + Nueva rutina
        </button>
      </div>

      {(rules ?? []).length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-slate-500">
          Aun no tienes rutinas. Crea la primera para automatizar tus areas.
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        {(rules ?? []).map((rule) => (
          <div
            key={rule.id}
            onClick={() => startEdit(rule)}
            className="flex cursor-pointer items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4 hover:border-slate-700"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-100">{rule.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    rule.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700/40 text-slate-400"
                  }`}
                >
                  {rule.enabled ? "Activa" : "Pausada"}
                </span>
              </div>
              <div className="mt-1 truncate text-xs text-slate-400">
                <span className="text-sky-400">CUANDO</span> {triggerSummary(rule)} <span className="text-slate-600">&rarr;</span>{" "}
                <span className="text-amber-400">ENTONCES</span> {actionSummary(rule)}
              </div>
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <ToggleSwitch checked={rule.enabled} onChange={(next) => handleToggleEnabled(rule, next)} />
            </div>
          </div>
        ))}
      </div>
      <ToastContainer toasts={toasts} />
    </div>
  );
}
