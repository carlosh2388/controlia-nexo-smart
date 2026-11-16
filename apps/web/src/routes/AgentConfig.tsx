import { useEffect, useMemo, useState } from "react";
import {
  useAgentConfig,
  useAgentScan,
  useAgents,
  useRequestScan,
  useSaveAgentConfig,
  type AgentConfigResponse,
  type AgentProtocols,
  type AgentSummary,
  type ScanItem,
  type ScanResultRow,
  type ScanState,
} from "../api/agents";
import { extractErrorMessage } from "../api/errors";
import { useAuthStore } from "../store/auth.store";
import { useToasts, ToastContainer } from "../components/Toast";
import { TONES, type Tone } from "../components/agent-config/fields";
import { BacnetCard, BrokerCard, LoraGatewayCard, ModbusCard } from "../components/agent-config/ProtocolCards";
import { changedSections, isOnline, newModbusServer, timeAgo, toDraft } from "../utils/agentConfig";

const PROTOCOL_LABEL: Record<string, { label: string; tone: Tone }> = {
  modbus: { label: "Modbus", tone: "amber" },
  bacnet: { label: "BACnet", tone: "orange" },
  lorawan: { label: "ChirpStack", tone: "teal" },
  mqtt: { label: "Zigbee2MQTT", tone: "emerald" },
};

/**
 * Agente Go > Configuracion: que protocolos escucha cada agente, en que IP y puertos, y busqueda de
 * equipos en la red de la sede. Se guarda en la API como una version nueva; el agente la descarga
 * en menos de 5 s y reinicia solo los protocolos que cambiaron. Ver docs/agentes-go-manual.md.
 */
