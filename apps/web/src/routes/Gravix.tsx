import { useEffect, useMemo, useRef, useState } from "react";
import { useAgents } from "../api/agents";
import {
  usePilotCompare,
  usePilotCompareMany,
  usePilotDevices,
  usePilotGaps,
  usePilotSeries,
  useSaveDirectConnection,
  type DirectConnection,
  type PilotDevice,
  type PilotCompareMetric,
  type PilotGap,
} from "../api/pilot";
import {
  DeviceBox,
  DIM,
  initialScreen,
  ION_HARM_SCREENS,
  kindOf,
  metricRows,
  num,
  POWER_METRIC,
  pressKey,
  screenTitle,
  type DeviceKind,
  type ScreenState,
} from "../components/gravix/DeviceArt";
import "../components/gravix/gravix.css";
import InteractiveChart from "../components/charts/InteractiveChart";
import { InformeComparativo } from "../components/gravix/InformeComparativo";
import { ArmonicosPanel } from "../components/gravix/Armonicos";

type DetailTab = "equipo" | "huecos" | "comparativo" | "conexion";

/**
 * Pestaña Piloto Gravix: los equipos de energia que lee el Agente_Go de una sede, con su avance en
 * el piloto (Fase A historial en TimescaleDB, Fase B lectura directa, Fase C recuperacion), el
 * equipo en 3D con sus botones, la grafica de la ultima hora, los huecos detectados y los datos de
 * conexion directa. Todo con datos reales: la API guarda cada lectura y detecta los huecos.
 */

const DEFAULT_BUILDING = "igss-escuintla";
const STAGES = [
  { k: "Fase A", t: "Historial", d: "PostgreSQL + TimescaleDB, huecos registrados" },
  { k: "Fase B", t: "Lectura directa", d: "Leer cada equipo por su IP y comparar con el AS-P" },
  { k: "Fase C", t: "Recuperación", d: "Rellenar huecos desde la memoria del equipo" },
];

const miniCls = (k: DeviceKind) => (k === "pm" ? "em" : k);
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString("es-GT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const hhmm = (d: Date) => d.toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit" });
const ipNum = (ip: string) => ip.split(".").reduce((s, x) => s * 256 + Number(x), 0);

/** 1 = historial, 2 = lectura directa configurada y activada, 0 = todavia sin historial. */
function stageOf(d: PilotDevice) {
  if (d.directConnection?.enabled) return 2;
  return d.historySince ? 1 : 0;
}

function sourceHost(d: PilotDevice) {
  return typeof d.attributes.host === "string" ? d.attributes.host : null;
}

