import { useEffect, useMemo, useState } from "react";
import { useAgentConfig, useSaveAgentConfig, type ModbusServerConfig } from "../../api/agents";
import { useAccess } from "../../api/access";
import { INDICADORES, NORMA_TXT, useGuardarUmbrales, useProbarLectura, useUmbrales, type Limites, type Norma } from "../../api/calidad";
import { usePilotDevices, type PilotDevice } from "../../api/pilot";
import { extractErrorMessage } from "../../api/errors";
import { FichaCampos, atributosDeFicha, fichaDeAtributos, type Ficha } from "./Ficha";
import { MAPA, TIPO_COLOR, TIPO_TXT, hace, perfilDe, servidores, tipoDe, unidad, type Tipo } from "./equiposUtil";
import "../centro/centro.css";
import "./red.css";

/**
 * Equipos → Configuración (mockup "Ficha del dispositivo · JSON v1"): lista de equipos a la izquierda,
 * formulario por pestañas al centro y el JSON v1 en vivo a la derecha. Los cambios de ficha y conexión
 * de uno o varios equipos se guardan juntos en una nueva versión de la configuración del agente.
 */

interface Conexion { host: string; port: number; unitId: number; intervalo: number; enabled: boolean }
type Pestana = "ficha" | "conexion" | "umbrales" | "registros";
const REQUERIDOS: (keyof Ficha)[] = ["device_id", "code_inventory", "area", "building", "floor", "fase_energy"];
const igual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const BASE: Record<Tipo, string> = { ion: "ion_7400", pm: "pm_2130", gen: "generador" };

function Icono({ tipo, size = 20 }: { tipo: Tipo; size?: number }) {
  return tipo === "gen" ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="11" rx="2" /><path d="M7 7V5h4v2M12 10l-2 3h4l-2 3" /></svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><rect x="7" y="6" width="10" height="6" rx="1" /><path d="M8 16h.01M12 16h.01M16 16h.01" /></svg>
  );
}