export default function AgentConfig() {
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === "admin";
  const canScan = role === "admin" || role === "operator";
  const { toasts, push } = useToasts();

  const [buildingKey, setBuildingKey] = useState<string | null>(null);
  const [trackVersion, setTrackVersion] = useState<number | null>(null);
  const agentsQ = useAgents({ fast: trackVersion !== null });
  const agents = agentsQ.data ?? [];
  const agent = agents.find((a) => a.buildingKey === buildingKey) ?? null;

  useEffect(() => {
    if (!buildingKey && agents.length) setBuildingKey(agents[0].buildingKey);
  }, [agents, buildingKey]);

  const configQ = useAgentConfig(agent?.hasConfig ? buildingKey : null);
  const [base, setBase] = useState<AgentConfigResponse | null>(null);
  const [draft, setDraft] = useState<AgentProtocols | null>(null);
  const changes = useMemo(() => (base && draft ? changedSections(base.config, draft) : []), [base, draft]);

  // Al cambiar de agente o llegar una version nueva, se recarga el formulario si no hay cambios sin guardar.
  useEffect(() => {
    const data = configQ.data;
    if (!data) return;
    if (!base || base.buildingKey !== data.buildingKey || (changes.length === 0 && data.version !== base.version)) {
      setBase(data);
      setDraft(toDraft(data.config));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configQ.data]);

  const save = useSaveAgentConfig();
  const requestScan = useRequestScan();
  const scanQ = useAgentScan(agent?.hasConfig ? buildingKey : null);

  function selectAgent(key: string) {
    if (changes.length && !window.confirm("Hay cambios sin guardar. ¿Descartarlos?")) return;
    setBuildingKey(key);
    setBase(null);
    setDraft(null);
    setTrackVersion(null);
  }

  function patch(p: Partial<AgentProtocols>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }

  function handleSave() {
    if (!buildingKey || !draft || !base) return;
    save.mutate(
      { buildingKey, config: draft, baseVersion: base.version },
      {
        onSuccess: (data) => {
          setBase(data);
          setDraft(toDraft(data.config));
          setTrackVersion(data.version);
          push(`Configuración v${data.version} guardada. El agente la toma en unos segundos.`, "success");
        },
        onError: (err) => push(extractErrorMessage(err, "No se pudo guardar la configuración")),
      },
    );
  }

  function scan(items: ScanItem[]) {
    if (!buildingKey) return;
    requestScan.mutate(
      { buildingKey, items },
      { onError: (err) => push(extractErrorMessage(err, "No se pudo pedir la búsqueda")) },
    );
  }

  function scanAll() {
    if (!draft) return;
    const items: ScanItem[] = [];
    const m = draft.discovery?.modbus;
    if (m?.targets.length) items.push({ protocol: "modbus", targets: m.targets, port: 502, unitIds: m.unitIds || "1-10" });
    const b = draft.discovery?.bacnet;
    if (b?.targets.length) items.push({ protocol: "bacnet", targets: b.targets });
    for (const kind of ["lorawan", "mqtt"] as const) {
      const c = draft[kind];
      const host = c?.brokerUrl ? /:\/\/([^:/]+)(?::(\d+))?/.exec(c.brokerUrl) : null;
      if (c?.enabled && host) items.push({ protocol: kind, targets: [host[1]], port: host[2] ? Number(host[2]) : 1883 });
    }
    if (!items.length) {
      push("Escribe dónde buscar (IP, rango o red) en la tarjeta de Modbus o de BACnet.");
      return;
    }
    scan(items);
  }

  function addFromScan(row: ScanResultRow) {
    if (!draft) return;
    if (row.protocol === "modbus") {
      patch({ modbusServers: [...(draft.modbusServers ?? []), { ...newModbusServer(row.host, row.unitIds?.[0] ?? 1), port: row.port }] });
    } else if (row.protocol === "bacnet") {
      const c = draft.bacnet ?? { enabled: true, bridgeUrl: "http://localhost:3099", pollIntervalSeconds: 20, devices: [] };
      patch({ bacnet: { ...c, enabled: true, devices: [...(c.devices ?? []), { name: `BACnet ${row.deviceId ?? row.host}`, host: row.host }] } });
    }
    push(`${row.host} agregado. Guarda y envía para que el agente empiece a leerlo.`, "success");
  }

  const scanning = scanQ.data?.status === "pending" || scanQ.data?.status === "running";
  const readOnly = !isAdmin;

  if (agentsQ.isLoading) return <p className="text-sm text-slate-500">Cargando agentes...</p>;
  if (!agents.length) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400">
        Ningún Agente Go se ha conectado todavía. Instálalo en el servidor de la sede con un <code>config.yaml</code> que tenga
        <code> buildingKey</code> y <code>api</code>; aparecerá aquí en su primera sincronización.
      </div>
    );
  }

  return (
    <div className="pb-24">
      <AgentStatus agents={agents} agent={agent} onSelect={selectAgent} draft={draft} />

      {agent && !agent.hasConfig && (
        <div className="mt-6 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-slate-300">
          <p className="font-medium text-amber-200">Este agente todavía usa solo su config.yaml.</p>
          <p className="mt-1 text-slate-400">
            Desde la versión 0.5 el agente sube su configuración la primera vez que se conecta y desde ahí se edita aquí. Actualiza el
            binario en el servidor de la sede (ver docs/procedimientos/agente-go.md) y recarga esta página.
          </p>
        </div>
      )}

      {configQ.isError && agent?.hasConfig && (
        <p className="mt-6 text-sm text-rose-300">{extractErrorMessage(configQ.error, "No se pudo cargar la configuración")}</p>
      )}

      {draft && base && (
        <>
          {trackVersion !== null && agent && (
            <ApplyTracker version={trackVersion} agent={agent} onClose={() => setTrackVersion(null)} />
          )}
          {trackVersion === null && agent?.applyError && (
            <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
              <b>Problemas al aplicar la configuración:</b> <span className="text-amber-100/80">{agent.applyError}</span>
            </div>
          )}

          {readOnly && (
            <p className="mt-6 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-2 text-xs text-slate-400">
              Solo un administrador puede cambiar la configuración. {canScan ? "Puedes buscar dispositivos en la red." : ""}
            </p>
          )}

          <div className="mb-3 mt-8">
            <h2 className="text-base font-semibold text-slate-100">Protocolos</h2>
            <p className="text-sm text-slate-500">Activa los que se usan en esta sede y dile al agente dónde están los equipos.</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <ModbusCard
              servers={draft.modbusServers ?? []}
              onChange={(modbusServers) => patch({ modbusServers })}
              discovery={draft.discovery?.modbus}
              onDiscoveryChange={(modbus) => patch({ discovery: { ...draft.discovery, modbus } })}
              readOnly={readOnly}
            />
            <BacnetCard
              config={draft.bacnet}
              onChange={(bacnet) => patch({ bacnet })}
              discovery={draft.discovery?.bacnet}
              onDiscoveryChange={(bacnet) => patch({ discovery: { ...draft.discovery, bacnet } })}
              readOnly={readOnly}
            />
            <LoraGatewayCard config={draft.loraGateway} onChange={(loraGateway) => patch({ loraGateway })} readOnly={readOnly} />
            <BrokerCard
              kind="lorawan"
              config={draft.lorawan}
              onChange={(lorawan) => patch({ lorawan })}
              onTest={(host, port) => scan([{ protocol: "lorawan", targets: [host], port }])}
              testing={scanning}
              readOnly={readOnly}
            />
            <BrokerCard
              kind="mqtt"
              config={draft.mqtt}
              onChange={(mqtt) => patch({ mqtt })}
              onTest={(host, port) => scan([{ protocol: "mqtt", targets: [host], port }])}
              testing={scanning}
              readOnly={readOnly}
            />
          </div>

          <DiscoveryPanel
            scan={scanQ.data ?? null}
            draft={draft}
            canScan={canScan}
            canAdd={isAdmin}
            starting={requestScan.isPending}
            onScan={scanAll}
            onAdd={addFromScan}
          />

          <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-800 bg-slate-950/90 backdrop-blur">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
              <p className="min-w-0 text-sm text-slate-400">
                {changes.length ? (
                  <>
                    <b className="text-slate-200">{changes.length}</b> sección(es) con cambios sin enviar:{" "}
                    <span className="text-slate-300">{changes.join(", ")}</span>
                  </>
                ) : (
                  <>Sin cambios · config v{base.version}</>
                )}
              </p>
              <div className="flex gap-2">
                <button
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                  disabled={!changes.length || save.isPending}
                  onClick={() => setDraft(toDraft(base.config))}
                >
                  Descartar
                </button>
                <button
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                  disabled={!changes.length || save.isPending || readOnly}
                  onClick={handleSave}
                >
                  {save.isPending ? "Guardando..." : "Guardar y enviar al agente"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
      <ToastContainer toasts={toasts} />
    </div>
  );
}

function AgentStatus({
  agents,
  agent,
  onSelect,
  draft,
}: {
  agents: AgentSummary[];
  agent: AgentSummary | null;
  onSelect: (key: string) => void;
  draft: AgentProtocols | null;
}) {
  const sync = agent?.lastSync;
  const online = isOnline(sync?.syncedAt);
  const devices = Object.values(sync?.byProtocol ?? {}).reduce((n, v) => n + v, 0);
  const active = draft
    ? [draft.modbusServers?.some((s) => s.enabled), draft.bacnet?.enabled, draft.loraGateway?.enabled, draft.lorawan?.enabled, draft.mqtt?.enabled].filter(Boolean)
        .length
    : null;

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${online ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-500"}`}>
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="4" width="18" height="7" rx="1.5" />
              <rect x="3" y="13" width="18" height="7" rx="1.5" />
              <path d="M7 7.5h.01M7 16.5h.01" />
            </svg>
          </div>
          <div className="min-w-0">
            <label htmlFor="agent-select" className="sr-only">
              Agente
            </label>
            <select
              id="agent-select"
              className="max-w-full rounded-lg border border-slate-800 bg-slate-950 px-2 py-1 font-medium text-slate-100"
              value={agent?.buildingKey ?? ""}
              onChange={(e) => onSelect(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.buildingKey} value={a.buildingKey}>
                  {a.buildingKey}
                </option>
              ))}
            </select>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
              <span className={`flex items-center gap-1 ${online ? "text-emerald-300" : "text-slate-500"}`}>
                <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-400" : "bg-slate-600"}`} />
                {online ? "En línea" : "Sin conexión"}
              </span>
              <span>·</span>
              <span>Última sincronización {timeAgo(sync?.syncedAt)}</span>
              {sync?.agentVersion && (
                <>
                  <span>·</span>
                  <span>Agente {sync.agentVersion}</span>
                </>
              )}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat value={agent?.appliedVersion ? `v${agent.appliedVersion}` : "—"} label="Config aplicada" tone="text-sky-300" />
          <Stat value={active ?? "—"} label="Protocolos activos" tone="text-emerald-300" />
          <Stat value={sync ? devices : "—"} label="Equipos leyendo" tone="text-slate-200" />
        </div>
      </div>
      <ol className="mt-5 grid gap-2 text-xs text-slate-400 sm:grid-cols-4">
        <li className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
          <b className="text-slate-200">1. Configuras aquí</b>
          <br />
          IP, rangos y puertos de cada protocolo.
        </li>
        <li className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
          <b className="text-slate-200">2. La API lo guarda</b>
          <br />
          Como una versión nueva (v13, v14…).
        </li>
        <li className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
          <b className="text-slate-200">3. El agente la descarga</b>
          <br />
          Consulta cada 5 segundos.
        </li>
        <li className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
          <b className="text-slate-200">4. Empieza a leer</b>
          <br />
          Reinicia solo los protocolos que cambiaron.
        </li>
      </ol>
    </section>
  );
}