export default function Gravix({ onOpenConfig }: { onOpenConfig?: () => void }) {
  const agents = useAgents();
  const [buildingKey, setBuildingKey] = useState(DEFAULT_BUILDING);
  const pilot = usePilotDevices(buildingKey);
  const devices = useMemo(() => pilot.data?.devices ?? [], [pilot.data]);
  // Fase B: equipos que el agente de prueba "<sede>-directo" ya lee por su propia IP.
  const direct = usePilotDevices(`${buildingKey}-directo`);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("equipo");
  const [typeFilter, setTypeFilter] = useState<"all" | DeviceKind>("all");
  const [view, setView] = useState<"fase" | "red">("fase");
  const [stageFilter, setStageFilter] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [screens, setScreens] = useState<Record<string, ScreenState>>({});
  const [fullscreen, setFullscreen] = useState(false);
  const [page, setPage] = useState<"equipos" | "resumen" | "informe">("equipos");

  useEffect(() => {
    if (!devices.length) return;
    if (!selectedId || !devices.some((d) => d.id === selectedId)) setSelectedId(devices[0].id);
  }, [devices, selectedId]);

  const selected = devices.find((d) => d.id === selectedId) ?? null;
  const screenOf = (id: string) => screens[id] ?? initialScreen();
  const press = (d: PilotDevice, key: string) => setScreens((s) => ({ ...s, [d.id]: pressKey(kindOf(d), s[d.id] ?? initialScreen(), key) }));

  const buildingOptions = useMemo(() => {
    const keys = new Set([DEFAULT_BUILDING, ...(agents.data ?? []).map((a) => a.buildingKey)]);
    return [...keys].sort();
  }, [agents.data]);

  const filtered = devices.filter((d) => {
    if (typeFilter !== "all" && kindOf(d) !== typeFilter) return false;
    if (stageFilter !== null && stageOf(d) !== stageFilter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [d.name, String(d.attributes.area ?? ""), String(d.attributes.code ?? ""), sourceHost(d) ?? "", d.directConnection?.ip ?? ""].some((x) =>
      x.toLowerCase().includes(q),
    );
  });

  const withHistory = devices.filter((d) => d.historySince).length;
  const directNames = new Set((direct.data?.devices ?? []).filter((d) => d.updatedAt).map((d) => d.name));
  const directCount = devices.filter((d) => d.directConnection?.enabled || directNames.has(d.name)).length;
  const totalPending = devices.reduce((s, d) => s + d.gaps.pending, 0);
  const withGaps = devices.filter((d) => d.gaps.pending > 0).length;
  const compl = devices.filter((d) => d.completeness != null);
  const avgCompl = compl.length ? compl.reduce((s, d) => s + (d.completeness ?? 0), 0) / compl.length : null;
  const lastSync = pilot.data?.lastSync;

  return (
    <div className="gx">
      <div className="wrap" style={{ paddingBlock: 0 }}>
        <div className="top">
          <div style={{ display: "grid", gap: 4 }}>
            <span className="eyebrow">Piloto Gravix · Calidad de energía</span>
            <label className="search" style={{ minWidth: 240 }}>
              <span className="muted" style={{ fontSize: ".8rem" }}>
                Sede
              </span>
              <select
                value={buildingKey}
                onChange={(e) => {
                  setBuildingKey(e.target.value);
                  setSelectedId(null);
                }}
                style={{ border: 0, background: "none", minHeight: 38, padding: 0 }}
                aria-label="Sede"
              >
                {buildingOptions.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {onOpenConfig && (
            <button type="button" className="btn primary" onClick={onOpenConfig} title="Los equipos se agregan en la configuración del agente de la sede">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Agregar equipo
            </button>
          )}
        </div>

        <nav className="stepper" aria-label="Fases del piloto" style={{ gridTemplateColumns: "1fr" }}>
          <div className="steps-wrap">
            <ol className="steps-row">
              <li className="rail" aria-hidden="true">
                <i style={{ width: directCount ? `${(directCount / Math.max(devices.length, 1)) * 50}%` : "0%" }} />
              </li>
              {STAGES.map((s, i) => {
                const stage = i + 1;
                const cls = stage === 1 ? "cur" : stage === 2 && directCount ? "cur" : "future";
                const n = stage === 1 ? withHistory : stage === 2 ? directCount : 0;
                const label = stage === 1 ? `${n} de ${devices.length} con historial` : stage === 2 ? (n ? `en prueba · ${n} de ${devices.length} leídos directo` : "en preparación") : "próxima";
                return (
                  <li key={s.k}>
                    <button
                      type="button"
                      className={`stp ${cls}`}
                      aria-pressed={stageFilter === stage}
                      onClick={() => setStageFilter((f) => (f === stage ? null : stage))}
                      title="Filtrar la lista por esta fase"
                      style={stageFilter === stage ? { background: "var(--panel-2)" } : undefined}
                    >
                      <span className="c">{stage}</span>
                      <span className="k">{s.k}</span>
                      <b>{s.t}</b>
                      <span className="n">{label}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </nav>

        <div className="phase-note" aria-live="polite">
          <span className="pill ok">{directCount ? "Fase B en prueba" : "Fase A en marcha"}</span>
          <span>
            {directCount
              ? `Cada lectura se guarda con su hora en PostgreSQL + TimescaleDB y la API registra cada hueco con su causa. ${directCount} de ${devices.length} equipos se leen además directo por su propia IP y se comparan contra el AS-P (ver "Resumen directo vs AS-P"). La recuperación desde la memoria de los medidores (Fase C) viene después.`
              : "Cada lectura del agente se guarda con su hora en PostgreSQL + TimescaleDB y la API registra cada hueco con su causa. La lectura directa (Fase B) y la recuperación (Fase C) se activan después."}
          </span>
        </div>

        <div className="kpis">
          <div className="kpi">
            <span className="eyebrow">Equipos con historial</span>
            <span className="v">
              {withHistory}
              <small> / {devices.length}</small>
            </span>
          </div>
          <div className="kpi">
            <span className="eyebrow">Huecos pendientes · 7 días</span>
            <span className="v" style={{ color: totalPending ? "var(--warn)" : "var(--ok)" }}>
              {totalPending}
              <small> en {withGaps} equipos</small>
            </span>
          </div>
          <div className="kpi">
            <span className="eyebrow">Datos completos</span>
            <span className="v">
              {avgCompl == null ? "—" : `${avgCompl.toFixed(2)}%`}
              <small> promedio</small>
            </span>
          </div>
          <div className="kpi">
            <span className="eyebrow">Último reporte del agente</span>
            <span className="v" style={{ fontSize: "1.05rem" }}>
              {lastSync?.syncedAt ? hhmm(new Date(lastSync.syncedAt)) : "—"}
              <small> {lastSync?.agentVersion ? `· v${lastSync.agentVersion}` : ""}</small>
            </span>
          </div>
        </div>

        <div className="seg page-seg" role="tablist" aria-label="Vista del piloto">
          {(
            [
              ["equipos", "Equipos"],
              ["resumen", "Resumen directo vs AS-P"],
              ["informe", "Informe comparativo 12/11"],
            ] as const
          ).map(([k, t]) => (
            <button key={k} type="button" role="tab" aria-selected={page === k} onClick={() => setPage(k)}>
              {t}
            </button>
          ))}
        </div>

        {page === "informe" ? (
          <InformeComparativo />
        ) : pilot.isLoading ? (
          <div className="empty">Cargando equipos…</div>
        ) : pilot.isError ? (
          <div className="empty">No se pudo leer el piloto de esta sede. Revisa la conexión con la API.</div>
        ) : !devices.length ? (
          <div className="empty">El agente de "{buildingKey}" todavía no reporta equipos de energía por Modbus.</div>
        ) : page === "resumen" ? (
          <CompareSummary
            devices={devices}
            onOpen={(id) => {
              setSelectedId(id);
              setTab("comparativo");
              setPage("equipos");
            }}
          />
        ) : (
          <div className="split">
            <section className="pane list-pane" aria-labelledby="gx-list-h">
              <div className="lp-head">
                <h2 id="gx-list-h">Equipos</h2>
                <div className="seg" role="tablist" aria-label="Forma de ver los equipos">
                  {(
                    [
                      ["fase", "Por fase"],
                      ["red", "Por red"],
                    ] as const
                  ).map(([k, t]) => (
                    <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="lp-head">
                <div className="seg" aria-label="Filtrar por tipo">
                  {(
                    [
                      ["all", "Todos"],
                      ["gen", "Generadores"],
                      ["ion", "ION7400"],
                      ["pm", "Medidores"],
                    ] as const
                  ).map(([k, t]) => (
                    <button key={k} type="button" aria-pressed={typeFilter === k} onClick={() => setTypeFilter(k)}>
                      {t} <span className="muted">{devices.filter((d) => k === "all" || kindOf(d) === k).length}</span>
                    </button>
                  ))}
                </div>
                <label className="search" style={{ flex: "1 1 180px" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <path d="M21 21l-4.3-4.3" />
                  </svg>
                  <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nombre, área o IP" aria-label="Buscar equipo" />
                </label>
              </div>
              {stageFilter !== null && (
                <div className="lock-line" style={{ borderStyle: "solid" }}>
                  Mostrando solo {STAGES[stageFilter - 1].t.toLowerCase()}.{" "}
                  <button type="button" className="mbtn" onClick={() => setStageFilter(null)}>
                    Ver todos
                  </button>
                </div>
              )}
              <DeviceList
                devices={filtered}
                all={devices}
                view={view}
                selectedId={selectedId}
                onSelect={(id, t) => {
                  setSelectedId(id);
                  setTab(t ?? "equipo");
                }}
              />
            </section>

            {selected && (
              <Detail
                key={selected.id}
                device={selected}
                devices={devices}
                direct={direct.data?.devices.find((d) => d.name === selected.name) ?? null}
                screen={screenOf(selected.id)}
                onKey={(k) => press(selected, k)}
                tab={tab}
                setTab={setTab}
                onFullscreen={() => setFullscreen(true)}
              />
            )}
          </div>
        )}
      </div>

      {fullscreen && selected && (
        <Fullscreen device={selected} screen={screenOf(selected.id)} onKey={(k) => press(selected, k)} onClose={() => setFullscreen(false)} />
      )}
    </div>
  );
}

/* =================== lista =================== */

function Chip({ d, selected, onSelect, showIp = true }: { d: PilotDevice; selected: boolean; onSelect: (id: string, tab?: "conexion" | "huecos") => void; showIp?: boolean }) {
  const kind = kindOf(d);
  const conn = d.directConnection;
  const addr = conn ? `${conn.ip} · ID ${conn.unitId ?? "?"}` : `AS-P ${sourceHost(d) ?? "?"} · ${String(d.attributes.code ?? "")}`;
  let act: React.ReactNode;
  if (d.state === "offline") act = <span className="tag" style={{ color: "var(--bad)", borderColor: "#5c2a24" }}>Sin respuesta</span>;
  else if (d.gaps.openNow) act = <span className="tag t-est">Hueco abierto</span>;
  else if (conn?.enabled) act = <span className="tag t-dir">Directo · pendiente</span>;
  else if (!conn)
    act = (
      <button type="button" className="mbtn go" onClick={() => onSelect(d.id, "conexion")}>
        Conexión ›
      </button>
    );
  else if (conn.unitId == null)
    act = (
      <button type="button" className="mbtn warn" onClick={() => onSelect(d.id, "conexion")}>
        Falta ID
      </button>
    );
  else act = <span className="tag t-local">Historial</span>;
  return (
    <div className={`chip${selected ? " sel" : ""}`}>
      <button type="button" className="chip-main" aria-pressed={selected} onClick={() => onSelect(d.id)}>
        <span className={`mini ${miniCls(kind)}`}>
          <i />
        </span>
        <span className="chip-tx">
          <span className="nm">{d.name}</span>
          <span className="ad">
            {showIp ? addr : String(d.attributes.area ?? d.model ?? "")}
            {d.gaps.pending > 0 && (
              <span style={{ color: "var(--warn)" }}>
                {" "}
                · {d.gaps.pending} hueco{d.gaps.pending > 1 ? "s" : ""}
              </span>
            )}
          </span>
        </span>
      </button>
      <div className="chip-act">{act}</div>
    </div>
  );
}

function DeviceList({
  devices,
  all,
  view,
  selectedId,
  onSelect,
}: {
  devices: PilotDevice[];
  all: PilotDevice[];
  view: "fase" | "red";
  selectedId: string | null;
  onSelect: (id: string, tab?: "conexion" | "huecos") => void;
}) {
  if (!devices.length) return <div className="empty">Ningún equipo coincide con el filtro.</div>;

  if (view === "red") {
    // Agrupa por la IP de conexion directa (si se cargo) o por la del AS-P.
    const ipOf = (d: PilotDevice) => {
      if (d.directConnection?.viaDeviceId) return all.find((x) => x.id === d.directConnection!.viaDeviceId)?.directConnection?.ip ?? d.directConnection.ip;
      return d.directConnection?.ip ?? `AS-P ${sourceHost(d) ?? "?"}`;
    };
    const ips = [...new Set(devices.map(ipOf))].sort((a, b) => (a.startsWith("AS-P") ? 1 : b.startsWith("AS-P") ? -1 : ipNum(a) - ipNum(b)));
    return (
      <div className="net">
        {ips.map((ip) => {
          const here = devices.filter((d) => ipOf(d) === ip);
          const heads = here.filter((d) => !d.directConnection?.viaDeviceId || !here.some((h) => h.id === d.directConnection!.viaDeviceId));
          return (
            <div key={ip} className="node">
              <div className="ip">
                <span>{ip.startsWith("AS-P") ? ip : `${ip}:502`}</span>
                <small>{here.length === 1 ? "1 equipo" : `${here.length} equipos en este enlace`}</small>
              </div>
              {heads.map((h) => {
                const chain = here.filter((d) => d.directConnection?.viaDeviceId === h.id);
                return (
                  <div key={h.id} style={{ display: "grid", gap: 6 }}>
                    <Chip d={h} selected={selectedId === h.id} onSelect={onSelect} showIp={false} />
                    {chain.length > 0 && (
                      <div className="chain">
                        <span className="lbl">por cable RS-485 detrás de {h.name}</span>
                        {chain.map((d) => (
                          <Chip key={d.id} d={d} selected={selectedId === d.id} onSelect={onSelect} showIp={false} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  const sections = [
    { stage: 2, t: "Lectura directa", sub: "configurada · pendiente del agente" },
    { stage: 1, t: "Historial", sub: "guardando en TimescaleDB" },
    { stage: 0, t: "Sin historial todavía", sub: "esperando su primera lectura" },
  ];
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {sections.map((s) => {
        const items = devices.filter((d) => stageOf(d) === s.stage);
        if (!items.length) return null;
        return (
          <div key={s.stage} className={`lsec${s.stage === 1 ? " cur" : ""}`}>
            <div className="lsec-h">
              <span className="sn">{s.stage || "·"}</span>
              <span>
                <b>{s.t}</b> <small>· {s.sub}</small>
              </span>
              <span className="cnt">{items.length}</span>
            </div>
            <div className="lgrid">
              {items.map((d) => (
                <Chip key={d.id} d={d} selected={selectedId === d.id} onSelect={onSelect} />
              ))}
            </div>
          </div>
        );
      })}
      <div className="lock-line">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
        <span>
          <b style={{ color: "var(--muted)" }}>Recuperación</b> · se activa en la Fase C
        </span>
      </div>
    </div>
  );
}

/* =================== detalle =================== */

function useRotation() {
  const [rot, setRot] = useState({ x: -6, y: -24 });
  const drag = useRef<{ x: number; y: number; rx: number; ry: number } | null>(null);
  const handlers = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("button")) return;
      drag.current = { x: e.clientX, y: e.clientY, rx: rot.x, ry: rot.y };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.classList.add("drag");
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      setRot({ y: d.ry + (e.clientX - d.x) * 0.45, x: Math.max(-35, Math.min(35, d.rx - (e.clientY - d.y) * 0.3)) });
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      drag.current = null;
      e.currentTarget.classList.remove("drag");
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      const k = ({ ArrowLeft: [0, -10], ArrowRight: [0, 10], ArrowUp: [6, 0], ArrowDown: [-6, 0] } as Record<string, number[]>)[e.key];
      if (!k) return;
      e.preventDefault();
      setRot((r) => ({ x: Math.max(-35, Math.min(35, r.x + k[0])), y: r.y + k[1] }));
    },
  };
  return { rot, setRot, handlers };
}

function useFit(kind: DeviceKind, extraBottom = 90) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.8);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = DIM[kind];
    const fit = () => setScale(Math.min(1.2, (el.clientWidth - 50) / (m.w + m.d * 0.45), (el.clientHeight - extraBottom) / (m.h + (kind === "gen" ? 70 : 10))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [kind, extraBottom]);
  return { ref, scale };
}

export function Stage3D({
  device,
  screen,
  onKey,
  extra,
  className = "dstage",
}: {
  device: PilotDevice;
  screen: ScreenState;
  onKey: (k: string) => void;
  extra?: React.ReactNode;
  className?: string;
}) {
  const kind = kindOf(device);
  const { rot, setRot, handlers } = useRotation();
  const { ref, scale } = useFit(kind);
  const m = DIM[kind];
  return (
    <div ref={ref} className={className} tabIndex={0} aria-label="Equipo en 3D. Arrastra o usa las flechas del teclado para girarlo." {...handlers}>
      <div className="glow" />
      <div className="floor" />
      <div style={{ width: m.w * scale, height: m.h * scale }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0" }}>
          <DeviceBox device={device} kind={kind} screen={screen} onKey={onKey} rot={rot} />
        </div>
      </div>
      <span className="hint">Arrastra para girar · los botones del equipo funcionan</span>
      <div className="rot">
        <button type="button" className="rbtn" aria-label="Girar a la izquierda" onClick={() => setRot((r) => ({ ...r, y: r.y - 30 }))}>
          ↶
        </button>
        <button type="button" className="rbtn" onClick={() => setRot({ x: 0, y: 0 })}>
          Frente
        </button>
        <button type="button" className="rbtn" aria-label="Girar a la derecha" onClick={() => setRot((r) => ({ ...r, y: r.y + 30 }))}>
          ↷
        </button>
        {extra}
      </div>
    </div>
  );
}

function Ring({ pct, label, color }: { pct: number; label: string; color: string }) {
  const c = 2 * Math.PI * 21;
  const off = c * (1 - Math.max(0, Math.min(1, pct / 100)));
  return (
    <svg className="ring" viewBox="0 0 52 52" role="img" aria-label={label}>
      <circle cx="26" cy="26" r="21" fill="none" stroke="#1b2532" strokeWidth="4.5" />
      <circle cx="26" cy="26" r="21" fill="none" stroke={color} strokeWidth="4.5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 26 26)" />
      <text x="26" y="30" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="11" fontWeight="600" fill="#e6edf5">
        {label}
      </text>
    </svg>
  );
}

function Detail({
  device,
  devices,
  direct,
  screen,
  onKey,
  tab,
  setTab,
  onFullscreen,
}: {
  device: PilotDevice;
  devices: PilotDevice[];
  direct: PilotDevice | null;
  screen: ScreenState;
  onKey: (k: string) => void;
  tab: DetailTab;
  setTab: (t: DetailTab) => void;
  onFullscreen: () => void;
}) {
  const kind = kindOf(device);
  const r = device.readings;
  const cap = Number(device.attributes.capacityKva) || 0;
  // El espectro de armonicos solo llega por la lectura directa: se suma a lo del AS-P para la pantalla del ION.
  const conArmonicos = useMemo(
    () => (direct ? { ...device, readings: { ...device.readings, ...Object.fromEntries(Object.entries(direct.readings).filter(([k]) => k.startsWith("harm_"))) } } : device),
    [device, direct],
  );
  let ring: React.ReactNode;
  if (kind === "ion") {
    const kva = num(r, "apparent_power_total") ?? 0;
    const pct = cap ? (kva / cap) * 100 : 0;
    ring = <Ring pct={pct} label={cap ? `${Math.round(pct)}%` : "—"} color="#5b9dff" />;
  } else if (kind === "pm") {
    const vs = ["a", "b", "c"].map((x) => num(r, `voltage_${x}_n`) ?? 0).filter(Boolean);
    const v = vs.length ? vs.reduce((s, x) => s + x, 0) / vs.length : 0;
    ring = <Ring pct={(v / 140) * 100} label={v ? String(Math.round(v)) : "—"} color="#2fd0a0" />;
  } else {
    const load = num(r, "engine_load_metering") ?? 0;
    ring = <Ring pct={load} label={`${Math.round(load)}%`} color="#f2b13d" />;
  }
  const conn = device.directConnection;

  return (
    <section className="pane detail" aria-label={`Detalle de ${device.name}`}>
      <div className="d-head">
        <span className={`mini ${miniCls(kind)}`}>
          <i />
        </span>
        <div style={{ minWidth: 0 }}>
          <h2>{device.name}</h2>
          <div className="sub">
            {[device.model === "generator" ? "Generador" : device.model, device.attributes.area, device.attributes.code, cap ? `${cap} kVA` : null].filter(Boolean).join(" · ")}
          </div>
          <div className="chips" style={{ marginTop: 6 }}>
            <span className="pill">vía AS-P {sourceHost(device)}</span>
            {device.historySince && <span className="pill ok">historial desde {fmtTime(device.historySince)}</span>}
            {device.state === "offline" && <span className="pill bad">sin respuesta</span>}
            {conn?.enabled && <span className="pill acc">lectura directa configurada</span>}
          </div>
          <div className="conn" style={{ marginTop: 6 }}>
            <span>
              Última lectura <b>{device.updatedAt ? hhmm(new Date(device.updatedAt)) : "—"}</b>
            </span>
            <span>{conn ? `directo: ${conn.ip}:${conn.port} · ID ${conn.unitId ?? "?"}` : "sin datos de conexión directa"}</span>
          </div>
        </div>
        {ring}
      </div>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "equipo"} onClick={() => setTab("equipo")}>
          Equipo y métricas
        </button>
        <button type="button" role="tab" aria-selected={tab === "huecos"} onClick={() => setTab("huecos")}>
          Huecos <span className={`tcount${device.gaps.pending ? "" : " zero"}`}>{device.gaps.pending}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "comparativo"} onClick={() => setTab("comparativo")}>
          Directo vs AS-P
        </button>
        <button type="button" role="tab" aria-selected={tab === "conexion"} onClick={() => setTab("conexion")}>
          Conexión
        </button>
      </div>

      {tab === "equipo" && (
        <div className="tabp fade-in">
          <Stage3D
            device={conArmonicos}
            screen={screen}
            onKey={onKey}
            extra={
              <button type="button" className="rbtn" onClick={onFullscreen}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
                Pantalla completa
              </button>
            }
          />
          <div className="dgrid">
            <Metrics device={conArmonicos} kind={kind} screen={screen} />
            <Trend device={device} kind={kind} />
          </div>
          {kind === "ion" && ION_HARM_SCREENS.includes(screen.ion.scr) && <ArmonicosPanel device={device} direct={direct} />}
          <Journey device={device} onConnection={() => setTab("conexion")} />
          <details className="howto-d">
            <summary>Cómo usar los botones de este equipo</summary>
            <div className="howto">
              {(kind === "ion"
                ? [
                    ["Casa", "Vuelve al menú principal."],
                    ["▲ ▼ OK", "En el menú: moverse y abrir una pantalla."],
                    ["◀ ▶", "Pantalla anterior o siguiente."],
                    ["≡", "Regresa al menú."],
                  ]
                : kind === "pm"
                  ? [
                      ["∨ ∧", "Recorre los parámetros que llegan por el AS-P (VL-N, VL-L, I, demanda y reloj)."],
                      ["OK", "Promedios: V, I y frecuencia."],
                      ["L1 L2 L3", "Cada fila de dígitos es una fase."],
                    ]
                  : [
                      ["MOT ELE BAT ALM", "Cambian la pantalla del controlador."],
                      ["STOP · START", "Solo se muestran: el agente no envía comandos."],
                    ]
              ).map(([k, t]) => (
                <div key={k}>
                  <b>{k}</b>
                  <span>{t}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
      {tab === "huecos" && <GapsTab device={device} />}
      {tab === "comparativo" && <CompareTab device={device} />}
      {tab === "conexion" && <ConnectionTab device={device} devices={devices} />}
    </section>
  );
}

function Metrics({ device, kind, screen }: { device: PilotDevice; kind: DeviceKind; screen: ScreenState }) {
  const rows = metricRows(device, kind, screen);
  const colors = { warn: "var(--warn)", bad: "var(--bad)" };
  return (
    <div className="card2">
      <div className="h">
        <span>
          Pantalla <b>{screenTitle(kind, screen)}</b>
        </span>
        <span className="cmpv">{device.state === "offline" ? "sin respuesta" : "calidad: real"}</span>
      </div>
      <div className="mrows">
        {rows.map((m) => (
          <div key={m.label} className="mrow">
            <span className="k">{m.label}</span>
            <span className="track">
              <i style={{ width: `${m.frac * 100}%`, ...(m.tone ? { background: colors[m.tone] } : {}) }} />
            </span>
            <span className="v" style={m.tone ? { color: colors[m.tone] } : undefined}>
              {m.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Trend({ device, kind }: { device: PilotDevice; kind: DeviceKind }) {
  const metric = POWER_METRIC[kind];
  const series = usePilotSeries(device.id, metric, 60);
  const pts = series.data?.points ?? [];
  const gaps = series.data?.gaps ?? [];
  return (
    <div className="card2 trend">
      <div className="h">
        <span>
          {kind === "pm" ? "Demanda" : "Potencia"} · <b>última hora</b>
        </span>
        <span className="cmpv">kW</span>
      </div>
      <InteractiveChart
        height={200}
        unit="kW"
        dec={2}
        series={[{ name: kind === "pm" ? "Demanda" : "Potencia", color: "#5b9dff", points: pts.map((p) => ({ t: new Date(p.t).getTime(), v: p.v })) }]}
        bands={gaps.map((g) => ({ from: new Date(g.startedAt).getTime(), to: g.endedAt ? new Date(g.endedAt).getTime() : Date.now(), label: "Hueco registrado", color: "#f2b13d" }))}
        emptyText="Todavía no hay lecturas guardadas en la última hora."
      />
      <p className="muted" style={{ fontSize: ".78rem" }}>
        {series.isLoading
          ? "Cargando historial…"
          : gaps.length
            ? `${gaps.length} hueco${gaps.length > 1 ? "s" : ""} en la última hora, marcado${gaps.length > 1 ? "s" : ""} en amarillo.`
            : "Sin huecos en la última hora."}
      </p>
    </div>
  );
}

function Journey({ device, onConnection }: { device: PilotDevice; onConnection: () => void }) {
  const conn = device.directConnection;
  const st = stageOf(device);
  let next: React.ReactNode;
  if (!device.historySince) next = <span>Esperando la primera lectura de este equipo para empezar su historial.</span>;
  else if (!conn)
    next = (
      <>
        <span>Siguiente paso: cargar su IP e ID Modbus para la lectura directa.</span>
        <button type="button" className="mbtn go" onClick={onConnection}>
          Cargar conexión
        </button>
      </>
    );
  else if (conn.unitId == null)
    next = (
      <>
        <span>
          Falta confirmar su <b>ID Modbus</b>.
        </span>
        <button type="button" className="mbtn warn" onClick={onConnection}>
          Completar ID
        </button>
      </>
    );
  else if (!conn.enabled) next = <span>Tiene IP e ID. La lectura directa está apagada para este equipo.</span>;
  else
    next = (
      <span>
        Lectura directa configurada. El agente la empezará cuando tenga el mapa de registros propio de este equipo, verificado contra el equipo (solo
        lectura 03/04).
      </span>
    );
  return (
    <div className="card2">
      <div className="h">
        <span>
          Avance de <b>este equipo</b> en el piloto
        </span>
        <span className="cmpv">Fase A</span>
      </div>
      <ol className="journey">
        {STAGES.map((s, i) => {
          const stage = i + 1;
          const reached = stage === 1 ? !!device.historySince : stage === 2 ? st === 2 : false;
          const here = stage === (st === 2 ? 2 : 1);
          return (
            <li key={s.k} className={`${reached && !here ? "reached" : ""}${here ? " here" : ""}`}>
              <span className="jd" />
              <b>{s.t}</b>
              <span>{s.k}</span>
            </li>
          );
        })}
      </ol>
      <div className="next">{next}</div>
    </div>
  );
}

/* =================== huecos =================== */

const GAP_LABEL: Record<PilotGap["status"], [string, string]> = {
  open: ["var(--bad)", "Abierto"],
  closed: ["var(--warn)", "Registrado"],
  recovered: ["var(--recup)", "Recuperado"],
  partial: ["var(--recup)", "Recuperado en parte"],
  estimated: ["var(--warn)", "Estimado"],
  unrecoverable: ["var(--dim)", "No recuperable"],
};

function dayLabel(n: number) {
  if (n === 0) return "Hoy";
  if (n === 1) return "Ayer";
  const t = new Date();
  t.setDate(t.getDate() - n);
  return `${String(t.getDate()).padStart(2, "0")}/${String(t.getMonth() + 1).padStart(2, "0")}`;
}

function GapsTab({ device }: { device: PilotDevice }) {
  const gaps = usePilotGaps(device.id, 7);
  const list = gaps.data ?? [];
  const kind = kindOf(device);
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const W = 520,
    H = 7 * 16 + 22,
    L = 44,
    Rr = 6;
  const xm = (m: number) => L + (m / 1440) * (W - L - Rr);
  // Parte cada hueco por dia para dibujarlo en su fila.
  const bars: { day: number; m0: number; m1: number; status: PilotGap["status"]; id: string }[] = [];
  for (const g of list) {
    let s = new Date(g.startedAt).getTime();
    const e = g.endedAt ? new Date(g.endedAt).getTime() : Date.now();
    while (s < e) {
      const dayStart = new Date(s);
      dayStart.setHours(0, 0, 0, 0);
      const day = Math.round((startToday.getTime() - dayStart.getTime()) / 86_400_000);
      const dayEnd = dayStart.getTime() + 86_400_000;
      const segEnd = Math.min(e, dayEnd);
      if (day >= 0 && day < 7) bars.push({ day, m0: (s - dayStart.getTime()) / 60_000, m1: (segEnd - dayStart.getTime()) / 60_000, status: g.status, id: g.id + day });
      s = segEnd;
    }
  }
  return (
    <div className="tabp fade-in">
      <div className="gstats">
        <div className="gstat">
          <span className="v" style={{ color: device.gaps.pending ? "var(--warn)" : "var(--ok)" }}>
            {device.gaps.pending}
          </span>
          <span className="t">huecos pendientes (7 días)</span>
        </div>
        <div className="gstat">
          <span className="v">{device.gaps.missingMinutes}</span>
          <span className="t">minutos sin dato</span>
        </div>
        <div className="gstat">
          <span className="v" style={{ color: "var(--ok)" }}>
            {device.gaps.openNow ? "Sí" : "No"}
          </span>
          <span className="t">hueco abierto ahora</span>
        </div>
        <div className="gstat">
          <span className="v">{device.completeness == null ? "—" : `${device.completeness.toFixed(2)}%`}</span>
          <span className="t">datos completos{device.historySince ? ` desde ${fmtTime(device.historySince)}` : ""}</span>
        </div>
      </div>
      <div className="card2 week">
        <div className="h">
          <span>
            Últimos <b>7 días</b> · cada barra es un día de 24 h
          </span>
          <span className="cmpv">{list.length} huecos</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Huecos de los últimos 7 días">
          {Array.from({ length: 7 }, (_, i) => (
            <g key={i}>
              <text x={L - 6} y={4 + i * 16 + 10} textAnchor="end" fontSize="9" fill="var(--dim)" fontFamily="JetBrains Mono, monospace">
                {dayLabel(i)}
              </text>
              <rect x={L} y={4 + i * 16 + 2} width={W - L - Rr} height="10" rx="2" fill="var(--accent)" opacity=".16" />
            </g>
          ))}
          {[0, 6, 12, 18, 24].map((h) => (
            <text key={h} x={xm(h * 60)} y={H - 4} textAnchor={h === 0 ? "start" : h === 24 ? "end" : "middle"} fontSize="9" fill="var(--dim)" fontFamily="JetBrains Mono, monospace">
              {String(h).padStart(2, "0")}:00
            </text>
          ))}
          {bars.map((b) => (
            <rect key={b.id} x={xm(b.m0)} y={4 + b.day * 16} width={Math.max(3, xm(b.m1) - xm(b.m0))} height="14" rx="2" fill={GAP_LABEL[b.status][0]} />
          ))}
        </svg>
      </div>
      <div className="gtools">
        <span className="muted" style={{ fontSize: ".8rem" }}>
          Los huecos se registran solos. Recuperarlos se habilita en la Fase C.
        </span>
      </div>
      {gaps.isLoading ? (
        <div className="empty">Cargando huecos…</div>
      ) : !list.length ? (
        <div className="nogap">
          <b style={{ color: "var(--ink)" }}>Sin huecos en los últimos 7 días.</b>
          <span>Desde que empezó el historial, este equipo entregó todas sus lecturas.</span>
        </div>
      ) : (
        <div className="gaps">
          {list.map((g) => {
            const [c, label] = GAP_LABEL[g.status];
            const s = new Date(g.startedAt);
            const e = g.endedAt ? new Date(g.endedAt) : null;
            const day = Math.round((startToday.getTime() - new Date(s).setHours(0, 0, 0, 0)) / 86_400_000);
            return (
              <div key={g.id} className="gap">
                <span className="sb" style={{ background: c }} />
                <span className="gt">
                  <b>
                    {dayLabel(day)} · {hhmm(s)} – {e ? hhmm(e) : "ahora"}
                  </b>
                  <span>
                    {g.minutes} min · {Math.round((g.minutes * 60) / 15)} lecturas faltantes · {g.cause}
                  </span>
                </span>
                <span className="tag" style={{ color: c, borderColor: c }}>
                  {label}
                </span>
                <span className="tag" title="Se habilita en la Fase C">
                  Recuperar · Fase C
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="how">
        <b>Cómo se recuperará {kind === "ion" ? "un ION7400" : kind === "pm" ? "un medidor de circuito" : "un generador"} (Fase C)</b>
        <ol>
          {(kind === "ion"
            ? [
                "Cuando el equipo vuelve a responder, el hueco queda en cola para recuperar.",
                "El agente lee la memoria interna del ION7400 para ese rango, solo con función 03 y despacio.",
                "Lo guarda marcado como recuperado: nunca reemplaza una lectura real y no se duplica.",
              ]
            : kind === "pm"
              ? [
                  "El medidor no guarda historial: voltajes y corrientes de un hueco no se pueden recuperar.",
                  "La energía sí: contador de después menos contador de antes, marcada como estimada.",
                ]
              : ["El controlador del generador no guarda historial: el hueco se registra pero no se puede recuperar."]
          ).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ol>
        {kind === "ion" && <span>Antes de construirlo hay que verificar en el equipo cómo se leen sus registros históricos por Modbus.</span>}
      </div>
    </div>
  );
}

/* =================== directo vs AS-P (Fase B) =================== */

export const METRIC_LABEL: Record<string, [string, string]> = {
  current_a: ["Corriente A", "A"], current_b: ["Corriente B", "A"], current_c: ["Corriente C", "A"], current_avg: ["Corriente promedio", "A"],
  voltage_a_n: ["Voltaje A-N", "V"], voltage_b_n: ["Voltaje B-N", "V"], voltage_c_n: ["Voltaje C-N", "V"], voltage_ln_avg: ["Voltaje L-N promedio", "V"],
  voltage_a_b: ["Voltaje A-B", "V"], voltage_b_c: ["Voltaje B-C", "V"], voltage_c_a: ["Voltaje C-A", "V"], voltage_ll_avg: ["Voltaje L-L promedio", "V"],
  active_power_a: ["Potencia activa A", "kW"], active_power_b: ["Potencia activa B", "kW"], active_power_c: ["Potencia activa C", "kW"], active_power_total: ["Potencia activa total", "kW"],
  apparent_power_a: ["Potencia aparente A", "kVA"], apparent_power_b: ["Potencia aparente B", "kVA"], apparent_power_c: ["Potencia aparente C", "kVA"], apparent_power_total: ["Potencia aparente total", "kVA"],
  reactive_power_a: ["Potencia reactiva A", "kVAr"], reactive_power_b: ["Potencia reactiva B", "kVAr"], reactive_power_total: ["Potencia reactiva total", "kVAr"],
  apparent_power_total_peak_demand: ["Demanda pico aparente total", "kVA"], apparent_power_del_a_peak_demand: ["Demanda pico aparente A", "kVA"],
  apparent_power_del_b_peak_demand: ["Demanda pico aparente B", "kVA"], apparent_power_del_c_peak_demand: ["Demanda pico aparente C", "kVA"],
  frequency: ["Frecuencia", "Hz"], demand_total: ["Demanda", "kW"],
  power_factor_a: ["Factor de potencia A", ""], power_factor_b: ["Factor de potencia B", ""], power_factor_c: ["Factor de potencia C", ""], power_factor_total: ["Factor de potencia total", ""],
  thd_current_a_high: ["THD corriente A", "%"], thd_current_b_high: ["THD corriente B", "%"], thd_current_c_high: ["THD corriente C", "%"],
  thd_voltage_v1_high: ["THD voltaje A-N", "%"], thd_voltage_v2_high: ["THD voltaje B-N", "%"], thd_voltage_v3_high: ["THD voltaje C-N", "%"],
  short_term_flicker_pst_a_n: ["Flicker Pst A", ""], short_term_flicker_pst_b_n: ["Flicker Pst B", ""], short_term_flicker_pst_c_n: ["Flicker Pst C", ""],
  s1_commercial_energy_status: ["ATS: comercial (S1)", ""], s2_generator_energy_status: ["ATS: generador (S2)", ""],
  s1_commercial_transition_count: ["ATS: transferencias S1", ""], s2_generator_transition_count: ["ATS: transferencias S2", ""],
  energy_active_kwh: ["Energía activa", "kWh"], energy_reactive_kvarh: ["Energía reactiva", "kVArh"], energy_apparent_kvah: ["Energía aparente", "kVAh"],
  // Generador
  gen_kva_a_metering: ["Generador kVA A", "kVA"], gen_kva_b_metering: ["Generador kVA B", "kVA"], gen_kva_c_metering: ["Generador kVA C", "kVA"], gen_kva_total_metering: ["Generador kVA total", "kVA"],
  gen_kw_a_metering: ["Generador kW A", "kW"], gen_kw_b_metering: ["Generador kW B", "kW"], gen_kw_c_metering: ["Generador kW C", "kW"], gen_kw_total_metering: ["Generador kW total", "kW"],
  power_factor_metering: ["Factor de potencia", ""], gen_pf_lagging: ["FP en atraso", ""],
  gen_frequency_metering: ["Frecuencia del generador", "Hz"], bus_frequency_metering: ["Frecuencia de la barra", "Hz"],
  active_speed_source: ["Fuente de velocidad", ""], engine_speed_metering: ["Velocidad del motor", "RPM"], engine_load_metering: ["Carga del motor", "%"],
  coolant_temp_metering: ["Temperatura refrigerante", "°C"], oil_pressure_metering: ["Presión de aceite", "psi"],
  battery_voltage_metering: ["Voltaje de batería", "V"], fuel_level_metering: ["Nivel de combustible", "%"],
};
const metricLabel = (m: string) => METRIC_LABEL[m]?.[0] ?? m;
const metricUnit = (m: string) => METRIC_LABEL[m]?.[1] ?? "";
const fmtN = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(d));
const tolText = (m: PilotCompareMetric) => (m.tolerance.kind === "pct" ? `±${m.tolerance.value} %` : m.tolerance.value === 0 ? "exacto" : `±${m.tolerance.value}`);
const withinColor = (p: number) => (p >= 95 ? "var(--ok)" : p >= 80 ? "var(--warn)" : "var(--bad)");

const COMPARE_WINDOWS: [number, string][] = [
  [60, "1 hora"],
  [24 * 60, "24 horas"],
  [7 * 24 * 60, "7 días"],
];

export function CompareTab({ device }: { device: PilotDevice }) {
  const [minutes, setMinutes] = useState(60);
  const cmp = usePilotCompare(device.id, minutes);
  const data = cmp.data;
  const rows = useMemo(() => [...(data?.metrics ?? [])].sort((a, b) => a.withinPct - b.withinPct || metricLabel(a.metric).localeCompare(metricLabel(b.metric))), [data]);
  const [chartMetric, setChartMetric] = useState<string | null>(null);
  const metric = chartMetric && rows.some((r) => r.metric === chartMetric) ? chartMetric : (rows.find((r) => r.metric === POWER_METRIC[kindOf(device)]) ?? rows[0])?.metric ?? null;

  if (cmp.isLoading) return <div className="tabp fade-in"><div className="empty">Cargando comparativo…</div></div>;
  if (!data?.directDeviceId) {
    return (
      <div className="tabp fade-in">
        <div className="nogap">
          <b style={{ color: "var(--ink)" }}>Este equipo todavía no se lee directo.</b>
          <span>
            La lectura directa corre en un agente de prueba aparte (sede <b>{data?.directBuildingKey ?? "—"}</b>). Hoy incluye ANALIZADOR-1 y PM2130-1; los demás
            se agregan cuando estos dos pasen la comparación sin afectar al AS-P.
          </span>
        </div>
      </div>
    );
  }

  const n = rows.length;
  const avgWithin = n ? rows.reduce((s, r) => s + r.withinPct, 0) / n : 0;
  const ok = rows.filter((r) => r.withinPct >= 95).length;
  const fresh = data.directUpdatedAt ? (Date.now() - new Date(data.directUpdatedAt).getTime()) / 1000 : null;

  return (
    <div className="tabp fade-in">
      <div className="gstats">
        <div className="gstat">
          <span className="v">{n}</span>
          <span className="t">métricas comparadas</span>
        </div>
        <div className="gstat">
          <span className="v" style={{ color: withinColor(avgWithin) }}>{n ? `${avgWithin.toFixed(1)}%` : "—"}</span>
          <span className="t">promedio dentro de tolerancia</span>
        </div>
        <div className="gstat">
          <span className="v" style={{ color: ok === n ? "var(--ok)" : "var(--warn)" }}>
            {ok}/{n}
          </span>
          <span className="t">métricas que coinciden (≥95 %)</span>
        </div>
        <div className="gstat">
          <span className="v" style={{ color: data.directState === "offline" || (fresh ?? 999) > 120 ? "var(--bad)" : "var(--ok)" }}>
            {fresh == null ? "—" : fresh < 90 ? "En línea" : `hace ${Math.round(fresh / 60)} min`}
          </span>
          <span className="t">lectura directa · cada 30 s</span>
        </div>
      </div>

      <div className="gtools">
        <div className="seg" role="tablist" aria-label="Ventana de comparación">
          {COMPARE_WINDOWS.map(([m, label]) => (
            <button key={m} type="button" role="tab" aria-selected={minutes === m} onClick={() => setMinutes(m)}>
              {label}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: ".8rem" }}>
          Promedios por {data.bucketSeconds >= 900 ? "15 minutos" : "minuto"}. El AS-P lee el medidor con su propio ciclo: en corriente y potencia siempre hay algo de diferencia.
        </span>
      </div>

      {metric && <CompareChart aspId={device.id} directId={data.directDeviceId} metric={metric} minutes={minutes} />}

      <div className="card2" style={{ overflowX: "auto" }}>
        <div className="h">
          <span>
            Métrica por métrica · <b>toca una fila</b> para verla en la gráfica
          </span>
          <span className="cmpv">{data.directBuildingKey}</span>
        </div>
        {!n ? (
          <div className="empty">Todavía no hay minutos con lectura de los dos caminos. Espera un par de minutos.</div>
        ) : (
          <table className="cmp-table">
            <thead>
              <tr>
                <th scope="col">Métrica</th>
                <th scope="col">AS-P</th>
                <th scope="col">Directo</th>
                <th scope="col">Diferencia</th>
                <th scope="col">Dentro de tolerancia</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.metric} aria-selected={r.metric === metric} onClick={() => setChartMetric(r.metric)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setChartMetric(r.metric)}>
                  <th scope="row">
                    {metricLabel(r.metric)}
                    <span className="u">{metricUnit(r.metric)}</span>
                  </th>
                  <td>{fmtN(r.avgAsp, 3)}</td>
                  <td>{fmtN(r.avgDirect, 3)}</td>
                  <td>{r.meanPctDiff != null && r.tolerance.kind === "pct" ? `${r.meanPctDiff.toFixed(2)} %` : fmtN(r.meanAbsDiff, 3)}</td>
                  <td>
                    <span className="wbar" aria-hidden="true">
                      <i style={{ width: `${r.withinPct}%`, background: withinColor(r.withinPct) }} />
                    </span>
                    <b style={{ color: withinColor(r.withinPct) }}>{r.withinPct.toFixed(0)}%</b>
                    <span className="u">{tolText(r)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(data.onlyDirect.length > 0 || data.onlyAsp.length > 0) && (
        <div className="how">
          {data.onlyDirect.length > 0 && (
            <>
              <b>Solo se obtienen leyendo directo ({data.onlyDirect.length})</b>
              <div className="chips">
                {data.onlyDirect.map((m) => (
                  <span key={m} className="pill acc">
                    {metricLabel(m)}
                  </span>
                ))}
              </div>
            </>
          )}
          {data.onlyAsp.length > 0 && (
            <>
              <b>Solo llegan por el AS-P ({data.onlyAsp.length})</b>
              <div className="chips">
                {data.onlyAsp.map((m) => (
                  <span key={m} className="pill">
                    {metricLabel(m)}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Resumen de la sede (Fase B): una fila por equipo con su comparativo directo vs AS-P. */
function CompareSummary({ devices, onOpen }: { devices: PilotDevice[]; onOpen: (id: string) => void }) {
  const [minutes, setMinutes] = useState(24 * 60);
  const results = usePilotCompareMany(
    devices.map((d) => d.id),
    minutes,
  );
  const rows = devices.map((d, i) => {
    const q = results[i];
    const data = q?.data;
    const metrics = data?.metrics ?? [];
    const n = metrics.length;
    const avg = n ? metrics.reduce((s, m) => s + m.withinPct, 0) / n : null;
    const ok = metrics.filter((m) => m.withinPct >= 95).length;
    const worst = n ? [...metrics].sort((a, b) => a.withinPct - b.withinPct)[0] : null;
    const fresh = data?.directUpdatedAt ? (Date.now() - new Date(data.directUpdatedAt).getTime()) / 1000 : null;
    return { d, loading: q?.isLoading ?? true, direct: !!data?.directDeviceId, n, avg, ok, worst, onlyDirect: data?.onlyDirect.length ?? 0, fresh, offline: data?.directState === "offline" };
  });
  const withDirect = rows.filter((r) => r.direct);
  const compared = withDirect.filter((r) => r.n > 0);
  const allMetrics = compared.reduce((s, r) => s + r.n, 0);
  const allOk = compared.reduce((s, r) => s + r.ok, 0);
  const overall = allMetrics ? compared.reduce((s, r) => s + (r.avg ?? 0) * r.n, 0) / allMetrics : null;
  const loading = rows.some((r) => r.loading);

  return (
    <section className="pane" aria-label="Resumen directo vs AS-P" style={{ padding: 16, display: "grid", gap: 14 }}>
      <div className="gstats">
        <div className="gstat">
          <span className="v">
            {withDirect.length}
            <small className="muted"> / {devices.length}</small>
          </span>
          <span className="t">equipos leídos directo</span>
        </div>
        <div className="gstat">
          <span className="v" style={{ color: overall == null ? undefined : withinColor(overall) }}>{overall == null ? "—" : `${overall.toFixed(1)}%`}</span>
          <span className="t">promedio dentro de tolerancia</span>
        </div>
        <div className="gstat">
          <span className="v" style={{ color: allMetrics && allOk === allMetrics ? "var(--ok)" : "var(--warn)" }}>
            {allOk}/{allMetrics}
          </span>
          <span className="t">métricas que coinciden (≥95 %)</span>
        </div>
        <div className="gstat">
          <span className="v">{compared.reduce((s, r) => s + r.onlyDirect, 0)}</span>
          <span className="t">métricas que solo se obtienen directo</span>
        </div>
      </div>

      <div className="gtools">
        <div className="seg" role="tablist" aria-label="Ventana del resumen">
          {COMPARE_WINDOWS.map(([m, label]) => (
            <button key={m} type="button" role="tab" aria-selected={minutes === m} onClick={() => setMinutes(m)}>
              {label}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: ".8rem" }}>
          {loading ? "Calculando…" : "Toca un equipo para ver su comparativo métrica por métrica."} "7 días" incluye todo lo leído directo desde que empezó la prueba.
        </span>
      </div>

      <div className="card2" style={{ overflowX: "auto" }}>
        <table className="cmp-table sum-table">
          <thead>
            <tr>
              <th scope="col">Equipo</th>
              <th scope="col">Métricas</th>
              <th scope="col">Dentro de tolerancia</th>
              <th scope="col">Coinciden</th>
              <th scope="col">Peor métrica</th>
              <th scope="col">Solo directo</th>
              <th scope="col">Lectura directa</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.d.id} onClick={() => r.direct && onOpen(r.d.id)} tabIndex={r.direct ? 0 : -1} onKeyDown={(e) => e.key === "Enter" && r.direct && onOpen(r.d.id)} style={r.direct ? undefined : { cursor: "default", opacity: 0.6 }}>
                <th scope="row">
                  {r.d.name}
                  <span className="u">{String(r.d.attributes.area ?? "")}</span>
                </th>
                {!r.direct ? (
                  <td colSpan={6} style={{ textAlign: "left", fontFamily: "inherit" }} className="muted">
                    {r.loading ? "Cargando…" : "Todavía no se lee directo"}
                  </td>
                ) : (
                  <>
                    <td>{r.n || "—"}</td>
                    <td>
                      {r.avg == null ? (
                        "—"
                      ) : (
                        <>
                          <span className="wbar" aria-hidden="true">
                            <i style={{ width: `${r.avg}%`, background: withinColor(r.avg) }} />
                          </span>
                          <b style={{ color: withinColor(r.avg) }}>{r.avg.toFixed(1)}%</b>
                        </>
                      )}
                    </td>
                    <td>
                      {r.ok}/{r.n}
                    </td>
                    <td style={{ textAlign: "left", fontFamily: "inherit" }}>
                      {r.worst ? (
                        <>
                          {metricLabel(r.worst.metric)} <b style={{ color: withinColor(r.worst.withinPct) }}>{r.worst.withinPct.toFixed(0)}%</b>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{r.onlyDirect}</td>
                    <td style={{ color: r.offline || (r.fresh ?? 999) > 120 ? "var(--bad)" : "var(--ok)" }}>
                      {r.fresh == null ? "—" : r.offline ? "sin respuesta" : r.fresh < 90 ? "en línea" : `hace ${Math.round(r.fresh / 60)} min`}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: ".78rem", margin: 0 }}>
        Tolerancias: voltaje ±1 %, corriente y potencia ±3 %, frecuencia ±0.05 Hz, factor de potencia ±0.02, THD ±0.5 puntos, flicker ±0.1, estado y contadores del ATS exactos. Cuando la
        diferencia es del AS-P (dato atrasado o mal escalado), la peor métrica lo muestra. Generador: el AS-P lo republica sin decimales (10.6 °C llega como 11), por eso
        la temperatura y la batería pueden salir fuera de tolerancia aunque la lectura directa sea correcta.
      </p>
    </section>
  );
}

function CompareChart({ aspId, directId, metric, minutes }: { aspId: string; directId: string; metric: string; minutes: number }) {
  const a = usePilotSeries(aspId, metric, minutes);
  const d = usePilotSeries(directId, metric, minutes);
  const pa = a.data?.points ?? [];
  const pd = d.data?.points ?? [];
  const unit = metricUnit(metric);
  return (
    <div className="card2 trend">
      <div className="h">
        <span>
          <b>{metricLabel(metric)}</b> {unit && `(${unit})`}
        </span>
      </div>
      <InteractiveChart
        height={240}
        unit={unit}
        dec={unit === "Hz" || unit === "" ? 3 : 2}
        series={[
          { name: "AS-P (EBO)", color: "#94a3b8", dashed: true, points: pa.map((p) => ({ t: new Date(p.t).getTime(), v: p.v })) },
          { name: "Directo", color: "#2fd0a0", points: pd.map((p) => ({ t: new Date(p.t).getTime(), v: p.v })) },
        ]}
      />
      <p className="muted" style={{ fontSize: ".78rem" }}>
        {a.isLoading || d.isLoading ? "Cargando…" : `AS-P: ${pa.length} puntos · Directo: ${pd.length} puntos. Pase el mouse para ver los dos valores en el mismo instante; arrastre para acercar.`}
      </p>
    </div>
  );
}

/* =================== conexion =================== */

const IPRE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function ConnectionTab({ device, devices }: { device: PilotDevice; devices: PilotDevice[] }) {
  const kind = kindOf(device);
  const save = useSaveDirectConnection();
  const c = device.directConnection;
  const [route, setRoute] = useState<"direct" | "via">(c?.viaDeviceId ? "via" : "direct");
  const [via, setVia] = useState(c?.viaDeviceId ?? "");
  const [ip, setIp] = useState(c?.ip ?? "");
  const [port, setPort] = useState(String(c?.port ?? 502));
  const [unit, setUnit] = useState(c?.unitId != null ? String(c.unitId) : "");
  const [enabled, setEnabled] = useState(c?.enabled ?? false);
  const [compare, setCompare] = useState(c?.compareWithAsp ?? true);
  const [interval, setIntervalSeconds] = useState(String(c?.intervalSeconds ?? 15));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  const bridges = devices.filter((d) => d.id !== device.id && kindOf(d) === "ion" && d.directConnection && !d.directConnection.viaDeviceId);
  const viaIp = devices.find((d) => d.id === via)?.directConnection?.ip ?? "";
  const effectiveIp = route === "via" ? viaIp : ip;

  const validate = () => {
    const e: Record<string, string> = {};
    if (route === "via" && !via) e.via = "Elige el equipo que hace de puente.";
    if (!IPRE.test(effectiveIp)) e.ip = "La IP debe tener 4 números de 0 a 255, por ejemplo 10.0.6.10.";
    const p = Number(port);
    if (!(p >= 1 && p <= 65535)) e.port = "El puerto va de 1 a 65535. Modbus TCP usa 502.";
    const u = unit.trim() ? Number(unit) : null;
    if (u != null && !(Number.isInteger(u) && u >= 1 && u <= 247)) e.unit = "El ID Modbus va de 1 a 247.";
    else if (route === "via" && u == null) e.unit = "Detrás de un puente el ID es obligatorio: es lo que distingue al equipo en el cable.";
    else {
      const dup = devices.find(
        (d) => d.id !== device.id && d.directConnection && (d.directConnection.viaDeviceId ? devices.find((x) => x.id === d.directConnection!.viaDeviceId)?.directConnection?.ip : d.directConnection.ip) === effectiveIp && d.directConnection.port === p && (d.directConnection.unitId ?? null) === u,
      );
      if (dup) e.unit = `${dup.name} ya usa ${effectiveIp} con ID ${u ?? "por defecto"}. Usa otro ID.`;
    }
    setErrors(e);
    return !Object.keys(e).length;
  };

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    setSaved(false);
    if (!validate()) return;
    const connection: Omit<DirectConnection, "updatedAt"> = {
      ip: effectiveIp,
      port: Number(port),
      unitId: unit.trim() ? Number(unit) : null,
      viaDeviceId: route === "via" ? via : null,
      enabled,
      compareWithAsp: compare,
      intervalSeconds: Number(interval),
    };
    save.mutate({ deviceId: device.id, connection }, { onSuccess: () => setSaved(true) });
  };

  const err = (k: string) => errors[k] && <span className="err">{errors[k]}</span>;
  const apiError = save.error as { response?: { data?: { message?: string | string[] } } } | null;
  return (
    <div className="tabp fade-in">
      <form onSubmit={submit} noValidate style={{ display: "grid", gap: 16 }}>
        <div className="steps">
          <div className="step">
            <div className="step-h">
              <span className="n">1</span>
              <span>Equipo</span>
            </div>
            <div className="lock" style={{ color: "var(--muted)", borderColor: "var(--line-2)", background: "#0a1018" }}>
              <span className={`mini ${miniCls(kind)}`}>
                <i />
              </span>
              <span>
                <b style={{ color: "var(--ink)" }}>{device.name}</b> · {kind === "ion" ? "ION7400" : kind === "pm" ? "Medidor de circuito (PM2130 / EM6400NG+)" : "Generador"}. Hoy se lee a través
                del AS-P {sourceHost(device)}.
              </span>
            </div>
          </div>
          <div className="step">
            <div className="step-h">
              <span className="n">2</span>Conexión Modbus TCP directa
            </div>
            <div className="fields">
              <div className="fl s6">
                <span className="lbl" id="gx-route-l">
                  ¿Cómo llega el agente al equipo?
                </span>
                <div className="radios" role="radiogroup" aria-labelledby="gx-route-l">
                  <label>
                    <input type="radio" name="gx-route" checked={route === "direct"} onChange={() => setRoute("direct")} /> Tiene su propia IP
                  </label>
                  <label>
                    <input type="radio" name="gx-route" checked={route === "via"} onChange={() => setRoute("via")} /> A través de otro equipo (cable RS-485)
                  </label>
                </div>
              </div>
              {route === "via" && (
                <div className="fl s6">
                  <label htmlFor="gx-via">Equipo que hace de puente</label>
                  <select id="gx-via" value={via} onChange={(e) => setVia(e.target.value)}>
                    <option value="">Elegir…</option>
                    {bridges.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} · {d.directConnection!.ip}
                        {d.directConnection!.unitId ? ` (ID ${d.directConnection!.unitId})` : ""}
                      </option>
                    ))}
                  </select>
                  <span className="help">Solo aparecen los ION7400 que ya tienen su IP cargada. Se usa la IP del puente; el ID Modbus distingue a cada equipo en el cable.</span>
                  {err("via")}
                </div>
              )}
              <div className="fl">
                <label htmlFor="gx-ip">Dirección IP</label>
                <input
                  id="gx-ip"
                  type="text"
                  className="mono"
                  inputMode="decimal"
                  placeholder="10.0.6.10"
                  value={effectiveIp}
                  readOnly={route === "via"}
                  onChange={(e) => setIp(e.target.value)}
                  aria-invalid={!!errors.ip}
                />
                {err("ip")}
              </div>
              <div className="fl s1">
                <label htmlFor="gx-port">Puerto</label>
                <input id="gx-port" type="number" className="mono" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} aria-invalid={!!errors.port} />
                {err("port")}
              </div>
              <div className="fl s2">
                <label htmlFor="gx-unit">ID Modbus</label>
                <input id="gx-unit" type="number" className="mono" min={1} max={247} placeholder="defecto" value={unit} onChange={(e) => setUnit(e.target.value)} aria-invalid={!!errors.unit} />
                {err("unit")}
              </div>
              <div className="fl s6">
                <div className="lock" style={{ color: "var(--muted)", borderColor: "var(--line-2)", background: "#0a1018" }}>
                  "Buscar ID" y "Probar lectura" los hace el agente de la sede desde su red. El agente de Escuintla todavía no los tiene: se habilitan al
                  instalarle la versión nueva.
                </div>
              </div>
            </div>
          </div>
          <div className="step">
            <div className="step-h">
              <span className="n">3</span>Cómo se lee
            </div>
            <div className="fields">
              <label className="toggle fl s6 on-toggle" htmlFor="gx-on">
                <input id="gx-on" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                <div>
                  <b>Leer este equipo directo (Fase B)</b>
                  <span>Queda guardado; el agente lo empezará a leer cuando tenga el mapa de registros propio del equipo, verificado contra el equipo.</span>
                </div>
              </label>
              <div className="fl s2">
                <label htmlFor="gx-int">Cada</label>
                <select id="gx-int" value={interval} onChange={(e) => setIntervalSeconds(e.target.value)}>
                  <option value="15">15 segundos</option>
                  <option value="30">30 segundos</option>
                  <option value="60">1 minuto</option>
                </select>
              </div>
              <div className="fl s4">
                <span className="lbl">Funciones Modbus</span>
                <div className="lock">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <rect x="5" y="11" width="14" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                  Solo lectura 03 y 04. No se puede cambiar.
                </div>
              </div>
              <label className="toggle fl s6" htmlFor="gx-cmp">
                <input id="gx-cmp" type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
                <div>
                  <b>Comparar con el AS-P</b>
                  <span>Guarda las dos lecturas y avisa si difieren más de 0.5 %.</span>
                </div>
              </label>
              <label className="toggle fl s6" aria-disabled="true">
                <input type="checkbox" disabled />
                <div>
                  <b>Recuperar huecos desde la memoria del equipo</b>
                  <span>Fase C. Se habilita después de verificar cómo se lee la memoria del ION7400.</span>
                </div>
              </label>
            </div>
          </div>
        </div>
        {saved && <div className="result">Guardado. {enabled ? "Lectura directa configurada para este equipo." : "Datos de conexión guardados (lectura directa apagada)."}</div>}
        {apiError && (
          <div className="result" style={{ color: "var(--bad)", borderColor: "#5c2a24" }}>
            No se pudo guardar: {[apiError.response?.data?.message ?? "error de la API"].flat().join(" ")}
          </div>
        )}
        <div className="actions">
          <button type="submit" className="btn primary" disabled={save.isPending}>
            {save.isPending ? "Guardando…" : "Guardar conexión"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* =================== pantalla completa =================== */

function Fullscreen({ device, screen, onKey, onClose }: { device: PilotDevice; screen: ScreenState; onKey: (k: string) => void; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`${device.name} en pantalla completa`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox">
        <div className="mhead">
          <div style={{ minWidth: 0 }}>
            <h2>
              {device.name} · {device.model === "generator" ? "Generador" : device.model}
            </h2>
            <div className="muted" style={{ fontSize: ".8rem" }}>
              Arrastra para girar · los botones del equipo funcionan
            </div>
          </div>
          <button ref={closeRef} type="button" className="mclose" aria-label="Cerrar pantalla completa" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <Stage3D device={device} screen={screen} onKey={onKey} />
      </div>
    </div>
  );
}