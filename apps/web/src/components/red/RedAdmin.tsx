import { useEffect, useMemo, useState } from "react";
import { apiClient, API_BASE_URL } from "../../api/client";
import { useAgents } from "../../api/agents";
import { extractErrorMessage } from "../../api/errors";
import type { CentroSede } from "../../api/centro";
import { useBorrarGrupo, useBorrarSede, useCrearGrupo, useEditarGrupo, useGuardarSede, useProbarGravix, useTelemetriaV1, type RedGrupo, type RedSede } from "../../api/red";
import { Descubrir } from "../../routes/Equipos";

/**
 * Administración de la red del centro de mando (solo administradores):
 *  - NuevaSede: asistente de 4 pasos (datos y plantilla → Agente Go → descubrir equipos → listo).
 *  - EditarSede: nombre, fase, ubicación y agentes de una sede (o solo la fase de una del monitoreo central).
 *  - GestionGrupos: crear, renombrar, colorear, ordenar y borrar las fases (Telemetría 1, 2, 3…).
 *  - BotonJsonV1: la respuesta de una sede nueva en el formato v1 de Telemetría 1.
 */

const PLANTILLAS = [
  { id: "hospital", t: "Hospital completo", d: "Analizadores ION7400, medidores PM2130, generador y sensores LoRaWAN. Igual que Escuintla.", items: ["Modbus TCP · IDs 1, 2, 21, 255", "Generador por RS-485", "Norma NTSD"] },
  { id: "periferica", t: "Consultorio / periférica", d: "Medidores PM2130 y sensores LoRaWAN, sin generador.", items: ["Modbus TCP · IDs 1, 2", "Norma NTSD"] },
  { id: "personalizada", t: "Personalizada", d: "Usted elige qué buscar y qué agregar.", items: ["A medida"] },
] as const;

const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const CODIGO_OK = /^[a-z0-9][a-z0-9-]{1,62}$/;
const campo = "min-h-[40px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none";
const etiqueta = "flex min-w-0 flex-col gap-1.5 text-xs text-slate-400";

function useEsc(onCerrar: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onCerrar]);
}