function Stat({ value, label, tone }: { value: string | number; label: string; tone: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-2">
      <div className={`text-xl font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

/** Avance de una version recien guardada: guardada -> el agente la tomo -> aplicada (o con problemas). */
function ApplyTracker({ version, agent, onClose }: { version: number; agent: AgentSummary; onClose: () => void }) {
  const applied = (agent.appliedVersion ?? 0) >= version;
  const rejected = !applied && !!agent.applyError;
  const steps = [
    { label: `Guardada en la API como v${version}`, done: true },
    { label: rejected ? "El agente la rechazó y sigue con la versión anterior" : "El agente la descargó", done: applied, failed: rejected },
    {
      label: applied ? (agent.applyError ? `Aplicada con problemas: ${agent.applyError}` : "Aplicada · el agente ya lee con esta configuración") : "Aplicando...",
      done: applied && !agent.applyError,
      warn: applied && !!agent.applyError,
    },
  ];
  return (
    <section className="mt-6 rounded-2xl border border-sky-500/30 bg-sky-500/5 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-100">Enviando la configuración v{version}</h2>
        <button className="text-xs text-slate-400 hover:text-slate-200" onClick={onClose}>
          Cerrar
        </button>
      </div>
      <ol className="space-y-2 text-sm">
        {steps.map((s, i) => (
          <li
            key={i}
            className={`flex items-start gap-2 ${s.failed ? "text-rose-300" : s.warn ? "text-amber-300" : s.done ? "text-emerald-300" : "text-slate-500"}`}
          >
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                s.done ? "bg-emerald-500/20" : s.failed ? "bg-rose-500/20" : s.warn ? "bg-amber-500/20" : "border border-slate-700"
              }`}
            >
              {s.done ? "✓" : s.failed ? "✕" : s.warn ? "!" : i + 1}
            </span>
            <span className="min-w-0 break-words">{s.label}</span>
          </li>
        ))}
      </ol>
      {!applied && !rejected && (
        <p className="mt-3 text-xs text-slate-500">Si el agente está sin conexión, la tomará apenas vuelva a conectarse.</p>
      )}
    </section>
  );
}

