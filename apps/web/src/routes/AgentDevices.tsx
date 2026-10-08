import { useMemo, useState } from "react";
import {
  useDevices,
  useUpdateDevice,
  useSendDeviceCommand,
  useAgentStatus,
  isAgentDiscovered,
  isAgentReadOnly,
  type Device,
} from "../api/devices";
import { useAllAreas } from "../api/areas";
import { extractErrorMessage } from "../api/errors";
import { inferDeviceKind, SECTION_ORDER, type DeviceKindMeta } from "../utils/deviceKind";
import { PROTOCOL_META, PROTOCOL_ORDER } from "../utils/protocol";
import { RadarIcon } from "../components/icons";
import { useToasts, ToastContainer } from "../components/Toast";
import { StatTile } from "../components/StatTile";
import DeviceIconBadge from "../components/DeviceIconBadge";
import SectionHeader from "../components/SectionHeader";
import AgentReadOnlyBadge from "../components/AgentReadOnlyBadge";
import ToggleSwitch from "../components/ToggleSwitch";

const selectClass =
  "w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30";

function timeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "recien";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  return `hace ${days} d`;
}

function AreaSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: allAreas } = useAllAreas();
  const groups = useMemo(() => {
    const byLevel: Record<string, typeof allAreas> = {};
    for (const area of allAreas ?? []) {
      (byLevel[area.tenant.level] ??= []).push(area);
    }
    return byLevel;
  }, [allAreas]);

  return (
    <select className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Elegi un area...</option>
      {Object.entries(groups).map(([level, areasInLevel]) => (
        <optgroup key={level} label={level}>
          {areasInLevel!.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * Misma tarjeta que usa Vista Operativa (icono, nombre, categoria) mas lo especifico de un
 * dispositivo de agente: de donde vino, y si todavia esta pendiente, el control para asignarlo
 * a un area o descartarlo. Si el agente ya reporto un commandTopic real (hoy solo pasa con
 * dispositivos MQTT tipo switch, ver mqttsource), lleva un ToggleSwitch de verdad en vez del
 * badge de "Solo lectura" - se puede manipular desde aca mismo, no hace falta ir a otra vista.
 */
function AgentDeviceCard({
  device,
  kind,
  onDone,
}: {
  device: Device;
  kind: DeviceKindMeta;
  onDone: (msg: string, tone: "success" | "error") => void;
}) {
  const [areaId, setAreaId] = useState("");
  const updateDevice = useUpdateDevice();
  const sendCommand = useSendDeviceCommand();
  const agent = device.metadata!.agent!;
  const isOn = device.state?.state === "on";
  const readOnly = isAgentReadOnly(device);

  function confirm() {
    if (!areaId) return;
    updateDevice.mutate(
      { id: device.id, payload: { areaId, clearAgentPendingReview: true } },
      {
        onSuccess: () => onDone(`"${device.name}" se asigno y ya aparece en Vista de Edificio`, "success"),
        onError: (err) => onDone(extractErrorMessage(err, `No se pudo confirmar "${device.name}"`), "error"),
      },
    );
  }

  function discard() {
    updateDevice.mutate(
      { id: device.id, payload: { hidden: true, clearAgentPendingReview: true } },
      {
        onSuccess: () => onDone(`"${device.name}" se descarto (sigue en la base, oculto)`, "success"),
        onError: (err) => onDone(extractErrorMessage(err, `No se pudo descartar "${device.name}"`), "error"),
      },
    );
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-sm transition-colors hover:border-slate-700">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <DeviceIconBadge kind={kind} isOn={isOn} />
          <div className="min-w-0">
            <h3 className="truncate font-medium text-slate-100">{device.name}</h3>
            <p className={`text-xs font-medium uppercase tracking-wide ${kind.accent.text}`}>{kind.label}</p>
          </div>
        </div>
        {device.kind === "sensor" ? (
          <AgentReadOnlyBadge isOn={isOn} />
        ) : readOnly ? (
          <AgentReadOnlyBadge isOn={isOn} />
        ) : (
          <ToggleSwitch checked={isOn} onChange={(next) => sendCommand.mutate({ deviceId: device.id, action: next ? "on" : "off" })} />
        )}
      </div>

      <div className="mb-3 flex items-center justify-between border-t border-slate-800/70 pt-3 text-xs text-slate-500">
        <span>
          {device.protocol.toUpperCase()} &middot; {timeAgo(agent.discoveredAt)}
        </span>
        <span className="truncate">{agent.buildingKey}</span>
      </div>

      {agent.pendingReview ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="flex-1">
            <AreaSelect value={areaId} onChange={setAreaId} />
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={confirm}
              disabled={!areaId || updateDevice.isPending}
              className="rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Confirmar
            </button>
            <button
              onClick={discard}
              disabled={updateDevice.isPending}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
            >
              Descartar
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-emerald-400/80">&#10003; Confirmado - visible en Vista de Edificio</p>
      )}
    </div>
  );
}

export default function AgentDevices() {
  const { data: devices, isLoading } = useDevices();
  const { data: agentStatus } = useAgentStatus();
  const { toasts, push } = useToasts();
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  function toggleSection(id: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const { sections, protocols, pendingCount, buildingKeys, totalCount } = useMemo(() => {
    const all = (devices ?? []).filter(isAgentDiscovered);

    const protocolCounts = new Map<string, number>();
    for (const d of all) protocolCounts.set(d.protocol, (protocolCounts.get(d.protocol) ?? 0) + 1);
    const protocols = PROTOCOL_ORDER.filter((key) => protocolCounts.get(key)).map((key) => ({
      key,
      count: protocolCounts.get(key)!,
      ...PROTOCOL_META[key],
    }));

    const bySection = new Map<string, { kind: DeviceKindMeta; devices: Device[] }>();
    for (const d of all) {
      const kind = inferDeviceKind(d.name, d.kind);
      if (!bySection.has(kind.id)) bySection.set(kind.id, { kind, devices: [] });
      bySection.get(kind.id)!.devices.push(d);
    }
    const sections = SECTION_ORDER.filter((id) => bySection.has(id)).map((id) => {
      const entry = bySection.get(id)!;
      entry.devices.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "es"));
      return entry;
    });

    const pendingCount = all.filter((d) => d.metadata!.agent!.pendingReview).length;
    const buildingKeys = [...new Set(all.map((d) => d.metadata!.agent!.buildingKey))];

    return { sections, protocols, pendingCount, buildingKeys, totalCount: all.length };
  }, [devices]);

  if (isLoading) {
    return <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-slate-500">Cargando...</div>;
  }

  if (totalCount === 0 && (!agentStatus || agentStatus.length === 0)) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-800 p-10 text-center">
        <RadarIcon className="mx-auto mb-3 h-10 w-10 text-slate-700" />
        <p className="text-slate-300">Todavia no hay ningun Agente_Go reportando.</p>
        <p className="mt-1 text-sm text-slate-500">
          Corre el agente (ver <code className="rounded bg-slate-900 px-1.5 py-0.5">apps/Agente_Go/README.md</code>)
          apuntando a esta API - lo que encuentre va a aparecer aca, agrupado igual que en Vista
          Operativa.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Dispositivos descubiertos por agentes</h2>
          <p className="text-sm text-slate-500">
            {buildingKeys.length} edificio(s) reportando &middot; {totalCount} dispositivo(s) &middot; {pendingCount} pendiente(s)
            de confirmar
          </p>
        </div>
      </div>

      {agentStatus && agentStatus.length > 0 && (
        <div className="mb-6 space-y-4">
          {agentStatus.map((status) => {
            const total = Object.values(status.byProtocol).reduce((a, b) => a + b, 0);
            return (
              <div key={status.buildingKey} className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-emerald-300">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400)]" />
                    Agente "{status.buildingKey}" activo - autodescubrio {total} dispositivo(s) real(es) en el ultimo ciclo
                  </span>
                  <span className="text-xs text-slate-500">
                    {new Date(status.syncedAt).toLocaleTimeString()}
                    {status.agentVersion ? ` · v${status.agentVersion}` : ""}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:max-w-lg sm:grid-cols-3 md:grid-cols-5">
                  {PROTOCOL_ORDER.filter((key) => status.byProtocol[key]).map((key) => (
                    <StatTile key={key} label={PROTOCOL_META[key].label} value={status.byProtocol[key]} tone={PROTOCOL_META[key].tone} />
                  ))}
                </div>
                {status.skippedExisting > 0 && (
                  <p className="mt-3 text-xs text-slate-500">
                    {status.skippedExisting} de esos ya estaban importados por otra via (BACnet/LoRaWAN manual, etc.) -
                    el agente los reconocio y NO los duplico ni les toco el estado.
                    {status.created === 0 && " Por eso no hay tarjetas nuevas abajo: todo lo que vio ya era conocido, cero duplicados."}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {protocols.length > 0 && (
        <div className="mb-6">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-600">
            Dispositivos nuevos pendientes/confirmados por protocolo
          </p>
          <div className="grid grid-cols-2 gap-3 sm:max-w-lg sm:grid-cols-3 md:grid-cols-5">
            {protocols.map((p) => (
              <StatTile key={p.key} label={p.label} value={p.count} tone={p.tone} />
            ))}
          </div>
        </div>
      )}

      {sections.length === 0 && agentStatus && agentStatus.length > 0 && (
        <div className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
          Nada nuevo para confirmar: todo lo que el agente autodescubrio ya estaba en el sistema (ver arriba).
        </div>
      )}

      {sections.map((section) => {
        const isCollapsed = collapsedSections.has(section.kind.id);
        return (
          <div key={section.kind.id}>
            <SectionHeader
              kind={section.kind}
              count={section.devices.length}
              collapsed={isCollapsed}
              onToggle={() => toggleSection(section.kind.id)}
            />
            {!isCollapsed && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {section.devices.map((device) => (
                  <AgentDeviceCard key={device.id} device={device} kind={section.kind} onDone={push} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <ToastContainer toasts={toasts} />
    </div>
  );
}
