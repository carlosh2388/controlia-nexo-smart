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
import { usePilotDevices } from "../api/pilot";
import { extractErrorMessage } from "../api/errors";
import AgentDevices from "./AgentDevices";
import AgentConfig from "./AgentConfig";
import { FichaCampos, atributosDeFicha, faseSugerida, fichaVacia, sugerirDeviceId, type Ficha } from "../components/red/Ficha";
import { hace, perfilDe, servidores } from "../components/red/equiposUtil";
import ConfigEquipos from "../components/red/ConfigEquipos";
import AgenteGo from "../components/red/AgenteGo";
import GestionAgente from "../components/red/GestionAgente";
import { NuevaSede } from "../components/red/RedAdmin";
import { useGuardarSede, useRed, useSedeDeAgente } from "../api/red";

/**
 * Pestaña "Equipos" (mockups aprobados "Gestión de equipos" y "Plataforma"): Agente Go (esquema en
 * vivo de cada agente), descubrir y agregar (el agente identifica ION7400 / PM2130 / generador),
 * topología en vivo, configuración por equipo (ficha, conexión, umbrales, registros) y los agentes.
 * Todo lo que toca un medidor real es solo lectura (función 03).
 */

type Seccion = "agente" | "descubrir" | "topologia" | "config" | "maneja" | "agentes";

const MODELO_TXT: Record<string, string> = { ION7400: "Analizador ION7400", PM2130: "Medidor PM2130", generator: "Controlador de generador", "": "No identificado" };
const PERFIL_DE: Record<string, string> = { ION7400: "ion7400-directo", PM2130: "pm2130-directo", generator: "generador-directo" };

