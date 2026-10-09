import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { useAgentStatus, type Device } from "../api/devices";
import { SITES, type SiteConfig } from "../config/sites";
import {
  AirCard,
  DoorTile,
  EnvCard,
  GatewayCard,
  GeneratorCard,
  IonCard,
  LoraCard,
  PmCard,
  RadioTable,
  WiseCard,
  generatorRunning,
  ionSource,
} from "../components/sedes/Cards";
import SedeTrendModal from "../components/sedes/SedeTrendModal";
import SiteEventsPanel from "../components/sedes/SiteEventsPanel";
import { useSiteEvents } from "../api/siteEvents";
import { demoDevices, demoEvents, fmt, isDoorOpen, num, str, type SedeDevice, type SedeKind, toSedeDevices } from "../utils/sedes";

/**
 * Pestaña Sedes (diseño final aprobado): energia de la sede por Modbus (generadores, ION7400,
 * PM2130 leidos por el Agente_Go desde el EBO AS-P) y sensores LoRaWAN por MQTT (ChirpStack),
 * con tendencias por equipo. Los equipos son los Device cuyo metadata.agent.buildingKey es el de
 * la sede (config/sites.ts). Mientras el agente de la sede modelo no reporte nada se muestran
 * datos de demostracion claramente marcados, para que el diseño se pueda revisar igual.
 */

type View = "energia" | "lora" | "eventos";
type EnergyFilter = "all" | "gen" | "ion" | "pm";
type LoraFilter = "all" | "door" | "env" | "wise" | "air" | "lora";

const TICK_MS = 2500;

function useSiteDevices() {
  return useQuery({
    queryKey: ["devices"],
    queryFn: async () => {
      const { data } = await apiClient.get<Device[]>("/devices");
      return data;
    },
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
  });
}

function agoText(iso: string | null | undefined, nowMs: number) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
}