export default function ConfigEquipos({ bk, sedeNombre = null }: { bk: string; sedeNombre?: string | null }) {
  const access = useAccess();
  const esAdmin = access.data?.role === "admin";
  const puedeUmb = (access.data?.role === "admin" || access.data?.role === "operator") && !!access.data?.actions.includes("agentes");
  const pilot = usePilotDevices(bk);
  const cfgQ = useAgentConfig(bk);
  const guardarCfg = useSaveAgentConfig();
  const guardarUmb = useGuardarUmbrales();
  const probar = useProbarLectura();

  const devs = useMemo(() => [...(pilot.data?.devices ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [pilot.data]);
  const servs = useMemo(() => servidores(cfgQ.data?.config), [cfgQ.data]);
  /** Servidor Modbus del agente que lee cada equipo (por nombre del equipo). */
  const servDe = (d: PilotDevice) => servs.find((s) => (s.devices ?? []).some((x) => x.name === d.name)) ?? null;

  // Ficha y conexion originales (lo guardado) de cada equipo.
  const originales = useMemo(() => {
    const porTipo: Record<Tipo, number> = { ion: 0, pm: 0, gen: 0 };
    const out = new Map<string, { ficha: Ficha; con: Conexion | null }>();
    for (const d of devs) {
      const t = tipoDe(d);
      porTipo[t] += 1;
      const s = servs.find((x) => (x.devices ?? []).some((y) => y.name === d.name));
      const dc = s?.devices?.find((y) => y.name === d.name);
      const ficha = fichaDeAtributos({ ...d.attributes, ...(dc?.attributes ?? {}) });
      // device_id: el mismo que la API asigna si no hay uno guardado (tipo + orden por nombre).
      if (!ficha.device_id) ficha.device_id = `${BASE[t]}_${porTipo[t]}`;
      out.set(d.name, { ficha, con: s ? { host: s.host, port: s.port ?? 502, unitId: s.unitId ?? 1, intervalo: s.pollIntervalSeconds ?? 15, enabled: s.enabled !== false } : null });
    }
    return out;
  }, [devs, servs]);

  const [sel, setSel] = useState<string | null>(null);
  const [pestana, setPestana] = useState<Pestana>("ficha");
  const [fichas, setFichas] = useState<Record<string, Ficha>>({});
  const [cons, setCons] = useState<Record<string, Conexion>>({});
  const [buscar, setBuscar] = useState("");
  const [soloFalta, setSoloFalta] = useState(false);
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  const [copiar, setCopiar] = useState(false);
  /** Tipos visibles en la lista (filtro) y grupos plegados; se recuerdan en este navegador. */
  const [tiposVisibles, setTiposVisibles] = useState<Tipo[]>(["ion", "pm", "gen"]);
  const [plegados, setPlegados] = useState<Tipo[]>(() => {
    try { return JSON.parse(localStorage.getItem("equipos.plegados") ?? "[]") as Tipo[]; } catch { return []; }
  });
  const plegar = (t: Tipo) => {
    const n = plegados.includes(t) ? plegados.filter((x) => x !== t) : [...plegados, t];
    setPlegados(n);
    try { localStorage.setItem("equipos.plegados", JSON.stringify(n)); } catch { /* sin almacenamiento */ }
  };

  const dev = devs.find((d) => d.name === sel) ?? devs[0] ?? null;
  const orig = dev ? originales.get(dev.name) : undefined;
  const ficha = dev ? fichas[dev.name] ?? orig?.ficha ?? null : null;
  const con = dev ? cons[dev.name] ?? orig?.con ?? null : null;
  const fichaDe = (n: string) => fichas[n] ?? originales.get(n)?.ficha;
  const completa = (f: Ficha | undefined) => !!f && REQUERIDOS.every((k) => String(f[k] ?? "").trim());

  // umbrales (se guardan aparte, por equipo)
  const umb = useUmbrales(dev?.id ?? null);
  const [norma, setNorma] = useState<Norma>("ntsd");
  const [lim, setLim] = useState<Limites | null>(null);
  useEffect(() => { if (umb.data) { setNorma(umb.data.norma); setLim(umb.data.limites); } }, [umb.data]);
  const umbSucio = !!umb.data && !!lim && (norma !== umb.data.norma || !igual(lim, umb.data.limites));

  // cambios pendientes de ficha / conexion (de cualquier equipo)
  const sucios = devs.filter((d) => {
    const o = originales.get(d.name);
    return (fichas[d.name] && !igual(fichas[d.name], o?.ficha)) || (cons[d.name] && !igual(cons[d.name], o?.con));
  });
  const fichaSucia = !!dev && !!fichas[dev.name] && !igual(fichas[dev.name], orig?.ficha);
  const conSucia = !!dev && !!cons[dev.name] && !igual(cons[dev.name], orig?.con);
  const hayCambios = sucios.length > 0 || umbSucio;

  function descartar() {
    setFichas({});
    setCons({});
    if (umb.data) { setNorma(umb.data.norma); setLim(umb.data.limites); }
    setMsg(null);
  }

  async function guardar() {
    setMsg(null);
    try {
      let version: number | null = null;
      if (sucios.length) {
        const base = cfgQ.data;
        if (!base) throw new Error("No se pudo leer la configuración del agente");
        const nuevos: ModbusServerConfig[] = servs.map((s) => {
          const d = devs.find((x) => (s.devices ?? []).some((y) => y.name === x.name) && sucios.includes(x));
          if (!d) return s;
          const c = cons[d.name];
          const f = fichas[d.name];
          return {
            ...s,
            ...(c ? { host: c.host.trim(), port: c.port, unitId: c.unitId, pollIntervalSeconds: c.intervalo, enabled: c.enabled } : {}),
            devices: (s.devices ?? []).map((y) => (y.name === d.name && f ? { ...y, attributes: atributosDeFicha(f, y.attributes ?? {}) } : y)),
          };
        });
        const r = await guardarCfg.mutateAsync({ buildingKey: bk, config: { ...base.config, modbus: null, modbusServers: nuevos }, baseVersion: base.version });
        version = r.version;
      }
      if (umbSucio && dev && lim) await guardarUmb.mutateAsync({ deviceId: dev.id, norma, limites: lim });
      setFichas({});
      setCons({});
      setMsg({ t: `Guardado${version ? ` · configuración v${version}: el agente lo aplica en segundos` : ""}${umbSucio ? " · umbrales actualizados" : ""}.`, ok: true });
    } catch (e) {
      setMsg({ t: extractErrorMessage(e, "No se pudo guardar"), ok: false });
    }
  }

  // lista
  const filtrados = devs.filter((d) => (!buscar || `${d.name} ${fichaDe(d.name)?.code_inventory ?? ""} ${fichaDe(d.name)?.area ?? ""}`.toLowerCase().includes(buscar.toLowerCase())) && (!soloFalta || !completa(fichaDe(d.name))));
  const faltan = devs.filter((d) => !completa(fichaDe(d.name))).length;

  // JSON v1 en vivo
  const json = useMemo(() => {
    if (!dev || !ficha) return "";
    const t = tipoDe(dev);
    const o: Record<string, unknown> = { device_id: ficha.device_id, name: dev.name, type: t === "gen" ? "generator" : t, model: t === "ion" ? "7400" : t === "pm" ? "2130" : String(dev.model ?? ""), online: String(dev.state === "online") };
    (["area", "building", "floor", "group", "room", "fase_energy", "code_inventory"] as const).forEach((k) => { if (ficha[k]) o[k] = ficha[k]; });
    if (ficha.capacity) o.capacity = Number(ficha.capacity) || ficha.capacity;
    const m: Record<string, { value: number; unit: string }> = {};
    Object.entries(dev.readings ?? {}).forEach(([k, v]) => { if (typeof v === "number" && Number.isFinite(v) && !/^harm_/.test(k)) m[k] = { value: v, unit: unidad(k) }; });
    o.metrics = m;
    return JSON.stringify(o, null, 2);
  }, [dev, ficha]);

  if (pilot.isLoading || cfgQ.isLoading) return <p className="py-10 text-center text-sm text-slate-500">Cargando equipos…</p>;
  if (!devs.length) return <p className="panel p-6 text-center text-sm text-slate-400">Este agente todavía no tiene equipos de energía. Agréguelos en «Descubrir y agregar».</p>;
  if (!dev || !ficha) return null;

  const tipo = tipoDe(dev);
  const perfil = perfilDe(dev);
  const vivo = dev.state === "online";
  const llenos = REQUERIDOS.filter((k) => String(ficha[k] ?? "").trim()).length;
  const enConfig = !!servDe(dev);
  const campo = "min-h-[40px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 focus:border-sky-600 focus:outline-none";
  const tabs: [Pestana, string, boolean][] = [["ficha", "Ficha", fichaSucia], ["conexion", "Conexión", conSucia], ["umbrales", "Umbrales", umbSucio], ["registros", "Registros", false]];

  return (
    <div className="cm grid items-start gap-4 xl:grid-cols-[270px_minmax(0,1fr)_minmax(320px,400px)]">
      {/* ---------------- lista de equipos ---------------- */}
      <aside aria-label="Equipos del agente" className="panel flex flex-col gap-2 p-3 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
        <div className="flex items-center justify-between px-1">
          <span className="eyebrow">Equipos · {devs.length}</span>
          {faltan > 0 && <span className="rounded-full bg-amber-950 px-2 py-0.5 text-[11px] font-bold text-amber-300">{faltan} sin ficha completa</span>}
        </div>
        <input value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Buscar nombre, inventario, área…" aria-label="Buscar equipo" className="min-h-[36px] rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 placeholder:text-slate-600" />
        {/* filtro por tipo: tocar un chip lo muestra u oculta; doble clic deja solo ese tipo */}
        <div role="group" aria-label="Tipos de equipo visibles" className="flex flex-wrap gap-1.5">
          {(["ion", "pm", "gen"] as Tipo[]).map((t) => {
            const n = devs.filter((d) => tipoDe(d) === t).length;
            if (!n) return null;
            const on = tiposVisibles.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                title="Clic: mostrar u ocultar · doble clic: solo este tipo"
                onClick={() => setTiposVisibles(on ? tiposVisibles.filter((x) => x !== t) : [...tiposVisibles, t])}
                onDoubleClick={() => setTiposVisibles([t])}
                className="flex min-h-[30px] items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-bold transition-colors"
                style={{ borderColor: on ? TIPO_COLOR[t] : "#334155", background: on ? `${TIPO_COLOR[t]}1f` : "transparent", color: on ? TIPO_COLOR[t] : "#64748b" }}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: on ? TIPO_COLOR[t] : "#475569" }} />{TIPO_TXT[t]} <span className="mono font-semibold opacity-80">{n}</span>
              </button>
            );
          })}
          {tiposVisibles.length < 3 && <button type="button" onClick={() => setTiposVisibles(["ion", "pm", "gen"])} className="min-h-[30px] rounded-full px-2 text-[11px] font-semibold text-sky-300 hover:bg-slate-800">Todos</button>}
        </div>
        <label className="flex items-center gap-2 px-1 text-xs text-slate-400"><input type="checkbox" checked={soloFalta} onChange={(e) => setSoloFalta(e.target.checked)} /> Solo los que les falta información</label>
        {(["ion", "pm", "gen"] as Tipo[]).filter((t) => tiposVisibles.includes(t)).map((t) => {
          const lista = filtrados.filter((d) => tipoDe(d) === t);
          if (!lista.length) return null;
          const todos = devs.filter((d) => tipoDe(d) === t);
          const listos = todos.filter((d) => completa(fichaDe(d.name))).length;
          const vivos = todos.filter((d) => d.state === "online").length;
          const cerrado = plegados.includes(t);
          const editandoAqui = cerrado && lista.some((d) => d.name === dev.name);
          return (
            <div key={t} className="flex flex-col gap-1 rounded-xl border border-slate-800/80 bg-slate-950/40 p-1.5">
              <button type="button" onClick={() => plegar(t)} aria-expanded={!cerrado} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-slate-800/50">
                <span className="w-3 text-[10px] text-slate-500" aria-hidden="true">{cerrado ? "▸" : "▾"}</span>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: TIPO_COLOR[t] }} />
                <span className="flex-1 text-[11px] font-extrabold uppercase tracking-wider" style={{ color: TIPO_COLOR[t] }}>{TIPO_TXT[t]} · {lista.length}</span>
                <span className="mono text-[10px] text-slate-500" title="En línea">{vivos}/{todos.length} ●</span>
              </button>
              {editandoAqui && <span className="mx-1.5 truncate text-[10.5px] text-sky-300">Editando {dev.name}</span>}
              <div className="mx-1.5 mb-1 flex items-center gap-2" title={`${listos} de ${todos.length} con ficha completa`}>
                <span className="h-1 flex-1 overflow-hidden rounded bg-slate-800"><span className="block h-full rounded transition-[width] duration-500" style={{ width: `${todos.length ? (listos / todos.length) * 100 : 0}%`, background: listos === todos.length ? "#22c55e" : TIPO_COLOR[t] }} /></span>
                <span className="mono text-[10px] text-slate-500">{listos}/{todos.length} fichas</span>
              </div>
              {!cerrado && lista.map((d) => {
                const on = d.name === dev.name;
                const ok = completa(fichaDe(d.name));
                const cambiado = sucios.includes(d);
                const s = originales.get(d.name)?.con;
                return (
                  <button key={d.id} type="button" onClick={() => { setSel(d.name); setMsg(null); probar.reset(); setCopiar(false); }} aria-current={on ? "true" : undefined} className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors ${on ? "border-sky-700 bg-[#13213f]" : "border-transparent hover:bg-slate-800/60"}`}>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${d.state === "online" ? "latido bg-emerald-400" : "bg-rose-500"}`} />
                    <span className="min-w-0 flex-1">
                      <b className="block truncate text-[13px] text-slate-100">{d.name}{cambiado && <span className="ml-1 text-sky-300" title="Cambios sin guardar">●</span>}</b>
                      <span className="mono block truncate text-[10.5px] text-slate-500">{s ? `${s.host} · ID ${s.unitId}` : "—"}</span>
                    </span>
                    <span className={`shrink-0 text-[10px] font-bold ${ok ? "text-emerald-300" : "text-amber-300"}`}>{ok ? "Completa" : "Falta info"}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {(!filtrados.length || !tiposVisibles.length) && <p className="px-2 py-4 text-center text-xs text-slate-500">Ningún equipo con ese filtro.</p>}
      </aside>

      {/* ---------------- formulario ---------------- */}
      <section aria-label={`Configuración de ${dev.name}`} className="panel flex min-w-0 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-4 border-b border-slate-800 p-5">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border" style={{ color: TIPO_COLOR[tipo], borderColor: `${TIPO_COLOR[tipo]}55`, background: `${TIPO_COLOR[tipo]}14` }}><Icono tipo={tipo} size={24} /></span>
          <div className="min-w-[200px] flex-1">
            <span className="text-xs text-slate-400">{sedeNombre ? <>Sede <b className="text-slate-200">{sedeNombre}</b> ›</> : <span className="text-amber-300">Sin sede asignada ›</span>}</span>
            <h3 className="text-xl font-semibold text-slate-50">{dev.name}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="rounded-full px-2 py-0.5 font-bold" style={{ color: TIPO_COLOR[tipo], background: `${TIPO_COLOR[tipo]}1f` }}>{TIPO_TXT[tipo]}</span>
              {con && <span className="mono rounded-full bg-slate-800 px-2 py-0.5 text-slate-300">{con.host} · ID {con.unitId}</span>}
              <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${vivo ? "bg-emerald-950 text-emerald-300" : "bg-rose-950 text-rose-300"}`}><span className={`h-1.5 w-1.5 rounded-full ${vivo ? "latido bg-emerald-400" : "bg-rose-400"}`} />{vivo ? "En línea" : "Sin respuesta"} · {hace(dev.updatedAt)}</span>
            </div>
          </div>
          <div className="w-40">
            <div className="flex justify-between text-[11px] text-slate-400"><span>Ficha</span><b className="text-slate-200">{llenos}/{REQUERIDOS.length}</b></div>
            <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-800"><div className="h-full rounded transition-[width] duration-500" style={{ width: `${(llenos / REQUERIDOS.length) * 100}%`, background: llenos === REQUERIDOS.length ? "#22c55e" : "#f59e0b" }} /></div>
          </div>
        </div>

        <div role="tablist" aria-label="Secciones" className="flex flex-wrap gap-1 border-b border-slate-800 px-4 py-2">
          {tabs.map(([k, t, dirty]) => (
            <button key={k} type="button" role="tab" aria-selected={pestana === k} onClick={() => setPestana(k)} className={`flex min-h-[38px] items-center gap-1.5 rounded-lg px-4 text-sm font-bold ${pestana === k ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}>
              {t}{dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-300" title="Cambios sin guardar" />}
            </button>
          ))}
        </div>

        <div key={`${dev.id}-${pestana}`} className="entrar flex flex-col gap-4 p-5">
          {pestana === "ficha" && (
            <>
              {!enConfig && <p className="rounded-lg border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">Este equipo no está en la configuración remota de «{bk}»: su ficha se edita en el config.yaml del agente.</p>}
              <FichaCampos valor={ficha} onChange={(f) => setFichas({ ...fichas, [dev.name]: f })} disabled={!esAdmin || !enConfig} />
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" disabled={!esAdmin || !enConfig} onClick={() => setCopiar((c) => !c)} aria-expanded={copiar} className="min-h-[36px] rounded-lg border border-slate-700 px-3 text-xs font-semibold text-sky-300 hover:bg-slate-800 disabled:opacity-40">Copiar edificio, nivel, grupo y ambiente a otros equipos…</button>
                {!esAdmin && <small className="text-xs text-slate-500">Solo un administrador cambia la ficha.</small>}
              </div>
              {copiar && <CopiarA origen={dev} ficha={ficha} devs={devs} fichaDe={fichaDe} onAplicar={(nombres, campos) => {
                const nuevas = { ...fichas };
                for (const n of nombres) { const f = fichaDe(n); if (f) nuevas[n] = { ...f, ...Object.fromEntries(campos.map((c) => [c, ficha[c]])) }; }
                setFichas(nuevas);
                setCopiar(false);
                setMsg({ t: `Copiado a ${nombres.length} equipo(s). Revise y presione «Guardar cambios».`, ok: true });
              }} />}
            </>
          )}

          {pestana === "conexion" && (
            con ? (
              <>
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(140px,1fr))]">
                  <label className="flex flex-col gap-1.5 text-xs text-slate-400">IP<input className={`${campo} mono`} value={con.host} disabled={!esAdmin} onChange={(e) => setCons({ ...cons, [dev.name]: { ...con, host: e.target.value.trim() } })} /></label>
                  <label className="flex flex-col gap-1.5 text-xs text-slate-400">Puerto<input type="number" className={`${campo} mono`} value={con.port} disabled={!esAdmin} onChange={(e) => setCons({ ...cons, [dev.name]: { ...con, port: Number(e.target.value) } })} /></label>
                  <label className="flex flex-col gap-1.5 text-xs text-slate-400">ID Modbus<input type="number" min={0} max={255} className={`${campo} mono`} value={con.unitId} disabled={!esAdmin} onChange={(e) => setCons({ ...cons, [dev.name]: { ...con, unitId: Number(e.target.value) } })} /></label>
                  <label className="flex flex-col gap-1.5 text-xs text-slate-400">Leer cada (s)<input type="number" min={5} className={`${campo} mono`} value={con.intervalo} disabled={!esAdmin} onChange={(e) => setCons({ ...cons, [dev.name]: { ...con, intervalo: Number(e.target.value) } })} /></label>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={con.enabled} disabled={!esAdmin} onChange={(e) => setCons({ ...cons, [dev.name]: { ...con, enabled: e.target.checked } })} /> Lectura activa (el agente lo lee)</label>
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <button type="button" disabled={!puedeUmb || probar.isPending} onClick={() => probar.mutate({ deviceId: dev.id, ip: con.host, port: con.port, unitId: con.unitId, perfil })} className="min-h-[38px] rounded-lg border border-sky-700 px-4 text-sm font-bold text-sky-200 hover:bg-sky-950 disabled:opacity-40">{probar.isPending ? "Leyendo…" : "Probar lectura"}</button>
                  <span className="text-xs text-slate-500">Una lectura de prueba de solo lectura (función 03) con estos datos, sin guardarlos.</span>
                </div>
                {probar.data && (
                  <div className={`rounded-xl border p-3 text-sm ${probar.data.ok && probar.data.valido ? "border-emerald-900 bg-emerald-950/30 text-emerald-100" : "border-rose-900 bg-rose-950/30 text-rose-100"}`} role="status">
                    {probar.data.ok ? <>Respondió en <b className="mono">{probar.data.ms} ms</b>: {Object.entries(probar.data.valores ?? {}).map(([k, v]) => `${k.replace(/_/g, " ")} = ${v ?? "sin valor"}`).join(" · ")}{probar.data.valido ? "." : " — los valores no parecen de este tipo de equipo; revise el ID o el perfil."}</> : <>No respondió: {probar.data.error}</>}
                  </div>
                )}
                {probar.isError && <p className="text-sm text-rose-300">{extractErrorMessage(probar.error)}</p>}
                <small className="text-xs text-slate-500">Perfil de lectura: <span className="mono text-slate-300">{perfil}</span>. Equipos con la misma IP y distinto ID se leen por el cable RS-485 del primero.</small>
              </>
            ) : <p className="text-sm text-slate-400">Este equipo no está en la configuración remota de «{bk}».</p>
          )}

          {pestana === "umbrales" && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-slate-300">Norma {umb.data?.propios ? "· con valores propios de este equipo" : ""}</span>
                <select value={norma} disabled={!puedeUmb} onChange={(e) => setNorma(e.target.value as Norma)} className="min-h-[38px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100" aria-label="Norma">
                  {(Object.keys(NORMA_TXT) as Norma[]).map((n) => <option key={n} value={n}>{NORMA_TXT[n]}</option>)}
                </select>
              </div>
              {lim ? (
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
                  {([["tension", "Tensión ± %"], ["nominal", "Nominal V"], ["desbalance", "Desbalance %"], ["thdV", "THD tensión %"], ["thdI", "THD corriente %"], ["pst", "Pst"], ["fp", "FP mínimo"], ["freq", "Frecuencia ± Hz"], ["carga", "Carga máx. %"]] as [keyof Limites, string][]).map(([k, t]) => (
                    <label key={k} className="flex flex-col gap-1.5 text-xs text-slate-400">{t}<input type="number" step="any" disabled={!puedeUmb} className={`${campo} mono`} value={lim[k]} onChange={(e) => setLim({ ...lim, [k]: Number(e.target.value) })} /></label>
                  ))}
                </div>
              ) : <p className="text-sm text-slate-500">Cargando…</p>}
              <small className="text-xs text-slate-500">Se evalúan: {INDICADORES.map((i) => i.t).join(", ")}. Se usan en Normas y cumplimiento y en el semáforo.</small>
            </>
          )}

          {pestana === "registros" && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-500"><th className="py-2">Registro</th><th>Variable</th><th>Formato</th></tr></thead>
                <tbody>{(MAPA[perfil] ?? []).map((m) => <tr key={m.r} className="border-t border-slate-800/80"><td className="mono py-2 text-sky-200">{m.r}</td><td className="text-slate-200">{m.v}</td><td className="mono text-xs text-slate-400">{m.t}</td></tr>)}</tbody>
              </table>
              <small className="mt-2 block text-xs text-slate-500">Registros como los documenta Schneider (base 1); el agente pide la dirección menos uno. Solo función 03.</small>
            </div>
          )}
        </div>

        {/* barra de guardado */}
        <div className={`sticky bottom-0 mt-auto flex flex-wrap items-center gap-3 border-t px-5 py-3 ${hayCambios ? "border-sky-900 bg-[#0c1a33]" : "border-slate-800 bg-[#0a1222]"}`}>
          <span className="min-w-[200px] flex-1 text-sm" role="status">
            {msg ? <span className={msg.ok ? "text-emerald-300" : "text-rose-300"}>{msg.t}</span>
              : hayCambios ? <span className="text-sky-200">Cambios sin guardar en {[...sucios.map((d) => d.name), ...(umbSucio ? [`umbrales de ${dev.name}`] : [])].join(", ")}</span>
              : <span className="text-slate-500">Sin cambios pendientes</span>}
          </span>
          <button type="button" disabled={!hayCambios} onClick={descartar} className="min-h-[40px] rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-40">Descartar</button>
          <button type="button" disabled={!hayCambios || guardarCfg.isPending || guardarUmb.isPending || (sucios.length > 0 && !esAdmin)} onClick={() => void guardar()} className="min-h-[40px] rounded-lg bg-sky-600 px-5 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-40">{guardarCfg.isPending || guardarUmb.isPending ? "Guardando…" : "Guardar cambios"}</button>
        </div>
      </section>

      {/* ---------------- JSON v1 en vivo ---------------- */}
      <aside aria-label="Vista previa JSON v1" className="flex min-w-0 flex-col gap-2 xl:sticky xl:top-4">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Así viaja en cada lectura · JSON v1</span>
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-300"><span className="latido h-1.5 w-1.5 rounded-full bg-emerald-400" />en vivo</span>
        </div>
        <pre className="mono max-h-[calc(100vh-9rem)] overflow-auto rounded-xl border border-slate-800 bg-[#03070f] p-4 text-[11.5px] leading-relaxed text-sky-100">{json}</pre>
        <span className="text-[11px] text-slate-500">Mismos campos que la respuesta de Telemetría 1. La ficha se ve aquí al escribir; las métricas son la última lectura real del equipo.</span>
      </aside>
    </div>
  );
}

