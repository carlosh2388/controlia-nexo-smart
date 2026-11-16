import { useEffect, useMemo, useState } from "react";
import {
  useAgentConfig,
  useAgents,
  useAgentScan,
  useRequestScan,
  useSaveAgentConfig,
  type AgentProtocols,
  type ModbusServerConfig,
  type ScanIdentity,
} from "../api/agents";
import { useAccess } from "../api/access";
import { INDICADORES, NORMA_TXT, useGuardarUmbrales, useProbarLectura, useUmbrales, type Limites, type Norma } from "../api/calidad";
import { usePilotDevices, useSaveDirectConnection, type PilotDevice } from "../api/pilot";
import { extractErrorMessage } from "../api/errors";
import AgentDevices from "./AgentDevices";
import AgentConfig from "./AgentConfig";

/**
 * Pestaña "Equipos" (mockup aprobado "Gestión de equipos"): reemplaza a "Agente Go" y
 * "Configuración". Descubrir y agregar (el agente identifica ION7400 / PM2130 / generador),
 * topología en vivo, configuración por equipo (conexión, prueba de lectura, registros, umbrales)
 * y los agentes. Todo lo que toca un medidor real es solo lectura (función 03).
 */

type Seccion = "descubrir" | "topologia" | "config" | "agentes";

const MODELO_TXT: Record<string, string> = { ION7400: "Analizador ION7400", PM2130: "Medidor PM2130", generator: "Controlador de generador", "": "No identificado" };
const PERFIL_DE: Record<string, string> = { ION7400: "ion7400-directo", PM2130: "pm2130-directo", generator: "generador-directo" };

function perfilDe(d: PilotDevice | null | undefined) {
  const m = `${d?.model ?? ""} ${d?.name ?? ""}`.toLowerCase();
  if (m.includes("2130")) return "pm2130-directo";
  if (m.includes("gen")) return "generador-directo";
  return "ion7400-directo";
}

function servidores(c: AgentProtocols | undefined): ModbusServerConfig[] {
  if (!c) return [];
  if (c.modbusServers?.length) return c.modbusServers;
  return c.modbus ? [c.modbus] : [];
}

function hace(s: string | null) {
  if (!s) return "sin datos";
  const seg = Math.max(0, Math.round((Date.now() - new Date(s).getTime()) / 1000));
  return seg < 60 ? `hace ${seg} s` : seg < 3600 ? `hace ${Math.round(seg / 60)} min` : `hace ${Math.round(seg / 3600)} h`;
}