function DiscoveryPanel({
  scan,
  draft,
  canScan,
  canAdd,
  starting,
  onScan,
  onAdd,
}: {
  scan: ScanState | null;
  draft: AgentProtocols;
  canScan: boolean;
  canAdd: boolean;
  starting: boolean;
  onScan: () => void;
  onAdd: (row: ScanResultRow) => void;
}) {
  const busy = starting || scan?.status === "pending" || scan?.status === "running";
  const results = scan?.results ?? [];

  function configured(row: ScanResultRow) {
    if (row.protocol === "modbus") return (draft.modbusServers ?? []).some((s) => s.host === row.host && (s.port ?? 502) === row.port);
    if (row.protocol === "bacnet") return (draft.bacnet?.devices ?? []).some((d) => d.host === row.host);
    return false;
  }

  return (
    <section className="mt-8 rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-slate-100">Buscar dispositivos en la red</h2>
          <p className="text-sm text-slate-500">
            El agente recorre solo las IP que escribiste en cada tarjeta y muestra lo que responde. Solo hace lecturas: Modbus con la
            función 03 y BACnet con Who-Is. No escribe registros ni envía comandos.
          </p>
        </div>
        <button
          className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canScan || busy}
          onClick={onScan}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          {busy ? "Buscando..." : scan ? "Buscar de nuevo" : "Buscar dispositivos"}
        </button>
      </div>

      {scan && (
        <div className="mt-4 space-y-2">
          {scan.status === "pending" && <p className="text-xs text-slate-400">Esperando que el agente tome el pedido (hasta 5 s)...</p>}
          {Object.entries(scan.progress ?? {}).map(([protocol, p]) => {
            const meta = PROTOCOL_LABEL[protocol] ?? { label: protocol, tone: "amber" as Tone };
            const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
            return (
              <div key={protocol} className="flex items-center gap-3 text-xs">
                <span className="w-24 shrink-0 text-slate-400">{meta.label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                  <div className={`h-full rounded-full ${TONES[meta.tone].bar} transition-all duration-300`} style={{ width: `${pct}%` }} />
                </div>
                <span className="w-24 text-right tabular-nums text-slate-500">
                  {p.done} / {p.total}
                </span>
              </div>
            );
          })}
          {scan.status === "done" && (
            <p className="text-xs text-slate-400">
              Terminó {timeAgo(scan.finishedAt)} · {results.filter((r) => r.status === "ok").length} respondieron
            </p>
          )}
          {scan.error && <p className="text-xs text-amber-300">{scan.error}</p>}
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-slate-950/70 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Dirección</th>
              <th className="px-4 py-2.5 font-medium">Protocolo</th>
              <th className="px-4 py-2.5 font-medium">Respuesta</th>
              <th className="px-4 py-2.5 font-medium">Estado</th>
              <th className="px-4 py-2.5 text-right font-medium">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {results.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  {busy
                    ? "Buscando..."
                    : scan
                      ? "Ningún equipo respondió en las direcciones indicadas."
                      : "Escribe dónde buscar en las tarjetas de Modbus o BACnet y pulsa Buscar dispositivos."}
                </td>
              </tr>
            )}
            {results.map((row, i) => {
              const meta = PROTOCOL_LABEL[row.protocol] ?? { label: row.protocol, tone: "amber" as Tone };
              const isBroker = row.protocol === "mqtt" || row.protocol === "lorawan";
              const already = configured(row);
              return (
                <tr key={`${row.protocol}-${row.host}-${row.port}-${i}`}>
                  <td className="px-4 py-3 tabular-nums text-slate-200">
                    {row.host}:{row.port}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-md border px-2 py-0.5 text-xs ${TONES[meta.tone].chip}`}>{meta.label}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{row.detail}</td>
                  <td className="px-4 py-3">
                    {isBroker ? (
                      row.status === "ok" ? (
                        <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300">Alcanzable</span>
                      ) : (
                        <span className="rounded-full bg-rose-500/15 px-2.5 py-0.5 text-xs font-medium text-rose-300">Sin respuesta</span>
                      )
                    ) : already ? (
                      <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300">Ya configurado</span>
                    ) : (
                      <span className="rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs font-medium text-sky-300">Nuevo</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!isBroker && !already ? (
                      <button
                        className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
                        disabled={!canAdd}
                        onClick={() => onAdd(row)}
                      >
                        Agregar
                      </button>
                    ) : (
                      <span className="text-xs text-slate-600">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