function payloadSummary(d: SedeDevice) {
  if (d.kind === "door") return `magnet_status: ${isDoorOpen(d.readings) ? "open" : "close"}`;
  return Object.entries(d.readings)
    .filter(([, v]) => typeof v === "number")
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${fmt(v as number, 1)}`)
    .join(", ");
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`min-h-[40px] rounded-full border px-3.5 py-2 text-sm ${
        on ? "border-[#E6EDF3] bg-[#E6EDF3] font-semibold text-[#0B1117]" : "border-[#2C3D50] bg-[#121A23] text-[#E6EDF3] hover:border-[#3A4E64]"
      }`}
    >
      {children}
    </button>
  );
}

function Kpi({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }) {
  return (
    <div className="rounded-[14px] border border-[#243243] bg-[#121A23] p-4">
      <div className="text-[13px] text-[#93A4B5]">{label}</div>
      <div className="sd-num text-[26px] font-semibold" style={{ color }}>
        {value} {unit && <span className="text-sm font-normal text-[#93A4B5]">{unit}</span>}
      </div>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2.5">
      <h2 className="text-lg font-semibold text-[#E6EDF3]">{title}</h2>
      {hint && <span className="text-[13px] text-[#93A4B5]">{hint}</span>}
    </div>
  );
}

export default function Sedes() {
  const { data: devices, isLoading } = useSiteDevices();
  const { data: agentStatus } = useAgentStatus();
  const [site, setSite] = useState<SiteConfig>(SITES[0]);
  const [view, setView] = useState<View>("energia");
  const [filter, setFilter] = useState<EnergyFilter>("all");
  const [loraFilter, setLoraFilter] = useState<LoraFilter>("all");
  const [compact, setCompact] = useState(false);
  const [outage, setOutage] = useState(false);
  const [trendId, setTrendId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const real = useMemo(() => toSedeDevices(devices ?? [], site.buildingKey), [devices, site.buildingKey]);
  const demo = !isLoading && real.length === 0 && !!site.model;
  const demoEventList = useMemo(() => (demo ? demoEvents() : undefined), [demo]);
  // Solo para los contadores de la pestaña Eventos (la lista la trae SiteEventsPanel).
  const since24h = useMemo(() => new Date(Date.now() - 86_400_000).toISOString(), [site.buildingKey]);
  const { data: eventSummary } = useSiteEvents(demo ? null : site.buildingKey, { from: since24h, limit: 1 });
  const critical24h = demo ? demoEventList?.filter((e) => e.severity === "critical").length ?? 0 : eventSummary?.counts.critical ?? 0;
  const total24h = demo
    ? demoEventList?.length ?? 0
    : Object.values(eventSummary?.counts ?? {}).reduce((s, n) => s + (n ?? 0), 0);
  const all = useMemo(() => (demo ? demoDevices(tick, outage) : real), [demo, real, tick, outage]);
  const nowMs = Date.now();

  const byKind = (k: SedeKind) => all.filter((d) => d.kind === k);
  const gens = byKind("gen");
  const ions = byKind("ion");
  const pms = byKind("pm");
  const doors = byKind("door");
  const envs = byKind("env");
  const wises = byKind("wise");
  const airs = byKind("air");
  const others = byKind("lora");
  const gateways = byKind("gateway");
  const radios = byKind("radio");
  const energy = [...gens, ...ions, ...pms];
  const lora = [...doors, ...envs, ...wises, ...airs, ...others, ...radios];

  const status = agentStatus?.find((s) => s.buildingKey === site.buildingKey);
  const sources = ions.map(ionSource).filter(Boolean);
  const onGenerator = sources.includes("Generador");
  const running = gens.filter(generatorRunning).length;
  const totalKw = ions.reduce((s, d) => s + (num(d.readings, "active_power_total") ?? 0), 0);
  const openDoors = doors.filter((d) => isDoorOpen(d.readings)).length;
  const lowBatt = lora.filter((d) => (num(d.readings, "battery") ?? 100) < 20).length;
  const uplinkAt = (d: SedeDevice) => str(d.attrs.lastUplinkAt) || d.updatedAt || "";
  const feed = [...lora].sort((a, b) => uplinkAt(b).localeCompare(uplinkAt(a))).slice(0, 7);
  const trendDevice = trendId ? all.find((d) => d.id === trendId) ?? null : null;

  const genGrid = compact ? "grid-cols-[repeat(auto-fill,minmax(280px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(min(440px,100%),1fr))]";
  const ionGrid = compact ? "grid-cols-[repeat(auto-fill,minmax(240px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))]";
  const pmGrid = compact ? "grid-cols-[repeat(auto-fill,minmax(220px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))]";
  const loraGrid = "grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))]";

  return (
    <div className="flex flex-col gap-5 text-[#E6EDF3]">
      <nav aria-label="Sedes del IGSS" className="flex flex-wrap gap-2">
        {SITES.map((s) => {
          const on = s.key === site.key;
          const active = agentStatus?.some((a) => a.buildingKey === s.buildingKey);
          const tag = s.model ? "modelo" : s.tag ?? (active ? "en línea" : "pendiente");
          return (
            <button
              key={s.key}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => {
                setSite(s);
                setTrendId(null);
              }}
              className={`inline-flex min-h-[40px] items-center gap-2 rounded-[10px] border px-3.5 py-2 text-sm ${
                on ? "border-[#5B9BFF] bg-[#182330] font-semibold text-[#E6EDF3]" : "border-[#243243] text-[#93A4B5] hover:text-[#E6EDF3]"
              }`}
            >
              {s.name}
              <span className={`text-[11px] ${s.model || active ? "text-[#8FE0B5]" : "text-[#7D8FA1]"}`}>{tag}</span>
            </button>
          );
        })}
      </nav>

      <section className="flex flex-wrap items-stretch gap-4">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col justify-center gap-1.5">
          <div className="text-[13px] uppercase tracking-[1.2px] text-[#93A4B5]">
            {site.model ? "Sede modelo" : "Sede"} · {site.buildingKey}
          </div>
          <h1 className="text-[32px] font-bold leading-tight">IGSS {site.name}</h1>
          <p className="max-w-[640px] text-[#93A4B5]">
            {site.loraDirect
              ? "Sensores LoRaWAN recibidos directo de los gateways por el Agente Go (Semtech UDP), sin ChirpStack ni broker intermedio."
              : "Energía por Modbus desde el EBO AS-P y sensores LoRaWAN por MQTT desde ChirpStack, leídos automáticamente por el Agente Go."}
          </p>
        </div>
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-2.5 rounded-[14px] border border-[#243243] bg-[#121A23] p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="font-semibold">Agente Go · {site.name}</div>
            {status ? (
              <span className="rounded-full border border-[#1F3A2E] bg-[#0F1F18] px-2.5 py-0.5 text-xs text-[#8FE0B5]">En línea</span>
            ) : (
              <span className="rounded-full border border-[#2C3D50] bg-[#0E151D] px-2.5 py-0.5 text-xs text-[#B4C2D0]">Sin reportar</span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 text-[13px]">
            <div className="rounded-[10px] bg-[#0E151D] px-2.5 py-2">
              <div className="text-xs text-[#93A4B5]">Modbus TCP · {site.modbus?.name ?? "—"}</div>
              <div className="sd-num">{site.modbus ? `${site.modbus.host}:${site.modbus.port} · unit ${site.modbus.unitId}` : "por configurar"}</div>
            </div>
            {site.loraDirect ? (
              <div className="rounded-[10px] bg-[#0E151D] px-2.5 py-2">
                <div className="text-xs text-[#93A4B5]">LoRaWAN directo · sin ChirpStack</div>
                <div className="sd-num">Gateways → agente UDP {site.loraDirect.port}</div>
              </div>
            ) : (
              <div className="rounded-[10px] bg-[#0E151D] px-2.5 py-2">
                <div className="text-xs text-[#93A4B5]">MQTT · ChirpStack</div>
                <div className="sd-num">{site.lorawan ? `${site.lorawan.host}:${site.lorawan.port}` : "por configurar"}</div>
              </div>
            )}
          </div>
          <div className="text-xs text-[#93A4B5]">
            Último sync: <span className="sd-num text-[#E6EDF3]">{demo ? "—" : agoText(status?.syncedAt, nowMs)}</span>
          </div>
        </div>
      </section>

      {demo && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#22406E] bg-[#0F1B2D] px-4 py-3 text-sm text-[#A9C8FF]">
          <span>
            <strong className="text-[#D6E6FF]">Datos de demostración.</strong> El Agente Go de esta sede todavía no ha reportado equipos; en cuanto lo haga,
            esta vista se llena sola con las lecturas reales.
          </span>
        </div>
      )}

      {!site.model && !site.loraDirect && real.length === 0 && !isLoading && (
        <div className="rounded-[14px] border border-dashed border-[#2C3D50] bg-[#121A23] p-8 text-center text-[#93A4B5]">
          Esta sede todavía no tiene un Agente Go configurado. Se instala con el mismo modelo que Escuintla, cambiando solo su archivo de configuración.
        </div>
      )}

      {site.loraDirect && gateways.length === 0 && !isLoading && (
        <section aria-label="Esperando gateway" className="flex flex-col gap-3 rounded-[14px] border border-dashed border-[#3A4E64] bg-[#121A23] p-6">
          <div className="flex items-center gap-2 font-semibold">
            <span className="sd-glow h-2.5 w-2.5 rounded-full bg-[#A99BFF]" />
            Esperando el primer gateway LoRa directo…
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-[#B4C2D0]">
            <li>El Agente Go de esta sede escucha en UDP {site.loraDirect.port} (protocolo Semtech UDP de los gateways).</li>
            <li>
              En el gateway (Advantech: <em>LoRaWAN RF → Radio Setting</em>) cambia <strong>Network Server</strong> por la IP de la máquina del agente;
              puertos de subida y bajada {site.loraDirect.port}.
            </li>
            <li>En cuanto el gateway envíe su primer paquete aparecerá aquí, junto con cada dispositivo que escuche por radio.</li>
          </ol>
          <p className="text-xs text-[#7D8FA1]">
            Sin llaves, cada sensor se ve como “escuchado por radio” (DevAddr, señal, contador). Con sus llaves cargadas en el agente se descifran sus métricas.
          </p>
        </section>
      )}

      {(site.model || real.length > 0 || site.loraDirect) && (
        <>
          <div role="tablist" aria-label="Vista de la sede" className="flex flex-wrap gap-1 self-start rounded-[14px] border border-[#243243] bg-[#0E151D] p-1">
            {(
              [
                { key: "energia", label: "Energía · Modbus", sub: `${energy.length} equipos · EBO AS-P` },
                {
                  key: "lora",
                  label: site.loraDirect ? "Sensores LoRaWAN · directo" : "Sensores LoRaWAN · MQTT",
                  sub: site.loraDirect ? `${lora.length} dispositivos · ${gateways.length} gateway(s)` : `${lora.length} sensores · ChirpStack`,
                },
                { key: "eventos", label: "Eventos", sub: `${total24h} en 24 h${critical24h ? ` · ${critical24h} crítico(s)` : ""}` },
              ] as const
            ).map((t) => {
              const on = view === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setView(t.key)}
                  className={`relative flex min-h-[52px] flex-col items-start gap-0.5 rounded-[10px] px-[18px] py-2 text-left ${
                    on ? "bg-[#1D2B3A] text-[#E6EDF3] shadow-[inset_0_-2px_0_#5B9BFF]" : "text-[#B4C2D0] hover:text-[#E6EDF3]"
                  }`}
                >
                  {t.key === "eventos" && critical24h > 0 && (
                    <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-[#FF8A7A]" aria-hidden="true" />
                  )}
                  <span className="font-semibold">{t.label}</span>
                  <span className={`text-xs ${on ? "text-[#B4C2D0]" : "text-[#7D8FA1]"}`}>{t.sub}</span>
                </button>
              );
            })}
          </div>

          {view === "energia" && (
            <div className="flex flex-col gap-5">
              {onGenerator && (
                <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-[#7A4A12] bg-[#2A1A08] px-4 py-3.5 text-[#FFD9A3]">
                  <strong className="text-[#FFE7C4]">Corte de energía comercial detectado.</strong>
                  <span>
                    El ATS transfirió {ions.filter((d) => ionSource(d) === "Generador").map((d) => d.name).join(" y ")} a generador.
                    {running > 0 ? ` ${running} generador(es) operando.` : ""}
                  </span>
                </div>
              )}

              <section aria-label="Resumen de energía" className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
                <Kpi label="Fuente de energía activa" value={sources.length ? (onGenerator ? "Generador" : "Comercial") : "—"} color={onGenerator ? "#F2A33A" : "#8FB8FF"} />
                <Kpi label="Potencia activa medida" value={fmt(totalKw, 1)} unit="kW" />
                <Kpi label="Equipos eléctricos en línea" value={String(energy.filter((d) => d.online).length)} unit={`/ ${energy.length}`} />
                <Kpi label="Generadores" value={gens.length ? `${running} operando` : "—"} unit={gens.length ? `/ ${gens.length}` : undefined} />
              </section>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-4">
                  <div role="group" aria-label="Filtrar por tipo" className="flex flex-wrap gap-2">
                    <Chip on={filter === "all"} onClick={() => setFilter("all")}>
                      Todos <span className="sd-num opacity-75">{energy.length}</span>
                    </Chip>
                    <Chip on={filter === "gen"} onClick={() => setFilter("gen")}>
                      Generadores <span className="sd-num opacity-75">{gens.length}</span>
                    </Chip>
                    <Chip on={filter === "ion"} onClick={() => setFilter("ion")}>
                      ION7400 <span className="sd-num opacity-75">{ions.length}</span>
                    </Chip>
                    <Chip on={filter === "pm"} onClick={() => setFilter("pm")}>
                      PM2130 <span className="sd-num opacity-75">{pms.length}</span>
                    </Chip>
                  </div>
                  <div role="group" aria-label="Tamaño de tarjetas" className="flex gap-[3px] rounded-xl border border-[#243243] bg-[#0E151D] p-[3px]">
                    {[false, true].map((c) => (
                      <button
                        key={String(c)}
                        type="button"
                        aria-pressed={compact === c}
                        onClick={() => setCompact(c)}
                        className={`min-h-[36px] rounded-[9px] px-3.5 py-1.5 text-sm ${compact === c ? "bg-[#2C3D50] font-semibold text-[#E6EDF3]" : "text-[#93A4B5]"}`}
                      >
                        {c ? "Compacto" : "Normal"}
                      </button>
                    ))}
                  </div>
                </div>
                {demo && (
                  <button
                    type="button"
                    onClick={() => setOutage((o) => !o)}
                    className={`min-h-[40px] rounded-[10px] border px-4 py-2 text-sm font-semibold ${
                      outage ? "border-[#2C3D50] bg-[#182330] text-[#E6EDF3]" : "border-[#7A4A12] bg-[#2A1E0C] text-[#FFC979]"
                    }`}
                  >
                    {outage ? "Restablecer energía comercial" : "Simular corte comercial"}
                  </button>
                )}
              </div>

              {(filter === "all" || filter === "gen") && gens.length > 0 && (
                <section aria-label="Generadores" className="flex flex-col gap-3">
                  <SectionTitle title="Generación" />
                  <div className={`grid gap-3 ${genGrid}`}>
                    {gens.map((d) => (
                      <GeneratorCard key={d.id} d={d} compact={compact} onTrend={(x) => setTrendId(x.id)} />
                    ))}
                  </div>
                </section>
              )}
              {(filter === "all" || filter === "ion") && ions.length > 0 && (
                <section aria-label="Analizadores ION7400" className="flex flex-col gap-3">
                  <SectionTitle title="Analizadores de red · ION7400" />
                  <div className={`grid gap-3 ${ionGrid}`}>
                    {ions.map((d) => (
                      <IonCard key={d.id} d={d} compact={compact} onTrend={(x) => setTrendId(x.id)} />
                    ))}
                  </div>
                </section>
              )}
              {(filter === "all" || filter === "pm") && pms.length > 0 && (
                <section aria-label="Medidores PM2130" className="flex flex-col gap-3">
                  <SectionTitle title="Medidores de circuito · PM2130" />
                  <div className={`grid gap-3 ${pmGrid}`}>
                    {pms.map((d) => (
                      <PmCard key={d.id} d={d} compact={compact} onTrend={(x) => setTrendId(x.id)} />
                    ))}
                  </div>
                </section>
              )}
              {energy.length === 0 && (
                <div className="rounded-[14px] border border-dashed border-[#2C3D50] bg-[#121A23] p-8 text-center text-[#93A4B5]">
                  El Agente Go todavía no reportó equipos Modbus de esta sede.
                </div>
              )}
            </div>
          )}

          {view === "lora" && (
            <div className="flex flex-col gap-5">
              <section aria-label="Resumen LoRaWAN" className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
                <Kpi label="Sensores en línea" value={String(lora.filter((d) => d.online).length)} unit={`/ ${lora.length}`} />
                <Kpi label="Puertas abiertas ahora" value={String(openDoors)} unit={`/ ${doors.length}`} color={openDoors > 0 ? "#FFC979" : undefined} />
                <Kpi label="Batería baja (< 20 %)" value={String(lowBatt)} color={lowBatt > 0 ? "#FF8A5C" : undefined} />
                <Kpi label={site.loraDirect ? "Última trama de radio" : "Último uplink MQTT"} value={agoText(feed[0] ? uplinkAt(feed[0]) : null, nowMs)} />
              </section>

              <div className="flex flex-wrap items-start gap-5">
                <div className="flex min-w-0 flex-[999_1_720px] flex-col gap-6">
                  <div role="group" aria-label="Filtrar sensores" className="flex flex-wrap gap-2">
                    {(
                      [
                        ["all", "Todos", lora.length],
                        ["door", "Puertas · LEO S595", doors.length],
                        ["env", "Temp/Hum · EVA", envs.length],
                        ["wise", "Cadena de frío · WISE", wises.length],
                        ["air", "Calidad de aire · LEO S592", airs.length],
                        ...(others.length + radios.length ? [["lora", "Otros / por radio", others.length + radios.length] as const] : []),
                      ] as const
                    ).map(([k, label, count]) => (
                      <Chip key={k} on={loraFilter === k} onClick={() => setLoraFilter(k as LoraFilter)}>
                        {label} <span className="sd-num opacity-75">{count}</span>
                      </Chip>
                    ))}
                  </div>

                  {gateways.length > 0 && (
                    <section aria-label="Gateways LoRa" className="flex flex-col gap-3">
                      <SectionTitle title="Gateways LoRa · conexión directa" hint="Semtech UDP al Agente Go, sin ChirpStack ni broker intermedio" />
                      <div className={`grid gap-3 ${loraGrid}`}>
                        {gateways.map((d) => (
                          <GatewayCard key={d.id} d={d} onTrend={(x) => setTrendId(x.id)} />
                        ))}
                      </div>
                    </section>
                  )}
                  {(loraFilter === "all" || loraFilter === "lora") && radios.length > 0 && (
                    <section aria-label="Escuchados por radio" className="flex flex-col gap-3">
                      <SectionTitle
                        title="Escuchados por radio · sin llaves"
                        hint="El agente ve que existen, su señal y su contador; con sus llaves cargadas se descifran sus métricas"
                      />
                      <RadioTable devices={radios} onTrend={(x) => setTrendId(x.id)} />
                    </section>
                  )}
                  {(loraFilter === "all" || loraFilter === "door") && doors.length > 0 && (
                    <section aria-label="Puertas" className="flex flex-col gap-3">
                      <SectionTitle title="Puertas · LEO S595" hint="Sensor magnético: abierta / cerrada, batería y sabotaje" />
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5">
                        {doors.map((d) => (
                          <DoorTile key={d.id} d={d} onTrend={(x) => setTrendId(x.id)} />
                        ))}
                      </div>
                    </section>
                  )}
                  {(loraFilter === "all" || loraFilter === "env") && envs.length > 0 && (
                    <section aria-label="Temperatura y humedad" className="flex flex-col gap-3">
                      <SectionTitle title="Temperatura y humedad · EVA" hint="El anillo se pone naranja fuera de 18–26 °C" />
                      <div className={`grid gap-3 ${loraGrid}`}>
                        {envs.map((d) => (
                          <EnvCard key={d.id} d={d} onTrend={(x) => setTrendId(x.id)} />
                        ))}
                      </div>
                    </section>
                  )}
                  {(loraFilter === "all" || loraFilter === "wise") && wises.length > 0 && (
                    <section aria-label="Entradas analógicas WISE" className="flex flex-col gap-3">
                      <SectionTitle title="Cadena de frío · WISE S617 / S614T" hint="Refrigeradores y congeladores: °C convertidos por el Agente Go desde 4–20 mA, con su rango permitido" />
                      <div className={`grid gap-3 ${loraGrid}`}>
                        {wises.map((d) => (
                          <WiseCard key={d.id} d={d} onTrend={(x) => setTrendId(x.id)} />
                        ))}
                      </div>
                    </section>
                  )}
                  {(loraFilter === "all" || loraFilter === "air") && airs.length > 0 && (
                    <section aria-label="Calidad de aire" className="flex flex-col gap-3">
                      <SectionTitle title="Calidad de aire · LEO S592" hint="El anillo se pone naranja con CO₂ sobre 1000 ppm" />
                      <div className={`grid gap-3 ${loraGrid}`}>
                        {airs.map((d) => (
                          <AirCard key={d.id} d={d} onTrend={(x) => setTrendId(x.id)} />
                        ))}
                      </div>
                    </section>
                  )}
                  {(loraFilter === "all" || loraFilter === "lora") && others.length > 0 && (
                    <section aria-label="Otros sensores" className="flex flex-col gap-3">
                      <SectionTitle title="Otros sensores LoRaWAN" />
                      <div className={`grid gap-3 ${loraGrid}`}>
                        {others.map((d) => (
                          <LoraCard key={d.id} d={d} onTrend={(x) => setTrendId(x.id)} />
                        ))}
                      </div>
                    </section>
                  )}
                  {lora.length === 0 && (
                    <div className="rounded-[14px] border border-dashed border-[#2C3D50] bg-[#121A23] p-8 text-center text-[#93A4B5]">
                      El Agente Go todavía no recibió uplinks LoRaWAN de esta sede.
                    </div>
                  )}
                </div>

                <aside aria-label="Uplinks MQTT en vivo" className="flex min-w-0 flex-[1_1_340px] flex-col gap-3 rounded-2xl border border-[#243243] bg-[#121A23] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-bold">{site.loraDirect ? "Tramas de radio en vivo" : "Uplinks MQTT en vivo"}</div>
                    <span className="inline-flex items-center gap-1.5 text-xs text-[#8FE0B5]">
                      <span className="sd-glow h-2 w-2 rounded-full bg-[#4CC38A]" />
                      suscrito
                    </span>
                  </div>
                  <div className="sd-num break-all rounded-lg bg-[#0E151D] px-2.5 py-2 text-[11px] text-[#93A4B5]">
                    {site.loraDirect ? `Gateways → Agente Go · UDP ${site.loraDirect.port}` : "application/+/device/+/event/up"}
                  </div>
                  <div aria-live="polite" className="flex flex-col gap-2">
                    {feed.map((d, k) => (
                      <div key={`${d.id}-${uplinkAt(d)}`} className={`flex flex-col gap-0.5 rounded-[10px] bg-[#0E151D] px-2.5 py-2 ${k === 0 ? "sd-feed-new" : ""}`}>
                        <div className="flex justify-between gap-2 text-[13px]">
                          <span className="truncate font-semibold">{d.name}</span>
                          <span className="sd-num shrink-0 text-[11px] text-[#93A4B5]">
                            {uplinkAt(d) ? new Date(uplinkAt(d)).toLocaleTimeString("es-GT", { hour12: false }) : ""}
                          </span>
                        </div>
                        <div className="truncate text-xs text-[#B4C2D0]">
                          {d.model || "LoRaWAN"} · {payloadSummary(d)}
                        </div>
                        <div className="sd-num text-[11px] text-[#7D8FA1]">
                          devEui {str(d.attrs.devEui) || "—"} · fCnt {str(d.attrs.fCnt) || "—"} · RSSI {d.attrs.rssi != null ? `${str(d.attrs.rssi)} dBm` : "—"} · SNR{" "}
                          {d.attrs.snr != null ? `${str(d.attrs.snr)} dB` : "—"}
                        </div>
                      </div>
                    ))}
                    {feed.length === 0 && <div className="text-sm text-[#93A4B5]">Esperando uplinks…</div>}
                  </div>
                </aside>
              </div>
            </div>
          )}
          {view === "eventos" && (
            <SiteEventsPanel buildingKey={site.buildingKey} demoEvents={demoEventList} onOpenDevice={(id) => setTrendId(id)} />
          )}
        </>
      )}

      {trendDevice && (
        <SedeTrendModal
          device={trendDevice}
          buildingKey={site.buildingKey}
          outage={outage}
          tick={tick}
          demoEvents={demoEventList}
          onClose={() => setTrendId(null)}
        />
      )}
    </div>
  );
}
