import { useEffect, useMemo, useState } from "react";
import { useAgentConfig, useAgentScan, type AgentSummary } from "../../api/agents";
import { usePilotDevicesMany, type SedeDeAgente } from "../../api/red";
import type { PilotDevice } from "../../api/pilot";
import { TIPO_COLOR, TIPO_TXT, hace, servidores, tipoDe, type Tipo } from "./equiposUtil";
import "../centro/centro.css";
import "./red.css";

/**
 * Equipos → "Agente Go" (mockup aprobado "Cómo descubre el Agente Go"), con datos reales:
 * tarjetas de todos los agentes, el esquema animado red de la sede → agente → Nodivo del agente
 * elegido, sus indicadores, cómo descubre equipos y una bitácora armada con sus syncs, su
 * configuración, la última búsqueda y el estado de cada equipo.
 */

const VIVO_MS = 2 * 60_000;
const vivo = (s: string | null | undefined) => !!s && Date.now() - new Date(s).getTime() < VIVO_MS;
const hora = (s: string | null | undefined) => (s ? new Date(s).toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--");
const fecha = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("es-GT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

const PASOS = [
  ["Se enlaza a la sede", "Se instala con su config.yaml y su API key. Queda registrado en Nodivo con el código de la sede."],
  ["Barre los rangos de IP", "Prueba el puerto 502 (Modbus TCP) en cada IP que se le indique en «Descubrir y agregar». Sin tocar nada."],
  ["Pregunta por cada ID Modbus", "En cada IP que contesta prueba los IDs 1, 2, 21 y 255 (o los que se indiquen)."],
  ["Lee el modelo del propio equipo", "Pide sus registros de identificación: el equipo dice si es ION7400, PM2130, etc. Si no los tiene, usa la huella (bloques, frecuencia, batería del generador)."],
  ["Propone la ficha", "Sugiere device_id (pm_2130_1, ion_7400_1…), tipo y si es trifásico. El técnico completa área, edificio, nivel e inventario."],
  ["Lee y envía cada 15-30 s", "Manda el JSON con la ficha y las métricas. Si se cae la red, guarda en disco y reenvía después (recupera el hueco)."],
] as const;

interface Linea { t: string; txt: string; c: string }

export default function AgenteGo({ agents, bk, onElegir, onIr, sedeDe }: { agents: AgentSummary[]; bk: string; onElegir: (bk: string) => void; onIr: (sec: "descubrir" | "config" | "topologia") => void; sedeDe: (bk: string) => SedeDeAgente | null }) {
  const keys = useMemo(() => agents.map((a) => a.buildingKey), [agents]);
  const devsQ = usePilotDevicesMany(keys);
  const devsDe = (k: string): PilotDevice[] => devsQ[keys.indexOf(k)]?.data?.devices ?? [];
  const agent = agents.find((a) => a.buildingKey === bk) ?? null;
  const devs = devsDe(bk);
  const cfg = useAgentConfig(agent?.hasConfig ? bk : null);
  const scan = useAgentScan(agent?.hasConfig ? bk : null);
  const servs = servidores(cfg.data?.config);
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);

  // ---- indicadores ----
  const porTipo = (t: Tipo) => devs.filter((d) => tipoDe(d) === t);
  const enLinea = devs.filter((d) => d.state === "online" && vivo(d.updatedAt)).length;
  const comps = devs.map((d) => d.completeness).filter((x): x is number => x != null);
  const completitud = comps.length ? comps.reduce((a, x) => a + x, 0) / comps.length : null;
  const huecosPend = devs.reduce((n, d) => n + d.gaps.pending, 0);
  const huecosAbiertos = devs.reduce((n, d) => n + d.gaps.openNow, 0);
  const agenteVivo = vivo(agent?.lastSync?.syncedAt);
  const intervalo = servs[0]?.pollIntervalSeconds ?? 15;
  const ips = [...new Set(servs.map((s) => s.host))];
  const encontradosSinAgregar = (scan.data?.results ?? []).filter((r) => r.protocol === "modbus" && r.status === "ok").flatMap((r) => (r.devices ?? []).map((d) => `${r.host}#${d.unitId}`)).filter((k) => !servs.some((s) => `${s.host}#${s.unitId ?? 1}` === k)).length;

  // ---- bitacora real ----
  const lineas: Linea[] = useMemo(() => {
    const out: (Linea & { orden: number })[] = [];
    const ls = agent?.lastSync;
    if (ls) out.push({ orden: new Date(ls.syncedAt).getTime(), t: hora(ls.syncedAt), txt: `[envío] sync a Nodivo · ${ls.total ?? devs.length} equipos · agente v${ls.agentVersion ?? "?"} · 200 OK`, c: "#4ade80" });
    if (agent?.appliedAt) out.push({ orden: new Date(agent.appliedAt).getTime(), t: hora(agent.appliedAt), txt: agent.applyError ? `[config] v${agent.appliedVersion} con error: ${agent.applyError}` : `[config] configuración v${agent.appliedVersion} aplicada sin errores`, c: agent.applyError ? "#fca5a5" : "#93c5fd" });
    const sc = scan.data;
    if (sc) {
      const t0 = sc.finishedAt ?? sc.startedAt ?? sc.requestedAt;
      const ok = sc.results.filter((r) => r.status === "ok");
      const ident = ok.flatMap((r) => (r.devices ?? []).map((d) => ({ r, d })));
      out.push({ orden: new Date(sc.requestedAt).getTime(), t: hora(sc.requestedAt), txt: `[red] búsqueda pedida en ${sc.results.length || "…"} direcciones`, c: "#a3b1c9" });
      if (sc.status === "done") {
        out.push({ orden: new Date(t0).getTime(), t: hora(t0), txt: `[red] ${ok.length} IP respondieron en el puerto 502 · ${ident.length} equipos identificados`, c: "#a3b1c9" });
        ident.slice(0, 6).forEach(({ r, d }, i) => out.push({ orden: new Date(t0).getTime() + i + 1, t: hora(t0), txt: `[ident] ${r.host} ID ${d.unitId} · ${d.model ? `${d.model === "generator" ? "generador" : d.model} · ${d.confidence} %` : "por confirmar"}`, c: d.model === "ION7400" ? TIPO_COLOR.ion : d.model === "PM2130" ? TIPO_COLOR.pm : d.model === "generator" ? TIPO_COLOR.gen : "#c4b5fd" }));
      } else if (sc.status === "error") out.push({ orden: new Date(t0).getTime(), t: hora(t0), txt: `[red] la búsqueda falló: ${sc.error ?? ""}`, c: "#fca5a5" });
      else out.push({ orden: Date.now(), t: hora(new Date().toISOString()), txt: "[red] buscando equipos…", c: "#fbbf24" });
    }
    for (const d of devs) {
      if (d.state !== "online" || !vivo(d.updatedAt)) out.push({ orden: new Date(d.updatedAt ?? 0).getTime(), t: hora(d.updatedAt), txt: `[alerta] ${d.name} sin respuesta desde ${fecha(d.updatedAt)}`, c: "#fca5a5" });
      if (d.gaps.openNow) out.push({ orden: Date.now() - 1, t: hora(new Date().toISOString()), txt: `[hueco] ${d.name}: hueco abierto ahora`, c: "#fbbf24" });
    }
    const leyendo = devs.filter((d) => d.state === "online" && vivo(d.updatedAt));
    if (leyendo.length) {
      const ult = leyendo.map((d) => d.updatedAt!).sort().pop()!;
      out.push({ orden: new Date(ult).getTime() + 1, t: hora(ult), txt: `[modbus] ${leyendo.length}/${devs.length} equipos con datos válidos en el último ciclo`, c: "#7cc4ff" });
    }
    return out.sort((a, b) => a.orden - b.orden).slice(-16);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, scan.data, devsQ.map((q) => q.dataUpdatedAt).join(",")]);

  // las lineas aparecen una a una al entrar o al cambiar de agente
  const [mostradas, setMostradas] = useState(0);
  useEffect(() => { setMostradas(0); }, [bk]);
  useEffect(() => {
    if (mostradas >= lineas.length) return;
    const t = setTimeout(() => setMostradas((m) => m + 1), 140);
    return () => clearTimeout(t);
  }, [mostradas, lineas.length]);

  const paso = scan.data?.status === "running" || scan.data?.status === "pending" ? 2 : 5;

  return (
    <div className="cm flex flex-col gap-5">
      {/* ---------------- tarjetas de agentes ---------------- */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
        {agents.map((a) => {
          const ds = devsDe(a.buildingKey);
          const v = vivo(a.lastSync?.syncedAt);
          const on = a.buildingKey === bk;
          const ok = ds.filter((d) => d.state === "online" && vivo(d.updatedAt)).length;
          return (
            <button key={a.buildingKey} type="button" onClick={() => onElegir(a.buildingKey)} aria-pressed={on} className={`flex flex-col gap-2.5 rounded-2xl border p-4 text-left transition-colors ${on ? "border-sky-600 bg-[#0f1d38]" : "border-slate-800 bg-[#0b1220] hover:border-slate-600"}`}>
              <span className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${v ? "latido bg-emerald-400" : "bg-rose-500"}`} />
                <b className="mono flex-1 truncate text-sm text-slate-100">{a.buildingKey}</b>
                {a.lastSync?.agentVersion && <span className="mono rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">v{a.lastSync.agentVersion}</span>}
              </span>
              {(() => {
                const s = sedeDe(a.buildingKey);
                return s ? (
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-200"><span className="h-2 w-2 rounded-[3px]" style={{ background: s.grupo?.color ?? "#475569" }} />Sede {s.nombre}{s.grupo ? <span className="font-normal text-slate-400">· {s.grupo.nombre}</span> : null}</span>
                ) : <span className="text-xs font-semibold text-amber-300">Sin sede asignada</span>;
              })()}
              <span className="flex items-baseline gap-2"><b className="mono text-3xl text-slate-50">{ds.length}</b><span className="text-xs text-slate-400">equipos de energía · {ok} en línea</span></span>
              <span className="flex gap-1.5">
                {(["ion", "pm", "gen"] as Tipo[]).map((t) => {
                  const n = ds.filter((d) => tipoDe(d) === t).length;
                  return n ? <span key={t} className="rounded-full px-2 py-0.5 text-[10.5px] font-bold" style={{ color: TIPO_COLOR[t], background: `${TIPO_COLOR[t]}1a` }}>{n} {TIPO_TXT[t]}</span> : null;
                })}
                {!ds.length && <span className="text-[11px] text-slate-500">Sin equipos Modbus directos</span>}
              </span>
              <span className="text-[11px] text-slate-500">{v ? `Envió ${hace(a.lastSync?.syncedAt)}` : a.lastSync ? `Sin reportar desde ${fecha(a.lastSync.syncedAt)}` : "Nunca se ha conectado"}{a.hasConfig ? ` · config v${a.appliedVersion ?? "—"}` : " · sin config remota"}</span>
            </button>
          );
        })}
      </div>

      {agent && (
        <>
          {/* ---------------- esquema animado ---------------- */}
          <section aria-label="Cómo trabaja el agente" className="flex flex-col gap-3">
            <div>
              <span className="eyebrow text-sky-400">Cómo trabaja el Agente Go en la sede · en vivo</span>
              <h3 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">Lee los equipos de la red de la sede y envía cada {intervalo} s a Nodivo</h3>
            </div>
            <div className="flex flex-wrap items-stretch gap-0">
              <div className="panel flex min-w-[250px] flex-[1_1_280px] flex-col gap-2 p-4">
                <span className="eyebrow">Red de la sede{ips.length ? ` · ${ips.length} IP` : ""}</span>
                {(["ion", "pm", "gen"] as Tipo[]).map((t) => {
                  const l = porTipo(t);
                  if (!l.length) return null;
                  const ok = l.filter((d) => d.state === "online" && vivo(d.updatedAt)).length;
                  const hosts = [...new Set(l.map((d) => String(d.attributes.host ?? "")).filter(Boolean))];
                  return (
                    <div key={t} className="flex items-center gap-3 rounded-xl border bg-slate-950/60 px-3 py-2.5" style={{ borderColor: `${TIPO_COLOR[t]}40` }}>
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: TIPO_COLOR[t] }} />
                      <span className="min-w-0 flex-1"><b className="text-sm text-slate-100">{TIPO_TXT[t]} × {l.length}</b><span className="mono block truncate text-[10.5px] text-slate-500">{hosts.slice(0, 3).join(", ")}{hosts.length > 3 ? ` +${hosts.length - 3}` : ""}</span></span>
                      <span className={`text-xs font-bold ${ok === l.length ? "text-emerald-400" : "text-amber-300"}`}>{ok === l.length ? "✓" : `${ok}/${l.length}`}</span>
                    </div>
                  );
                })}
                {encontradosSinAgregar > 0 && (
                  <button type="button" onClick={() => onIr("descubrir")} className="flex items-center gap-3 rounded-xl border border-violet-900 bg-violet-950/20 px-3 py-2.5 text-left">
                    <span className="h-2.5 w-2.5 rounded-full bg-violet-300" />
                    <span className="flex-1"><b className="text-sm text-slate-100">{encontradosSinAgregar} encontrados sin agregar</b><span className="block text-[10.5px] text-slate-500">en la última búsqueda · revisar</span></span>
                  </button>
                )}
                {!devs.length && <span className="py-4 text-center text-xs text-slate-500">Todavía no lee equipos directos.</span>}
              </div>

              <div className="flex flex-[0_0_96px] flex-col items-center justify-center gap-1.5 px-2 py-3">
                <div className={`ag-flujo w-full ${agenteVivo && devs.length ? "verde" : "gris"}`}>{agenteVivo && devs.length > 0 && <span className="ag-paquete bg-emerald-300" />}</div>
                <span className="text-center text-[10.5px] text-slate-500">Modbus TCP<br />solo lectura</span>
              </div>

              <div className={`panel flex min-w-[220px] flex-[1_1_240px] flex-col items-center justify-center gap-2 p-5 text-center ${agenteVivo ? "border-sky-700" : ""}`}>
                <span className={`grid h-16 w-16 place-items-center rounded-2xl ${agenteVivo ? "ag-pulso bg-sky-600" : "bg-slate-700"}`}>
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 9h6v6H9z" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" /></svg>
                </span>
                <b className="text-lg text-slate-50">Agente Go {agent.lastSync?.agentVersion ? `v${agent.lastSync.agentVersion}` : ""}</b>
                <span className="mono text-xs text-slate-400">{agent.buildingKey}</span>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${agenteVivo ? "bg-emerald-950 text-emerald-300" : "bg-rose-950 text-rose-300"}`}>{agenteVivo ? `Envió ${hace(agent.lastSync?.syncedAt)}` : "Sin reportar"}</span>
                <span className="text-xs text-slate-400">Lee {devs.length} equipos · cada {intervalo} s{agent.hasConfig ? ` · config v${agent.appliedVersion ?? "—"}` : ""}</span>
              </div>

              <div className="flex flex-[0_0_96px] flex-col items-center justify-center gap-1.5 px-2 py-3">
                <div className={`ag-flujo w-full ${agenteVivo ? "azul" : "gris"}`}>{agenteVivo && <span className="ag-paquete bg-sky-300" style={{ animationDelay: ".6s" }} />}</div>
                <span className="text-center text-[10.5px] text-slate-500">JSON v1<br />con API key</span>
              </div>

              <div className="panel flex min-w-[240px] flex-[1_1_260px] flex-col gap-2 p-4">
                <span className="eyebrow">Nodivo · 192.168.70.4</span>
                {[
                  ["Guardando historial", `${enLinea}/${devs.length} equipos`, enLinea === devs.length ? "#4ade80" : "#fbbf24"],
                  ["Completitud del historial", completitud != null ? `${completitud.toFixed(2)} %` : "—", completitud == null ? "#94a3b8" : completitud >= 99.5 ? "#4ade80" : "#fbbf24"],
                  ["Huecos sin recuperar", String(huecosPend), huecosPend ? "#fbbf24" : "#4ade80"],
                  ["Huecos abiertos ahora", String(huecosAbiertos), huecosAbiertos ? "#fca5a5" : "#4ade80"],
                ].map(([t, v, c]) => (
                  <div key={t} className="flex items-center justify-between rounded-lg bg-slate-950/60 px-3 py-2 text-sm"><span className="text-slate-300">{t}</span><b className="mono" style={{ color: c }}>{v}</b></div>
                ))}
              </div>
            </div>
          </section>

          {/* ---------------- tarjetas de lo que lee ---------------- */}
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
            {(["ion", "pm", "gen"] as Tipo[]).map((t) => (
              <div key={t} className="panel flex flex-col gap-1 p-4" style={{ borderColor: `${TIPO_COLOR[t]}40` }}>
                <small className="text-xs font-semibold" style={{ color: TIPO_COLOR[t] }}>{t === "ion" ? "Analizadores ION7400" : t === "pm" ? "Medidores PM2130" : "Generadores"}</small>
                <b className="mono text-3xl text-slate-50">{porTipo(t).length}</b>
                <small className="text-[11px] text-slate-500">{porTipo(t).filter((d) => d.state === "online" && vivo(d.updatedAt)).length} en línea</small>
              </div>
            ))}
            <div className="panel flex flex-col gap-1 p-4"><small className="text-xs font-semibold text-slate-400">En línea</small><b className="mono text-3xl text-slate-50">{enLinea}<span className="text-lg text-slate-500">/{devs.length}</span></b><small className="text-[11px] text-slate-500">último ciclo</small></div>
            <div className="panel flex flex-col gap-1 p-4"><small className="text-xs font-semibold text-slate-400">Completitud</small><b className="mono text-3xl text-slate-50">{completitud != null ? completitud.toFixed(1) : "—"}<span className="text-lg text-slate-500">%</span></b><small className="text-[11px] text-slate-500">promedio del historial</small></div>
          </div>

          {/* ---------------- como descubre + bitacora ---------------- */}
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="eyebrow">Cómo descubre equipos</span>
                <span className="flex gap-1.5">
                  <button type="button" onClick={() => onIr("descubrir")} className="min-h-[34px] rounded-lg bg-sky-600 px-3 text-xs font-bold text-white hover:bg-sky-500">Buscar equipos</button>
                  <button type="button" onClick={() => onIr("config")} className="min-h-[34px] rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-200 hover:bg-slate-800">Fichas</button>
                </span>
              </div>
              <ol className="flex flex-col gap-2">
                {PASOS.map(([t, d], i) => {
                  const hecho = i < paso, actual = i === paso;
                  return (
                    <li key={t} className={`flex gap-3.5 rounded-xl border p-3.5 ${actual ? "border-sky-700 bg-sky-950/30" : "border-slate-800 bg-[#0b1220]"}`}>
                      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-bold ${hecho ? "bg-emerald-600 text-white" : actual ? "ag-pulso bg-sky-600 text-white" : "bg-slate-800 text-slate-400"}`}>{hecho ? "✓" : i + 1}</span>
                      <span><b className="text-sm text-slate-100">{t}</b><span className="mt-0.5 block text-[12.5px] leading-snug text-slate-400">{d}</span></span>
                    </li>
                  );
                })}
              </ol>
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="eyebrow">Bitácora del agente · real</span>
                <button type="button" onClick={() => setMostradas(0)} className="min-h-[30px] rounded-md border border-slate-700 px-2.5 text-xs text-slate-300 hover:bg-slate-800">Repetir</button>
              </div>
              <div className="mono min-h-[360px] flex-1 overflow-hidden rounded-xl border border-slate-800 bg-[#03070f] p-4 text-[12px] leading-[1.8]">
                {lineas.slice(0, mostradas).map((l, i) => (
                  <div key={`${i}-${l.txt}`} className="ag-linea whitespace-pre-wrap" style={{ color: l.c }}><span className="text-slate-600">{l.t} </span>{l.txt}</div>
                ))}
                {!lineas.length && <div className="text-slate-500">Sin actividad registrada todavía.</div>}
                <span className="ag-cursor text-sky-300">▍</span>
              </div>
              <small className="text-[11px] text-slate-500">Armada con el último envío del agente, su configuración, la última búsqueda de equipos y el estado de cada equipo. Se actualiza sola.</small>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