/** Copia campos de ubicacion de un equipo a otros (quedan como cambios sin guardar). */
function CopiarA({ origen, ficha, devs, fichaDe, onAplicar }: { origen: PilotDevice; ficha: Ficha; devs: PilotDevice[]; fichaDe: (n: string) => Ficha | undefined; onAplicar: (nombres: string[], campos: (keyof Ficha)[]) => void }) {
  const [elegidos, setElegidos] = useState<string[]>([]);
  const [campos, setCampos] = useState<(keyof Ficha)[]>(["building", "floor", "group", "room"]);
  const otros = devs.filter((d) => d.name !== origen.name);
  const nombresCampo: [keyof Ficha, string][] = [["building", "Edificio"], ["floor", "Nivel"], ["group", "Grupo"], ["room", "Ambiente"], ["area", "Área"], ["fase_energy", "Tipo de conexión"]];
  return (
    <div className="entrar flex flex-col gap-3 rounded-xl border border-sky-900 bg-sky-950/20 p-4">
      <div className="flex flex-wrap gap-2">
        {nombresCampo.map(([k, t]) => (
          <label key={k} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${campos.includes(k) ? "border-sky-600 bg-sky-950 text-sky-100" : "border-slate-700 text-slate-400"}`}>
            <input type="checkbox" className="sr-only" checked={campos.includes(k)} onChange={() => setCampos(campos.includes(k) ? campos.filter((c) => c !== k) : [...campos, k])} />
            {t}: <span className="font-normal">{String(ficha[k] || "—")}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>Copiar a:</span>
        <button type="button" onClick={() => setElegidos(elegidos.length === otros.length ? [] : otros.map((d) => d.name))} className="font-semibold text-sky-300">{elegidos.length === otros.length ? "Ninguno" : "Todos"}</button>
      </div>
      <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(170px,1fr))]">
        {otros.map((d) => {
          const on = elegidos.includes(d.name);
          const t = tipoDe(d);
          return (
            <label key={d.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-xs ${on ? "border-sky-600 bg-sky-950/60 text-white" : "border-slate-800 text-slate-300 hover:bg-slate-800/50"}`}>
              <input type="checkbox" checked={on} onChange={() => setElegidos(on ? elegidos.filter((x) => x !== d.name) : [...elegidos, d.name])} />
              <span className="h-2 w-2 rounded-full" style={{ background: TIPO_COLOR[t] }} />
              <span className="truncate font-semibold">{d.name}</span>
              <span className="ml-auto truncate text-[10px] text-slate-500">{fichaDe(d.name)?.building || ""}</span>
            </label>
          );
        })}
      </div>
      <div className="flex justify-end">
        <button type="button" disabled={!elegidos.length || !campos.length} onClick={() => onAplicar(elegidos, campos)} className="min-h-[38px] rounded-lg bg-sky-600 px-4 text-sm font-bold text-white disabled:opacity-40">Aplicar a {elegidos.length} equipo(s)</button>
      </div>
    </div>
  );
}
