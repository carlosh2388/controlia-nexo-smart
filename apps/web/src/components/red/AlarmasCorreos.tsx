import { useEffect, useMemo, useState } from "react";
import { extractErrorMessage } from "../../api/errors";
import { abrirCorreo, useAlarmasSede, useCorreoPrueba, useGuardarAlarmas, type FuenteAlarmas, type RedGrupo } from "../../api/red";

/**
 * Modulo "Alarmas y correos" del Centro de mando (solo administradores). Por sede:
 *  - de donde lee el Centro de mando las alarmas (api-SIASA, la actual, o el Gravix de la sede);
 *  - si el Gravix de la sede envia los correos, a quien, por que servidor y con que tiempos.
 * Todo se guarda en la sede (alarma_config) y se aplica al momento, sin entrar al servidor ni al codigo.
 */

const campo = "min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-sky-500";
const etiqueta = "flex flex-col gap-1.5 text-xs text-slate-400";

const REGLAS: [string, string, string][] = [
  ["ALERTA_FUERA_DE_LINEA_MIN", "Medidor fuera de línea a los", "min"],
  ["ALERTA_OFFLINE_SIN_CAMBIO_MIN", "Fuera de línea por valores repetidos a los", "min"],
  ["ALERTA_EN_CERO_MIN", "Voltaje en cero a los", "min"],
  ["ALERTA_SIN_CAMBIO_MIN", "Medidor sin cambio a los", "min"],
  ["ALERTA_CONGELADO_MIN", "Datos congelados (Gravix sin lecturas del agente) a los", "min"],
  ["ALERTA_TRANSFERENCIA_CONFIRMACION_S", "Confirmación de transferencia / vigilantes S1-S2", "s"],
  ["ALERTA_RECORDATORIO_HORAS", "Recordatorio de críticos abiertos cada (0 = sin recordatorio)", "h"],
  ["ALERTA_MAX_CORREOS_POR_HORA", "Máximo de correos por hora", "correos"],
];

const TIPO_CORREO: Record<string, string> = {
  apertura: "Alarma",
  cierre: "Resuelto",
  recordatorio: "Recordatorio",
  "grupo-apertura": "Varios medidores",
  "grupo-cierre": "Varios resueltos",
  "grupo-advertencia": "Advertencias",
  resumen: "Resumen diario",
  prueba: "Prueba",
};

export interface SedeAlarmas {
  id: string;
  nombre: string;
  grupo: RedGrupo | null;
  gravix: boolean;
}