function Modal({ titulo, sub, ancho = 980, onCerrar, children, pie }: { titulo: string; sub?: string; ancho?: number; onCerrar: () => void; children: React.ReactNode; pie?: React.ReactNode }) {
  useEsc(onCerrar);
  return (
    <div className="cm-modal arriba" role="presentation" onClick={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="caja cm entrar flex flex-col" role="dialog" aria-modal="true" aria-label={titulo} style={{ width: `min(${ancho}px, 100%)` }}>
        <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0 flex-1">
            <strong className="block text-lg text-slate-50">{titulo}</strong>
            {sub && <span className="text-xs text-slate-400">{sub}</span>}
          </div>
          <button type="button" onClick={onCerrar} aria-label="Cerrar" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800">✕</button>
        </div>
        <div className="p-5">{children}</div>
        {pie && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 bg-[#0a1222] px-5 py-3.5">{pie}</div>}
      </div>
    </div>
  );
}

function SelectorGrupo({ grupos, valor, onChange }: { grupos: RedGrupo[]; valor: string | null; onChange: (id: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Fase de telemetría" className="flex flex-wrap gap-1.5">
      {grupos.map((g) => {
        const on = valor === g.id;
        return (
          <button key={g.id} type="button" role="radio" aria-checked={on} onClick={() => onChange(g.id)} className="flex min-h-[38px] items-center gap-2 rounded-lg border px-3.5 text-sm font-semibold" style={{ borderColor: on ? g.color : "#334155", background: on ? `${g.color}26` : "#020617", color: on ? "#f1f5f9" : "#94a3b8" }}>
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: g.color }} />{g.nombre}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================ asistente: nueva sede */
export function NuevaSede({ grupos, sedes, idsExistentes, agentesEnUso, sedeId, pasoInicial, agenteInicial, onCerrar, onAbrirSede }: {
  /** Crear la sede para un agente que ya existe (desde Equipos). */
  agenteInicial?: string;
  grupos: RedGrupo[];
  sedes: RedSede[];
  idsExistentes: string[];
  /** Agente → sede que ya lo usa (un agente lee una sola sede). */
  agentesEnUso: Record<string, string>;
  /** Sede nueva ya creada: el asistente abre directo en "Descubrir equipos". */
  sedeId: string | null;
  pasoInicial: number;
  onCerrar: () => void;
  onAbrirSede: (id: string) => void;
}) {
  const existente = sedeId ? sedes.find((s) => s.id === sedeId) ?? null : null;
  const [paso, setPaso] = useState(existente ? pasoInicial : 1);
  const [nombre, setNombre] = useState(existente?.nombre ?? "");
  const [codigo, setCodigo] = useState(existente?.id ?? "");
  const [codigoEditado, setCodigoEditado] = useState(!!existente);
  const [grupoId, setGrupoId] = useState<string | null>(existente?.grupoId ?? grupos.find((g) => g.id === "t2")?.id ?? grupos[0]?.id ?? null);
  const [plantilla, setPlantilla] = useState(existente?.plantilla ?? "hospital");
  const [lat, setLat] = useState(existente?.lat != null ? String(existente.lat) : "");
  const [lon, setLon] = useState(existente?.lon != null ? String(existente.lon) : "");
  const [modo, setModo] = useState<"nuevo" | "existente" | "gravix">(existente?.origen === "gravix" ? "gravix" : existente?.agentes.length || agenteInicial ? "existente" : "nuevo");
  /** Sede con su propio Gravix: direccion de su API y clave de consulta (CENTRO_API_KEY de su .env). */
  const [gxUrl, setGxUrl] = useState(existente?.url ?? "");
  const [gxClave, setGxClave] = useState("");
  const probar = useProbarGravix();
  const [agente, setAgente] = useState(existente?.agentes[0] ?? agenteInicial ?? "");
  const [clave, setClave] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creandoClave, setCreandoClave] = useState(false);
  const agentes = useAgents({ fast: paso === 2 && modo === "nuevo" });
  const guardar = useGuardarSede();

  const codigoFinal = codigoEditado ? codigo : nombre ? `igss-${slug(nombre)}` : "";
  const gxAgentes = probar.data?.agentes.map((a) => a.buildingKey) ?? existente?.agentes ?? [];
  const bkAgente = modo === "gravix" ? gxAgentes[0] ?? "" : modo === "nuevo" ? codigoFinal : agente;
  const infoAgente = (agentes.data ?? []).find((a) => a.buildingKey === bkAgente) ?? null;
  const conectado = !!infoAgente?.lastSync;
  const nLat = lat.trim() === "" ? null : Number(lat), nLon = lon.trim() === "" ? null : Number(lon);
  const coordsOk = (nLat == null && nLon == null) || (nLat != null && nLon != null && Number.isFinite(nLat) && Number.isFinite(nLon) && Math.abs(nLat) <= 90 && Math.abs(nLon) <= 180);

  const errPaso1 = nombre.trim().length < 2 ? "Escriba el nombre de la sede." : !CODIGO_OK.test(codigoFinal) ? "El código solo lleva minúsculas, números y guiones." : !existente && idsExistentes.includes(codigoFinal) ? "Ya existe una sede con ese código." : !grupoId ? "Elija la fase de telemetría." : !coordsOk ? "Revise la latitud y la longitud (por ejemplo 14.305 y -90.785)." : null;
  const usadoPor = bkAgente && agentesEnUso[bkAgente] && agentesEnUso[bkAgente] !== codigoFinal ? agentesEnUso[bkAgente] : null;
  const errPaso2 = modo === "gravix"
    ? !probar.data ? "Pruebe la conexión con el Gravix de la sede antes de seguir." : null
    : !bkAgente ? "Elija el agente de la sede." : !CODIGO_OK.test(bkAgente) ? "El código del agente no es válido." : usadoPor ? `Ese agente ya lee la sede ${usadoPor}: cada sede necesita su propio agente.` : null;

  async function crearClave() {
    setCreandoClave(true);
    setError(null);
    try {
      const { data } = await apiClient.post<{ key: string }>("/api-keys", { name: `Agente ${nombre.trim() || codigoFinal}`, role: "agent" });
      setClave(data.key);
    } catch (e) {
      setError(extractErrorMessage(e, "No se pudo crear la API key del agente"));
    } finally {
      setCreandoClave(false);
    }
  }

  function guardarSede(siguiente: number) {
    setError(null);
    guardar.mutate(
      modo === "gravix"
        ? { id: codigoFinal, nombre: nombre.trim(), origen: "gravix", grupoId, agentes: gxAgentes, lat: nLat, lon: nLon, plantilla, url: gxUrl.trim(), apiKey: gxClave.trim() || undefined }
        : { id: codigoFinal, nombre: nombre.trim(), origen: "nodivo", grupoId, agentes: [bkAgente], lat: nLat, lon: nLon, plantilla },
      { onSuccess: () => setPaso(siguiente), onError: (e) => setError(extractErrorMessage(e, "No se pudo guardar la sede")) },
    );
  }

  function siguiente() {
    setError(null);
    if (paso === 1) return errPaso1 ? setError(errPaso1) : setPaso(2);
    if (paso === 2) return errPaso2 ? setError(errPaso2) : guardarSede(3);
    if (paso === 3) return setPaso(4);
    onAbrirSede(codigoFinal);
  }

  const yaml = `buildingKey: "${bkAgente}"
api:
  baseUrl: "${API_BASE_URL}"
  apiKey: "${clave ?? "<la API key de arriba>"}"
syncIntervalSeconds: 30
# Los equipos se agregan desde Nodivo (Descubrir y agregar): el agente los recibe solo.
remoteConfig: true`;

  const pasos = ["Datos y plantilla", "Agente de la sede", "Descubrir equipos", "Listo"];
  const pl = PLANTILLAS.find((p) => p.id === plantilla) ?? PLANTILLAS[0];

  return (
    <Modal
      titulo={existente ? `Buscar equipos · ${existente.nombre}` : "Nueva sede"}
      sub="Se crea con una plantilla; su Agente Go descubre los equipos por IP y los agrega con su ficha"
      ancho={1080}
      onCerrar={onCerrar}
      pie={
        <>
          <button type="button" onClick={() => (paso > 1 && paso < 4 && !(existente && paso === pasoInicial) ? setPaso(paso - 1) : onCerrar())} className="min-h-[42px] rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-300 hover:bg-slate-800">{paso > 1 && paso < 4 && !(existente && paso === pasoInicial) ? "← Atrás" : "Cerrar"}</button>
          {error ? <span className="text-sm text-rose-300" role="alert">{error}</span> : <span className="text-xs text-slate-500">Paso {paso} de 4</span>}
          <button type="button" onClick={siguiente} disabled={guardar.isPending} className="min-h-[42px] rounded-lg bg-sky-600 px-5 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-50">
            {guardar.isPending ? "Guardando…" : paso === 2 ? "Crear sede y seguir →" : paso === 3 ? "Terminar →" : paso === 4 ? "Abrir la sede" : "Siguiente →"}
          </button>
        </>
      }
    >
      <ol className="mb-5 grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        {pasos.map((t, i) => {
          const n = i + 1, hecho = n < paso, actual = n === paso;
          return (
            <li key={t} className="flex items-center gap-2.5" aria-current={actual ? "step" : undefined}>
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border text-xs font-bold ${hecho ? "border-emerald-600 bg-emerald-600 text-white" : actual ? "border-sky-500 bg-sky-600 text-white" : "border-slate-700 text-slate-500"}`}>{hecho ? "✓" : n}</span>
              <span className={`text-[13px] font-semibold ${actual ? "text-white" : hecho ? "text-slate-300" : "text-slate-500"}`}>{t}</span>
            </li>
          );
        })}
      </ol>

      {paso === 1 && (
        <div className="flex flex-col gap-5">
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
            <label className={etiqueta}>Nombre de la sede<input className={campo} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej. Quetzaltenango" autoFocus /></label>
            <label className={etiqueta}>Código (identifica la sede y su agente)
              <input className={`${campo} mono`} value={codigoFinal} onChange={(e) => { setCodigoEditado(true); setCodigo(e.target.value.toLowerCase()); }} placeholder="igss-quetzaltenango" disabled={!!existente} />
            </label>
          </div>
          <div className={etiqueta}>Fase de telemetría<SelectorGrupo grupos={grupos} valor={grupoId} onChange={setGrupoId} /></div>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
            <label className={etiqueta}>Latitud<input className={`${campo} mono`} value={lat} onChange={(e) => setLat(e.target.value)} placeholder="14.305" inputMode="decimal" /></label>
            <label className={etiqueta}>Longitud<input className={`${campo} mono`} value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-90.785" inputMode="decimal" /></label>
            <p className="self-end pb-2 text-xs text-slate-500">Para ubicarla en el mapa. En Google Maps: clic derecho sobre la sede → se copian las coordenadas.</p>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-slate-400">Plantilla</span>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
              {PLANTILLAS.map((p) => {
                const on = plantilla === p.id;
                return (
                  <button key={p.id} type="button" aria-pressed={on} onClick={() => setPlantilla(p.id)} className={`flex flex-col gap-2 rounded-xl border p-4 text-left ${on ? "border-sky-600 bg-sky-950/40" : "border-slate-800 bg-slate-950/60 hover:border-slate-600"}`}>
                    <span className="flex justify-between gap-2"><b className="text-[15px] text-slate-50">{p.t}</b>{on && <span className="text-xs font-bold text-sky-300">✓ Elegida</span>}</span>
                    <span className="text-[12.5px] leading-snug text-slate-400">{p.d}</span>
                    <span className="flex flex-wrap gap-1.5">{p.items.map((it) => <span key={it} className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">{it}</span>)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {paso === 2 && (
        <div className="flex flex-col gap-4">
          <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5 text-sm leading-relaxed text-slate-300">
            Para descubrir y leer equipos, la sede necesita un <b className="text-slate-50">Agente Go dentro de su red</b>: las IP de los medidores solo se alcanzan desde ahí. El agente solo lee (función 03); nunca escribe en los equipos.
          </p>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
            {([["gravix", "La sede tiene su Gravix", "VM de la sede con Gravix + Agente Go (docker compose). El centro la consulta."], ["nuevo", "Instalar un agente nuevo", "En una PC o servidor de la sede. Se le crea su API key aquí mismo."], ["existente", "Usar un agente que ya existe", "Si la sede ya tiene un Agente Go reportando a Nodivo."]] as const).map(([k, t, d]) => (
              <button key={k} type="button" aria-pressed={modo === k} onClick={() => setModo(k)} className={`flex flex-col gap-1.5 rounded-xl border p-4 text-left ${modo === k ? "border-sky-600 bg-sky-950/40" : "border-slate-800 bg-slate-950/60 hover:border-slate-600"}`}>
                <span className="flex justify-between"><b className="text-[15px] text-slate-50">{t}</b>{modo === k && <span className="text-xs font-bold text-sky-300">✓ Elegida</span>}</span>
                <span className="text-[12.5px] text-slate-400">{d}</span>
              </button>
            ))}
          </div>

          {modo === "gravix" ? (
            <div className="flex flex-col gap-3">
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
                <label className={etiqueta}>Dirección del Gravix de la sede
                  <input className={`${campo} mono`} value={gxUrl} onChange={(e) => { setGxUrl(e.target.value); probar.reset(); }} placeholder="http://10.20.5.10:3010" />
                </label>
                <label className={etiqueta}>Clave de consulta (CENTRO_API_KEY de su .env)
                  <input className={`${campo} mono`} type="password" autoComplete="off" value={gxClave} onChange={(e) => { setGxClave(e.target.value); probar.reset(); }} placeholder={existente?.claveFinal ? `Guardada: ••••${existente.claveFinal}` : "siasa_…"} />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" disabled={!gxUrl.trim() || probar.isPending} onClick={() => probar.mutate({ url: gxUrl.trim(), apiKey: gxClave.trim() || undefined, sedeId: existente?.id })} className="min-h-[38px] rounded-lg border border-sky-700 px-3.5 text-sm font-bold text-sky-200 hover:bg-sky-950 disabled:opacity-50">
                  {probar.isPending ? "Probando…" : "Probar conexión"}
                </button>
                <span className="text-xs text-slate-500">La clave queda cifrada en el servidor central y no se vuelve a mostrar.</span>
              </div>
              {probar.isError && <p className="rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-200" role="alert">{extractErrorMessage(probar.error, "No se pudo conectar con la sede")}</p>}
              {probar.data && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-800 bg-emerald-950/30 px-4 py-3" role="status">
                  <span className="latido h-2.5 w-2.5 rounded-full bg-emerald-400" />
                  <span className="min-w-[220px] flex-1 text-sm">
                    <b className="text-slate-100">Gravix de sede conectado · v{probar.data.version}</b>
                    <span className="block text-xs text-slate-400">
                      {probar.data.sede.nombre} · {probar.data.equipos} equipos · agentes: {probar.data.agentes.map((a) => `${a.buildingKey}${a.agentVersion ? ` v${a.agentVersion}` : ""}`).join(", ") || "ninguno todavía"}
                    </span>
                  </span>
                </div>
              )}
            </div>
          ) : modo === "existente" ? (
            <label className={etiqueta}>Agente
              <select className={campo} value={agente} onChange={(e) => setAgente(e.target.value)}>
                <option value="">Elija un agente…</option>
                {(agentes.data ?? []).map((a) => {
                  const uso = agentesEnUso[a.buildingKey] && agentesEnUso[a.buildingKey] !== codigoFinal ? agentesEnUso[a.buildingKey] : null;
                  return <option key={a.buildingKey} value={a.buildingKey} disabled={!!uso}>{a.buildingKey}{a.lastSync?.agentVersion ? ` · v${a.lastSync.agentVersion}` : ""}{uso ? ` · ya lo usa ${uso}` : a.hasConfig ? "" : " · sin configuración remota"}</option>;
                })}
              </select>
              <span className="text-[11px] text-slate-500">Cada sede necesita su propio agente: los que ya leen otra sede no se pueden elegir.</span>
            </label>
          ) : (
            <div className="flex flex-col gap-3">
              <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-slate-300">
                <li>Cree la API key del agente (se muestra una sola vez).</li>
                <li>En el equipo de la sede, junto al programa <span className="mono text-slate-100">agente-go</span>, guarde este <span className="mono text-slate-100">config.yaml</span>.</li>
                <li>Inicie el agente. Este paso se completa solo cuando se conecta.</li>
              </ol>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={crearClave} disabled={!!clave || creandoClave} className="min-h-[38px] rounded-lg border border-sky-700 px-3.5 text-sm font-bold text-sky-200 hover:bg-sky-950 disabled:opacity-50">{clave ? "API key creada ✓" : creandoClave ? "Creando…" : "Crear API key del agente"}</button>
                {clave && <span className="text-xs text-amber-200">Cópiela ahora: no se vuelve a mostrar.</span>}
              </div>
              <div className="relative">
                <pre className="mono overflow-x-auto rounded-xl border border-slate-800 bg-[#03070f] p-4 text-[12.5px] leading-relaxed text-sky-100">{yaml}</pre>
                <button type="button" onClick={() => void navigator.clipboard?.writeText(yaml)} className="absolute right-2 top-2 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-800">Copiar</button>
              </div>
            </div>
          )}

          {bkAgente && modo !== "gravix" && (
            <div className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 ${conectado ? "border-emerald-800 bg-emerald-950/30" : "border-amber-900 bg-amber-950/20"}`} role="status">
              <span className={`h-2.5 w-2.5 rounded-full ${conectado ? "latido bg-emerald-400" : "latido bg-amber-400"}`} />
              <span className="min-w-[220px] flex-1 text-sm">
                <b className="text-slate-100">{conectado ? `Agente conectado${infoAgente?.lastSync?.agentVersion ? ` · v${infoAgente.lastSync.agentVersion}` : ""}` : "Esperando al agente…"}</b>
                <span className="block text-xs text-slate-400">{conectado ? (infoAgente?.hasConfig ? "Listo para buscar equipos." : "Conectado, pero sin configuración remota: active «remoteConfig: true» en su config.yaml.") : "Puede seguir: la sede se crea igual y los equipos se buscan cuando el agente se conecte."}</span>
              </span>
            </div>
          )}
        </div>
      )}

      {paso === 3 && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
            <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold">Plantilla: {pl.t}</span>
            {pl.items.map((it) => <span key={it} className="rounded-full bg-slate-900 px-2.5 py-1 text-xs text-slate-400">{it}</span>)}
          </div>
          {modo === "gravix" ? (
            <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
              <p>Esta sede tiene su propio Gravix: los equipos se buscan y se agregan en <b className="text-slate-100">su web local</b>, que lee la red de la sede. El centro los muestra solo en la próxima consulta (15 s).</p>
              {(() => {
                try {
                  const u = new URL(gxUrl.trim());
                  const web = `${u.protocol}//${u.hostname}:5173`;
                  return <p>Web local de la sede: normalmente <a className="mono text-sky-300 underline" href={web} target="_blank" rel="noreferrer">{web}</a> (usuario admin; la clave está en ADMIN_PASSWORD de su .env).</p>;
                } catch {
                  return null;
                }
              })()}
            </div>
          ) : bkAgente ? <Descubrir bk={bkAgente} remoto={!!infoAgente?.hasConfig} /> : <p className="text-sm text-slate-400">La sede no tiene agente.</p>}
        </div>
      )}

      {paso === 4 && (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
          <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <span className="eyebrow">Resumen</span>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-[11px] text-slate-500">Sede</dt><dd className="font-semibold text-slate-100">{nombre}</dd></div>
              <div><dt className="text-[11px] text-slate-500">Código</dt><dd className="mono text-xs font-semibold text-slate-100">{codigoFinal}</dd></div>
              <div><dt className="text-[11px] text-slate-500">Fase</dt><dd className="font-semibold text-slate-100">{grupos.find((g) => g.id === grupoId)?.nombre ?? "—"}</dd></div>
              <div><dt className="text-[11px] text-slate-500">Agente</dt><dd className="mono text-xs font-semibold text-slate-100">{bkAgente}</dd></div>
            </dl>
          </div>
          <ul className="flex flex-col gap-2 text-sm text-slate-300">
            {["La sede ya aparece en el árbol, dentro de su fase, y en el mapa (si tiene ubicación).", "Cada equipo agregado se lee cada 15-30 s y su historial queda guardado.", "Un equipo fuera de línea llega a la campana y al Centro de alertas.", "Su respuesta en formato v1 de Telemetría 1 está en «JSON v1» dentro de la sede.", "Puede buscar más equipos cuando quiera desde la misma sede."].map((t) => (
              <li key={t} className="flex gap-2"><span className="font-bold text-emerald-400">✓</span>{t}</li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

/* ============================================================ editar sede */
export function EditarSede({ sede, fila, nueva, grupos, grupoActual, agentesEnUso, confirmarInicial = false, onCerrar, onBorrada }: {
  sede: CentroSede | null;
  fila: RedSede | null;
  nueva: boolean;
  grupos: RedGrupo[];
  grupoActual: string | null;
  agentesEnUso: Record<string, string>;
  /** Abre directo en la confirmacion de "Quitar sede". */
  confirmarInicial?: boolean;
  onCerrar: () => void;
  onBorrada: () => void;
}) {
  const guardar = useGuardarSede();
  const borrar = useBorrarSede();
  const [nombre, setNombre] = useState(fila?.nombre ?? sede?.nombre ?? "");
  const [grupoId, setGrupoId] = useState<string | null>(grupoActual);
  const [lat, setLat] = useState(fila?.lat != null ? String(fila.lat) : "");
  const [lon, setLon] = useState(fila?.lon != null ? String(fila.lon) : "");
  const [agentes, setAgentes] = useState((fila?.agentes ?? []).join(", "));
  const [confirmar, setConfirmar] = useState(confirmarInicial);
  const [msg, setMsg] = useState<string | null>(null);
  const esGravix = fila?.origen === "gravix";
  const [url, setUrl] = useState(fila?.url ?? "");
  const [claveNueva, setClaveNueva] = useState("");
  if (!sede) return null;

  function guardarCambios() {
    setMsg(null);
    if (esGravix) {
      const nLatG = lat.trim() === "" ? null : Number(lat), nLonG = lon.trim() === "" ? null : Number(lon);
      guardar.mutate(
        { id: sede!.id, nombre: nombre.trim(), origen: "gravix", grupoId, agentes: fila!.agentes, lat: nLatG, lon: nLonG, plantilla: fila?.plantilla ?? null, url: url.trim(), ...(claveNueva.trim() ? { apiKey: claveNueva.trim() } : {}) },
        { onSuccess: onCerrar, onError: (e) => setMsg(extractErrorMessage(e, "No se pudo guardar")) },
      );
      return;
    }
    const lista = agentes.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    const ajeno = lista.find((a) => agentesEnUso[a] && agentesEnUso[a] !== sede!.id);
    if (nueva && ajeno) return setMsg(`El agente ${ajeno} ya lee la sede ${agentesEnUso[ajeno]}.`);
    const nLat = lat.trim() === "" ? null : Number(lat), nLon = lon.trim() === "" ? null : Number(lon);
    if (nueva && ((nLat == null) !== (nLon == null) || (nLat != null && !Number.isFinite(nLat)) || (nLon != null && !Number.isFinite(nLon)))) return setMsg("Revise la latitud y la longitud.");
    guardar.mutate(
      nueva
        ? { id: sede!.id, nombre: nombre.trim(), origen: "nodivo", grupoId, agentes: lista, lat: nLat, lon: nLon, plantilla: fila?.plantilla ?? null }
        : { id: sede!.id, nombre: sede!.nombre, origen: "central", grupoId, agentes: [], lat: null, lon: null, plantilla: null },
      { onSuccess: onCerrar, onError: (e) => setMsg(extractErrorMessage(e, "No se pudo guardar")) },
    );
  }

  return (
    <Modal
      titulo={nueva ? `Editar sede · ${sede.nombre}` : `Fase de ${sede.nombre}`}
      sub={esGravix ? "Sede con su propio Gravix (VM local): el centro la consulta" : nueva ? "Sede leída por Agentes Go" : "Sede del monitoreo central: aquí solo se elige su fase"}
      ancho={720}
      onCerrar={onCerrar}
      pie={
        <>
          {nueva ? (
            confirmar ? (
              <span className="flex flex-wrap items-center gap-2 text-sm text-rose-200">¿Quitar «{sede.nombre}» del centro de mando? Sale del árbol y del mapa; {esGravix ? "el Gravix de la sede sigue funcionando y no se borra nada allá." : "el agente, sus equipos y su historial no se borran."}
                <button type="button" onClick={() => borrar.mutate(sede.id, { onSuccess: onBorrada, onError: (e) => setMsg(extractErrorMessage(e, "No se pudo quitar")) })} className="min-h-[36px] rounded-lg bg-rose-700 px-3 text-xs font-bold text-white">Sí, quitar</button>
                <button type="button" onClick={() => setConfirmar(false)} className="min-h-[36px] rounded-lg border border-slate-700 px-3 text-xs text-slate-300">No</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmar(true)} className="min-h-[40px] rounded-lg border border-rose-900 px-3 text-sm font-semibold text-rose-300 hover:bg-rose-950/40">Quitar sede</button>
            )
          ) : <span />}
          {msg && <span className="text-sm text-rose-300" role="alert">{msg}</span>}
          <button type="button" onClick={guardarCambios} disabled={guardar.isPending} className="min-h-[42px] rounded-lg bg-sky-600 px-5 text-sm font-bold text-white disabled:opacity-50">{guardar.isPending ? "Guardando…" : "Guardar"}</button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {nueva && <label className={etiqueta}>Nombre<input className={campo} value={nombre} onChange={(e) => setNombre(e.target.value)} /></label>}
        <div className={etiqueta}>Fase de telemetría<SelectorGrupo grupos={grupos} valor={grupoId} onChange={setGrupoId} /></div>
        {nueva && (
          <>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
              <label className={etiqueta}>Latitud<input className={`${campo} mono`} value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" /></label>
              <label className={etiqueta}>Longitud<input className={`${campo} mono`} value={lon} onChange={(e) => setLon(e.target.value)} inputMode="decimal" /></label>
            </div>
            {esGravix ? (
              <>
                <label className={etiqueta}>Dirección del Gravix de la sede<input className={`${campo} mono`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://10.20.5.10:3010" /></label>
                <label className={etiqueta}>Clave de consulta (CENTRO_API_KEY)
                  <input className={`${campo} mono`} type="password" autoComplete="off" value={claveNueva} onChange={(e) => setClaveNueva(e.target.value)} placeholder={fila?.claveFinal ? `Guardada: ••••${fila.claveFinal}. Déjela vacía para conservarla` : "Pegue la clave de la sede"} />
                </label>
                <p className="text-xs text-slate-500">Agentes de la sede (los informa la propia sede): <span className="mono text-slate-300">{fila?.agentes.join(", ") || "ninguno"}</span></p>
                <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
                  Alarmas y correos (de dónde se leen, envío, destinatarios, servidor de correo y reglas): <b className="text-slate-200">Centro de mando → pestaña «Alarmas y correos»</b>.
                  Hoy se leen de <b className="text-slate-200">{fila?.alarmasFuente === "gravix" ? "Gravix" : "api-SIASA"}</b>
                  {fila?.estado?.alarmas ? <> · Gravix {fila.estado.alarmas.correoActivo ? "envía correos" : "no envía (modo paralelo)"}</> : null}.
                </p>
              </>
            ) : (
              <label className={etiqueta}>Agentes Go de la sede (códigos separados por coma)<input className={`${campo} mono`} value={agentes} onChange={(e) => setAgentes(e.target.value)} /></label>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/* ============================================================ grupos (fases) */
export function GestionGrupos({ grupos, conteo, onCerrar }: { grupos: RedGrupo[]; conteo: (id: string) => number; onCerrar: () => void }) {
  const crear = useCrearGrupo();
  const editar = useEditarGrupo();
  const borrar = useBorrarGrupo();
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [nuevo, setNuevo] = useState({ nombre: "", color: "#f472b6" });
  const [msg, setMsg] = useState<string | null>(null);
  const [aBorrar, setABorrar] = useState<string | null>(null);
  const orden = useMemo(() => [...grupos].sort((a, b) => a.orden - b.orden), [grupos]);
  const err = (e: unknown) => setMsg(extractErrorMessage(e, "No se pudo guardar"));

  function mover(i: number, d: -1 | 1) {
    const a = orden[i], b = orden[i + d];
    if (!a || !b) return;
    editar.mutate({ id: a.id, orden: b.orden }, { onError: err });
    editar.mutate({ id: b.id, orden: a.orden }, { onError: err });
  }

  return (
    <Modal titulo="Grupos del árbol" sub="Fases del proyecto: Telemetría 1, 2, 3… Las sedes del monitoreo central sin fase quedan en Telemetría 1." ancho={720} onCerrar={onCerrar}>
      <div className="flex flex-col gap-2">
        {orden.map((g, i) => (
          <div key={g.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
            <input type="color" aria-label={`Color de ${g.nombre}`} value={g.color} onChange={(e) => editar.mutate({ id: g.id, color: e.target.value }, { onError: err })} className="h-9 w-10 cursor-pointer rounded border border-slate-700 bg-transparent" />
            <input aria-label="Nombre del grupo" className={`${campo} min-w-[180px] flex-1`} value={nombres[g.id] ?? g.nombre} onChange={(e) => setNombres({ ...nombres, [g.id]: e.target.value })} onBlur={() => { const n = (nombres[g.id] ?? g.nombre).trim(); if (n.length >= 2 && n !== g.nombre) editar.mutate({ id: g.id, nombre: n }, { onError: err }); }} />
            <span className="mono w-16 text-center text-xs text-slate-400">{conteo(g.id)} sedes</span>
            <button type="button" onClick={() => mover(i, -1)} disabled={i === 0} aria-label="Subir" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-700 text-slate-300 disabled:opacity-30">↑</button>
            <button type="button" onClick={() => mover(i, 1)} disabled={i === orden.length - 1} aria-label="Bajar" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-700 text-slate-300 disabled:opacity-30">↓</button>
            {aBorrar === g.id ? (
              <span className="flex items-center gap-1.5">
                <button type="button" onClick={() => borrar.mutate(g.id, { onSuccess: () => setABorrar(null), onError: err })} className="min-h-[36px] rounded-lg bg-rose-700 px-2.5 text-xs font-bold text-white">Borrar</button>
                <button type="button" onClick={() => setABorrar(null)} className="min-h-[36px] rounded-lg border border-slate-700 px-2.5 text-xs text-slate-300">No</button>
              </span>
            ) : (
              <button type="button" onClick={() => setABorrar(g.id)} aria-label={`Borrar ${g.nombre}`} className="grid h-9 w-9 place-items-center rounded-lg border border-rose-900 text-rose-300">✕</button>
            )}
          </div>
        ))}
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-slate-700 p-2.5">
          <input type="color" aria-label="Color del grupo nuevo" value={nuevo.color} onChange={(e) => setNuevo({ ...nuevo, color: e.target.value })} className="h-9 w-10 cursor-pointer rounded border border-slate-700 bg-transparent" />
          <input aria-label="Nombre del grupo nuevo" className={`${campo} min-w-[180px] flex-1`} value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} placeholder="Ej. Telemetría 4" />
          <button type="button" disabled={nuevo.nombre.trim().length < 2 || crear.isPending} onClick={() => crear.mutate({ nombre: nuevo.nombre.trim(), color: nuevo.color }, { onSuccess: () => setNuevo({ nombre: "", color: "#f472b6" }), onError: err })} className="min-h-[40px] rounded-lg bg-sky-600 px-4 text-sm font-bold text-white disabled:opacity-40">Agregar grupo</button>
        </div>
        {aBorrar && <p className="text-xs text-amber-200">Al borrar un grupo sus sedes quedan «Sin grupo» (las del monitoreo central vuelven a Telemetría 1). No se borra ninguna sede.</p>}
        {msg && <p className="text-sm text-rose-300" role="alert">{msg}</p>}
      </div>
    </Modal>
  );
}

/* ============================================================ JSON v1 */
export function BotonJsonV1({ sedeId, nombre }: { sedeId: string; nombre: string }) {
  const [abierto, setAbierto] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setAbierto(true)} className="min-h-[34px] rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs font-semibold text-slate-200 hover:bg-slate-800">JSON v1</button>
      {abierto && <VisorJson sedeId={sedeId} nombre={nombre} onCerrar={() => setAbierto(false)} />}
    </>
  );
}

function VisorJson({ sedeId, nombre, onCerrar }: { sedeId: string; nombre: string; onCerrar: () => void }) {
  const q = useTelemetriaV1(sedeId);
  const texto = q.data ? JSON.stringify(q.data, null, 2) : "";
  return (
    <Modal titulo={`JSON v1 · ${nombre}`} sub={`Mismo formato que Telemetría 1 · GET /api/v1/red/sedes/${sedeId}/telemetria · se actualiza cada 30 s`} ancho={900} onCerrar={onCerrar}
      pie={<><span className="text-xs text-slate-500">{q.data ? `${q.data.devices.length} equipos` : ""}</span><button type="button" disabled={!texto} onClick={() => void navigator.clipboard?.writeText(texto)} className="min-h-[38px] rounded-lg border border-slate-700 px-3.5 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40">Copiar JSON</button></>}
    >
      {q.isLoading ? <p className="py-8 text-center text-sm text-slate-500">Cargando…</p> : q.isError ? <p className="text-sm text-rose-300">{extractErrorMessage(q.error)}</p> : (
        <pre className="mono max-h-[60vh] overflow-auto rounded-xl border border-slate-800 bg-[#03070f] p-4 text-[12px] leading-relaxed text-sky-100">{texto}</pre>
      )}
    </Modal>
  );
}