export default function Equipos() {
  const [sec, setSec] = useState<Seccion>("descubrir");
  const agentsQ = useAgents();
  const agents = agentsQ.data ?? [];
  const [bk, setBk] = useState<string | null>(null);
  useEffect(() => {
    if (!bk && agents.length) setBk((agents.find((a) => a.buildingKey.endsWith("-directo")) ?? agents.find((a) => a.hasConfig) ?? agents[0]).buildingKey);
  }, [agents, bk]);
  const agent = agents.find((a) => a.buildingKey === bk) ?? null;

  const tabs: [Seccion, string][] = [["descubrir", "Descubrir y agregar"], ["topologia", "Topología en vivo"], ["config", "Configuración"], ["agentes", "Agentes"]];

  return (
    <div className="flex flex-col gap-4 pb-16">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Equipos" className="flex w-fit flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
          {tabs.map(([k, t]) => (
            <button key={k} type="button" role="tab" aria-selected={sec === k} onClick={() => setSec(k)} className={`min-h-[36px] rounded-lg px-3.5 text-[13px] font-bold ${sec === k ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}>{t}</button>
          ))}
        </div>
        {sec !== "agentes" && (
          <label className="flex items-center gap-2 text-sm text-slate-400">
            Agente
            <select value={bk ?? ""} onChange={(e) => setBk(e.target.value)} className="min-h-[38px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100">
              {agents.map((a) => <option key={a.buildingKey} value={a.buildingKey}>{a.buildingKey}{a.lastSync?.agentVersion ? ` · v${a.lastSync.agentVersion}` : ""}</option>)}
            </select>
          </label>
        )}
      </div>
      {agentsQ.isLoading && <p className="py-8 text-center text-sm text-slate-500">Cargando agentes…</p>}
      {sec === "descubrir" && bk && <Descubrir bk={bk} remoto={!!agent?.hasConfig} />}
      {sec === "topologia" && bk && <Topologia bk={bk} remoto={!!agent?.hasConfig} />}
      {sec === "config" && bk && <Configuracion bk={bk} />}
      {sec === "agentes" && (
        <div className="flex flex-col gap-8">
          <AgentDevices />
          <div className="border-t border-slate-800 pt-6"><AgentConfig /></div>
        </div>
      )}
    </div>
  );
}

/* ================= descubrir y agregar ================= */
function Descubrir({ bk, remoto }: { bk: string; remoto: boolean }) {
  const access = useAccess();
  const role = access.data?.role;
  const puedeBuscar = role === "admin" || role === "operator";
  const puedeAgregar = role === "admin";
  const [targets, setTargets] = useState("");
  const [unitIds, setUnitIds] = useState("1,2,21,255");
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  const scanQ = useAgentScan(remoto ? bk : null);
  const pedir = useRequestScan();
  const cfgQ = useAgentConfig(remoto ? bk : null);
  const guardar = useSaveAgentConfig();
  const scan = scanQ.data;
  const corriendo = scan?.status === "pending" || scan?.status === "running";
  const ya = useMemo(() => new Set(servidores(cfgQ.data?.config).map((s) => `${s.host}#${s.unitId ?? 1}`)), [cfgQ.data]);
  const [nombres, setNombres] = useState<Record<string, string>>({});

  const encontrados = (scan?.results ?? []).filter((r) => r.protocol === "modbus" && r.status === "ok");
  const filas = encontrados.flatMap((r) => (r.devices?.length ? r.devices : (r.unitIds ?? []).map((u): ScanIdentity => ({ unitId: u, model: "", confidence: 0, evidence: "agente anterior a 0.5.3: sin identificación" }))).map((d) => ({ host: r.host, port: r.port, d })));

  function buscar() {
    const ts = targets.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!ts.length) return setMsg({ t: "Escriba una IP, un rango (10.0.6.9-10.0.6.24) o una red (10.0.6.0/24).", ok: false });
    setMsg(null);
    pedir.mutate({ buildingKey: bk, items: [{ protocol: "modbus", targets: ts, port: 502, unitIds }] }, { onError: (e) => setMsg({ t: extractErrorMessage(e, "No se pudo pedir la búsqueda"), ok: false }) });
  }

  function agregar(host: string, port: number, d: ScanIdentity) {
    const base = cfgQ.data;
    if (!base) return;
    const perfil = d.profile || PERFIL_DE[d.model];
    if (!perfil) return setMsg({ t: "Equipo no identificado: agréguelo a mano en Agentes → configuración.", ok: false });
    const clave = `${host}#${d.unitId}`;
    const nombre = (nombres[clave] ?? d.name ?? "").trim() || `${d.model || "Equipo"} ${host} ID ${d.unitId}`;
    const nuevo: ModbusServerConfig = {
      enabled: true, name: nombre, host, port, unitId: d.unitId, pollIntervalSeconds: 15, timeoutMs: 3000, readDelayMs: 100,
      devices: [{ name: nombre, profile: perfil, start: 0, attributes: { model: d.model, identificadoPor: "agente", confianza: d.confidence } }],
    };
    const config: AgentProtocols = { ...base.config, modbus: null, modbusServers: [...servidores(base.config), nuevo] };
    guardar.mutate(
      { buildingKey: bk, config, baseVersion: base.version },
      {
        onSuccess: (r) => setMsg({ t: `"${nombre}" agregado (configuración v${r.version}). El agente empieza a leerlo en unos segundos.`, ok: true }),
        onError: (e) => setMsg({ t: extractErrorMessage(e, "No se pudo guardar"), ok: false }),
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="panel flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Descubrir y agregar</span>
          <h2 className="text-xl font-bold text-slate-50">El agente busca en la red de la sede y reconoce cada equipo</h2>
          <p className="max-w-3xl text-sm text-slate-400">Pregunta por Modbus TCP (solo lectura, función 03) en cada IP e ID. Reconoce el ION7400 porque acepta bloques grandes y trae su nombre, el PM2130 porque rechaza bloques con registros vacíos, y el generador por su bloque 4770 con voltaje de batería. No escribe nada en los equipos.</p>
        </div>
        {!remoto ? (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-100">Este agente usa solo su config.yaml (sin configuración remota), así que no recibe pedidos de búsqueda. Elija un agente con configuración remota o actívela en el servidor de la sede.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-[260px] flex-1 flex-col gap-1 text-xs text-slate-400">Dónde buscar
              <input value={targets} onChange={(e) => setTargets(e.target.value)} placeholder="10.0.6.9-10.0.6.24" className="min-h-[40px] rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100" />
            </label>
            <label className="flex w-40 flex-col gap-1 text-xs text-slate-400">IDs Modbus
              <input value={unitIds} onChange={(e) => setUnitIds(e.target.value)} className="mono min-h-[40px] rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100" />
            </label>
            <button type="button" disabled={!puedeBuscar || corriendo || pedir.isPending} onClick={buscar} className="min-h-[40px] rounded-lg bg-sky-600 px-4 text-sm font-bold text-white disabled:opacity-50">{corriendo ? "Buscando…" : "Buscar equipos"}</button>
          </div>
        )}
        {scan?.progress && corriendo && (
          <p className="mono text-xs text-slate-400">{Object.entries(scan.progress).map(([k, p]) => `${k}: ${p.done}/${p.total}`).join(" · ")}</p>
        )}
        {scan?.status === "error" && <p className="text-sm text-rose-300">{scan.error}</p>}
        {msg && <p className={`text-sm ${msg.ok ? "text-emerald-300" : "text-rose-300"}`} role="status">{msg.t}</p>}
      </section>

      {remoto && scan && (
        <section className="panel flex flex-col gap-2 p-4">
          <span className="eyebrow">Resultado · {new Date(scan.requestedAt).toLocaleString("es-GT")} · {filas.length} equipo(s)</span>
          {!filas.length && !corriendo && <p className="py-4 text-center text-sm text-slate-500">No respondió ningún equipo Modbus en esas direcciones.</p>}
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
            {filas.map(({ host, port, d }) => {
              const clave = `${host}#${d.unitId}`;
              const instalado = ya.has(clave);
              const color = d.model === "ION7400" ? "text-sky-300" : d.model === "PM2130" ? "text-emerald-300" : d.model === "generator" ? "text-amber-300" : "text-slate-400";
              return (
                <div key={clave} className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <b className={`block text-sm ${color}`}>{MODELO_TXT[d.model] ?? d.model}</b>
                      <span className="mono text-xs text-slate-400">{host} · ID {d.unitId}</span>
                    </div>
                    {d.confidence > 0 && <span className="mono rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-200" title="Qué tan seguro está el agente">{d.confidence} %</span>}
                  </div>
                  <small className="text-xs text-slate-400">{d.evidence}</small>
                  {instalado ? (
                    <span className="text-xs font-semibold text-emerald-300">Ya está en la configuración del agente</span>
                  ) : (
                    <div className="flex gap-2">
                      <input aria-label="Nombre del equipo" value={nombres[clave] ?? d.name ?? ""} onChange={(e) => setNombres({ ...nombres, [clave]: e.target.value })} placeholder="Nombre (ej. ANALIZADOR-7)" className="min-h-[36px] min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm text-slate-100" />
                      <button type="button" disabled={!puedeAgregar || !d.model || guardar.isPending || !cfgQ.data} onClick={() => agregar(host, port, d)} title={puedeAgregar ? "" : "Solo un administrador cambia la configuración del agente"} className="min-h-[36px] rounded-lg border border-sky-700 px-3 text-sm font-bold text-sky-200 hover:bg-sky-950 disabled:opacity-40">Agregar</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/* ================= topologia ================= */
function Topologia({ bk, remoto }: { bk: string; remoto: boolean }) {
  const cfgQ = useAgentConfig(remoto ? bk : null);
  const pilot = usePilotDevices(bk);
  const devs = pilot.data?.devices ?? [];
  const porNombre = new Map(devs.map((d) => [d.name, d]));
  const servs = servidores(cfgQ.data?.config).filter((s) => s.enabled !== false);

  // Una caja por IP: el equipo con ID 255 (o el primero) es el que tiene la IP; los demás cuelgan del cable RS-485.
  const porIp = new Map<string, ModbusServerConfig[]>();
  for (const s of servs) porIp.set(s.host, [...(porIp.get(s.host) ?? []), s]);
  for (const l of porIp.values()) l.sort((a, b) => (b.unitId === 255 ? 1 : 0) - (a.unitId === 255 ? 1 : 0));
  // Sin configuración remota: se arma con la conexión directa guardada de cada equipo.
  const sinCfg = !servs.length ? devs.filter((d) => d.directConnection?.ip) : [];
  for (const d of sinCfg) {
    const c = d.directConnection!;
    porIp.set(c.ip, [...(porIp.get(c.ip) ?? []), { enabled: true, name: d.name, host: c.ip, port: c.port, unitId: c.unitId ?? 1, devices: [{ name: d.name, profile: perfilDe(d), start: 0 }] }]);
  }

  function Nodo({ s, sub }: { s: ModbusServerConfig; sub: boolean }) {
    const nombre = s.devices?.[0]?.name ?? s.name ?? s.host;
    const d = porNombre.get(nombre);
    const vivo = d?.updatedAt && Date.now() - new Date(d.updatedAt).getTime() < 120_000;
    const r = d?.readings ?? {};
    const num = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : null);
    const dato = num("active_power_total") != null ? `${num("active_power_total")!.toFixed(1)} kW` : num("battery_voltage_metering") != null ? `Batería ${num("battery_voltage_metering")!.toFixed(1)} V` : num("voltage_a_n") != null ? `${num("voltage_a_n")!.toFixed(1)} V` : "—";
    return (
      <div className={`flex items-center gap-3 rounded-xl border p-3 ${sub ? "ml-6 border-slate-800 bg-slate-950/40" : "border-slate-700 bg-slate-950/70"}`}>
        <span className={`h-2.5 w-2.5 flex-none rounded-full ${vivo ? "latido bg-emerald-400" : d ? "bg-amber-400" : "bg-slate-600"}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <b className="block truncate text-sm text-slate-100">{nombre}</b>
          <span className="mono text-[11px] text-slate-400">{sub ? `por RS-485 · ID ${s.unitId}` : `${s.host}:${s.port ?? 502} · ID ${s.unitId ?? 1}`} · {s.devices?.[0]?.profile ?? "perfil EBO"}</span>
        </div>
        <div className="text-right">
          <b className="mono block text-sm text-slate-100">{dato}</b>
          <small className={`text-[11px] ${vivo ? "text-emerald-300" : "text-amber-300"}`}>{d ? hace(d.updatedAt) : "sin lecturas"}</small>
        </div>
      </div>
    );
  }

  return (
    <section className="panel flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <span className="eyebrow">Topología en vivo · {bk}</span>
        <p className="text-sm text-slate-400">Cada caja es una IP en la red de la sede. Los equipos con sangría no tienen IP propia: el agente los lee a través del cable RS-485 del equipo de arriba (mismo IP, otro ID Modbus).</p>
      </div>
      {(cfgQ.isLoading || pilot.isLoading) && <p className="py-6 text-center text-sm text-slate-500">Cargando…</p>}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
        {[...porIp.entries()].map(([ip, l]) => (
          <div key={ip} className="flex flex-col gap-2 rounded-2xl border border-slate-800 p-2.5">
            {l.map((s, i) => <Nodo key={`${s.host}-${s.unitId}-${i}`} s={s} sub={i > 0} />)}
          </div>
        ))}
      </div>
      {!porIp.size && !cfgQ.isLoading && <p className="py-6 text-center text-sm text-slate-500">Este agente no tiene equipos Modbus de lectura directa configurados.</p>}
    </section>
  );
}

/* ================= configuracion por equipo ================= */
const MAPA: Record<string, { r: string; v: string; t: string }[]> = {
  "ion7400-directo": [
    { r: "3000-3005", v: "Corriente A, B, C", t: "float32" }, { r: "3020-3033", v: "Voltajes L-L y L-N", t: "float32" },
    { r: "3054-3061", v: "Potencia activa por fase y total (W → kW)", t: "float32" }, { r: "3070-3077", v: "Potencia aparente (VA → kVA)", t: "float32" },
    { r: "3110", v: "Frecuencia", t: "float32" }, { r: "3144-3151", v: "Factor de potencia", t: "float32" },
    { r: "21300-21335", v: "THD de corriente y tensión", t: "float32 ×100" }, { r: "34649-34654", v: "Flicker Pst A/B/C", t: "float32" },
    { r: "30112, 30450-30479", v: "Demanda pico", t: "float32" }, { r: "411-414", v: "Estado comercial / generador y transferencias", t: "entero 16" },
  ],
  "pm2130-directo": [
    { r: "3000-3011", v: "Corrientes y promedio", t: "float32" }, { r: "3020-3037", v: "Voltajes L-L, L-N y promedios", t: "float32" },
    { r: "3054-3085", v: "Potencias activa, reactiva, aparente y FP", t: "float32" }, { r: "3110", v: "Frecuencia", t: "float32" },
    { r: "3204-3243", v: "Energías kWh, kVArh, kVAh", t: "int64" }, { r: "3764", v: "Demanda total", t: "float32" },
    { r: "21300-21338", v: "THD", t: "float32" },
  ],
  "generador-directo": [
    { r: "4770-4785", v: "kVA y kW por fase y total", t: "int32 CDAB" }, { r: "4786", v: "Factor de potencia", t: "float32 CDAB" },
    { r: "4790-4797", v: "Frecuencias, fuente de velocidad, RPM", t: "int32 CDAB" }, { r: "4798", v: "Carga del motor %", t: "int32 CDAB" },
    { r: "4800", v: "Temperatura del refrigerante", t: "int32 ×0.1 °C" }, { r: "4802", v: "Presión de aceite", t: "int32 CDAB" },
    { r: "4804", v: "Voltaje de batería", t: "int32 ×0.1 V" }, { r: "4806", v: "Nivel de combustible", t: "int32 CDAB" },
  ],
};

function Configuracion({ bk }: { bk: string }) {
  const access = useAccess();
  const puede = (access.data?.role === "admin" || access.data?.role === "operator") && !!access.data?.actions.includes("agentes");
  const pilot = usePilotDevices(bk);
  const devs = pilot.data?.devices ?? [];
  const [id, setId] = useState<string | null>(null);
  const dev = devs.find((d) => d.id === id) ?? devs[0] ?? null;
  const perfil = perfilDe(dev);

  const [f, setF] = useState({ ip: "", port: 502, unitId: 1, intervalSeconds: 15, enabled: true, compareWithAsp: true });
  useEffect(() => {
    const c = dev?.directConnection;
    setF({ ip: c?.ip ?? "", port: c?.port ?? 502, unitId: c?.unitId ?? 1, intervalSeconds: c?.intervalSeconds ?? 15, enabled: c?.enabled ?? true, compareWithAsp: c?.compareWithAsp ?? true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dev?.id]);
  const guardarCon = useSaveDirectConnection();
  const probar = useProbarLectura();
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);

  const umb = useUmbrales(dev?.id ?? null);
  const guardarUmb = useGuardarUmbrales();
  const [norma, setNorma] = useState<Norma>("ntsd");
  const [lim, setLim] = useState<Limites | null>(null);
  useEffect(() => {
    if (umb.data) { setNorma(umb.data.norma); setLim(umb.data.limites); }
  }, [umb.data]);

  const campo = "min-h-[38px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100";

  return (
    <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
      <nav aria-label="Equipos del agente" className="panel flex max-h-[70vh] flex-col gap-1 overflow-y-auto p-2">
        {devs.map((d) => (
          <button key={d.id} type="button" onClick={() => { setId(d.id); setMsg(null); probar.reset(); }} aria-current={dev?.id === d.id ? "true" : undefined} className={`flex min-h-[40px] items-center justify-between rounded-lg px-3 text-left text-sm ${dev?.id === d.id ? "bg-sky-600 text-white" : "text-slate-200 hover:bg-slate-800"}`}>
            <span className="truncate">{d.name}</span>
            <small className="mono text-[10px] opacity-70">{d.directConnection?.ip ? `ID ${d.directConnection.unitId ?? "—"}` : ""}</small>
          </button>
        ))}
        {!devs.length && <p className="p-3 text-sm text-slate-500">Este agente no tiene equipos de energía.</p>}
      </nav>

      {dev && (
        <div className="flex flex-col gap-4">
          <section className="panel flex flex-col gap-3 p-4">
            <span className="eyebrow">Conexión · {dev.name} · perfil {perfil}</span>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
              <label className="flex flex-col gap-1 text-xs text-slate-400">IP<input className={`${campo} mono`} value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value.trim() })} placeholder="10.0.6.9" /></label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">Puerto<input type="number" className={`${campo} mono`} value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} /></label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">ID Modbus<input type="number" min={0} max={255} className={`${campo} mono`} value={f.unitId} onChange={(e) => setF({ ...f, unitId: Number(e.target.value) })} /></label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">Intervalo (s)<input type="number" min={5} className={`${campo} mono`} value={f.intervalSeconds} onChange={(e) => setF({ ...f, intervalSeconds: Number(e.target.value) })} /></label>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-300">
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Lectura directa activa</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.compareWithAsp} onChange={(e) => setF({ ...f, compareWithAsp: e.target.checked })} /> Comparar con el AS-P</label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={!f.ip || probar.isPending || !puede} onClick={() => probar.mutate({ deviceId: dev.id, ip: f.ip, port: f.port, unitId: f.unitId, perfil })} className="min-h-[38px] rounded-lg border border-slate-600 px-4 text-sm font-bold text-slate-100 hover:bg-slate-800 disabled:opacity-40">{probar.isPending ? "Leyendo…" : "Probar lectura"}</button>
              <button
                type="button"
                disabled={!f.ip || guardarCon.isPending || !puede}
                onClick={() => guardarCon.mutate({ deviceId: dev.id, connection: { ...f, viaDeviceId: dev.directConnection?.viaDeviceId ?? null } }, { onSuccess: () => setMsg({ t: "Conexión guardada.", ok: true }), onError: (e) => setMsg({ t: extractErrorMessage(e, "No se pudo guardar"), ok: false }) })}
                className="min-h-[38px] rounded-lg bg-sky-600 px-4 text-sm font-bold text-white disabled:opacity-40"
              >Guardar conexión</button>
              {!puede && <small className="text-xs text-slate-500">Su perfil no tiene el permiso "Configurar agentes y equipos".</small>}
              {msg && <small className={`text-sm ${msg.ok ? "text-emerald-300" : "text-rose-300"}`}>{msg.t}</small>}
            </div>
            {probar.data && (
              <div className={`rounded-xl border p-3 text-sm ${probar.data.ok && probar.data.valido ? "border-emerald-900 bg-emerald-950/30 text-emerald-100" : "border-rose-900 bg-rose-950/30 text-rose-100"}`} role="status">
                {probar.data.ok ? (
                  <>Respondió en <b className="mono">{probar.data.ms} ms</b> (función {probar.data.funcion}): {Object.entries(probar.data.valores ?? {}).map(([k, v]) => `${k.replace(/_/g, " ")} = ${v ?? "sin valor"}`).join(" · ")}{probar.data.valido ? "." : " — los valores no parecen de este tipo de equipo; revise el ID o el perfil."}</>
                ) : (
                  <>No respondió: {probar.data.error}</>
                )}
              </div>
            )}
            {probar.isError && <p className="text-sm text-rose-300">{extractErrorMessage(probar.error)}</p>}
          </section>

          <div className="grid gap-4 2xl:grid-cols-2">
            <section className="panel flex flex-col gap-2 p-4">
              <span className="eyebrow">Mapa de registros · {perfil}</span>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-500"><th className="py-1.5">Registro</th><th>Variable</th><th>Formato</th></tr></thead>
                  <tbody>
                    {(MAPA[perfil] ?? []).map((m) => (
                      <tr key={m.r} className="border-t border-slate-800/80"><td className="mono py-1.5 text-sky-200">{m.r}</td><td className="text-slate-200">{m.v}</td><td className="mono text-xs text-slate-400">{m.t}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <small className="text-xs text-slate-500">Registros como los documenta Schneider (base 1); el agente pide la dirección menos uno. Solo función 03.</small>
            </section>

            <section className="panel flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="eyebrow">Umbrales por norma{umb.data?.propios ? " · propios del equipo" : ""}</span>
                <select value={norma} onChange={(e) => { const n = e.target.value as Norma; setNorma(n); }} className={campo} aria-label="Norma">
                  {(Object.keys(NORMA_TXT) as Norma[]).map((n) => <option key={n} value={n}>{NORMA_TXT[n]}</option>)}
                </select>
              </div>
              {lim && (
                <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
                  {([["tension", "Tensión ± %"], ["nominal", "Nominal V"], ["desbalance", "Desbalance %"], ["thdV", "THD tensión %"], ["thdI", "THD corriente %"], ["pst", "Pst"], ["fp", "FP mínimo"], ["freq", "Frecuencia ± Hz"], ["carga", "Carga máx. %"]] as [keyof Limites, string][]).map(([k, t]) => (
                    <label key={k} className="flex flex-col gap-1 text-xs text-slate-400">{t}
                      <input type="number" step="any" className={`${campo} mono`} value={lim[k]} onChange={(e) => setLim({ ...lim, [k]: Number(e.target.value) })} />
                    </label>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" disabled={!lim || !puede || guardarUmb.isPending} onClick={() => lim && guardarUmb.mutate({ deviceId: dev.id, norma, limites: lim }, { onSuccess: () => setMsg({ t: "Umbrales guardados: se usan en Normas y cumplimiento.", ok: true }) })} className="min-h-[38px] rounded-lg bg-sky-600 px-4 text-sm font-bold text-white disabled:opacity-40">Guardar umbrales</button>
                <small className="text-xs text-slate-500">Se evalúan: {INDICADORES.map((i) => i.t).join(", ")}.</small>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