export function AlarmasCorreos({ sedes }: { sedes: SedeAlarmas[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const [buscar, setBuscar] = useState("");
  const lista = useMemo(
    () => [...sedes].sort((a, b) => Number(b.gravix) - Number(a.gravix) || a.nombre.localeCompare(b.nombre)).filter((s) => !buscar || s.nombre.toLowerCase().includes(buscar.toLowerCase())),
    [sedes, buscar],
  );
  useEffect(() => {
    if (!sel && lista.length) setSel(lista[0].id);
  }, [lista, sel]);

  return (
    <div className="grid gap-4 [grid-template-columns:minmax(220px,280px)_1fr] max-[860px]:grid-cols-1">
      <aside className="panel flex flex-col gap-2 p-3" aria-label="Sedes">
        <input className={campo} placeholder="Buscar sede…" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
        <ul className="flex flex-col gap-1">
          {lista.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => setSel(s.id)} aria-current={sel === s.id}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm ${sel === s.id ? "bg-sky-950/60 text-white ring-1 ring-sky-700" : "text-slate-300 hover:bg-slate-800"}`}>
                <span className="flex items-center gap-2">
                  {s.grupo && <span className="h-2 w-2 rounded-[3px]" style={{ background: s.grupo.color }} />}
                  {s.nombre}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${s.gravix ? "bg-emerald-950 text-emerald-300" : "bg-slate-800 text-slate-400"}`}>{s.gravix ? "Gravix" : "api-SIASA"}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      {sel ? <PanelSede key={sel} sede={sedes.find((s) => s.id === sel)!} /> : <p className="text-sm text-slate-400">Elija una sede.</p>}
    </div>
  );
}

function PanelSede({ sede }: { sede: SedeAlarmas }) {
  const q = useAlarmasSede(sede.id);
  const guardar = useGuardarAlarmas();
  const prueba = useCorreoPrueba();
  const [cambios, setCambios] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const d = q.data;
  const cfg = d?.gravix?.config ?? null;
  const val = (k: string) => (k in cambios ? cambios[k] : cfg?.valores[k] ?? "");
  const poner = (k: string, v: string) => setCambios((c) => ({ ...c, [k]: v }));
  const pendientes = Object.keys(cambios).length;

  function guardarCambios() {
    setMsg(null);
    guardar.mutate(
      { id: sede.id, cambios },
      { onSuccess: () => { setCambios({}); setMsg({ ok: true, t: "Cambios guardados en la sede y aplicados." }); }, onError: (e) => setMsg({ ok: false, t: extractErrorMessage(e, "No se pudo guardar") }) },
    );
  }
  function cambiarFuente(f: FuenteAlarmas) {
    setMsg(null);
    guardar.mutate({ id: sede.id, fuente: f }, { onError: (e) => setMsg({ ok: false, t: extractErrorMessage(e, "No se pudo cambiar la fuente") }) });
  }

  if (q.isLoading) return <section className="panel p-5 text-sm text-slate-400">Cargando…</section>;
  if (q.isError || !d) return <section className="panel p-5 text-sm text-rose-300">{extractErrorMessage(q.error, "No se pudo leer la configuración de la sede")}</section>;

  return (
    <section className="flex flex-col gap-4" aria-label={`Alarmas y correos de ${sede.nombre}`}>
      <div className="panel flex flex-col gap-1 p-5">
        <span className="eyebrow">Alarmas y correos</span>
        <h2 className="text-2xl font-semibold text-slate-50">{sede.nombre}</h2>
        {cfg?.actualizado && <span className="text-xs text-slate-500">Última modificación: {new Date(cfg.actualizado).toLocaleString("es-GT")}{cfg.actualizadoPor ? ` · ${cfg.actualizadoPor}` : ""}</span>}
      </div>

      {/* 1. Fuente */}
      <div className="panel flex flex-col gap-3 p-5">
        <h3 className="text-sm font-bold text-slate-100">1. ¿De dónde lee el Centro de mando las alarmas de esta sede?</h3>
        {!d.tieneGravix ? (
          <p className="text-sm text-slate-300">De la <b>api-SIASA de la sede</b>, que es la que envía los correos. Esta sede todavía no tiene su propio Gravix, así que es la única opción.</p>
        ) : (
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
            {([
              ["api-siasa", "api-SIASA de la sede (actual)", "Alarmas, campana y hora de los correos salen de la api-SIASA, con datos del AS-P."],
              ["gravix", "Gravix de la sede", "Salen del motor de Gravix (mismas reglas, lectura directa). El Centro de mando deja de consumir las alarmas de la api-SIASA."],
            ] as const).map(([k, t, x]) => (
              <button key={k} type="button" aria-pressed={d.fuente === k} disabled={guardar.isPending} onClick={() => d.fuente !== k && cambiarFuente(k)}
                className={`flex flex-col gap-1 rounded-xl border p-3.5 text-left ${d.fuente === k ? "border-sky-600 bg-sky-950/40" : "border-slate-800 bg-slate-950/60 hover:border-slate-600"}`}>
                <span className="flex justify-between"><b className="text-sm text-slate-50">{t}</b>{d.fuente === k && <span className="text-xs font-bold text-sky-300">✓ En uso</span>}</span>
                <span className="text-xs text-slate-400">{x}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {d.tieneGravix && !d.gravix?.conectado && <p className="panel p-4 text-sm text-rose-300">El Gravix de la sede no responde: no se puede leer ni cambiar su configuración ahora.</p>}

      {d.tieneGravix && cfg && (
        <>
          {/* 2. Envio */}
          <div className="panel flex flex-col gap-3 p-5">
            <h3 className="text-sm font-bold text-slate-100">2. Envío de correos desde Gravix</h3>
            <Interruptor activo={val("ALERTAS_CORREO_ACTIVO") === "true"} onCambio={(v) => poner("ALERTAS_CORREO_ACTIVO", String(v))}
              si="Gravix ENVÍA los correos" no="Gravix NO envía (modo paralelo: solo los prepara para comparar)" />
            {val("ALERTAS_CORREO_ACTIVO") === "true" && cfg.valores.ALERTAS_CORREO_ACTIVO !== "true" && (
              <p className="rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
                Si la api-SIASA de la sede sigue enviando, los responsables recibirán <b>cada correo dos veces</b>. Active esto cuando quien administra la api-SIASA de la sede haya apagado su envío.
              </p>
            )}
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
              <label className={etiqueta}>Para (separados por coma)<input className={campo} value={val("ALERTAS_CORREO_PARA")} onChange={(e) => poner("ALERTAS_CORREO_PARA", e.target.value)} placeholder="mantenimiento@igss.gob.gt" /></label>
              <label className={etiqueta}>Copia (CC)<input className={campo} value={val("ALERTAS_CORREO_CC")} onChange={(e) => poner("ALERTAS_CORREO_CC", e.target.value)} /></label>
              <label className={etiqueta}>Remitente (De)<input className={campo} value={val("ALERTAS_CORREO_DE")} onChange={(e) => poner("ALERTAS_CORREO_DE", e.target.value)} placeholder="alertas@…" /></label>
            </div>
            <p className="text-xs text-slate-500">Estado del correo en la sede: <span className={d.gravix?.estado?.correo_activo ? "text-emerald-300" : "text-amber-200"}>{cfg.correo}</span></p>
          </div>

          {/* 3. SMTP */}
          <div className="panel flex flex-col gap-3 p-5">
            <h3 className="text-sm font-bold text-slate-100">3. Servidor de correo (SMTP)</h3>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
              <label className={etiqueta}>Servidor<input className={`${campo} mono`} value={val("SMTP_HOST")} onChange={(e) => poner("SMTP_HOST", e.target.value)} placeholder="smtp.office365.com" /></label>
              <label className={etiqueta}>Puerto<input className={`${campo} mono`} inputMode="numeric" value={val("SMTP_PORT")} onChange={(e) => poner("SMTP_PORT", e.target.value)} /></label>
              <label className={etiqueta}>Usuario<input className={campo} value={val("SMTP_USUARIO")} onChange={(e) => poner("SMTP_USUARIO", e.target.value)} autoComplete="off" /></label>
              <label className={etiqueta}>Clave
                <input className={campo} type="password" autoComplete="new-password" value={cambios.SMTP_CLAVE ?? ""} onChange={(e) => poner("SMTP_CLAVE", e.target.value)} placeholder={cfg.claveSmtpGuardada ? "Guardada: déjela vacía para conservarla" : "Sin clave guardada"} />
              </label>
            </div>
            <Interruptor activo={val("SMTP_SEGURO") === "true"} onCambio={(v) => poner("SMTP_SEGURO", String(v))} si="Conexión segura (SSL, normalmente puerto 465)" no="STARTTLS / sin SSL (normalmente puerto 587)" />
          </div>

          {/* 4. Reglas */}
          <div className="panel flex flex-col gap-3 p-5">
            <h3 className="text-sm font-bold text-slate-100">4. Reglas de las alarmas</h3>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
              {REGLAS.map(([k, t, u]) => (
                <label key={k} className={etiqueta}>{t}
                  <span className="flex items-center gap-2"><input className={`${campo} mono`} inputMode="decimal" value={val(k)} onChange={(e) => poner(k, e.target.value)} /><span className="w-14 text-slate-500">{u}</span></span>
                </label>
              ))}
              <label className={etiqueta}>Medidores de generador (inventario o nombre, separados por coma)
                <input className={`${campo} mono`} value={val("MEDIDORES_GENERADOR")} onChange={(e) => poner("MEDIDORES_GENERADOR", e.target.value)} placeholder="vacío = ninguno" />
              </label>
              <div className={etiqueta}>Resumen diario por correo
                <span className="flex items-center gap-2">
                  <Interruptor activo={val("ALERTA_RESUMEN_DIARIO_CORREO") === "true"} onCambio={(v) => poner("ALERTA_RESUMEN_DIARIO_CORREO", String(v))} si="Sí, a las" no="No" />
                  <input className={`${campo} mono w-24`} value={val("ALERTA_RESUMEN_DIARIO_HORA")} onChange={(e) => poner("ALERTA_RESUMEN_DIARIO_HORA", e.target.value)} placeholder="07:00" />
                </span>
              </div>
            </div>
            <Interruptor activo={val("ALARMAS_ACTIVAS") !== "false"} onCambio={(v) => poner("ALARMAS_ACTIVAS", String(v))} si="Motor de alarmas de Gravix ENCENDIDO" no="Motor de alarmas de Gravix APAGADO (no detecta ni prepara nada)" />
          </div>

          {/* Guardar */}
          <div className="sticky bottom-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/95 p-3 shadow-lg">
            <button type="button" onClick={guardarCambios} disabled={!pendientes || guardar.isPending} className="min-h-[40px] rounded-lg bg-sky-600 px-4 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-40">
              {guardar.isPending ? "Guardando…" : `Guardar cambios${pendientes ? ` (${pendientes})` : ""}`}
            </button>
            {pendientes > 0 && <button type="button" onClick={() => setCambios({})} className="min-h-[40px] rounded-lg border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-800">Descartar</button>}
            <button type="button" onClick={() => void abrirCorreo(sede.id, "vista-previa")} className="min-h-[40px] rounded-lg border border-slate-700 px-3 text-sm text-slate-200 hover:bg-slate-800">Vista previa del correo</button>
            <button type="button" disabled={!d.gravix?.estado?.correo_activo || prueba.isPending}
              title={d.gravix?.estado?.correo_activo ? "Envía un correo de prueba a los destinatarios" : "Primero active el envío y configure el servidor de correo"}
              onClick={() => prueba.mutate({ id: sede.id }, { onSuccess: (r) => setMsg(r.enviado ? { ok: true, t: `Correo de prueba enviado a ${r.para}` } : { ok: false, t: r.motivo ?? "No se envió" }), onError: (e) => setMsg({ ok: false, t: extractErrorMessage(e, "No se pudo enviar") }) })}
              className="min-h-[40px] rounded-lg border border-slate-700 px-3 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-40">
              {prueba.isPending ? "Enviando…" : "Enviar correo de prueba"}
            </button>
            {msg && <span role="status" className={`text-sm ${msg.ok ? "text-emerald-300" : "text-rose-300"}`}>{msg.t}</span>}
          </div>

          {/* 5. Estado y correos */}
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
            <div className="panel flex flex-col gap-2 p-5">
              <h3 className="text-sm font-bold text-slate-100">Motor de alarmas ahora</h3>
              <p className="text-sm text-slate-300">Estado: <b>{d.gravix?.estado?.estado ?? "—"}</b>{d.gravix?.estado?.motivo ? ` (${d.gravix.estado.motivo})` : ""} · {d.gravix?.estado?.dispositivos.length ?? 0} medidores vigilados</p>
              {(d.gravix?.estado?.eventos_abiertos ?? []).length ? (
                <ul className="flex flex-col gap-1 text-sm">
                  {d.gravix!.estado!.eventos_abiertos.map((e) => (
                    <li key={e.codigo} className="rounded-lg bg-slate-950/60 px-3 py-1.5"><b className={e.severidad === "critico" ? "text-rose-300" : "text-amber-200"}>{e.titulo}</b> · {e.inventario ? `${e.inventario} ` : ""}{e.dispositivo ?? ""} <span className="text-xs text-slate-500">desde {new Date(e.desde).toLocaleString("es-GT")}</span></li>
                  ))}
                </ul>
              ) : <p className="text-sm text-emerald-300">Sin alarmas abiertas.</p>}
            </div>
            <div className="panel flex flex-col gap-2 p-5">
              <h3 className="text-sm font-bold text-slate-100">Correos de los últimos 7 días <span className="text-xs font-normal text-slate-500">({d.gravix?.correos?.modo})</span></h3>
              {(d.gravix?.correos?.correos ?? []).length ? (
                <ul className="flex max-h-[360px] flex-col gap-1 overflow-y-auto text-sm">
                  {d.gravix!.correos!.correos.map((c) => (
                    <li key={c.id} className="flex items-center gap-2 rounded-lg bg-slate-950/60 px-3 py-1.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-slate-100" title={c.asunto}>{c.asunto}</span>
                        <span className="text-xs text-slate-500">{new Date(c.creadoEn).toLocaleString("es-GT")} · {TIPO_CORREO[c.tipo] ?? c.tipo} · <span className={c.enviado ? "text-emerald-300" : "text-amber-200"}>{c.enviado ? "enviado" : "preparado, no enviado"}</span></span>
                      </span>
                      <button type="button" onClick={() => void abrirCorreo(sede.id, c.id)} className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800">Ver</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-slate-400">Todavía no hay correos.</p>}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Interruptor({ activo, onCambio, si, no }: { activo: boolean; onCambio: (v: boolean) => void; si: string; no: string }) {
  return (
    <button type="button" role="switch" aria-checked={activo} onClick={() => onCambio(!activo)} className="flex items-center gap-2.5 text-left text-sm">
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition ${activo ? "bg-emerald-600" : "bg-slate-700"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${activo ? "left-[22px]" : "left-0.5"}`} />
      </span>
      <span className={activo ? "text-slate-100" : "text-slate-400"}>{activo ? si : no}</span>
    </button>
  );
}
