import { useEffect, useMemo, useState } from "react";
import { useGravixBus } from "../../store/gravix.store";
import { downloadFile } from "../../api/access";

/** Equipo que se puede exportar (lo arma el Centro de mando). */
export interface EquipoExportable {
  key: string;
  sedeId: string;
  sedeNombre: string;
  nombre: string;
  inventario: string | null;
  kind: "ion" | "pm" | "gen";
  /** "p:<deviceId>" (Agente Go / Gravix de sede) o "c:<sede>:<medidor>" (Telemetria 1). */
  ref: string;
  /** Claves de las metricas que tiene el equipo. */
  metricas: string[];
  origen: string;
  /** El equipo guarda espectro de armonicos (ION7400 leido directo). */
  armonicos: boolean;
}

/** "3,5,7" o "2-25" -> lista de ordenes validos (1 a 63). */
function ordenesDe(txt: string): number[] {
  const n = new Set<number>();
  for (const p of txt.split(",")) {
    const m = /^\s*(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*$/.exec(p);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let k = Math.max(1, Math.min(a, b)); k <= Math.min(63, Math.max(a, b)); k++) n.add(k);
  }
  return [...n].sort((x, y) => x - y);
}
const ORDENES_RAPIDOS: [string, string][] = [["3,5,7,9,11,13,15", "Impares 3–15"], ["2-25", "H2 a H25"], ["2-50", "H2 a H50"], ["1-63", "Todos (H1 a H63)"]];

const TIPO_TXT: Record<EquipoExportable["kind"], string> = { ion: "ION7400", pm: "PM2130", gen: "Generador" };

/** Grupos de metricas para elegir mas facil. */
const GRUPOS: { id: string; nombre: string; re: RegExp }[] = [
  { id: "potencia", nombre: "Potencia y demanda", re: /power|demand|kw|kva|kvar|ebo:kw/i },
  { id: "voltaje", nombre: "Voltaje", re: /volt|ebo:v$/i },
  { id: "corriente", nombre: "Corriente", re: /current|amp|ebo:a$/i },
  { id: "energia", nombre: "Energía", re: /energy|kwh/i },
  { id: "fp", nombre: "Factor de potencia", re: /factor|_pf|^pf/i },
  { id: "frecuencia", nombre: "Frecuencia", re: /freq/i },
  { id: "calidad", nombre: "Distorsión y desbalance", re: /thd|tdd|unbal|desbal|harm|flicker|k_factor|crest/i },
  { id: "generador", nombre: "Generador", re: /gen_|fuel|battery|oil|coolant|engine|rpm|run/i },
];
const grupoDe = (m: string) => GRUPOS.find((g) => g.re.test(m))?.id ?? "otras";
/** Seleccion rapida "básicas". */
const BASICAS = /^(active_power_total|demand_total|gen_kw_total_metering|voltage_a_n|voltage_b_n|voltage_c_n|current_a|current_b|current_c|power_factor_total|frequency|ebo:kw|ebo:v|ebo:a)$/;

const PASOS: [number, string][] = [[60, "1 minuto"], [300, "5 minutos"], [900, "15 minutos"], [3600, "1 hora"], [86400, "1 día"]];