export default function Equipos() {
  const [sec, setSec] = useState<Seccion>("agente");
  const agentsQ = useAgents();
  const agents = agentsQ.data ?? [];
  const [bk, setBk] = useState<string | null>(null);
  useEffect(() => {
    if (!bk && agents.length) setBk((agents.find((a) => a.buildingKey.endsWith("-directo")) ?? agents.find((a) => a.hasConfig) ?? agents[0]).buildingKey);
  }, [agents, bk]);
  const agent = agents.find((a) => a.buildingKey === bk) ?? null;
  const access = useAccess();
  const esAdmin = access.data?.role === "admin";
  const red = useRed();
  const sedeDe = useSedeDeAgente();
  const sede = sedeDe(bk);
  const [crearSede, setCrearSede] = useState(false);

  const tabs: [Seccion, string][] = [["agente", "Agente Go"], ["descubrir", "Descubrir y agregar"], ["topologia", "Topología en vivo"], ["config", "Configuración"], ["maneja", "Equipos que maneja"], ["agentes", "Agentes"]];
  /** Agente → sede que ya lo usa (para no repetir un agente en dos sedes). */
  const agentesEnUso: Record<string, string> = { "igss-escuintla": "Escuintla", "igss-escuintla-directo": "Escuintla" };
  for (const s of red.data?.sedes ?? []) if (s.origen === "nodivo") for (const a of s.agentes) agentesEnUso[a] ??= s.nombre;

  return (
    <div className="flex flex-col gap-4 pb-16">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Equipos" className="flex w-fit flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
          {tabs.map(([k, t]) => (
            <button key={k} type="button" role="tab" aria-selected={sec === k} onClick={() => setSec(k)} className={`min-h-[36px] rounded-lg px-3.5 text-[13px] font-bold ${sec === k ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}>{t}</button>
          ))}
        </div>
        {sec !== "agentes" && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-slate-400">
              Agente
              <select value={bk ?? ""} onChange={(e) => setBk(e.target.value)} className="min-h-[38px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100">
                {agents.map((a) => <option key={a.buildingKey} value={a.buildingKey}>{a.buildingKey} · {sedeDe(a.buildingKey)?.nombre ?? "sin sede"}{a.lastSync?.agentVersion ? ` · v${a.lastSync.agentVersion}` : ""}</option>)}
              </select>
            </label>
            {bk && (sede ? (
              <span className="flex min-h-[38px] items-center gap-2 rounded-lg border px-3 text-sm font-semibold text-slate-100" style={{ borderColor: `${sede.grupo?.color ?? "#475569"}88`, background: `${sede.grupo?.color ?? "#475569"}1f` }} title="Los equipos de este agente pertenecen a esta sede">
                <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: sede.grupo?.color ?? "#475569" }} />
                Sede: {sede.nombre}{sede.grupo ? <span className="font-normal text-slate-300">· {sede.grupo.nombre}</span> : null}
              </span>
            ) : (
              <span className="flex min-h-[38px] items-center rounded-lg border border-amber-800 bg-amber-950/30 px-3 text-sm font-semibold text-amber-200">Sin sede asignada</span>
            ))}
          </div>
        )}
      </div>
      {bk && !sede && sec !== "agentes" && red.data && (
        <SinSede bk={bk} esAdmin={esAdmin} sedes={red.data.sedes.filter((s) => s.origen === "nodivo")} onCrear={() => setCrearSede(true)} />
      )}
      {crearSede && bk && red.data && (
        <NuevaSede
          grupos={red.data.grupos}
          sedes={red.data.sedes}
          idsExistentes={red.data.sedes.map((s) => s.id).concat(["escuintla"])}
          agentesEnUso={agentesEnUso}
          sedeId={null}
          pasoInicial={1}
          agenteInicial={bk}
          onCerrar={() => setCrearSede(false)}
          onAbrirSede={() => setCrearSede(false)}
        />
      )}
      {agentsQ.isLoading && <p className="py-8 text-center text-sm text-slate-500">Cargando agentes…</p>}
      {sec === "agente" && bk && <AgenteGo agents={agents} bk={bk} onElegir={setBk} onIr={setSec} sedeDe={sedeDe} />}
      {sec === "descubrir" && bk && <Descubrir bk={bk} remoto={!!agent?.hasConfig} />}
      {sec === "topologia" && bk && <Topologia bk={bk} remoto={!!agent?.hasConfig} />}
      {sec === "config" && bk && <ConfigEquipos key={bk} bk={bk} sedeNombre={sede?.nombre ?? null} />}
      {sec === "maneja" && bk && <GestionAgente key={bk} bk={bk} esAdmin={esAdmin} />}
      {sec === "agentes" && (
        <div className="flex flex-col gap-8">
          <AgentDevices />
          <div className="border-t border-slate-800 pt-6"><AgentConfig /></div>
        </div>
      )}
    </div>
  );
}

/** Aviso: el agente elegido no pertenece a ninguna sede, asi que sus equipos no salen en el centro de mando. */
function SinSede({ bk, esAdmin, sedes, onCrear }: { bk: string; esAdmin: boolean; sedes: import("../api/red").RedSede[]; onCrear: () => void }) {
  const guardar = useGuardarSede();
  const [destino, setDestino] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  function asignar() {
    const s = sedes.find((x) => x.id === destino);
    if (!s) return;
    guardar.mutate(
      { id: s.id, nombre: s.nombre, origen: "nodivo", grupoId: s.grupoId, agentes: [...new Set([...s.agentes, bk])], lat: s.lat, lon: s.lon, plantilla: s.plantilla },
      { onError: (e) => setMsg(extractErrorMessage(e, "No se pudo asignar")) },
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-800 bg-amber-950/20 px-4 py-3" role="status">
      <span className="min-w-[260px] flex-1 text-sm text-amber-100">
        <b>El agente «{bk}» no está asignado a ninguna sede.</b> Sus equipos se leen y se guardan, pero no aparecen en el Centro de mando. Cada sede tiene su propio agente.
      </span>
      {esAdmin ? (
        <>
          <button type="button" onClick={onCrear} className="min-h-[38px] rounded-lg bg-sky-600 px-3.5 text-sm font-bold text-white hover:bg-sky-500">Crear sede con este agente</button>
          {sedes.length > 0 && (
            <span className="flex items-center gap-1.5">
              <select value={destino} onChange={(e) => setDestino(e.target.value)} aria-label="Sede existente" className="min-h-[38px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100">
                <option value="">Asignar a una sede…</option>
                {sedes.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
              </select>
              <button type="button" disabled={!destino || guardar.isPending} onClick={asignar} className="min-h-[38px] rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-100 disabled:opacity-40">Asignar</button>
            </span>
          )}
          {msg && <span className="text-sm text-rose-300">{msg}</span>}
        </>
      ) : <span className="text-xs text-amber-200/80">Un administrador puede crearle su sede.</span>}
    </div>
  );
}

/**
 * El agente reconoce el ION7400 porque acepta bloques grandes; otros medidores Schneider tambien los
 * aceptan. Un "ION7400" que se nombra "Power Meter" (nombre de fabrica de la serie PM) queda por
 * confirmar hasta que el agente lea el modelo del propio equipo.
 */
function porConfirmar(d: ScanIdentity) {
  return d.model === "ION7400" && /power\s*meter/i.test(d.name ?? "");
}

/* ================= descubrir y agregar ================= */
export function Descubrir({ bk, remoto }: { bk: string; remoto: boolean }) {
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
  /** Ficha de cada equipo encontrado (clave host#unitId), abierta en una sola tarjeta a la vez. */
  const [fichas, setFichas] = useState<Record<string, Ficha>>({});
  const [fichaAbierta, setFichaAbierta] = useState<string | null>(null);
  const usados = useMemo(() => {
    const ids = servidores(cfgQ.data?.config).flatMap((s) => (s.devices ?? []).map((d) => String(d.attributes?.device_id ?? ""))).filter(Boolean);
    return [...ids, ...Object.values(fichas).map((f) => f.device_id).filter(Boolean)];
  }, [cfgQ.data, fichas]);
  const fichaDe = (clave: string, d: ScanIdentity) => fichas[clave] ?? { ...fichaVacia(), device_id: sugerirDeviceId(d.model, usados), fase_energy: faseSugerida(d.evidence) };

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
    const ficha = fichaDe(clave, d);
    const nuevo: ModbusServerConfig = {
      enabled: true, name: nombre, host, port, unitId: d.unitId, pollIntervalSeconds: 15, timeoutMs: 3000, readDelayMs: 100,
      devices: [{ name: nombre, profile: perfil, start: 0, attributes: atributosDeFicha(ficha, { model: d.model, identificadoPor: "agente", confianza: d.confidence }) }],
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
              const dudoso = porConfirmar(d);
              const color = dudoso ? "text-violet-300" : d.model === "ION7400" ? "text-sky-300" : d.model === "PM2130" ? "text-emerald-300" : d.model === "generator" ? "text-amber-300" : "text-slate-400";
              const abierta = fichaAbierta === clave;
              const ficha = fichaDe(clave, d);
              return (
                <div key={clave} className={`flex flex-col gap-2 rounded-xl border bg-slate-950/60 p-3 ${abierta ? "border-sky-800" : "border-slate-800"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <b className={`block text-sm ${color}`}>{dudoso ? "Medidor Schneider · por confirmar" : MODELO_TXT[d.model] ?? d.model}</b>
                      <span className="mono text-xs text-slate-400">{host} · ID {d.unitId}</span>
                    </div>
                    {d.confidence > 0 && <span className="mono rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-200" title="Qué tan seguro está el agente">{dudoso ? "?" : `${d.confidence} %`}</span>}
                  </div>
                  <small className="text-xs text-slate-400">{d.evidence}</small>
                  {dudoso && (
                    <small className="rounded-lg border border-violet-900 bg-violet-950/30 px-2.5 py-1.5 text-xs text-violet-200">
                      Se nombra «Power Meter» (nombre de fábrica de la serie PM), pero respondió como ION7400. Confirme el modelo en la placa del equipo antes de agregarlo.
                    </small>
                  )}
                  {instalado ? (
                    <span className="text-xs font-semibold text-emerald-300">Ya está en la configuración del agente</span>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <input aria-label="Nombre del equipo" value={nombres[clave] ?? d.name ?? ""} onChange={(e) => setNombres({ ...nombres, [clave]: e.target.value })} placeholder="Nombre (ej. ANALIZADOR-7)" className="min-h-[36px] min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm text-slate-100" />
                        <button type="button" disabled={!puedeAgregar || !d.model || guardar.isPending || !cfgQ.data} onClick={() => agregar(host, port, d)} title={puedeAgregar ? "" : "Solo un administrador cambia la configuración del agente"} className="min-h-[36px] rounded-lg border border-sky-700 px-3 text-sm font-bold text-sky-200 hover:bg-sky-950 disabled:opacity-40">Agregar</button>
                      </div>
                      <button type="button" aria-expanded={abierta} onClick={() => { if (!fichas[clave]) setFichas({ ...fichas, [clave]: ficha }); setFichaAbierta(abierta ? null : clave); }} className="flex min-h-[32px] items-center justify-between rounded-lg px-1 text-left text-xs font-semibold text-sky-300 hover:bg-slate-900">
                        <span>Ficha del dispositivo {ficha.area || ficha.code_inventory ? `· ${[ficha.code_inventory, ficha.area].filter(Boolean).join(" · ")}` : "· área, edificio, nivel, inventario…"}</span>
                        <span aria-hidden="true">{abierta ? "▴" : "▾"}</span>
                      </button>
                      {abierta && <FichaCampos valor={ficha} onChange={(f) => setFichas({ ...fichas, [clave]: f })} disabled={!puedeAgregar} />}
                    </>
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