/** "2026-11-23T08:00" en hora local del navegador. */
const local = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const inicioDia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export default function ExportarHistorial({ sedes, equipos, etiqueta }: { sedes: { id: string; nombre: string; color: string | null }[]; equipos: EquipoExportable[]; etiqueta: (m: string) => string }) {
  const [sedesSel, setSedesSel] = useState<Set<string>>(new Set());
  const [eqSel, setEqSel] = useState<Set<string>>(new Set());
  const [mSel, setMSel] = useState<Set<string>>(new Set());
  const [buscarEq, setBuscarEq] = useState("");
  const [buscarM, setBuscarM] = useState("");
  const [tipos, setTipos] = useState<Set<EquipoExportable["kind"]>>(new Set(["ion", "pm", "gen"]));
  const ahora = new Date();
  const [desde, setDesde] = useState(local(new Date(ahora.getTime() - 7 * 86_400_000)));
  const [hasta, setHasta] = useState(local(ahora));
  const [paso, setPaso] = useState(900);
  // Armonicos (ION7400)
  const [armOn, setArmOn] = useState(false);
  const [armSen, setArmSen] = useState<Set<string>>(new Set(["v", "i"]));
  const [armFas, setArmFas] = useState<Set<string>>(new Set(["a", "b", "c"]));
  const [armOrd, setArmOrd] = useState("3,5,7,9,11,13,15");
  const [armModo, setArmModo] = useState<"pct" | "valor" | "ambos">("pct");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState<string | null>(null);

  // Exportacion que Gravix dejo lista: llena el formulario; la persona revisa y descarga.
  const pre = useGravixBus((s) => s.preExportar);
  const setPre = useGravixBus((s) => s.setPreExportar);
  useEffect(() => {
    if (!pre) return;
    const claves = new Set(pre.equipos);
    setSedesSel(new Set(pre.sedes));
    setEqSel(claves);
    setTipos(new Set(["ion", "pm", "gen"]));
    setBuscarEq("");
    setBuscarM("");
    setMSel(pre.armonicos ? new Set() : new Set(equipos.filter((e) => claves.has(e.key)).flatMap((e) => e.metricas).filter((m) => BASICAS.test(m))));
    setArmOn(pre.armonicos);
    setDesde(local(new Date(pre.desde)));
    setHasta(local(new Date(pre.hasta)));
    setPaso(pre.paso);
    setPre(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pre]);

  const toggle = <T,>(set: Set<T>, v: T) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };

  // Paso 2: equipos de las sedes elegidas
  const visibles = useMemo(() => {
    const q = buscarEq.trim().toLowerCase();
    return equipos.filter((e) => sedesSel.has(e.sedeId) && tipos.has(e.kind) && (!q || `${e.nombre} ${e.inventario ?? ""}`.toLowerCase().includes(q)));
  }, [equipos, sedesSel, tipos, buscarEq]);
  const elegidos = equipos.filter((e) => eqSel.has(e.key) && sedesSel.has(e.sedeId));

  // Paso 3: metricas de los equipos elegidos (con cuantos equipos la tienen)
  const metricas = useMemo(() => {
    const cuenta = new Map<string, number>();
    for (const e of elegidos) for (const m of e.metricas) cuenta.set(m, (cuenta.get(m) ?? 0) + 1);
    const q = buscarM.trim().toLowerCase();
    return [...cuenta.entries()]
      .filter(([m]) => !q || `${m} ${etiqueta(m)}`.toLowerCase().includes(q))
      .sort((a, b) => etiqueta(a[0]).localeCompare(etiqueta(b[0]), "es"));
  }, [elegidos, buscarM, etiqueta]);
  const porGrupo = useMemo(() => {
    const g = new Map<string, [string, number][]>();
    for (const x of metricas) {
      const id = grupoDe(x[0]);
      if (!g.has(id)) g.set(id, []);
      g.get(id)!.push(x);
    }
    return [...GRUPOS.map((x) => ({ id: x.id, nombre: x.nombre })), { id: "otras", nombre: "Otras" }].filter((x) => g.has(x.id)).map((x) => ({ ...x, lista: g.get(x.id)! }));
  }, [metricas]);
  const disponibles = new Set(elegidos.flatMap((e) => e.metricas));
  const mElegidas = [...mSel].filter((m) => disponibles.has(m));

  // Paso 4: rango y tamaño estimado
  const dDesde = new Date(desde);
  const dHasta = new Date(hasta);
  const rangoOk = !Number.isNaN(dDesde.getTime()) && !Number.isNaN(dHasta.getTime()) && dHasta > dDesde;
  const filasAprox = rangoOk ? Math.ceil((dHasta.getTime() - dDesde.getTime()) / 1000 / paso) : 0;
  const rapido = (dias: number | "hoy" | "ayer" | "mes" | "mesAnterior") => {
    const hoy = inicioDia(new Date());
    let a: Date, b: Date;
    if (dias === "hoy") { a = hoy; b = new Date(); }
    else if (dias === "ayer") { a = new Date(hoy.getTime() - 86_400_000); b = hoy; }
    else if (dias === "mes") { a = new Date(hoy.getFullYear(), hoy.getMonth(), 1); b = new Date(); }
    else if (dias === "mesAnterior") { a = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1); b = new Date(hoy.getFullYear(), hoy.getMonth(), 1); }
    else { a = new Date(Date.now() - dias * 86_400_000); b = new Date(); }
    setDesde(local(a));
    setHasta(local(b));
  };

  const conArm = elegidos.filter((e) => e.armonicos);
  const ordenes = ordenesDe(armOrd);
  const colsArm = armSen.size * armFas.size * ordenes.length * (armModo === "ambos" ? 2 : 1);
  const armActivo = armOn && conArm.length > 0 && colsArm > 0;
  const exceso = elegidos.length > 40 ? "Máximo 40 equipos por archivo" : mElegidas.length > 60 ? "Máximo 60 métricas por archivo" : null;
  const puede = elegidos.length > 0 && (mElegidas.length > 0 || armActivo) && rangoOk && !ocupado && !exceso;
  const descargar = async () => {
    setError(null);
    setListo(null);
    setOcupado(true);
    try {
      await downloadFile(
        "/exportar/historial",
        {
          equipos: elegidos.map((e) => e.ref).join(","),
          nombres: elegidos.map((e) => e.nombre.replace(/\|/g, "/")).join("|"),
          sedes: elegidos.map((e) => e.sedeNombre.replace(/\|/g, "/")).join("|"),
          metricas: mElegidas.join(","),
          etiquetas: mElegidas.map((m) => etiqueta(m).replace(/\|/g, "/")).join("|"),
          desde: dDesde.toISOString(),
          hasta: dHasta.toISOString(),
          step: paso,
          ...(armActivo ? { armSenales: [...armSen].join(","), armFases: [...armFas].join(","), armOrdenes: ordenes.join(","), armModo } : {}),
        },
        `historial_${desde.slice(0, 10)}_a_${hasta.slice(0, 10)}.xlsx`,
      );
      setListo(`Excel generado: ${elegidos.length} ${elegidos.length === 1 ? "equipo" : "equipos"}, ${mElegidas.length} ${mElegidas.length === 1 ? "métrica" : "métricas"}${armActivo ? ` y armónicos de ${conArm.length} ION7400` : ""}.`);
    } catch (e) {
      let msg = (e as Error).message;
      const datos = (e as { response?: { data?: Blob } }).response?.data;
      if (datos instanceof Blob) {
        try {
          const j = JSON.parse(await datos.text()) as { message?: string | string[] };
          if (j.message) msg = Array.isArray(j.message) ? j.message.join("; ") : j.message;
        } catch {
          /* mensaje generico */
        }
      }
      setError(msg);
    } finally {
      setOcupado(false);
    }
  };

  const chip = (on: boolean) => `min-h-[34px] rounded-full border px-3 text-[12.5px] font-semibold transition-colors ${on ? "border-sky-500 bg-sky-500/15 text-sky-100" : "border-slate-700 bg-slate-900/60 text-slate-300 hover:border-slate-500"}`;
  const paso_ = (n: number, titulo: string, sub: string) => (
    <div className="flex items-center gap-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-blue-600 to-cyan-500 text-[13px] font-extrabold text-white">{n}</span>
      <span className="flex flex-col"><b className="text-[14px] text-slate-100">{titulo}</b><span className="text-[12px] text-slate-400">{sub}</span></span>
    </div>
  );

  return (
    <section aria-label="Exportar historial de métricas" className="flex flex-col gap-4">
      <div className="panel flex flex-wrap items-center gap-3 p-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="eyebrow">Exportar historial de métricas</span>
          <span className="text-[13px] text-slate-400">Elija sedes, equipos, métricas y un rango de fechas; se descarga un Excel con una hoja por equipo, un comparativo alineado por fecha y un resumen. Solo administradores.</span>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* 1. sedes */}
        <div className="panel flex flex-col gap-3 p-4">
          {paso_(1, "Sedes", `${sedesSel.size} de ${sedes.length} elegidas`)}
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={chip(sedesSel.size === sedes.length && sedes.length > 0)} onClick={() => setSedesSel(sedesSel.size === sedes.length ? new Set() : new Set(sedes.map((s) => s.id)))}>
              {sedesSel.size === sedes.length ? "Quitar todas" : "Todas"}
            </button>
            {sedes.map((s) => (
              <button key={s.id} type="button" aria-pressed={sedesSel.has(s.id)} onClick={() => setSedesSel((p) => toggle(p, s.id))} className={`${chip(sedesSel.has(s.id))} flex items-center gap-1.5`}>
                {s.color && <span className="h-2 w-2 rounded-[3px]" style={{ background: s.color }} />}
                {s.nombre}
                <span className="mono text-[11px] text-slate-500">{equipos.filter((e) => e.sedeId === s.id).length}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 4. rango */}
        <div className="panel flex flex-col gap-3 p-4">
          {paso_(4, "Rango de fechas", rangoOk ? `${filasAprox.toLocaleString("es-GT")} filas aprox. por equipo` : "La fecha final debe ser mayor que la inicial")}
          <div className="flex flex-wrap gap-1.5">
            {([["hoy", "Hoy"], ["ayer", "Ayer"], [7, "Últimos 7 días"], [30, "Últimos 30 días"], ["mes", "Este mes"], ["mesAnterior", "Mes anterior"], [60, "Últimos 60 días"]] as const).map(([k, t]) => (
              <button key={String(k)} type="button" onClick={() => rapido(k)} className={chip(false)}>{t}</button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-[12px] text-slate-400">Desde
              <input type="datetime-local" value={desde} onChange={(e) => setDesde(e.target.value)} className="min-h-[40px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-[13px] text-slate-100 [color-scheme:dark]" />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-slate-400">Hasta
              <input type="datetime-local" value={hasta} onChange={(e) => setHasta(e.target.value)} className="min-h-[40px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-[13px] text-slate-100 [color-scheme:dark]" />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-slate-400">Un dato cada
              <select value={paso} onChange={(e) => setPaso(Number(e.target.value))} className="min-h-[40px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-[13px] text-slate-100">
                {PASOS.map(([v, t]) => <option key={v} value={v}>{t} (promedio)</option>)}
              </select>
            </label>
          </div>
          {filasAprox > 100_000 && <p className="m-0 text-[12px] text-amber-300">Con ese rango e intervalo pasan de 100 000 filas: el archivo usará un intervalo mayor automáticamente.</p>}
          <p className="m-0 text-[11.5px] text-slate-500">Cada sede Gravix guarda 60 días de detalle. Las sedes de Telemetría 1 exportan kW, voltaje y corriente promedio del monitoreo central.</p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* 2. equipos */}
        <div className="panel flex flex-col gap-3 p-4">
          {paso_(2, "Equipos", `${elegidos.length} elegidos`)}
          {sedesSel.size === 0 ? (
            <p className="m-0 py-6 text-center text-[13px] text-slate-500">Primero elija una o más sedes.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input type="search" value={buscarEq} onChange={(e) => setBuscarEq(e.target.value)} placeholder="Buscar por nombre o inventario…" aria-label="Buscar equipo" className="min-h-[36px] min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-[13px] text-slate-100 placeholder:text-slate-500" />
                {(["ion", "pm", "gen"] as const).map((k) => (
                  <button key={k} type="button" aria-pressed={tipos.has(k)} onClick={() => setTipos((p) => toggle(p, k))} className={chip(tipos.has(k))}>{TIPO_TXT[k]}</button>
                ))}
              </div>
              <div className="flex gap-2 text-[12px]">
                <button type="button" className="text-sky-300 hover:underline" onClick={() => setEqSel((p) => new Set([...p, ...visibles.map((e) => e.key)]))}>Elegir los {visibles.length} visibles</button>
                <span className="text-slate-600">·</span>
                <button type="button" className="text-slate-400 hover:underline" onClick={() => setEqSel(new Set())}>Ninguno</button>
              </div>
              <div className="flex max-h-[360px] flex-col gap-3 overflow-y-auto pr-1">
                {sedes.filter((s) => sedesSel.has(s.id)).map((s) => {
                  const lista = visibles.filter((e) => e.sedeId === s.id);
                  if (!lista.length) return null;
                  const todos = lista.every((e) => eqSel.has(e.key));
                  return (
                    <div key={s.id} className="flex flex-col gap-1">
                      <label className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.08em] text-slate-300">
                        <input type="checkbox" checked={todos} onChange={() => setEqSel((p) => { const n = new Set(p); lista.forEach((e) => (todos ? n.delete(e.key) : n.add(e.key))); return n; })} />
                        {s.nombre} <span className="mono font-normal normal-case tracking-normal text-slate-500">{lista.length}</span>
                      </label>
                      {lista.map((e) => (
                        <label key={e.key} className={`ml-5 flex min-h-[34px] cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] ${eqSel.has(e.key) ? "bg-sky-500/10 text-slate-100" : "text-slate-300 hover:bg-slate-800/60"}`}>
                          <input type="checkbox" checked={eqSel.has(e.key)} onChange={() => setEqSel((p) => toggle(p, e.key))} />
                          <span className="min-w-0 flex-1 truncate">{e.nombre}{e.inventario ? <span className="mono ml-1.5 text-[11px] text-slate-500">{e.inventario}</span> : null}</span>
                          <span className="text-[10.5px] text-slate-500">{TIPO_TXT[e.kind]} · {e.origen}</span>
                        </label>
                      ))}
                    </div>
                  );
                })}
                {!visibles.length && <p className="m-0 py-4 text-center text-[13px] text-slate-500">No hay equipos con ese filtro.</p>}
              </div>
            </>
          )}
        </div>

        {/* 3. metricas */}
        <div className="panel flex flex-col gap-3 p-4">
          {paso_(3, "Métricas", `${mElegidas.length} elegidas`)}
          {elegidos.length === 0 ? (
            <p className="m-0 py-6 text-center text-[13px] text-slate-500">Elija equipos para ver sus métricas.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input type="search" value={buscarM} onChange={(e) => setBuscarM(e.target.value)} placeholder="Buscar métrica…" aria-label="Buscar métrica" className="min-h-[36px] min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-[13px] text-slate-100 placeholder:text-slate-500" />
                <button type="button" className={chip(false)} onClick={() => setMSel(new Set([...disponibles].filter((m) => BASICAS.test(m))))}>Básicas</button>
                <button type="button" className={chip(false)} onClick={() => setMSel(new Set(disponibles))}>Todas</button>
                <button type="button" className={chip(false)} onClick={() => setMSel(new Set())}>Ninguna</button>
              </div>
              <div className="flex max-h-[360px] flex-col gap-3 overflow-y-auto pr-1">
                {porGrupo.map((g) => {
                  const todas = g.lista.every(([m]) => mSel.has(m));
                  return (
                    <div key={g.id} className="flex flex-col gap-1">
                      <label className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.08em] text-slate-300">
                        <input type="checkbox" checked={todas} onChange={() => setMSel((p) => { const n = new Set(p); g.lista.forEach(([m]) => (todas ? n.delete(m) : n.add(m))); return n; })} />
                        {g.nombre} <span className="mono font-normal normal-case tracking-normal text-slate-500">{g.lista.length}</span>
                      </label>
                      <div className="ml-5 flex flex-wrap gap-1.5">
                        {g.lista.map(([m, n]) => (
                          <button key={m} type="button" aria-pressed={mSel.has(m)} onClick={() => setMSel((p) => toggle(p, m))} title={`${m} · la tienen ${n} de ${elegidos.length} equipos`} className={chip(mSel.has(m))}>
                            {etiqueta(m)}
                            {n < elegidos.length && <span className="mono ml-1 text-[10.5px] text-slate-500">{n}/{elegidos.length}</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Armonicos del ION7400 (espectro H1..H63 guardado cada 10 min) */}
          {conArm.length > 0 && (
            <div className="flex flex-col gap-2.5 rounded-xl border border-violet-500/40 bg-violet-500/[.07] p-3">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={armOn} onChange={(e) => setArmOn(e.target.checked)} />
                <b className="text-[13.5px] text-violet-100">Armónicos (ION7400)</b>
                <span className="text-[11.5px] text-violet-200/70">{conArm.length} de {elegidos.length} equipos los tienen · espectro cada 10 min</span>
              </label>
              {armOn && (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="w-14 text-[11.5px] text-slate-400">Señal</span>
                    {([["v", "Voltaje"], ["i", "Corriente"]] as const).map(([k, t]) => (
                      <button key={k} type="button" aria-pressed={armSen.has(k)} onClick={() => setArmSen((p) => toggle(p, k))} className={chip(armSen.has(k))}>{t}</button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="w-14 text-[11.5px] text-slate-400">Fases</span>
                    {(["a", "b", "c"] as const).map((k) => (
                      <button key={k} type="button" aria-pressed={armFas.has(k)} onClick={() => setArmFas((p) => toggle(p, k))} className={chip(armFas.has(k))}>Fase {k.toUpperCase()}</button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="w-14 text-[11.5px] text-slate-400">Órdenes</span>
                    {ORDENES_RAPIDOS.map(([v, t]) => (
                      <button key={v} type="button" aria-pressed={armOrd === v} onClick={() => setArmOrd(v)} className={chip(armOrd === v)}>{t}</button>
                    ))}
                    <input
                      value={armOrd}
                      onChange={(e) => setArmOrd(e.target.value)}
                      aria-label="Órdenes de armónicos (ej. 3,5,7 o 2-25)"
                      placeholder="3,5,7 o 2-25"
                      className="mono min-h-[34px] w-40 rounded-lg border border-slate-700 bg-slate-950 px-2 text-[12px] text-slate-100"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="w-14 text-[11.5px] text-slate-400">Mostrar</span>
                    {([["pct", "% de la fundamental (como el ION)"], ["valor", "Valor en V / A"], ["ambos", "Ambos"]] as const).map(([k, t]) => (
                      <button key={k} type="button" aria-pressed={armModo === k} onClick={() => setArmModo(k)} className={chip(armModo === k)}>{t}</button>
                    ))}
                  </div>
                  <span className={`text-[11.5px] ${colsArm ? "text-violet-200/80" : "text-amber-300"}`}>
                    {colsArm
                      ? `${colsArm} columnas por ION7400 (${ordenes.length} ${ordenes.length === 1 ? "orden" : "órdenes"}), en una hoja «Armónicos» por equipo.`
                      : "Elija al menos una señal, una fase y un orden válido (1 a 63)."}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="panel flex flex-wrap items-center gap-3 p-4" style={{ borderColor: "rgba(34,197,94,.45)", background: "linear-gradient(160deg,rgba(34,197,94,.1),#0b1220 70%)" }}>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <b className="text-[14px] text-slate-100">
            {elegidos.length} {elegidos.length === 1 ? "equipo" : "equipos"} · {mElegidas.length} {mElegidas.length === 1 ? "métrica" : "métricas"} · {rangoOk ? `${new Date(desde).toLocaleString("es-GT")} → ${new Date(hasta).toLocaleString("es-GT")}` : "rango no válido"}
          </b>
          <span className="text-[12px] text-slate-400">Hojas: Resumen, Comparativo (todo alineado por fecha), una por equipo e Información. Máximo 40 equipos y 60 métricas por archivo.</span>
          {exceso && <span className="text-[12.5px] text-amber-300">{exceso}</span>}
          {error && <span role="alert" className="text-[12.5px] text-rose-300">{error}</span>}
          {listo && <span className="text-[12.5px] text-emerald-300">{listo}</span>}
        </div>
        <button type="button" disabled={!puede} onClick={() => void descargar()} className="min-h-[44px] rounded-xl bg-emerald-500 px-5 text-[14px] font-bold text-emerald-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40">
          {ocupado ? "Preparando el Excel…" : "⬇ Descargar Excel"}
        </button>
      </div>
    </section>
  );
}
