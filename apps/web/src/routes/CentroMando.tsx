import { useEffect, useMemo, useRef, useState } from "react";
import InteractiveChart, { type ChartSeries } from "../components/charts/InteractiveChart";
import type { Access } from "../api/access";
import { useDevices } from "../api/devices";
import { doorsByCode, str, toSedeDevices, type SedeDevice } from "../utils/sedes";
import { resumenSensor } from "../utils/resumenSensor";
import { AirCard, DoorTile, EnvCard, LoraCard, WiseCard } from "../components/sedes/Cards";
import SedeTrendModal from "../components/sedes/SedeTrendModal";
import { downloadFile } from "../api/access";
import {
  useCentroEventos,
  useCentroHistorial,
  useCentroVista,
  type CentroDispositivo,
  type CentroEvento,
  type CentroSede,
  type CentroVista,
  type Nivel,
  esInstrumentacion,
} from "../api/centro";
import { usePilotDevices, usePilotGaps, usePilotSeries, type PilotDevice } from "../api/pilot";
import { extractErrorMessage } from "../api/errors";
import { DeviceBox, DIM, initialScreen, ION_HARM_SCREENS, kindOf, metricRows, POWER_METRIC, pressKey, screenTitle, type DeviceKind, type ScreenState } from "../components/gravix/DeviceArt";
import { CompareTab, METRIC_LABEL, Stage3D } from "./Gravix";
import "../components/gravix/gravix.css";
import "../components/centro/centro.css";
import { NormasCumplimiento, Prediccion } from "../components/centro/Calidad";
import { Analitica } from "../components/centro/Analitica";
import { ArmonicosPanel } from "../components/gravix/Armonicos";
import { GRUPO_INICIAL, conAgentes, useGuardarPunto, usePilotDevicesMany, usePlanoSede, useRed, webDeSede, type RedGrupo, type RedSede } from "../api/red";
import { BotonJsonV1, EditarSede, GestionGrupos, NuevaSede } from "../components/red/RedAdmin";
import { AlarmasCorreos as ModuloAlarmasCorreos } from "../components/red/AlarmasCorreos";
import { PublicarGravix } from "../components/asistente/GravixGlobal";
import ArquitecturaGravix from "../components/centro/ArquitecturaGravix";
import ExportarHistorial, { type EquipoExportable } from "../components/centro/ExportarHistorial";
import { VISTAS_ADMIN, type Accion as AccionGravix } from "../components/asistente/comandos";

/**
 * Centro de mando (mockup aprobado "Diseño final"): las 10 sedes del IGSS en una sola pantalla.
 *  - Datos de las sedes: monitoreo central (EBO -> api-SIASA de cada sede), via la API de Nodivo.
 *  - Escuintla: ademas los equipos del piloto Gravix (lectura directa + historial en TimescaleDB).
 * Solo lectura: no envia comandos a ningun equipo ni cambia nada en las sedes.
 */

const ESCUINTLA = "escuintla";
const GRAVIX_KEY = "igss-escuintla";

const COLOR: Record<Nivel, string> = { ok: "#22c55e", advertencia: "#f59e0b", critico: "#ef4444", sin_respuesta: "#ef4444" };
const NIVEL_TXT: Record<Nivel, string> = { ok: "Operando", advertencia: "Advertencia", critico: "Crítico", sin_respuesta: "Sin respuesta" };
const EVENTO_TXT: Record<string, string> = {
  MEDIDOR_FUERA_DE_LINEA: "Fuera de línea",
  MEDIDOR_EN_CERO: "Voltaje en cero",
  MEDIDOR_SIN_CAMBIO: "Sin cambio en sus valores",
  GENERADOR_EN_MARCHA: "Generador en marcha",
  DATOS_CONGELADOS: "Datos congelados",
  LECTURA_ATASCADA: "Lectura atascada",
  RECONEXIONES_FRECUENTES: "Reconexiones frecuentes",
  MEDIDOR_VIGILANTES_DESCONECTADOS: "Vigilantes desconectados (comercial / generador)",
};
const ESTADO_TXT: Record<string, string> = {
  ok: "En línea",
  fuera_de_linea: "Fuera de línea",
  en_cero: "Voltaje en cero",
  sin_cambio: "Sin cambio",
  generador_en_marcha: "Generador en marcha",
  en_espera_generador_apagado: "En espera",
};
const OK_ESTADOS = new Set(["ok", "generador_en_marcha", "en_espera_generador_apagado"]);

const fmt = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const fechaHora = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("es-GT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const hace = (s: string | null | undefined) => {
  if (!s) return "—";
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (m < 1) return "hace segundos";
  if (m < 60) return `hace ${m} min`;
  if (m < 1440) return `hace ${Math.floor(m / 60)} h ${m % 60} min`;
  return fechaHora(s);
};
const duracion = (s: number | null) => {
  if (s == null) return "sigue activa";
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/* ---------------- modelo de equipo (une monitoreo central + Gravix) ---------------- */

interface Equipo {
  key: string;
  sedeId: string;
  sedeNombre: string;
  nombre: string;
  area: string | null;
  inventario: string | null;
  kind: DeviceKind;
  ok: boolean;
  estadoTxt: string;
  /** Equipo para dibujar (Gravix real o armado con lo del monitoreo central). */
  art: PilotDevice;
  central: CentroDispositivo | null;
  /** Equipo del piloto Gravix (lectura por el AS-P) y su pareja leida directo. */
  pilot: PilotDevice | null;
  pilotDirect: PilotDevice | null;
  /** Sede nueva de Nodivo: el equipo lo lee directo un Agente Go (no hay EBO ni monitoreo central). */
  directo?: boolean;
}

/** Leido directo del equipo (Gravix en Escuintla o Agente Go de una sede nueva). */
const esDirecto = (e: Equipo) => !!e.pilotDirect || !!e.directo;

/* ---------- panel del plano 3D ---------- */
const PANEL3D_KEY = "nodivo.panel3d";
function leerPanel3d() {
  try {
    return localStorage.getItem(PANEL3D_KEY) === "plegado";
  } catch {
    return false;
  }
}
function guardarPanel3d(plegado: boolean) {
  try {
    localStorage.setItem(PANEL3D_KEY, plegado ? "plegado" : "abierto");
  } catch {
    /* sin almacenamiento: dura solo esta visita */
  }
}

/** Valor corto de un equipo de energia para el plano 3D. */
function valorEnergia(e: Equipo) {
  const r = (e.pilotDirect ?? e.art).readings ?? {};
  const kw = numero(r, "active_power_total", "demand_total", "gen_kw_total_metering") ?? e.central?.lectura?.kw ?? null;
  const v = promedio(r, ["voltage_a_n", "voltage_b_n", "voltage_c_n"]) ?? e.central?.lectura?.v_prom ?? null;
  return [kw != null ? `${kw.toFixed(1)} kW` : "", v != null ? `${v.toFixed(1)} V` : ""].filter(Boolean).join(" · ");
}

/* ---------- arbol plegable ---------- */
const ARBOL_KEY = "nodivo.arbol";
function leerArbolAbierto() {
  try {
    return localStorage.getItem(ARBOL_KEY) !== "plegado";
  } catch {
    return true;
  }
}
function guardarArbolAbierto(abierto: boolean) {
  try {
    localStorage.setItem(ARBOL_KEY, abierto ? "abierto" : "plegado");
  } catch {
    /* sin almacenamiento: dura solo esta visita */
  }
}
/** Siglas de cada sede sin repetir: "Villa Nueva" = VN, "Palín" = PA; si chocan se agrega una letra. */
function siglasSedes(sedes: { id: string; nombre: string }[]): Map<string, string> {
  const usadas = new Set<string>();
  const out = new Map<string, string>();
  for (const s of sedes) {
    const [a = "S", b = ""] = s.nombre.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(" ").filter(Boolean);
    const opciones = b ? [a[0] + b[0], a[0] + b.slice(0, 2), a.slice(0, 2) + b[0]] : [a.slice(0, 2), a.slice(0, 3)];
    let x = opciones.find((o) => !usadas.has(o));
    for (let n = 2; !x; n++) if (!usadas.has(`${a[0]}${n}`)) x = `${a[0]}${n}`;
    usadas.add(x);
    out.set(s.id, x);
  }
  return out;
}

/** Nombre de una metrica para el Excel: "Potencia activa total (kW)". */
const EBO_LABEL: Record<string, string> = { "ebo:kw": "Potencia (kW)", "ebo:v": "Voltaje promedio (V)", "ebo:a": "Corriente promedio (A)" };
const etiquetaMetrica = (m: string) => EBO_LABEL[m] ?? (METRIC_LABEL[m] ? `${METRIC_LABEL[m][0]}${METRIC_LABEL[m][1] ? ` (${METRIC_LABEL[m][1]})` : ""}` : m);

/** Equipos que se pueden exportar: los leidos por Agente Go con todas sus metricas; los de Telemetria 1 con kW, V y A. */
function exportables(lista: Equipo[]): EquipoExportable[] {
  return lista.flatMap((e): EquipoExportable[] => {
    const dev = e.pilotDirect ?? e.pilot;
    const base = { key: e.key, sedeId: e.sedeId, sedeNombre: e.sedeNombre, nombre: e.nombre, inventario: e.inventario, kind: e.kind };
    if (dev) {
      const claves = Object.keys(dev.readings ?? {});
      const metricas = claves.filter((k) => typeof dev.readings[k] === "number" && !k.startsWith("harm_"));
      const armonicos = e.kind === "ion" && claves.some((k) => k.startsWith("harm_"));
      return [{ ...base, ref: `p:${dev.id}`, metricas, origen: e.pilotDirect || e.directo ? "directo" : "Agente Go", armonicos }];
    }
    if (e.central) return [{ ...base, ref: `c:${e.sedeId}:${e.central.id}`, metricas: ["ebo:kw", "ebo:v", "ebo:a"], origen: "EBO", armonicos: false }];
    return [];
  });
}

/* ---------------- sedes nuevas (Nodivo + Agentes Go) unidas a las del monitoreo central ---------------- */

/** Una sede nueva no reporta si su agente lleva mas de esto sin sincronizar. */
const SIN_RESPUESTA_MS = 5 * 60_000;

function numero(r: Record<string, unknown>, ...ks: string[]) {
  for (const k of ks) if (typeof r[k] === "number" && Number.isFinite(r[k] as number)) return r[k] as number;
  return null;
}
function promedio(r: Record<string, unknown>, ks: string[]) {
  const xs = ks.map((k) => r[k]).filter((x): x is number => typeof x === "number" && x > 0);
  return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
}

/** Arma una sede "como las del monitoreo central" con los equipos que leen sus Agentes Go. */
function sedeNodivo(rs: RedSede, devices: PilotDevice[], ultimoSync: string | null, generado: string): CentroSede {
  // Sede con su propio Gravix: si el centro no la alcanza, no responde aunque su agente siga leyendo alla.
  const gx = rs.origen === "gravix" ? rs.estado ?? null : null;
  const gravixCaida = rs.origen === "gravix" && (!gx || !gx.ok);
  const sinRespuesta = gravixCaida || (!!rs.agentes.length && (!ultimoSync || Date.now() - new Date(ultimoSync).getTime() > SIN_RESPUESTA_MS));
  const dispositivos: CentroDispositivo[] = devices.map((d) => {
    const a = d.attributes ?? {};
    const r = d.readings ?? {};
    const k = kindOf(d);
    const online = d.state === "online";
    return {
      id: d.id,
      nombre: d.name,
      inventario: String(a.code_inventory ?? a.code ?? "") || null,
      area: String(a.area ?? "") || null,
      estado: online ? "ok" : "fuera_de_linea",
      ultimo_cambio: d.updatedAt,
      evento: null,
      generador: k === "gen",
      lectura: online
        ? { kw: numero(r, "active_power_total", "demand_total", "gen_kw_total_metering"), tipo_kw: k === "pm" ? "demanda" : "potencia", fuente: null, v_prom: promedio(r, ["voltage_a_n", "voltage_b_n", "voltage_c_n"]), a_prom: promedio(r, ["current_a", "current_b", "current_c"]) }
        : null,
    };
  });
  const fuera = dispositivos.filter((d) => d.estado !== "ok");
  const abiertos: CentroSede["abiertos"] = fuera.map((d) => ({
    codigo: `${rs.id}-${d.id}-fuera`,
    evento: "MEDIDOR_FUERA_DE_LINEA",
    titulo: "Medidor fuera de línea",
    severidad: "critico",
    dispositivo: d.nombre,
    inventario: d.inventario,
    desde: d.ultimo_cambio ?? generado,
  }));
  const nivel: CentroSede["nivel"] = sinRespuesta ? "sin_respuesta" : fuera.length ? "critico" : !devices.length ? "advertencia" : "ok";
  return {
    id: rs.id,
    nombre: rs.nombre,
    ip: rs.origen === "gravix" ? `Gravix de sede${gx?.version ? ` v${gx.version}` : ""} · ${rs.url ?? ""}` : rs.agentes.length ? `Agente Go · ${rs.agentes.join(", ")}` : "sin agente",
    lat: rs.lat,
    lon: rs.lon,
    panel: "",
    nivel,
    sin_respuesta: sinRespuesta,
    error: gravixCaida
      ? `El Gravix de la sede no responde${gx?.error ? ` (${gx.error})` : ""}${gx?.ultimoContacto ? `; último contacto ${new Date(gx.ultimoContacto).toLocaleString("es-GT")}` : ""}`
      : sinRespuesta ? (ultimoSync ? `El agente no reporta desde ${new Date(ultimoSync).toLocaleString("es-GT")}` : "El agente todavía no se ha conectado") : !devices.length ? "Sin equipos todavía: búsquelos con «Buscar equipos»" : null,
    ultima_consulta_ok: gx?.ultimoContacto ?? ultimoSync,
    latencia_ms: gx?.latenciaMs ?? null,
    estado: null,
    medidores: { total: dispositivos.length, ok: dispositivos.length - fuera.length, fuera: fuera.length, alerta: 0, espera: 0, generador: dispositivos.filter((d) => d.generador).length },
    dispositivos,
    abiertos,
    por_dia: {},
    historial: [],
  };
}

/** La vista del monitoreo central + las sedes nuevas de Nodivo (con sus totales sumados). */
function unirRed(base: CentroVista, nuevas: CentroSede[]): CentroVista {
  if (!nuevas.length) return base;
  const t = { ...base.totales };
  for (const s of nuevas) {
    t.sedes += 1;
    if (!s.sin_respuesta) t.sedes_responden += 1;
    if (s.nivel === "ok") t.sedes_ok += 1;
    t.medidores += s.medidores.total;
    t.medidores_ok += s.medidores.ok;
    t.medidores_fuera += s.medidores.fuera;
    t.criticos += s.abiertos.filter((a) => a.severidad === "critico").length;
    t.abiertos += s.abiertos.length;
  }
  return { ...base, sedes: [...base.sedes, ...nuevas], totales: t };
}

function equipoNodivo(s: CentroSede, d: PilotDevice): Equipo {
  const k = kindOf(d);
  const ok = d.state === "online" && !s.sin_respuesta;
  const a = d.attributes ?? {};
  return {
    key: `${s.id}:${d.id}`,
    sedeId: s.id,
    sedeNombre: s.nombre,
    nombre: d.name,
    area: String(a.area ?? "") || null,
    inventario: String(a.code_inventory ?? a.code ?? "") || null,
    kind: k,
    ok,
    estadoTxt: ok ? (k === "gen" ? "En espera" : "En línea") : s.sin_respuesta ? "Sin datos (agente sin reportar)" : "Fuera de línea",
    art: d,
    central: s.dispositivos.find((x) => x.id === d.id) ?? null,
    pilot: d,
    pilotDirect: null,
    directo: true,
  };
}

function kindDeCentral(d: CentroDispositivo): DeviceKind {
  if (d.generador) return "gen";
  if (d.lectura?.tipo_kw === "potencia" || /ANALIZ|ION/i.test(d.nombre)) return "ion";
  return "pm";
}

/** Arma un equipo "dibujable" con lo poco que entrega el monitoreo central (kW, V y A promedio). */
function artDeCentral(sede: CentroSede, d: CentroDispositivo, kind: DeviceKind): PilotDevice {
  const l = d.lectura;
  const fuera = d.estado === "fuera_de_linea";
  const r: Record<string, unknown> = {};
  if (!fuera && l) {
    if (kind === "ion") Object.assign(r, { active_power_total: l.kw, voltage_a_n: l.v_prom, current_a: l.a_prom });
    if (kind === "pm") Object.assign(r, { demand_total: l.kw, voltage_a_n: l.v_prom, current_a: l.a_prom });
    if (kind === "gen") Object.assign(r, { gen_kw_total_metering: l.kw });
  }
  return {
    id: `${sede.id}:${d.id}`,
    name: d.nombre,
    model: kind === "ion" ? "ION7400" : kind === "pm" ? "PM2130" : "generator",
    attributes: { category: kind === "gen" ? "generator" : kind === "pm" ? "circuit_meter" : "power_meter", area: d.area, code: d.inventario },
    externalId: null,
    state: fuera ? "offline" : "online",
    readings: r,
    updatedAt: d.ultimo_cambio,
    directConnection: null,
    historySince: null,
    gaps: { pending: 0, openNow: 0, total: 0, missingMinutes: 0 },
    completeness: null,
  };
}

function useEquipos(vista: CentroVista | undefined, pilot: PilotDevice[], pilotDirect: PilotDevice[], nuevas: Map<string, PilotDevice[]>) {
  return useMemo(() => {
    const porSede = new Map<string, Equipo[]>();
    for (const s of vista?.sedes ?? []) {
      const lista: Equipo[] = [];
      const propios = nuevas.get(s.id);
      if (propios) {
        // Sede nueva: sus equipos los lee directo su Agente Go.
        for (const d of propios) lista.push(equipoNodivo(s, d));
      } else if (s.id === ESCUINTLA && pilot.length) {
        // Escuintla: los equipos del piloto Gravix (15) con su estado del monitoreo central por codigo.
        const usados = new Set<string>();
        for (const p of pilot) {
          const k = kindOf(p);
          const code = String(p.attributes.code ?? "");
          const c = s.dispositivos.find((d) => !usados.has(d.id) && (d.nombre === p.name || (code && d.inventario === code && (kindDeCentral(d) === "gen") === (k === "gen")))) ?? null;
          if (c) usados.add(c.id);
          const direct = pilotDirect.find((x) => x.name === p.name) ?? null;
          const offline = p.state === "offline" && (!direct || direct.state === "offline");
          lista.push({
            key: `${s.id}:${p.id}`,
            sedeId: s.id,
            sedeNombre: s.nombre,
            nombre: p.name,
            area: String(p.attributes.area ?? c?.area ?? "") || null,
            inventario: code || c?.inventario || null,
            kind: k,
            ok: !offline,
            estadoTxt: offline ? "Fuera de línea" : k === "gen" ? "En espera" : "En línea",
            art: direct && direct.updatedAt ? direct : p,
            central: c,
            pilot: p,
            pilotDirect: direct,
          });
        }
        // Lo que el monitoreo central tenga y Gravix no.
        for (const d of s.dispositivos.filter((x) => !usados.has(x.id))) lista.push(equipoCentral(s, d));
      } else {
        for (const d of s.dispositivos) lista.push(equipoCentral(s, d));
      }
      porSede.set(s.id, lista);
    }
    return porSede;
  }, [vista, pilot, pilotDirect, nuevas]);
}

function equipoCentral(s: CentroSede, d: CentroDispositivo): Equipo {
  const kind = kindDeCentral(d);
  const ok = !s.sin_respuesta && OK_ESTADOS.has(d.estado);
  return {
    key: `${s.id}:${d.id}`,
    sedeId: s.id,
    sedeNombre: s.nombre,
    nombre: d.nombre,
    area: d.area,
    inventario: d.inventario,
    kind,
    ok,
    estadoTxt: s.sin_respuesta ? "Sin datos (sede sin respuesta)" : ESTADO_TXT[d.estado] ?? d.estado,
    art: artDeCentral(s, d, kind),
    central: d,
    pilot: null,
    pilotDirect: null,
  };
}

/* ============================================================ */

export default function CentroMando({ access }: { access: Access }) {
  const vista = useCentroVista();
  const conEscuintla = access.sites.length === 0 || access.sites.includes(ESCUINTLA);
  const pilot = usePilotDevices(conEscuintla ? GRAVIX_KEY : "__ninguna__");
  const pilotDir = usePilotDevices(conEscuintla ? `${GRAVIX_KEY}-directo` : "__ninguna__");
  const esAdmin = access.role === "admin";

  // ---- red por fases: grupos y sedes nuevas de Nodivo (leidas por sus Agentes Go) ----
  const red = useRed();
  const grupos: RedGrupo[] = useMemo(() => red.data?.grupos ?? [], [red.data]);
  const filasRed: RedSede[] = useMemo(() => red.data?.sedes ?? [], [red.data]);
  const nuevasCfg = useMemo(
    () => filasRed.filter((s) => conAgentes(s) && (access.sites.length === 0 || access.sites.includes(s.id))),
    [filasRed, access.sites],
  );
  const keysNuevas = useMemo(() => [...new Set(nuevasCfg.flatMap((s) => s.agentes))], [nuevasCfg]);
  const devsQ = usePilotDevicesMany(keysNuevas);
  const sello = devsQ.map((q) => q.dataUpdatedAt).join(",");
  const { vistaUnida, nuevasDevs } = useMemo(() => {
    const porKey = new Map(keysNuevas.map((k, i) => [k, devsQ[i]?.data]));
    const devs = new Map<string, PilotDevice[]>();
    const sedes: CentroSede[] = [];
    if (vista.data) {
      for (const rs of nuevasCfg) {
        if (vista.data.sedes.some((s) => s.id === rs.id)) continue; // ya la trae el monitoreo central
        const lista = rs.agentes.flatMap((k) => porKey.get(k)?.devices ?? []);
        const syncs = rs.agentes.map((k) => porKey.get(k)?.lastSync?.syncedAt).filter((x): x is string => !!x).sort();
        devs.set(rs.id, lista);
        sedes.push(sedeNodivo(rs, lista, syncs[syncs.length - 1] ?? null, vista.data.generado));
      }
    }
    // Sedes cuyas alarmas se leen del Gravix de sede (opcion en "Editar sede"): sus alarmas abiertas son las del motor de Gravix.
    const deGravix = new Map(filasRed.filter((f) => f.alarmasFuente === "gravix" && f.estado?.ok && f.estado.abiertos).map((f) => [f.id, f.estado!.abiertos!]));
    const unida = vista.data ? unirRed(vista.data, sedes) : undefined;
    const vistaUnida = unida && deGravix.size ? { ...unida, sedes: unida.sedes.map((s) => (deGravix.has(s.id) ? { ...s, abiertos: deGravix.get(s.id)! } : s)) } : unida;
    return { vistaUnida, nuevasDevs: devs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vista.data, nuevasCfg, keysNuevas, sello, filasRed]);
  /** Grupo (fase) de cada sede: su fila en la red; sin fila, las del monitoreo central van a Telemetría 1. */
  const grupoDe = (id: string): RedGrupo | null => {
    const fila = filasRed.find((s) => s.id === id);
    const gid = fila ? fila.grupoId : nuevasDevs.has(id) ? null : GRUPO_INICIAL;
    return grupos.find((g) => g.id === gid) ?? null;
  };

  /** Agente → sede que lo usa: los dos de Escuintla (EBO y directo) y los de cada sede nueva. */
  const agentesEnUso: Record<string, string> = { [GRAVIX_KEY]: "Escuintla", [`${GRAVIX_KEY}-directo`]: "Escuintla" };
  for (const s of filasRed) if (conAgentes(s)) for (const a of s.agentes) agentesEnUso[a] ??= s.id;

  const equipos = useEquipos(vistaUnida, pilot.data?.devices ?? [], pilotDir.data?.devices ?? [], nuevasDevs);
  const [sedeId, setSedeId] = useState<string | null>(null);
  const [sedePlano, setSedePlano] = useState("");
  const visorPlano = useRef<HTMLIFrameElement>(null);
  const { data: dispositivosSede, isError: errorDispositivos } = useDevices();
  const sensoresPlano = useMemo(() => toSedeDevices(dispositivosSede ?? [], GRAVIX_KEY)
    .filter((d) => ["door", "env", "wise", "air", "lora", "radio"].includes(d.kind)), [dispositivosSede]);
  const [sensorPlanoId, setSensorPlanoId] = useState<string | null>(null);
  const [tendenciaPlanoId, setTendenciaPlanoId] = useState<string | null>(null);
  const sensorPlano = sensoresPlano.find((sensor) => sensor.id === sensorPlanoId);
  const tendenciaPlano = sensoresPlano.find((sensor) => sensor.id === tendenciaPlanoId);
  const puertasPlano = useMemo(() => doorsByCode(sensoresPlano.filter((sensor) => sensor.kind === "door")), [sensoresPlano]);
  const inventarioPlano = JSON.stringify(sensoresPlano.map((sensor) => ({
    id: sensor.id, nombre: sensor.name, area: sensor.area, modelo: sensor.model,
    codigo: str(sensor.attrs.tag_code_inventory ?? sensor.attrs.code_inventory ?? sensor.attrs.tag_code),
  })));
  const [planoAmpliado, setPlanoAmpliado] = useState(false);
  const [avisoPlano, setAvisoPlano] = useState("");
  useEffect(() => {
    const abrirDesdePlano = (event: MessageEvent) => {
      if (event.origin !== "null" || event.source !== visorPlano.current?.contentWindow) return;
      const data = event.data;
      if (data?.tipo === "nodivo:listo-3d") {
        enviarPlanoRef.current();
        return;
      }
      if (data?.tipo === "nodivo:abrir-sensor-3d" && typeof data.id === "string") {
        setSensorPlanoId(data.id);
        return;
      }
      if (data?.tipo === "nodivo:cerrar-ampliacion-3d") {
        setPlanoAmpliado(false);
        return;
      }
      if (data?.tipo === "nodivo:sede-3d" && typeof data.sede === "string") {
        setSedePlano(data.sede === ESCUINTLA ? ESCUINTLA : "");
        return;
      }
      if (data?.tipo === "nodivo:panel-3d") {
        guardarPanel3d(!!data.plegado);
        return;
      }
      if (data?.tipo === "nodivo:guardar-punto" && esAdmin && typeof data.clave === "string" && Number.isFinite(data.x) && Number.isFinite(data.y)) {
        guardarPuntoRef.current({ clave: data.clave, x: data.x, y: data.y });
        return;
      }
      if (data?.tipo !== "nodivo:abrir-equipo-3d" || typeof data.inventario !== "string") return;
      const coincidencias = (equipos.get(ESCUINTLA) ?? []).filter(
        (equipo) => equipo.kind === data.clase && equipo.inventario === data.inventario,
      );
      const equipo = coincidencias.length === 1 ? coincidencias[0] : coincidencias.find(
        (candidato) => candidato.nombre === data.nombre,
      );
      setAvisoPlano(equipo ? "" : "El equipo del plano todavía no está vinculado a una ficha.");
      if (equipo) {
        setTabEquipo("equipo");
        setAbierto(equipo);
      }
    };
    window.addEventListener("message", abrirDesdePlano);
    return () => window.removeEventListener("message", abrirDesdePlano);
  }, [equipos, esAdmin]);
  const [sobre, setSobre] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<Equipo | null>(null);
  /** Pestaña con la que abre la ventana del equipo (Gravix puede pedir una; el clic normal abre "Equipo"). */
  const [tabEquipo, setTabEquipo] = useState<Pestana>("equipo");
  const [filtro, setFiltro] = useState<"todos" | DeviceKind>("todos");
  const [arbolMovil, setArbolMovil] = useState(false);
  /** Arbol abierto o plegado a la izquierda (solo en pantalla ancha); lo recuerda el navegador. */
  const [arbolVisible, setArbolVisible] = useState(leerArbolAbierto);
  /** Nombre que sale al instante junto a un icono del arbol plegado. */
  const [tipArbol, setTipArbol] = useState<{ t: string; x: number; y: number } | null>(null);
  /** Sede cuyos equipos estan desplegados en el arbol (clic en la misma sede = abrir / cerrar). */
  const [desplegada, setDesplegada] = useState<string | null>(null);
  const [vistaRed, setVistaRed] = useState<"mapa" | "sedes3d" | "incidentes" | "ranking" | "normas" | "prediccion" | "analitica" | "alarmas" | "arquitectura" | "exportar">("mapa");
  useEffect(() => {
    if (vistaRed !== "sedes3d" || sedeId) setPlanoAmpliado(false);
  }, [vistaRed, sedeId]);
  // Plano 3D: lugares guardados en el servidor y estado real de cada equipo.
  const planoSede = usePlanoSede(ESCUINTLA, vistaRed === "sedes3d");
  const guardarPunto = useGuardarPunto(ESCUINTLA);
  const guardarPuntoRef = useRef<(p: { clave: string; x: number; y: number }) => void>(() => {});
  guardarPuntoRef.current = (p) =>
    guardarPunto.mutate(p, {
      onSuccess: () => setAvisoPlano(""),
      onError: (e) => {
        setAvisoPlano(`No se guardó el cambio: ${extractErrorMessage(e)}`);
        enviarPlanoRef.current();
      },
    });
  const estadoPlano = JSON.stringify({
    admin: esAdmin,
    panel: leerPanel3d(),
    puntos: planoSede.data?.puntos ?? null,
    energia: (equipos.get(ESCUINTLA) ?? []).map((e) => ({ inventario: e.inventario, clase: e.kind, nombre: e.nombre, ok: e.ok, texto: e.estadoTxt, valor: valorEnergia(e) })),
    sensores: Object.fromEntries(sensoresPlano.map((s) => [s.id, resumenSensor(s)])),
    error: errorDispositivos && !dispositivosSede ? "No se pudieron leer los sensores de la sede." : "",
  });
  const enviarPlanoRef = useRef<() => void>(() => {});
  enviarPlanoRef.current = () => {
    const w = visorPlano.current?.contentWindow;
    w?.postMessage({ tipo: "nodivo:sensores-3d", inventario: inventarioPlano }, "*");
    w?.postMessage({ tipo: "nodivo:estado-3d", estado: estadoPlano }, "*");
    w?.postMessage({ tipo: "nodivo:ir-3d", sede: sedePlano }, "*");
  };
  useEffect(() => {
    enviarPlanoRef.current();
  }, [estadoPlano, inventarioPlano, sedePlano]);
  useEffect(() => {
    if (!planoAmpliado || abierto || sensorPlanoId) return;
    const cerrarConEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlanoAmpliado(false);
    };
    document.addEventListener("keydown", cerrarConEscape);
    return () => document.removeEventListener("keydown", cerrarConEscape);
  }, [planoAmpliado, abierto, sensorPlanoId]);
  const [sala, setSala] = useState(false);
  /** Centro de alertas (modal de la campana): de toda la red o de una sede, con una alerta elegida. */
  const [alertas, setAlertas] = useState<{ sede: string | null; sel: string | null } | null>(null);
  /** Grupos plegados en el arbol. */
  const [plegados, setPlegados] = useState<Set<string>>(new Set());
  /** Administracion de la red: asistente de sede nueva (o buscar equipos de una), editar sede, grupos. */
  const [nuevaSede, setNuevaSede] = useState<{ sedeId?: string; paso?: number } | null>(null);
  const [editarSede, setEditarSede] = useState<{ id: string; quitar?: boolean } | null>(null);
  const [verGrupos, setVerGrupos] = useState(false);

  if (vista.isLoading) return <div className="cm py-16 text-center text-slate-400">Cargando el centro de mando…</div>;
  if (vista.isError || !vista.data || !vistaUnida)
    return (
      <div className="cm panel mx-auto max-w-2xl p-6 text-center">
        <p className="font-semibold text-slate-100">No se pudo cargar el centro de mando</p>
        <p className="mt-1 text-sm text-slate-400">{extractErrorMessage(vista.error)}</p>
      </div>
    );

  const v = vistaUnida;
  const sigla = siglasSedes(v.sedes);
  /** Sedes del arbol agrupadas por fase (en el orden de los grupos); las sin grupo al final. */
  const arbol: { g: RedGrupo | null; sedes: CentroSede[] }[] = grupos.length
    ? [
        ...grupos.map((g) => ({ g, sedes: v.sedes.filter((s) => grupoDe(s.id)?.id === g.id) })),
        { g: null, sedes: v.sedes.filter((s) => !grupoDe(s.id)) },
      ].filter((x) => x.g || x.sedes.length)
    : [{ g: null, sedes: v.sedes }];
  const activasRed = alarmasActivas(v);
  const sede = v.sedes.find((s) => s.id === sedeId) ?? null;
  const abrirSede = (id: string) => {
    setSedeId(id);
    setDesplegada(id);
    setFiltro("todos");
    setSobre(null);
  };
  const alternarArbol = () => {
    setTipArbol(null);
    setArbolVisible(!arbolVisible);
    guardarArbolAbierto(!arbolVisible);
  };
  const arbolMini = () => !arbolVisible && window.matchMedia("(min-width: 1024px)").matches;
  const conTip = (t: string) => {
    const ver = (e: React.SyntheticEvent<HTMLElement>) => {
      if (!arbolMini()) return;
      const c = e.currentTarget.getBoundingClientRect();
      setTipArbol({ t, x: c.right + 16, y: c.top + c.height / 2 });
    };
    const quitar = () => setTipArbol(null);
    return { onMouseEnter: ver, onFocus: ver, onMouseLeave: quitar, onBlur: quitar };
  };
  /** Clic en una sede del arbol (plegado: solo la abre): la abre y despliega; si ya esta abierta, despliega / pliega sus equipos. */
  const clicSedeArbol = (id: string) => {
    setTipArbol(null);
    if (arbolMini()) abrirSede(id);
    else if (sedeId === id) setDesplegada((d) => (d === id ? null : id));
    else abrirSede(id);
  };
  const abrirEquipo = (sedeIdEq: string, ref: string | null) => {
    const lista = equipos.get(sedeIdEq) ?? [];
    const e = ref ? lista.find((x) => x.inventario === ref || x.nombre === ref || x.central?.nombre === ref) : null;
    abrirSede(sedeIdEq);
    if (e) setAbierto(e);
  };
  /** Gravix (asistente de voz): solo navega por el Centro de mando, no envia nada a los equipos. */
  const ejecutarGravix = (a: AccionGravix) => {
    switch (a.tipo) {
      case "alertas":
        setAbierto(null);
        setAlertas({ sede: a.sedeId, sel: null });
        break;
      case "vista":
        if (VISTAS_ADMIN.has(a.vista) && !esAdmin) break;
        setAlertas(null);
        setAbierto(null);
        setSedeId(null);
        setVistaRed(a.vista);
        break;
      case "inicio":
        setAlertas(null);
        setAbierto(null);
        setSala(false);
        setSedeId(null);
        setVistaRed("mapa");
        break;
      case "sede":
        setAlertas(null);
        setAbierto(null);
        setSala(false);
        abrirSede(a.sedeId);
        break;
      case "equipo": {
        const e = [...equipos.values()].flat().find((x) => x.key === a.equipoKey);
        if (!e) break;
        setAlertas(null);
        setSala(false);
        abrirSede(e.sedeId);
        setTabEquipo(a.pestana);
        setAbierto(e);
        break;
      }
      case "sala":
        setAlertas(null);
        setAbierto(null);
        setSala(a.activar);
        break;
      case "cerrar":
        setAlertas(null);
        setAbierto(null);
        setSala(false);
        break;
    }
  };
  const cerrarEquipo = () => {
    setAbierto(null);
    setTabEquipo("equipo");
  };

  return (
    <div className="cm flex flex-col gap-4">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[auto_minmax(0,1fr)]">
        {/* ---------- arbol del sistema ---------- */}
        <aside id="cm-arbol-sistema" aria-label="Árbol del sistema" className={`panel flex flex-col gap-1 p-3 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto arbol ${arbolVisible ? "" : "arbol-mini"}`} onScroll={() => setTipArbol(null)}>
          <button type="button" onClick={alternarArbol} aria-expanded={arbolVisible} aria-controls="cm-arbol-sistema" aria-label={arbolVisible ? "Plegar el árbol del sistema" : "Abrir el árbol del sistema"} {...conTip("Abrir el árbol del sistema")} className="hidden min-h-[38px] shrink-0 items-center gap-2 overflow-hidden rounded-lg border border-transparent pl-[7px] pr-2 text-left hover:bg-slate-800/60 lg:flex">
            <span className="arbol-ficha !bg-transparent text-sky-300"><svg className="giro" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 6l-6 6 6 6M19 6l-6 6 6 6" /></svg></span>
            <span className="tx eyebrow flex-1 !tracking-[0.04em]">Árbol del sistema</span>
            <span className="tx text-[11px] text-slate-400">{v.sedes.length} sedes</span>
          </button>
          <div className="flex items-center justify-between px-1 pb-1 lg:hidden">
            <span className="eyebrow">Árbol del sistema</span>
            <span className="text-xs text-slate-500">{v.sedes.length} sedes</span>
          </div>
          <button type="button" onClick={() => setArbolMovil((x) => !x)} aria-expanded={arbolMovil} className="flex min-h-[44px] items-center justify-between rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-100 lg:hidden">
            {arbolMovil ? "Ocultar sedes y equipos" : "Ver sedes y equipos"} <span>{arbolMovil ? "▴" : "▾"}</span>
          </button>
          <div className={`${arbolMovil ? "flex" : "hidden"} flex-col gap-1 lg:flex`}>
            <button
              type="button"
              onClick={() => {
                setTipArbol(null);
                // En una sede vuelve al mapa; ya en el mapa, pliega o abre el arbol (solo pantalla ancha).
                if (sede) setSedeId(null);
                else if (window.matchMedia("(min-width: 1024px)").matches) alternarArbol();
              }}
              {...conTip(sede ? "Volver al mapa" : "Red IGSS · mapa (abrir el árbol)")}
              className={`flex min-h-[42px] shrink-0 items-center gap-2 overflow-hidden rounded-lg border pl-[7px] pr-2 text-left text-sm font-semibold ${!sede ? "border-sky-900 bg-slate-800 text-white" : "border-transparent text-slate-200 hover:bg-slate-800/60"}`}
            >
              <span className="arbol-ficha !bg-blue-700 text-white"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg></span>
              <span className="tx">Red IGSS · mapa</span>
            </button>
            {arbol.map(({ g, sedes: delGrupo }) => {
              const gk = g?.id ?? "__sin";
              const plegado = plegados.has(gk);
              const enGrupo = delGrupo.reduce((n, s) => n + (equipos.get(s.id) ?? []).length, 0);
              return (
              <div key={gk} className="mt-1.5 flex flex-col">
                {(grupos.length > 0) && (
                  <button
                    type="button"
                    onClick={() => setPlegados((p) => { const n = new Set(p); if (n.has(gk)) n.delete(gk); else n.add(gk); return n; })}
                    aria-expanded={!plegado}
                    title={arbolVisible ? `${delGrupo.length} sedes · ${enGrupo} equipos` : undefined}
                    {...conTip(`${g?.nombre ?? "Sin grupo"} · ${delGrupo.length} ${delGrupo.length === 1 ? "sede" : "sedes"} · ${enGrupo} equipos`)}
                    className="arbol-grupo flex min-h-[32px] items-center gap-2 rounded-md px-1.5 text-left text-[11px] font-extrabold uppercase tracking-[0.08em] text-slate-300 hover:bg-slate-800/60"
                  >
                    <span className="solo-abierto w-2.5 text-slate-500" aria-hidden="true">{plegado ? "▸" : "▾"}</span>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: g?.color ?? "#475569" }} />
                    <span className="solo-abierto flex-1 truncate">{g?.nombre ?? "Sin grupo"}</span>
                    <span className="mono text-[11px] font-medium normal-case tracking-normal text-slate-500">{delGrupo.length}</span>
                  </button>
                )}
                {!plegado && delGrupo.length === 0 && <span className="solo-abierto ml-6 py-1.5 text-xs text-slate-600">Sin sedes todavía</span>}
                {!plegado && (
                <div className={grupos.length ? "arbol-rama ml-[13px] flex flex-col border-l border-dashed pl-1" : "flex flex-col"} style={grupos.length ? { borderColor: `${g?.color ?? "#475569"}55` } : undefined}>
            {delGrupo.map((s) => {
              const lista = equipos.get(s.id) ?? [];
              const en = lista.filter((e) => e.ok).length;
              const elegida = sede?.id === s.id;
              const abiertoS = elegida && desplegada === s.id;
              const nueva = nuevasDevs.has(s.id);
              return (
                <div key={s.id} className="flex flex-col">
                  <div
                    className={`group flex items-center rounded-lg border ${elegida ? "bg-slate-800" : "hover:bg-slate-800/60"}`}
                    style={s.nivel === "ok" ? { borderColor: "transparent" } : { borderColor: `${COLOR[s.nivel]}66`, background: elegida ? undefined : `${COLOR[s.nivel]}14` }}
                  >
                  <button type="button" onClick={() => clicSedeArbol(s.id)} aria-expanded={abiertoS} title={!arbolVisible ? undefined : abiertoS ? "Clic para ocultar sus equipos" : "Clic para ver sus equipos"} {...conTip(`${s.nombre} · ${s.sin_respuesta ? "sin respuesta" : `${en}/${lista.length} en línea · ${NIVEL_TXT[s.nivel].toLowerCase()}`}`)} className="flex min-h-[38px] min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-lg pl-[7px] pr-2 text-left text-sm">
                    <span className="arbol-ficha" aria-hidden="true">{sigla.get(s.id)}<span className="arbol-punto" style={{ background: COLOR[s.nivel], boxShadow: `0 0 8px ${COLOR[s.nivel]}` }} /></span>
                    <span className="tx min-w-0 flex-1 truncate font-semibold text-slate-100">{s.nombre}</span>
                    {s.id === ESCUINTLA && pilot.data?.devices.length ? <span className="tx rounded bg-emerald-950 px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider text-emerald-300">GRAVIX</span> : null}
                    {nueva && <span className="tx rounded bg-sky-950 px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider text-sky-300">AGENTE</span>}
                    <span className={`tx mono text-[11px] ${en < lista.length ? "text-rose-300" : "text-slate-400"}`}>{s.sin_respuesta ? "—" : `${en}/${lista.length}`}</span>
                  </button>
                  {esAdmin && nueva && (
                    <button type="button" onClick={() => setEditarSede({ id: s.id })} aria-label={`Editar o quitar ${s.nombre}`} title="Editar o quitar la sede" className="solo-abierto mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 hover:bg-slate-700 hover:text-white">⋯</button>
                  )}
                  </div>
                  {abiertoS && (
                    <div className="solo-abierto ml-6 flex flex-col border-l border-dashed border-slate-700 pb-1.5 pl-3">
                      {(["ion", "pm", "gen"] as const).map((k) => {
                        const items = lista.filter((e) => e.kind === k);
                        if (!items.length) return null;
                        return (
                          <div key={k} className="flex flex-col">
                            <span className="px-1.5 pb-0.5 pt-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">{k === "ion" ? "Analizadores ION7400" : k === "pm" ? "Medidores PM2130" : "Generadores"}</span>
                            {items.map((e) => (
                              <button key={e.key} type="button" onClick={() => setAbierto(e)} className={`flex min-h-[32px] items-center gap-2 rounded-md px-2 text-left text-[13px] text-slate-300 hover:bg-slate-800/70 ${abierto?.key === e.key ? "bg-slate-800" : ""}`}>
                                <span className="h-[7px] w-[7px] shrink-0 rounded-sm" style={{ background: e.ok ? COLOR.ok : COLOR.critico }} />
                                <span className="flex-1 truncate">{e.nombre}</span>
                                <span className={`text-[9px] font-bold ${esDirecto(e) ? "text-emerald-300" : "text-slate-500"}`}>{esDirecto(e) ? "DIR" : "EBO"}</span>
                              </button>
                            ))}
                          </div>
                        );
                      })}
                      {lista.length === 0 && <span className="px-1.5 py-2 text-xs text-slate-500">Sin equipos todavía</span>}
                    </div>
                  )}
                </div>
              );
            })}
                </div>
                )}
              </div>
              );
            })}
            {esAdmin && (
              <div className="arbol-pie mt-3 flex gap-1.5">
                <button type="button" onClick={() => setNuevaSede({})} aria-label="Nueva sede" {...conTip("Nueva sede")} className="flex min-h-[40px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed border-sky-700 bg-sky-950/30 text-[13px] font-bold text-sky-200 hover:bg-sky-950/60">
                  <span aria-hidden="true">＋</span> <span className="texto-pie">Nueva sede</span>
                </button>
                <button type="button" onClick={() => setVerGrupos(true)} aria-label="Grupos" title={arbolVisible ? "Crear, renombrar y ordenar los grupos (Telemetría 1, 2, 3…)" : undefined} {...conTip("Grupos")} className="grid min-h-[40px] place-items-center rounded-lg border border-dashed border-slate-700 px-3 text-[13px] font-semibold text-slate-300 hover:bg-slate-800">
                  <svg className="icono-pie" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></svg>
                  <span className="texto-pie">Grupos</span>
                </button>
              </div>
            )}
            <div className="solo-abierto mt-2 flex flex-col gap-1 border-t border-slate-800 px-1 pt-3 text-[11px] text-slate-500">
              <span><b className="rounded bg-emerald-950 px-1 text-[9px] text-emerald-300">DIR</b> Leído directo del equipo (Gravix / Agente Go)</span>
              <span><b className="rounded bg-slate-800 px-1 text-[9px] text-slate-300">EBO</b> Vía EBO AS-P → api-SIASA</span>
            </div>
          </div>
        </aside>
        {tipArbol && !arbolVisible && <div role="tooltip" className="arbol-tip" style={{ left: tipArbol.x, top: tipArbol.y }}>{tipArbol.t}</div>}

        {/* ---------- area de trabajo ---------- */}
        <div className="flex min-w-0 flex-col gap-4">
          <nav aria-label="Ubicación" className="flex flex-wrap items-center gap-1 text-sm">
            <button type="button" onClick={() => setSedeId(null)} className="rounded px-2 py-1 text-sky-300 hover:bg-slate-800">Red IGSS</button>
            {sede && (
              <>
                <span className="text-slate-600">/</span>
                <span className="px-2 font-semibold text-slate-100">{sede.nombre}</span>
              </>
            )}
            <button type="button" onClick={() => setSala(true)} title="Pantalla completa para un monitor fijo: recorre las sedes con problema" className="ml-auto flex min-h-[30px] items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 px-3 text-xs font-semibold text-slate-200 hover:border-sky-600">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
              Modo sala de control
            </button>
            <span className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${v.atrasado ? "bg-amber-950 text-amber-200" : "bg-emerald-950 text-emerald-300"}`}>
              <span className={`h-2 w-2 rounded-full ${v.atrasado ? "bg-amber-400" : "latido bg-emerald-400"}`} />
              {v.atrasado ? `Desactualizado · ${hace(v.recibido)}` : `En vivo · ${hace(v.recibido)}`}
            </span>
            <Campana alarmas={activasRed} onClick={() => setAlertas({ sede: null, sel: null })} />
          </nav>

          <FranjaEstado vista={v} alarmas={activasRed} gravix={(pilotDir.data?.devices.filter((d) => d.updatedAt).length ?? 0) + [...nuevasDevs.values()].flat().filter((d) => d.updatedAt).length} onAlertas={() => setAlertas({ sede: null, sel: null })} />

          {!sede ? (
            <>
              <div role="tablist" aria-label="Vista de la red" className="flex w-fit flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
                {([["mapa", "Mapa en vivo"], ["sedes3d", "Sedes en 3D"], ["incidentes", "Línea de tiempo de incidentes"], ["ranking", "Ranking de sedes"], ["normas", "Normas y cumplimiento"], ["prediccion", "Predicción"], ["analitica", "Analítica"], ...(esAdmin ? ([["alarmas", "Alarmas y correos"], ["exportar", "Exportar historial"], ["arquitectura", "Arquitectura"]] as const) : [])] as const).map(([k, t]) => (
                  <button key={k} type="button" role="tab" aria-selected={vistaRed === k} onClick={() => setVistaRed(k)} className={`min-h-[38px] rounded-lg px-3.5 text-[13px] font-bold transition-colors ${vistaRed === k ? "tab-activa" : "text-slate-300 hover:bg-slate-800"}`}>{t}</button>
                ))}
              </div>
              {(vistaRed === "mapa" || vistaRed === "sedes3d") && (
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                  {vistaRed === "mapa" ? (
                    <Mapa vista={v} equipos={equipos} sobre={sobre} setSobre={setSobre} onAbrir={abrirSede} grupos={grupos} grupoDe={grupoDe} onAbrirEquipo={setAbierto} />
                  ) : (
                    <section className={`panel flex min-w-0 flex-col p-3 ${planoAmpliado ? "fixed inset-3 z-50 shadow-2xl sm:inset-6" : ""}`} aria-label="Sedes en 3D" role={planoAmpliado ? "dialog" : undefined} aria-modal={planoAmpliado || undefined}>
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <label className="flex flex-wrap items-center gap-2 text-sm text-slate-200">
                        Sede
                        <select value={sedePlano} onChange={(event) => { setSedePlano(event.target.value); setAvisoPlano(""); }} className="min-h-[44px] rounded-lg border border-slate-700 bg-slate-900 px-3">
                          <option value="">Mapa de Guatemala</option>
                          {v.sedes.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                        </select>
                      </label>
                        {(!sedePlano || sedePlano === ESCUINTLA || planoAmpliado) && (
                          <button type="button" onClick={() => setPlanoAmpliado((valor) => !valor)} aria-expanded={planoAmpliado} className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm font-bold text-slate-100 hover:border-sky-600">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">{planoAmpliado ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />}</svg>
                            {planoAmpliado ? "Cerrar" : "Ampliar"}
                          </button>
                        )}
                      </div>
                      {!sedePlano || sedePlano === ESCUINTLA ? (
                        <>
                          <p className="mb-2 text-xs text-slate-400">Selecciona un equipo para abrir su ficha. Pasa el cursor sobre un equipo para ver su valor en vivo. Los WISE de cadena de frío incluyen las puertas vinculadas. Las posiciones vienen del plano de telemetría de SIASA (abril 2026).</p>
                          <p role="status" className="text-sm text-amber-300">{avisoPlano}</p>
                          <iframe
                            ref={visorPlano}
                            onLoad={() => enviarPlanoRef.current()}
                            title="Mapa y plano 3D de Escuintla"
                            src={`${import.meta.env.BASE_URL}sedes-3d/escuintla.html`}
                            sandbox="allow-scripts"
                            className={`w-full rounded-xl border border-slate-800 ${planoAmpliado ? "min-h-0 flex-1" : "h-[75vh] min-h-[540px]"}`}
                          />
                        </>
                      ) : (
                        <p className="rounded-xl border border-slate-800 p-4 text-sm text-slate-300">Esta sede todavía no tiene un plano 3D cargado.</p>
                      )}
                    </section>
                  )}
                  {vistaRed === "sedes3d" && planoAmpliado && <div className="fixed inset-0 z-40 bg-slate-950/80 backdrop-blur-sm" onClick={() => setPlanoAmpliado(false)} aria-hidden="true" />}
                  <div className="flex flex-col gap-4">
                    <TarjetaGravix vista={v} alarmas={activasRed} onAlertas={() => setAlertas({ sede: null, sel: null })} />
                    <Actividad vista={v} onIr={(id) => abrirSede(id)} />
                  </div>
                </div>
              )}
              {vistaRed === "incidentes" && <Incidentes vista={v} onIr={abrirSede} />}
              {vistaRed === "ranking" && <Ranking vista={v} equipos={equipos} onIr={abrirSede} />}
              {vistaRed === "normas" && <NormasCumplimiento />}
              {vistaRed === "prediccion" && <Prediccion />}
              {vistaRed === "analitica" && (
                <Analitica
                  grupos={grupos}
                  grupoDe={(id) => grupoDe(id)?.id ?? null}
                  onAbrirSede={abrirSede}
                  onAbrirHallazgo={(h) => abrirEquipo(h.sedeId, h.inventario ?? h.equipo)}
                />
              )}
              {vistaRed === "alarmas" && esAdmin && (
                <ModuloAlarmasCorreos sedes={v.sedes.map((s) => ({ id: s.id, nombre: s.nombre, grupo: grupoDe(s.id), gravix: filasRed.some((f) => f.id === s.id && f.origen === "gravix") }))} />
              )}
              {vistaRed === "exportar" && esAdmin && (
                <ExportarHistorial
                  sedes={v.sedes.map((s) => ({ id: s.id, nombre: s.nombre, color: grupoDe(s.id)?.color ?? null }))}
                  equipos={exportables(v.sedes.flatMap((s) => equipos.get(s.id) ?? []))}
                  etiqueta={etiquetaMetrica}
                />
              )}
              {vistaRed === "arquitectura" && esAdmin && (
                <ArquitecturaGravix
                  sedesGravix={filasRed.filter((f) => f.origen === "gravix")}
                  sedesTelemetria1={v.sedes.filter((s) => { const o = filasRed.find((f) => f.id === s.id)?.origen; return o !== "gravix" && o !== "nodivo"; }).length}
                />
              )}
            </>
          ) : (
            <SedeVista
              key={sede.id}
              sede={sede}
              equipos={equipos.get(sede.id) ?? []}
              alarmas={activasRed.filter((a) => a.sedeId === sede.id)}
              filtro={filtro}
              setFiltro={setFiltro}
              onAbrir={setAbierto}
              onAlertas={(sel) => setAlertas({ sede: sede.id, sel })}
              grupo={grupoDe(sede.id)}
              nueva={nuevasDevs.has(sede.id)}
              esAdmin={esAdmin}
              onEditar={() => setEditarSede({ id: sede.id })}
              onQuitar={() => setEditarSede({ id: sede.id, quitar: true })}
              onBuscarEquipos={() => setNuevaSede({ sedeId: sede.id, paso: 3 })}
              webGravix={webDeSede(filasRed.find((f) => f.id === sede.id))}
            />
          )}
        </div>
      </div>

      {nuevaSede && (
        <NuevaSede
          grupos={grupos}
          sedes={filasRed}
          idsExistentes={v.sedes.map((s) => s.id)}
          agentesEnUso={agentesEnUso}
          sedeId={nuevaSede.sedeId ?? null}
          pasoInicial={nuevaSede.paso ?? 1}
          onCerrar={() => setNuevaSede(null)}
          onAbrirSede={(id) => { setNuevaSede(null); abrirSede(id); }}
        />
      )}
      {editarSede && (
        <EditarSede
          key={`${editarSede.id}-${editarSede.quitar ? "q" : "e"}`}
          sede={v.sedes.find((s) => s.id === editarSede.id) ?? null}
          fila={filasRed.find((s) => s.id === editarSede.id) ?? null}
          nueva={nuevasDevs.has(editarSede.id)}
          grupos={grupos}
          grupoActual={grupoDe(editarSede.id)?.id ?? null}
          agentesEnUso={agentesEnUso}
          confirmarInicial={!!editarSede.quitar}
          onCerrar={() => setEditarSede(null)}
          onBorrada={() => { setEditarSede(null); setSedeId(null); }}
        />
      )}
      {verGrupos && <GestionGrupos grupos={grupos} conteo={(id) => v.sedes.filter((s) => grupoDe(s.id)?.id === id).length} onCerrar={() => setVerGrupos(false)} />}

      {alertas && (
        <CentroAlertas
          vista={v}
          equipos={equipos}
          alarmas={activasRed}
          sedeId={alertas.sede}
          selInicial={alertas.sel}
          onIr={(s, ref) => { setAlertas(null); abrirEquipo(s, ref); }}
          onIrSede={(s) => { setAlertas(null); abrirSede(s); }}
          onCerrar={() => setAlertas(null)}
        />
      )}

      {abierto && <VentanaEquipo key={`${abierto.key}-${tabEquipo}`} equipo={abierto} equiposSede={equipos.get(abierto.sedeId) ?? []} access={access} tabInicial={tabEquipo} onCerrar={cerrarEquipo} />}
      {sensorPlano && !tendenciaPlano && (
        <FichaSensorPlano sensor={sensorPlano} puertas={puertasPlano} onTrend={(sensor) => setTendenciaPlanoId(sensor.id)} onClose={() => setSensorPlanoId(null)} />
      )}
      {tendenciaPlano && (
        <SedeTrendModal key={tendenciaPlano.id} device={tendenciaPlano} buildingKey={GRAVIX_KEY} outage={false} tick={0} onClose={() => setTendenciaPlanoId(null)} />
      )}
      {sala && <SalaControl vista={v} equipos={equipos} onSalir={() => setSala(false)} />}
      <PublicarGravix datos={{ vista: v, equipos, alarmas: activasRed.map((a) => ({ ...a, titulo: EVENTO_TXT[a.evento] ?? a.titulo })), esAdmin, sedeActual: sede?.id ?? null, grupos, grupoDe: (id) => grupoDe(id)?.id ?? null, vistaActual: vistaRed }} ejecutar={ejecutarGravix} />

    </div>
  );
}

/* ---------------- alertas: campana, franja de estado y centro de alertas ---------------- */
function FichaSensorPlano({ sensor, puertas, onTrend, onClose }: {
  sensor: SedeDevice;
  puertas: Map<string, SedeDevice[]>;
  onTrend: (sensor: SedeDevice) => void;
  onClose: () => void;
}) {
  const dialogo = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialogo.current?.showModal();
  }, []);

  const props = { d: sensor, onTrend };
  return (
    <dialog
      ref={dialogo}
      aria-labelledby="cm-ficha-lorawan"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100%-2rem))] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950 p-4 text-slate-100 backdrop:bg-slate-950/75"
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 id="cm-ficha-lorawan" className="font-semibold">Ficha LoRaWAN</h2>
        <button type="button" onClick={onClose} className="min-h-[44px] rounded-lg border border-slate-700 px-3 text-sm hover:bg-slate-800">Cerrar</button>
      </header>
      {sensor.kind === "wise" ? <WiseCard {...props} doors={puertas} />
        : sensor.kind === "air" ? <AirCard {...props} />
        : sensor.kind === "env" ? <EnvCard {...props} />
        : sensor.kind === "door" ? <DoorTile {...props} />
        : <LoraCard {...props} />}
    </dialog>
  );
}

interface Alarma {
  codigo: string;
  evento: string;
  titulo: string;
  severidad: "critico" | "advertencia" | "info";
  dispositivo: string | null;
  inventario: string | null;
  desde: string;
  sedeId: string;
  sedeNombre: string;
}

/** Alarmas abiertas de todas las sedes (mas "sede sin respuesta"), las criticas primero. */
function alarmasActivas(vista: CentroVista): Alarma[] {
  const out: Alarma[] = vista.sedes.flatMap((s) =>
    s.abiertos
      .map((a): Alarma => ({ ...a, sedeId: s.id, sedeNombre: s.nombre }))
      .concat(s.sin_respuesta ? [{ codigo: `${s.id}-sr`, evento: "SEDE_SIN_RESPUESTA", titulo: "La sede no responde", severidad: "critico", dispositivo: null, inventario: null, desde: s.ultima_consulta_ok ?? vista.generado, sedeId: s.id, sedeNombre: s.nombre }] : []),
  );
  return out.sort((a, b) => (a.severidad === b.severidad ? b.desde.localeCompare(a.desde) : a.severidad === "critico" ? -1 : 1));
}

const SEV_COLOR: Record<string, string> = { critico: "#ef4444", advertencia: "#f59e0b", info: "#8ab8ff", ok: "#22c55e" };
const SEV_TXT: Record<string, string> = { critico: "Crítica", advertencia: "Advertencia", info: "Informativa", ok: "Normalizada" };
/** "hace 3 d 6 h" (corto, para duraciones de alarmas abiertas). */
const haceCorto = (s: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(s).getTime()) / 60000));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
};

function IconoCampana({ size = 20, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/** Campana del centro de mando: numero de alarmas activas; late en ambar (o rojo si hay criticas). */
function Campana({ alarmas, onClick }: { alarmas: Alarma[]; onClick: () => void }) {
  const n = alarmas.length;
  const critico = alarmas.some((a) => a.severidad === "critico");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={n ? `Centro de alertas: ${n} activas` : "Centro de alertas: sin alertas activas"}
      title="Centro de alertas"
      className={`relative grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-slate-700 bg-slate-900 text-slate-100 hover:bg-slate-800 ${n ? (critico ? "campana-roja" : "campana-ambar") : ""}`}
    >
      <IconoCampana />
      {n > 0 && (
        <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-[20px] place-items-center rounded-full border-2 border-[#0b1220] px-1 text-[11px] font-bold text-slate-950" style={{ background: critico ? SEV_COLOR.critico : SEV_COLOR.advertencia }}>
          {n}
        </span>
      )}
    </button>
  );
}

/** Tarjetas de estado general (salud, sedes, criticas, advertencias, lectura directa). */
function FranjaEstado({ vista, alarmas, gravix, onAlertas }: { vista: CentroVista; alarmas: Alarma[]; gravix: number; onAlertas: () => void }) {
  const t = vista.totales;
  const crit = alarmas.filter((a) => a.severidad === "critico");
  const adv = alarmas.filter((a) => a.severidad !== "critico");
  const pct = t.medidores ? Math.round((t.medidores_ok / t.medidores) * 100) : 0;
  const colorPct = pct >= 98 ? "#22c55e" : pct >= 90 ? "#f59e0b" : "#ef4444";
  const c = 2 * Math.PI * 46;
  const SEG: Record<string, string> = { ok: "#22c55e", advertencia: "#f59e0b", critico: "#ef4444", sin_respuesta: "#ef4444" };
  const nombres = (l: Alarma[]) => [...new Set(l.map((a) => a.sedeNombre))].slice(0, 2).join(", ") + (new Set(l.map((a) => a.sedeNombre)).size > 2 ? "…" : "");
  return (
    <div aria-label="Estado general" className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
      <div className="kpi !flex-row items-center !gap-4" style={{ background: "linear-gradient(160deg,#0e1a30,#0b1220)" }}>
        <svg width="72" height="72" viewBox="0 0 112 112" role="img" aria-label={`Salud de la red: ${pct} por ciento de medidores en línea`} className="shrink-0">
          <circle cx="56" cy="56" r="46" fill="none" stroke="#1C2740" strokeWidth="11" />
          <circle className="anillo-dibujo" cx="56" cy="56" r="46" fill="none" stroke={colorPct} strokeWidth="11" strokeLinecap="round" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 56 56)" style={{ ["--total" as string]: `${(pct / 100) * c}` }} />
          <text x="56" y="64" textAnchor="middle" fill="#e8eef8" fontSize="24" fontWeight="800" fontFamily="monospace">{pct}%</text>
        </svg>
        <div className="flex flex-col gap-1">
          <span className="kpi-titulo">Salud de la red</span>
          <b className="text-[17px] text-slate-100">{t.medidores_ok}/{t.medidores} medidores</b>
          <span className={`text-[12px] ${t.medidores_fuera ? "text-rose-300" : "text-emerald-300"}`}>{t.medidores_fuera ? `${t.medidores_fuera} fuera de línea` : "todos en línea"}</span>
        </div>
      </div>
      <div className="kpi" style={{ animationDelay: ".05s" }}>
        <span className="kpi-titulo">Sedes respondiendo</span>
        <b className="kpi-valor text-slate-100">{t.sedes_responden}<span className="text-[19px] text-slate-500">/{t.sedes}</span></b>
        <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${Math.max(1, vista.sedes.length)}, minmax(0, 1fr))` }}>
          {vista.sedes.map((s) => <span key={s.id} title={s.nombre} className="h-1.5 rounded-full" style={{ background: SEG[s.nivel] }} />)}
        </div>
      </div>
      {crit.length ? (
        <button type="button" onClick={onAlertas} className="kpi text-left" style={{ animationDelay: ".1s", borderColor: "rgba(239,68,68,.55)", background: "linear-gradient(160deg,rgba(239,68,68,.14),#0b1220 70%)" }}>
          <span className="kpi-titulo !text-rose-300">Alarmas críticas</span>
          <b className="kpi-valor text-rose-400">{crit.length}</b>
          <span className="text-[12px] text-rose-200">{nombres(crit)} · ver detalle →</span>
        </button>
      ) : (
        <div className="kpi" style={{ animationDelay: ".1s" }}>
          <span className="kpi-titulo">Alarmas críticas</span>
          <b className="kpi-valor text-emerald-300">0</b>
          <span className="flex items-center gap-1.5 text-[12px] text-slate-400">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>Sin críticas en la red
          </span>
        </div>
      )}
      {adv.length ? (
        <button type="button" onClick={onAlertas} className="kpi text-left" style={{ animationDelay: ".15s", borderColor: "rgba(245,158,11,.5)", background: "linear-gradient(160deg,rgba(245,158,11,.12),#0b1220 70%)" }}>
          <span className="kpi-titulo !text-amber-300">Advertencias</span>
          <b className="kpi-valor text-amber-400">{adv.length}</b>
          <span className="text-[12px] text-amber-100">{nombres(adv)} · ver detalle →</span>
        </button>
      ) : (
        <div className="kpi" style={{ animationDelay: ".15s" }}>
          <span className="kpi-titulo">Advertencias</span>
          <b className="kpi-valor text-emerald-300">0</b>
          <span className="text-[12px] text-slate-400">Sin advertencias</span>
        </div>
      )}
      <div className="kpi" style={{ animationDelay: ".2s" }}>
        <span className="kpi-titulo">Lectura directa Gravix</span>
        <b className="kpi-valor text-sky-300">{gravix}</b>
        <span className="text-[12px] text-slate-400">medidores sin AS-P · {t.reconexiones} reconexiones (1 h)</span>
      </div>
    </div>
  );
}

interface ItemAlerta {
  id: string;
  sev: "critico" | "advertencia" | "info" | "ok";
  activa: boolean;
  titulo: string;
  equipoRef: string | null;
  sedeId: string;
  sedeNombre: string;
  t: string;
  evento: string | null;
  detalle: string | null;
}

/** Modal "Centro de alertas": activas e historial, de toda la red o de una sede, con su detalle. */
function CentroAlertas({ vista, equipos, alarmas, sedeId, selInicial, onIr, onIrSede, onCerrar }: {
  vista: CentroVista;
  equipos: Map<string, Equipo[]>;
  alarmas: Alarma[];
  sedeId: string | null;
  selInicial: string | null;
  onIr: (sede: string, ref: string | null) => void;
  onIrSede: (sede: string) => void;
  onCerrar: () => void;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onCerrar]);
  const [tab, setTab] = useState<"activas" | "historial">("activas");
  const [sev, setSev] = useState<"todas" | "critico" | "advertencia" | "info">("todas");
  const [sel, setSel] = useState<string | null>(selInicial);

  const sedeNombre = sedeId ? vista.sedes.find((s) => s.id === sedeId)?.nombre ?? sedeId : null;
  const activas: ItemAlerta[] = alarmas
    .filter((a) => !sedeId || a.sedeId === sedeId)
    .map((a) => ({ id: a.codigo, sev: a.severidad, activa: true, titulo: EVENTO_TXT[a.evento] ?? a.titulo, equipoRef: a.inventario ?? a.dispositivo, sedeId: a.sedeId, sedeNombre: a.sedeNombre, t: a.desde, evento: a.evento, detalle: null }));
  const historial: ItemAlerta[] = vista.actividad
    .filter((a) => !sedeId || a.sede_id === sedeId)
    .slice(0, 80)
    .map((a) => ({ id: a.id, sev: a.tipo === "sin_respuesta" ? "critico" : a.tipo, activa: false, titulo: a.titulo, equipoRef: null, sedeId: a.sede_id, sedeNombre: a.sede, t: a.t, evento: null, detalle: a.detalle }));
  const base = tab === "activas" ? activas : historial;
  const lista = base.filter((i) => sev === "todas" || i.sev === sev || (sev === "info" && i.sev === "ok"));
  const item = lista.find((i) => i.id === sel) ?? lista[0] ?? null;
  const eq = item?.equipoRef ? (equipos.get(item.sedeId) ?? []).find((x) => x.inventario === item.equipoRef || x.nombre === item.equipoRef || x.central?.nombre === item.equipoRef) ?? null : null;
  const crit = activas.filter((a) => a.sev === "critico").length;
  const adv = activas.filter((a) => a.sev === "advertencia").length;
  const sedesAfectadas = new Set(activas.map((a) => a.sedeId)).size;

  const tabBtn = (on: boolean) => `min-h-[36px] rounded-lg px-3.5 text-[13px] font-bold ${on ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`;
  const sevs: [typeof sev, string][] = tab === "activas" ? [["todas", "Todas"], ["critico", "Críticas"], ["advertencia", "Advertencias"]] : [["todas", "Todas"], ["critico", "Críticas"], ["advertencia", "Advertencias"], ["info", "Informativas"]];

  return (
    <div className="cm-modal arriba" role="presentation" onClick={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="caja cm entrar" role="dialog" aria-modal="true" aria-label="Centro de alertas" style={{ width: "min(1080px, 100%)" }}>
        {/* cabecera */}
        <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border" style={{ borderColor: `${crit ? SEV_COLOR.critico : SEV_COLOR.advertencia}66`, background: `${crit ? SEV_COLOR.critico : SEV_COLOR.advertencia}1a` }}>
            <IconoCampana size={22} color={crit ? "#fca5a5" : "#fbbf24"} />
          </span>
          <div className="min-w-0 flex-1">
            <strong className="block text-lg text-slate-50">Centro de alertas</strong>
            <span className="flex items-center gap-2 text-xs text-slate-400">
              {sedeNombre ? `Sede ${sedeNombre}` : "Toda la red IGSS"} ·
              <span className={`h-2 w-2 rounded-full ${vista.atrasado ? "bg-amber-400" : "latido bg-emerald-400"}`} />
              {vista.atrasado ? `desactualizado · ${hace(vista.recibido)}` : `en vivo · ${hace(vista.recibido)}`}
            </span>
          </div>
          {sedeId && (
            <button type="button" onClick={() => onIrSede(sedeId)} className="hidden min-h-[40px] rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs font-semibold text-sky-300 hover:bg-slate-800 sm:block">Ir a la sede</button>
          )}
          <button type="button" onClick={onCerrar} aria-label="Cerrar" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800">✕</button>
        </div>

        {/* resumen */}
        <div className="grid gap-2.5 px-5 py-4 [grid-template-columns:repeat(auto-fit,minmax(140px,1fr))]">
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3.5 py-2.5"><small className="font-semibold text-slate-400">Activas</small><b className="mono block text-2xl text-slate-50">{activas.length}</b></div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3.5 py-2.5"><small className="font-semibold text-rose-300">Críticas</small><b className="mono block text-2xl text-slate-50">{crit}</b></div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3.5 py-2.5"><small className="font-semibold text-amber-300">Advertencias</small><b className="mono block text-2xl text-slate-50">{adv}</b></div>
          {sedeId ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3.5 py-2.5"><small className="font-semibold text-slate-400">En el historial</small><b className="mono block text-2xl text-slate-50">{historial.length}</b></div>
          ) : (
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3.5 py-2.5"><small className="font-semibold text-slate-400">Sedes afectadas</small><b className="mono block text-2xl text-slate-50">{sedesAfectadas}</b></div>
          )}
        </div>

        {/* pestañas y filtros */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-3">
          <div role="tablist" aria-label="Alertas" className="flex gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
            <button type="button" role="tab" aria-selected={tab === "activas"} onClick={() => { setTab("activas"); setSel(null); setSev("todas"); }} className={tabBtn(tab === "activas")}>Activas ({activas.length})</button>
            <button type="button" role="tab" aria-selected={tab === "historial"} onClick={() => { setTab("historial"); setSel(null); }} className={tabBtn(tab === "historial")}>Historial</button>
          </div>
          <div role="group" aria-label="Filtrar por severidad" className="flex flex-wrap gap-1.5">
            {sevs.map(([k, t]) => (
              <button key={k} type="button" aria-pressed={sev === k} onClick={() => { setSev(k); setSel(null); }} className={`min-h-[32px] rounded-full border px-3 text-xs font-semibold ${sev === k ? "border-slate-100 bg-slate-100 text-slate-900" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}>{t}</button>
            ))}
          </div>
        </div>

        {/* lista + detalle */}
        <div className="flex flex-wrap border-t border-slate-800">
          <div className="flex max-h-[52vh] min-w-0 flex-[1_1_340px] flex-col gap-1 overflow-y-auto border-slate-800 p-2.5 md:border-r">
            {lista.length === 0 && (
              <p className="px-3 py-10 text-center text-sm text-slate-400">{tab === "activas" ? (base.length ? "No hay alertas con este filtro." : "Sin alertas activas. Todo en orden.") : "Sin eventos con este filtro."}</p>
            )}
            {lista.map((i) => {
              const on = item?.id === i.id;
              return (
                <button key={i.id} type="button" onClick={() => setSel(i.id)} aria-current={on} className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left ${on ? "border-[#2c4170] bg-[#13213f]" : "border-transparent hover:bg-slate-800/50"}`}>
                  <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SEV_COLOR[i.sev] }} />
                  <span className="min-w-0 flex-1">
                    <span className="flex justify-between gap-2">
                      <b className="truncate text-[13px] text-slate-100">{i.equipoRef ? `${i.equipoRef} · ` : ""}{i.titulo}</b>
                      <span className="shrink-0 text-[11px] text-slate-400">{i.activa ? haceCorto(i.t) : hace(i.t).replace("hace ", "")}</span>
                    </span>
                    <span className="block truncate text-xs text-slate-400">{i.sedeNombre}{i.detalle ? ` · ${i.detalle}` : ""}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="min-w-0 flex-[1.5_1_420px] p-5">
            {!item ? (
              <div className="grid h-full min-h-[260px] place-items-center text-sm text-slate-400">Seleccione una alerta para ver su detalle.</div>
            ) : (
              <div className="entrar flex flex-col gap-4" key={item.id}>
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold" style={{ color: SEV_COLOR[item.sev], background: `${SEV_COLOR[item.sev]}1f` }}>
                    <span className="h-2 w-2 rounded-full" style={{ background: SEV_COLOR[item.sev] }} />
                    {SEV_TXT[item.sev]}{item.activa ? " · activa" : ""}
                  </span>
                  <h3 className="mt-2.5 text-xl font-semibold leading-snug text-slate-50">{item.titulo}</h3>
                  <p className="mt-1 text-sm text-slate-300">{[item.equipoRef, eq && eq.nombre !== item.equipoRef ? eq.nombre : null, item.sedeNombre].filter(Boolean).join(" · ")}</p>
                </div>

                {item.activa ? (
                  <div className="grid grid-cols-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
                    {[
                      ["Detectada", fechaHora(item.t), SEV_COLOR[item.sev]],
                      ["Activa desde hace", haceCorto(item.t), SEV_COLOR[item.sev]],
                      ["Correo", "lo envía la sede", "#475569"],
                    ].map(([l, val, c], idx) => (
                      <div key={l} className="min-w-0">
                        <div className="flex items-center"><span className="h-3 w-3 shrink-0 rounded-full" style={{ background: c }} />{idx < 2 && <span className="h-0.5 flex-1 bg-slate-700" />}</div>
                        <small className="mt-2 block text-[11px] text-slate-400">{l}</small>
                        <b className="block text-[13px] text-slate-100">{val}</b>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm">
                    <small className="block text-[11px] text-slate-400">Registrado</small>
                    <b className="text-slate-100">{fechaHora(item.t)}</b>
                    {item.detalle && <p className="mt-2 text-slate-300">{item.detalle}</p>}
                  </div>
                )}

                <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
                  <div><dt className="text-[11px] text-slate-400">Sede</dt><dd className="font-semibold text-slate-100">{item.sedeNombre}</dd></div>
                  <div><dt className="text-[11px] text-slate-400">Equipo</dt><dd className="font-semibold text-slate-100">{eq?.nombre ?? item.equipoRef ?? "—"}</dd></div>
                  <div><dt className="text-[11px] text-slate-400">Área</dt><dd className="font-semibold text-slate-100">{eq?.area ?? "—"}</dd></div>
                  {item.evento && <div><dt className="text-[11px] text-slate-400">Código del evento</dt><dd className="mono text-xs font-semibold text-slate-100">{item.evento}</dd></div>}
                  {item.activa && <div className="col-span-2"><dt className="text-[11px] text-slate-400">Referencia</dt><dd className="mono text-xs font-semibold text-slate-100">{item.id}</dd></div>}
                </dl>

                <p className="rounded-xl border border-slate-800 bg-[#0a1222] px-3.5 py-2.5 text-xs leading-relaxed text-slate-400">
                  Los correos los envía cada sede (api-SIASA). El historial con sus correos está en el equipo → «Alarmas y correos».
                </p>

                <div className="flex flex-wrap gap-2">
                  {item.equipoRef && (
                    <button type="button" onClick={() => onIr(item.sedeId, item.equipoRef)} className="min-h-[42px] rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-500">Ver equipo</button>
                  )}
                  <button type="button" onClick={() => onIrSede(item.sedeId)} className="min-h-[42px] rounded-lg border border-slate-700 bg-slate-900 px-4 text-sm font-semibold text-slate-100 hover:bg-slate-800">Ir a la sede</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- mapa (misma proyeccion que el monitoreo central) ---------------- */
const W = 640, H = 420, LON0 = -91.95, LON1 = -90.25, LAT0 = 13.8, LAT1 = 14.8;
const px = (lon: number) => ((lon - LON0) / (LON1 - LON0)) * W;
const py = (lat: number) => ((LAT1 - lat) / (LAT1 - LAT0)) * H;
const COSTA: [number, number][] = [[-91.95, 14.33], [-91.82, 14.25], [-91.7, 14.18], [-91.58, 14.11], [-91.45, 14.05], [-91.3, 13.98], [-91.15, 13.93], [-90.98, 13.92], [-90.82, 13.92], [-90.65, 13.9], [-90.48, 13.89], [-90.25, 13.82]];
const costaPx: [number, number][] = COSTA.map(([lo, la]) => [px(lo), py(la)]);
/** Altura de la costa (px) en una x del mapa. */
const yCosta = (x: number) => {
  const i = Math.max(0, costaPx.findIndex(([cx]) => cx >= x) - 1);
  const [x0, y0] = costaPx[i];
  const [x1, y1] = costaPx[Math.min(i + 1, costaPx.length - 1)];
  return x1 === x0 ? y0 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
};
/** Curva suave por los puntos (Catmull-Rom convertida a Bezier). */
const curva = (pts: [number, number][]) => {
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
};
const costaD = curva(costaPx);
const tierraD = `${costaD} L${W} 0 L0 0 Z`;
/** Olas: lineas onduladas paralelas a la costa, cada una mas lejos, mas tenue y mas lenta. */
const OLAS = [
  { dy: 8, amp: 1.4, largo: 26, op: 0.7, seg: 7 },
  { dy: 18, amp: 2.2, largo: 34, op: 0.48, seg: 10 },
  { dy: 31, amp: 3, largo: 44, op: 0.3, seg: 14 },
  { dy: 48, amp: 3.8, largo: 56, op: 0.18, seg: 19 },
].map((o, k) => {
  const pts: [number, number][] = [];
  for (let x = 0; x <= W + 0.1; x += 14) pts.push([x, yCosta(x) + o.dy + o.amp * Math.sin((x / o.largo) * Math.PI + k * 1.7)]);
  return { ...o, d: curva(pts) };
});
const CENTRAL = { x: px(-90.42), y: py(14.7) };
const ETQ: Record<string, [number, number]> = { gineco: [16, -2], villanueva: [16, 2], amatitlan: [-16, -6], palin: [16, 10], escuintla: [16, 16], santalucia: [0, 32], gomera: [16, 0], tiquisate: [0, 30], mazatenango: [0, -30], retalhuleu: [0, 30] };

interface Caja { x: number; y: number; w: number; h: number }
const COMPLETA: Caja = { x: 0, y: 0, w: W, h: H };
const ZOOM_MAX = 5, PASO = 1.35;
function ajustar(c: Caja): Caja {
  const w = Math.min(W, Math.max(W / ZOOM_MAX, c.w));
  const h = (w / W) * H;
  return { w, h, x: Math.min(W - w, Math.max(0, c.x)), y: Math.min(H - h, Math.max(0, c.y)) };
}

const TIPO_COLOR: Record<DeviceKind, string> = { ion: "#7cc4ff", pm: "#4ade80", gen: "#fbbf24" };
const TIPO_TXT: Record<DeviceKind, string> = { ion: "Analizador ION7400", pm: "Medidor PM2130", gen: "Generador" };

function Mapa({ vista, equipos, sobre, setSobre, onAbrir, grupos, grupoDe, onAbrirEquipo }: {
  vista: CentroVista;
  equipos: Map<string, Equipo[]>;
  sobre: string | null;
  setSobre: (id: string | null) => void;
  onAbrir: (id: string) => void;
  grupos: RedGrupo[];
  grupoDe: (id: string) => RedGrupo | null;
  onAbrirEquipo: (e: Equipo) => void;
}) {
  const [vb, setVb] = useState<Caja>(COMPLETA);
  const [ampliado, setAmpliado] = useState(false);
  /** Sede con sus ramas (equipos) desplegadas en el mapa. */
  const [rama, setRama] = useState<string | null>(null);
  /** Grupos (fases) ocultos en el mapa. */
  const [ocultos, setOcultos] = useState<Set<string>>(new Set());
  const cajaRef = useRef<HTMLDivElement>(null);
  const arrastre = useRef<{ x: number; y: number; vb: Caja; movio: boolean } | null>(null);
  const zoom = W / vb.w;
  const sedes = vista.sedes.filter((s) => s.lat != null && s.lon != null && !ocultos.has(grupoDe(s.id)?.id ?? "__sin"));
  const sinUbicacion = vista.sedes.filter((s) => s.lat == null || s.lon == null);
  const sr = sedes.find((s) => s.id === rama) ?? null;
  /** Ramas de la sede desplegada: un punto por equipo alrededor de la sede (radio fijo en pantalla). */
  const ramas = (() => {
    if (!sr) return [];
    const lista = equipos.get(sr.id) ?? [];
    const x0 = px(sr.lon!), y0 = py(sr.lat!);
    const r = (lista.length > 9 ? 40 : lista.length > 5 ? 32 : 26) / zoom;
    return lista.map((e, i) => {
      const a = (i / Math.max(1, lista.length)) * Math.PI * 2 - Math.PI / 2;
      return { e, x: x0 + Math.cos(a) * r, y: y0 + Math.sin(a) * r, x0, y0 };
    });
  })();

  /** punto del mapa bajo el cursor */
  const aMapa = (cx: number, cy: number) => {
    const r = cajaRef.current?.getBoundingClientRect();
    if (!r) return { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 };
    return { x: vb.x + ((cx - r.left) / r.width) * vb.w, y: vb.y + ((cy - r.top) / r.height) * vb.h };
  };
  const acercar = (f: number, centro?: { x: number; y: number }) =>
    setVb((c) => {
      const cx = centro?.x ?? c.x + c.w / 2, cy = centro?.y ?? c.y + c.h / 2;
      const w = c.w / f, h = c.h / f;
      return ajustar({ w, h, x: cx - ((cx - c.x) / c.w) * w, y: cy - ((cy - c.y) / c.h) * h });
    });

  // rueda del mouse: acerca hacia el cursor (listener no pasivo para que la pagina no se desplace)
  useEffect(() => {
    const el = cajaRef.current;
    if (!el) return;
    const rueda = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setVb((c) => {
        const f = e.deltaY < 0 ? PASO : 1 / PASO;
        const cx = c.x + ((e.clientX - r.left) / r.width) * c.w, cy = c.y + ((e.clientY - r.top) / r.height) * c.h;
        const w = c.w / f, h = c.h / f;
        return ajustar({ w, h, x: cx - ((cx - c.x) / c.w) * w, y: cy - ((cy - c.y) / c.h) * h });
      });
    };
    el.addEventListener("wheel", rueda, { passive: false });
    return () => el.removeEventListener("wheel", rueda);
  }, [ampliado]);

  // Esc cierra la vista ampliada
  useEffect(() => {
    if (!ampliado) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setAmpliado(false);
    document.addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", k); document.body.style.overflow = ""; };
  }, [ampliado]);

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    arrastre.current = { x: e.clientX, y: e.clientY, vb, movio: false };
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const a = arrastre.current, el = cajaRef.current;
    if (!a || !el) return;
    const dx = e.clientX - a.x, dy = e.clientY - a.y;
    if (!a.movio && Math.hypot(dx, dy) < 4) return;
    if (!a.movio) { a.movio = true; el.setPointerCapture(e.pointerId); }
    const r = el.getBoundingClientRect();
    setVb(ajustar({ ...a.vb, x: a.vb.x - (dx / r.width) * a.vb.w, y: a.vb.y - (dy / r.height) * a.vb.h }));
  };
  const onUp = () => { arrastre.current = null; };

  const P = (x: number, y: number) => ({ left: `${((x - vb.x) / vb.w) * 100}%`, top: `${((y - vb.y) / vb.h) * 100}%` });
  const lineas = (n: (s: CentroSede) => boolean) =>
    sedes.filter(n).map((s) => {
      const x = px(s.lon!), y = py(s.lat!);
      return `M${x.toFixed(1)} ${y.toFixed(1)} Q${((x + CENTRAL.x) / 2).toFixed(1)} ${(Math.min(y, CENTRAL.y) - 30).toFixed(1)} ${(CENTRAL.x - 14).toFixed(1)} ${(CENTRAL.y + 4).toFixed(1)}`;
    }).join(" ");
  const f = sedes.find((s) => s.id === sobre);
  const btn = "grid h-8 min-w-8 place-items-center rounded-md border border-slate-700 bg-slate-900 px-2 text-sm font-bold text-slate-200 hover:border-sky-600 disabled:opacity-40";

  const mapa = (
    <section aria-label="Sedes en el mapa" className={`panel flex flex-col gap-2 p-3 ${ampliado ? "fixed inset-3 z-50 shadow-2xl sm:inset-6" : ""}`} {...(ampliado ? { role: "dialog", "aria-modal": true } : {})}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow">Sedes en el mapa</span>
        {grupos.length > 1 && (
          <div role="group" aria-label="Fases visibles en el mapa" className="flex flex-wrap gap-1.5">
            {grupos.map((g) => {
              const on = !ocultos.has(g.id);
              return (
                <button key={g.id} type="button" aria-pressed={on} onClick={() => setOcultos((o) => { const n = new Set(o); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })} className="flex min-h-[30px] items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold" style={{ borderColor: on ? g.color : "#334155", background: on ? `${g.color}22` : "transparent", color: on ? "#e2e8f0" : "#64748b" }}>
                  <span className="h-2 w-2 rounded-[3px]" style={{ background: on ? g.color : "#475569" }} />{g.nombre}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <button type="button" className={btn} onClick={() => acercar(PASO)} disabled={zoom >= ZOOM_MAX - 0.01} aria-label="Acercar" title="Acercar">+</button>
          <button type="button" className={btn} onClick={() => acercar(1 / PASO)} disabled={zoom <= 1.01} aria-label="Alejar" title="Alejar">−</button>
          <button type="button" className={btn} onClick={() => setVb(COMPLETA)} disabled={zoom <= 1.01} aria-label="Ver el mapa completo" title="Ver el mapa completo">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
          </button>
          <button type="button" className={`${btn} gap-1.5 ${ampliado ? "border-sky-600 bg-sky-950" : ""}`} onClick={() => setAmpliado((a) => !a)} aria-label={ampliado ? "Cerrar el mapa ampliado" : "Ampliar el mapa"} style={{ display: "flex" }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">{ampliado ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />}</svg>
            {ampliado ? "Cerrar" : "Ampliar"}
          </button>
        </div>
      </div>
      <div
        ref={cajaRef}
        className={`mapa ${ampliado ? "mapa-lleno" : ""}`}
        style={ampliado ? { width: "min(100%, calc((100vh - 9.5rem) * 1.5238))", margin: "0 auto" } : undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button")) acercar(PASO * PASO, aMapa(e.clientX, e.clientY)); }}
      >
        <svg width="100%" height="100%" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", inset: 0, cursor: arrastre.current?.movio ? "grabbing" : "grab" }}>
          <defs>
            <linearGradient id="cmMar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0B2540" /><stop offset="1" stopColor="#06182B" /></linearGradient>
            <radialGradient id="cmTierra" cx="70%" cy="10%" r="90%"><stop offset="0" stopColor="#15213A" /><stop offset="1" stopColor="#0E1627" /></radialGradient>
            <pattern id="cmRej" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#1A2742" strokeWidth="1" /></pattern>
            <radialGradient id="cmHalo" cx={CENTRAL.x / W} cy={CENTRAL.y / H} r=".38"><stop offset="0" stopColor="#3b82f6" stopOpacity=".28" /><stop offset="1" stopColor="#3b82f6" stopOpacity="0" /></radialGradient>
          </defs>
          <rect width={W} height={H} fill="url(#cmMar)" />
          <path d={tierraD} fill="url(#cmTierra)" />
          <path d={tierraD} fill="url(#cmRej)" opacity=".55" />
          <rect width={W} height={H} fill="url(#cmHalo)" />
          {/* Mar: olas que se mueven y un brillo que recorre la costa */}
          {OLAS.map((o, i) => (
            <path key={i} className="ola" d={o.d} fill="none" stroke="#38bdf8" strokeOpacity={o.op} strokeWidth="1.2" strokeLinecap="round" vectorEffect="non-scaling-stroke" style={{ animationDuration: `${o.seg}s, ${4 + i * 1.5}s`, animationDelay: `-${i * 1.3}s, -${i}s` }} />
          ))}
          <path d={costaD} fill="none" stroke="#38bdf8" strokeOpacity=".18" strokeWidth="7" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={costaD} fill="none" stroke="#3b82f6" strokeWidth="2.2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path className="brillo-costa" d={costaD} fill="none" stroke="#bae6fd" strokeWidth="2.6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <text className={`mar-texto ${ampliado ? "mar-svg" : ""}`} x={px(-91.5)} y={H - 16} fill="#38bdf8" fontSize="11" letterSpacing="6" fontFamily="monospace">OCÉANO PACÍFICO</text>
          {[["Volcán de Fuego", -90.88, 14.47], ["Volcán de Agua", -90.74, 14.47]].map(([n, lo, la]) => (
            <path key={n as string} d={`M${px(lo as number) - 7} ${py(la as number) + 5} L${px(lo as number)} ${py(la as number) - 6} L${px(lo as number) + 7} ${py(la as number) + 5} Z`} fill="#22324f" stroke="#3a4d70"><title>{n as string}</title></path>
          ))}
          <path className="flujo" d={lineas((s) => s.nivel === "ok")} fill="none" stroke="#22c55e" strokeWidth="1.4" opacity=".75" vectorEffect="non-scaling-stroke" />
          <path className="flujo" d={lineas((s) => s.nivel === "advertencia")} fill="none" stroke="#f59e0b" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
          <path className="flujo" d={lineas((s) => s.nivel === "critico")} fill="none" stroke="#ef4444" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
          {/* paquetes de luz que viajan de cada sede que responde hacia el monitoreo central */}
          {sedes.filter((s) => !s.sin_respuesta).map((s, i) => (
            <path key={`p-${s.id}`} className="paquete" d={lineas((x) => x.id === s.id)} fill="none" stroke={s.nivel === "ok" ? "#86efac" : s.nivel === "advertencia" ? "#fcd34d" : "#fca5a5"} strokeWidth="2.6" strokeLinecap="round" vectorEffect="non-scaling-stroke" style={{ animationDelay: `-${(i * 0.7) % 3.2}s`, animationDuration: `${2.6 + (i % 4) * 0.5}s` }} />
          ))}
          <path d={lineas((s) => s.nivel === "sin_respuesta")} fill="none" stroke="#ef4444" strokeWidth="1.4" strokeDasharray="2 6" opacity=".6" vectorEffect="non-scaling-stroke" />
          {ramas.map((b) => (
            <line key={b.e.key} x1={b.x0} y1={b.y0} x2={b.x} y2={b.y} stroke={b.e.ok ? TIPO_COLOR[b.e.kind] : "#ef4444"} strokeWidth="1.6" opacity=".85" vectorEffect="non-scaling-stroke" className="rama-linea" />
          ))}
        </svg>
        <div className="pointer-events-none absolute flex items-center gap-2" style={{ ...P(CENTRAL.x - 18, CENTRAL.y), transform: "translate(-100%, -50%)" }}>
          <span className="flex flex-col items-end"><strong className="text-[13px] text-slate-100">Monitoreo central</strong><span className="mono text-[10px] text-slate-400">Ciudad de Guatemala</span></span>
          <span className="grid h-[26px] w-[26px] place-items-center rounded-md bg-blue-500 shadow-[0_0_14px_rgba(59,130,246,.6)]"><span className="h-2.5 w-2.5 rounded-sm border-2 border-white" /></span>
        </div>
        {/* Ampliado el mapa llena el recuadro: el rotulo va fuera del dibujo para que no se estire. */}
        {ampliado && <span className="mar-rotulo mono" style={P(px(-91.5), H - 20)} aria-hidden="true">OCÉANO PACÍFICO</span>}
        {/* recuadro de flujo de datos (no tapa el arrastre: solo informa) */}
        <div className="pointer-events-none absolute left-3 top-3 hidden flex-col gap-1 rounded-lg border border-slate-800 bg-[#090f1c]/85 px-3 py-2 sm:flex">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Flujo de datos</span>
          <span className="mono text-[12px] text-slate-100">{sedes.filter((s) => !s.sin_respuesta).length} de {sedes.length} rutas activas</span>
          <span className={`mono text-[11px] ${vista.atrasado ? "text-amber-300" : "text-emerald-300"}`}>↑ actualizado {hace(vista.recibido)}</span>
        </div>
        {sedes.map((s) => {
          const x = px(s.lon!), y = py(s.lat!);
          const [dx, dy] = ETQ[s.id] ?? [16, 0];
          const lista = equipos.get(s.id) ?? [];
          const malos = lista.filter((e) => !e.ok);
          const alarma = s.nivel === "critico" || s.nivel === "sin_respuesta";
          const nAl = s.abiertos.length;
          const sub = s.sin_respuesta ? "sin respuesta" : malos.length === 1 ? `${malos[0].inventario ?? malos[0].nombre} ${malos[0].estadoTxt.toLowerCase()}` : malos.length ? `${malos.length} equipos con falla` : `${lista.length}/${lista.length} en línea${nAl ? ` · ${nAl} ${nAl === 1 ? "alerta" : "alertas"}` : ""}`;
          const g = grupoDe(s.id);
          const desplegada = rama === s.id;
          return (
            <button
              key={s.id}
              type="button"
              className="nodo"
              style={{ ...P(x, y), zIndex: desplegada ? 4 : undefined }}
              onClick={() => setRama(desplegada ? null : s.id)}
              onDoubleClick={() => { setAmpliado(false); onAbrir(s.id); }}
              onMouseEnter={() => setSobre(s.id)}
              onMouseLeave={() => setSobre(null)}
              onFocus={() => setSobre(s.id)}
              onBlur={() => setSobre(null)}
              aria-expanded={desplegada}
              aria-label={`${s.nombre}${g ? ` (${g.nombre})` : ""}: ${NIVEL_TXT[s.nivel]}, ${sub}. ${desplegada ? "Plegar sus equipos" : "Desplegar sus equipos"}`}
            >
              <span className="absolute -left-[26px] -top-[26px] h-[52px] w-[52px] rounded-full" style={{ background: `radial-gradient(circle, ${COLOR[s.nivel]}88, transparent 70%)` }} />
              {/* pulso: todas las sedes laten con su color; advertencia y alarma, con doble onda */}
              <span className="onda" style={{ borderColor: COLOR[s.nivel], animationDuration: alarma ? "1.6s" : "2.4s", animationDelay: `-${(s.nombre.length % 7) * 0.3}s` }} />
              {(alarma || s.nivel === "advertencia") && <span className="onda" style={{ borderColor: COLOR[s.nivel], animationDuration: alarma ? "1.6s" : "2.4s", animationDelay: alarma ? "-.8s" : "-1.2s" }} />}
              {g && <span className="absolute -left-[13px] -top-[13px] h-[26px] w-[26px] rounded-full" style={{ border: `2.5px solid ${g.color}`, boxShadow: desplegada ? `0 0 0 4px ${g.color}44` : undefined }} />}
              <span className="punto absolute -left-[9px] -top-[9px] grid h-[18px] w-[18px] place-items-center rounded-full" style={{ background: COLOR[s.nivel], boxShadow: sobre === s.id ? "0 0 0 3px #fff" : undefined }}>
                <span className="h-1.5 w-1.5 rounded-full bg-[#052e16]" />
              </span>
              {!desplegada && (
                <span className="placa" style={{ left: dx, top: dy - 17, transform: dx < 0 ? "translateX(-100%)" : dx === 0 ? "translateX(-50%)" : undefined, border: `1px solid ${alarma ? "#ef4444" : s.nivel === "advertencia" ? "#f59e0b" : g ? `${g.color}99` : "#1f6b3d"}` }}>
                  <strong className="text-[13px] text-slate-100">{s.nombre}</strong>
                  <span className={`mono hidden text-[11px] sm:block ${alarma ? "text-rose-300" : s.nivel === "advertencia" ? "text-amber-200" : "text-emerald-200"}`}>{sub}{lista.some(esDirecto) ? " · directo" : ""}</span>
                </span>
              )}
            </button>
          );
        })}
        {/* ramas: un punto por equipo de la sede desplegada (clic = abrir el equipo) */}
        {ramas.map((b) => (
          <button
            key={b.e.key}
            type="button"
            className="rama"
            style={{ ...P(b.x, b.y), background: b.e.ok ? TIPO_COLOR[b.e.kind] : "#ef4444" }}
            onClick={() => onAbrirEquipo(b.e)}
            title={`${b.e.nombre} · ${TIPO_TXT[b.e.kind]} · ${b.e.estadoTxt}`}
            aria-label={`Abrir ${b.e.nombre}, ${TIPO_TXT[b.e.kind]}, ${b.e.estadoTxt}`}
          />
        ))}
        {sr && (
          <div className="ficha-rama entrar" role="region" aria-label={`Equipos de ${sr.nombre}`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {grupoDe(sr.id) && <span className="mb-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: `${grupoDe(sr.id)!.color}26`, color: "#e2e8f0" }}><span className="h-1.5 w-1.5 rounded-[2px]" style={{ background: grupoDe(sr.id)!.color }} />{grupoDe(sr.id)!.nombre}</span>}
                <strong className="block truncate text-[15px] text-slate-50">{sr.nombre}</strong>
              </div>
              <button type="button" onClick={() => setRama(null)} aria-label="Plegar" className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-slate-800">✕</button>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(["ion", "pm", "gen"] as DeviceKind[]).map((k) => (
                <div key={k} className="rounded-lg bg-slate-950/70 px-2 py-1.5 text-center">
                  <b className="mono block text-base text-slate-50">{(equipos.get(sr.id) ?? []).filter((e) => e.kind === k).length}</b>
                  <small className="text-[10px] font-semibold" style={{ color: TIPO_COLOR[k] }}>{k === "ion" ? "ION7400" : k === "pm" ? "PM2130" : "Generador"}</small>
                </div>
              ))}
            </div>
            <span className="text-[11px] text-slate-400">Toque un punto para abrir ese equipo.</span>
            <button type="button" onClick={() => { setAmpliado(false); setRama(null); onAbrir(sr.id); }} className="min-h-[36px] rounded-lg bg-sky-600 text-[13px] font-bold text-white hover:bg-sky-500">Abrir la sede</button>
          </div>
        )}
        {f && f.id !== rama && (
          <div role="tooltip" className="ficha entrar" style={{ ...P(px(f.lon!), py(f.lat!)), transform: (py(f.lat!) - vb.y) / vb.h < 0.45 ? "translate(-50%, 24px)" : "translate(-50%, calc(-100% - 24px))" }}>
            <div className="flex items-center gap-2">
              <strong className="flex-1 text-[15px] text-slate-50">{f.nombre}</strong>
              <span className="rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: `${COLOR[f.nivel]}22`, color: COLOR[f.nivel] }}>{NIVEL_TXT[f.nivel]}</span>
            </div>
            {f.sin_respuesta && <div className="rounded-lg border border-rose-900 bg-rose-950/60 p-2 text-xs"><b>La sede no responde</b><br />{f.error ?? "sin datos"}</div>}
            {(() => {
              const caidos = (equipos.get(f.id) ?? []).filter((e) => !e.ok);
              const alertas = [...f.abiertos].sort((a, b) => (a.severidad === b.severidad ? b.desde.localeCompare(a.desde) : a.severidad === "critico" ? -1 : 1));
              const total = caidos.length + alertas.length;
              const max = 5;
              const mostrarCaidos = caidos.slice(0, max);
              const mostrarAlertas = alertas.slice(0, Math.max(0, max - mostrarCaidos.length));
              return (
                <>
                  {total > 0 && <span className="eyebrow">{total === 1 ? "1 alerta activa" : `${total} alertas activas`}</span>}
                  {mostrarCaidos.map((e) => (
                    <div key={e.key} className="rounded-lg border border-rose-900 bg-rose-950/60 p-2 text-xs"><b>{e.inventario ?? e.nombre} · {e.estadoTxt}</b><br /><span className="text-rose-200/80">{e.nombre}{e.area ? ` · ${e.area}` : ""}</span></div>
                  ))}
                  {mostrarAlertas.map((a) => {
                    const crit = a.severidad === "critico";
                    const eq = (equipos.get(f.id) ?? []).find((e) => e.inventario && e.inventario === a.inventario);
                    return (
                      <div key={a.codigo} className={`rounded-lg border p-2 text-xs ${crit ? "border-rose-900 bg-rose-950/60" : "border-amber-900 bg-amber-950/50"}`}>
                        <b>{a.inventario ?? a.dispositivo ?? f.nombre} · {EVENTO_TXT[a.evento] ?? a.titulo}</b>
                        <br />
                        <span className={crit ? "text-rose-200/80" : "text-amber-200/80"}>
                          {eq ? `${eq.nombre}${eq.area ? ` · ${eq.area}` : ""} · ` : a.dispositivo ? `${a.dispositivo} · ` : ""}
                          {crit ? "Crítica" : esInstrumentacion(a.evento, a.titulo) ? "Advertencia de instrumentación" : "Advertencia"} · {hace(a.desde)}
                        </span>
                      </div>
                    );
                  })}
                  {total > max && <span className="text-[11px] text-slate-400">y {total - max} más · clic para verlas todas</span>}
                </>
              );
            })()}
            <div className="flex justify-between text-xs"><span className="text-slate-400">Equipos en línea</span><b className="text-slate-100">{(equipos.get(f.id) ?? []).filter((e) => e.ok).length}/{(equipos.get(f.id) ?? []).length}</b></div>
            {grupoDe(f.id) && <div className="flex justify-between text-xs"><span className="text-slate-400">Fase</span><b style={{ color: grupoDe(f.id)!.color }}>{grupoDe(f.id)!.nombre}</b></div>}
            <div className="flex justify-between text-xs"><span className="text-slate-400">Origen del dato</span><b className={f.id === ESCUINTLA || (equipos.get(f.id) ?? []).some((e) => e.directo) ? "text-emerald-300" : "text-slate-200"}>{f.id === ESCUINTLA ? "Directo (Gravix) + EBO" : (equipos.get(f.id) ?? []).some((e) => e.directo) || f.ip.startsWith("Agente") ? "Directo (Agente Go)" : "EBO → api-SIASA"}</b></div>
            <div className="flex justify-between text-xs"><span className="text-slate-400">Respuesta</span><b className="text-slate-100">{f.latencia_ms != null ? `${f.latencia_ms} ms` : "—"}</b></div>
            <span className="text-[11px] text-sky-300">Clic: desplegar sus equipos · doble clic: abrir la sede</span>
          </div>
        )}
        <span className="mono pointer-events-none absolute bottom-2 left-3 rounded bg-slate-950/70 px-1.5 py-0.5 text-[10px] text-slate-400">
          {zoom > 1.01 ? `${zoom.toFixed(1)}× · arrastre para moverse` : "Rueda o +/− para acercar · arrastrar para mover · doble clic acerca"}
        </span>
      </div>
      <div className="flex flex-wrap gap-4 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-green-500" />Operando</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" />Advertencia (incluye vigilantes desconectados)</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500" />Alarma: medidor fuera de línea, voltaje en cero o sede sin respuesta</span>
        <span>- - - Línea de datos con el monitoreo central</span>
        {grupos.length > 0 && <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border-2 border-slate-400" />Aro: fase de telemetría</span>}
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: TIPO_COLOR.ion }} /><span className="h-2 w-2 rounded-full" style={{ background: TIPO_COLOR.pm }} /><span className="h-2 w-2 rounded-full" style={{ background: TIPO_COLOR.gen }} />Ramas: ION7400 · PM2130 · generador</span>
      </div>
      {sinUbicacion.length > 0 && (
        <p className="text-[11px] text-amber-200/80">Sin ubicación en el mapa: {sinUbicacion.map((s) => s.nombre).join(", ")}. Agréguela en «Editar sede» (latitud y longitud).</p>
      )}
    </section>
  );
  return (
    <>
      {ampliado && <div className="fixed inset-0 z-40 bg-slate-950/80 backdrop-blur-sm" onClick={() => setAmpliado(false)} aria-hidden="true" />}
      {ampliado && <div className="panel aspect-[640/420]" aria-hidden="true" />}
      {mapa}
    </>
  );
}

/** Envia una orden a Gravix (el asistente global la procesa como si se hubiera dicho). */
const ordenGravix = (texto: string) => window.dispatchEvent(new CustomEvent("gravix:orden", { detail: { texto } }));
const ATAJOS_GRAVIX = ["¿Qué puede fallar?", "Equipos fuera de línea", "Generadores en marcha", "Consumo de energía", "Estado por telemetría"];

/** Tarjeta de Gravix en el panel derecho: resumen hablado, alertas, microfono y preguntas rapidas. */
function TarjetaGravix({ vista, alarmas, onAlertas }: { vista: CentroVista; alarmas: Alarma[]; onAlertas: () => void }) {
  const t = vista.totales;
  const crit = alarmas.filter((a) => a.severidad === "critico");
  const adv = alarmas.filter((a) => a.severidad !== "critico");
  const sedesDe = (l: Alarma[]) => [...new Set(l.map((a) => a.sedeNombre))];
  const lista = (n: string[]) => (n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} y ${n[n.length - 1]}`);
  let msg = `${t.sedes_responden} de ${t.sedes} sedes responden`;
  msg += crit.length ? ` y hay ${crit.length} ${crit.length === 1 ? "alarma crítica" : "alarmas críticas"} en ${lista(sedesDe(crit))}.` : " y no hay alarmas críticas.";
  if (adv.length) {
    const s = sedesDe(adv);
    msg += ` ${lista(s)} ${s.length === 1 ? "tiene" : "tienen"} ${adv.length} ${adv.length === 1 ? "advertencia" : "advertencias"}.`;
  }
  if (alarmas.length) msg += " ¿Quiere que se las muestre?";
  return (
    <section aria-label="Gravix, asistente" className="panel flex flex-col gap-3 p-4" style={{ borderColor: "#1e4b73", background: "linear-gradient(160deg,#0d2340,#0b1220 70%)" }}>
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full font-extrabold text-white" style={{ background: "radial-gradient(circle at 35% 30%,#7dd3fc,#2563eb 60%,#1e3a8a)", boxShadow: "0 0 22px rgba(56,189,248,.55)" }}>G</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <b className="text-[14px] text-slate-100">Gravix</b>
          <span className="text-[11px] text-slate-400">Asistente de voz del Centro de mando</span>
        </span>
        <span className="voz-gravix flex h-5 items-end gap-[3px]" aria-hidden="true">
          {[0, 0.2, 0.5, 0.7, 0.35].map((d) => <span key={d} style={{ animationDelay: `-${d}s` }} />)}
        </span>
      </div>
      <p className="m-0 rounded-xl border border-sky-500/25 bg-sky-500/[.08] p-3 text-[13px] leading-relaxed text-sky-100">{msg}</p>
      <div className="flex gap-2">
        {alarmas.length > 0 ? (
          <button type="button" onClick={onAlertas} className="min-h-[40px] flex-1 rounded-lg bg-sky-500 text-[13px] font-bold text-slate-950 hover:bg-sky-400">
            Ver {crit.length ? "alertas" : adv.length === 1 ? "advertencia" : "advertencias"}
          </button>
        ) : (
          <button type="button" onClick={() => ordenGravix("¿Qué puede fallar?")} className="min-h-[40px] flex-1 rounded-lg bg-sky-500 text-[13px] font-bold text-slate-950 hover:bg-sky-400">
            ¿Qué puede fallar?
          </button>
        )}
        <button type="button" onClick={() => ordenGravix("¿Cómo está la red?")} aria-label="Escuchar el resumen de la red" title="Escuchar el resumen" className="grid min-h-[40px] w-11 place-items-center rounded-lg border border-[#1e4b73] bg-[#0b1220] text-sky-300 hover:bg-slate-800">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></svg>
        </button>
        <button type="button" onClick={() => window.dispatchEvent(new Event("gravix:escuchar"))} aria-label="Hablar con Gravix" title="Hablar con Gravix" className="grid min-h-[40px] w-11 place-items-center rounded-lg border border-[#1e4b73] bg-[#0b1220] text-sky-300 hover:bg-slate-800">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5" /></svg>
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Preguntas rápidas</span>
        <div className="flex flex-wrap gap-1.5">
          {ATAJOS_GRAVIX.map((q) => (
            <button key={q} type="button" onClick={() => ordenGravix(q)} className="min-h-[30px] rounded-full border border-slate-700 bg-slate-900/70 px-2.5 text-[11.5px] text-slate-200 hover:border-sky-500 hover:text-white">{q}</button>
          ))}
        </div>
      </div>
    </section>
  );
}

function Actividad({ vista, onIr }: { vista: CentroVista; onIr: (sede: string) => void }) {
  const col: Record<string, string> = { critico: "#ef4444", sin_respuesta: "#ef4444", advertencia: "#f59e0b", info: "#8ab8ff", ok: "#22c55e" };
  return (
    <section aria-label="Actividad en vivo" className="panel flex max-h-[560px] flex-col gap-2 p-4">
      <span className="flex items-center justify-between">
        <span className="eyebrow">Actividad en vivo</span>
        <span className="latido h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#22c55e]" aria-hidden="true" />
      </span>
      {vista.actividad.length === 0 && <p className="py-4 text-sm text-slate-500">Sin actividad en los últimos días</p>}
      <ol className="linea-tiempo m-0 flex list-none flex-col overflow-y-auto pr-1">
        {vista.actividad.slice(0, 40).map((a, i) => (
          <li key={a.id} className="hito entrar" style={{ animationDelay: `${Math.min(i, 8) * 0.04}s` }}>
            <span className="hito-punto" style={{ background: col[a.tipo] }} aria-hidden="true" />
            <button type="button" onClick={() => onIr(a.sede_id)} className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left hover:bg-slate-800/60">
              <span className="text-[13px] text-slate-200"><b>{a.sede}</b> · {a.titulo}</span>
              <span className="mono text-[11px] text-slate-500">{hace(a.t)}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ---------------- sede: equipos fisicos ---------------- */
function MiniEquipo({ device }: { device: PilotDevice }) {
  const kind = kindOf(device);
  const m = DIM[kind];
  const esc = kind === "gen" ? 0.3 : 0.38;
  return (
    <span className="mini gx" style={{ width: m.w, height: m.h, transform: `translate(-50%, -50%) scale(${esc})`, background: "transparent" }}>
      <DeviceBox device={device} kind={kind} screen={initialScreen()} onKey={() => {}} rot={{ x: -4, y: -16 }} />
    </span>
  );
}

function SedeVista({ sede, equipos, alarmas, filtro, setFiltro, onAbrir, onAlertas, enSala = false, grupo = null, nueva = false, esAdmin = false, onEditar, onQuitar, onBuscarEquipos, webGravix = null }: {
  sede: CentroSede;
  equipos: Equipo[];
  alarmas: Alarma[];
  filtro: "todos" | DeviceKind;
  setFiltro: (f: "todos" | DeviceKind) => void;
  onAbrir: (e: Equipo) => void;
  onAlertas: (sel: string | null) => void;
  enSala?: boolean;
  /** Fase de telemetria de la sede (grupo del arbol). */
  grupo?: RedGrupo | null;
  /** Sede nueva de Nodivo (leida por sus Agentes Go). */
  nueva?: boolean;
  esAdmin?: boolean;
  onEditar?: () => void;
  onQuitar?: () => void;
  onBuscarEquipos?: () => void;
  /** Sede con su propio Gravix: direccion de su web local (los equipos se agregan alla). */
  webGravix?: string | null;
}) {
  const [tab, setTab] = useState<"equipos" | "calidad" | "eventos">("equipos");
  const lista = equipos.filter((e) => filtro === "todos" || e.kind === filtro);
  const en = equipos.filter((e) => e.ok).length;
  const kw = equipos.reduce((t, e) => t + (e.central?.lectura?.kw ?? 0), 0);
  const gravix = sede.id === ESCUINTLA && equipos.some((e) => e.pilotDirect);
  const cal = filasCalidad(equipos);
  const nCal = { bad: cal.filter((f) => f.peor === "bad").length, warn: cal.filter((f) => f.peor === "warn").length, ok: cal.filter((f) => f.peor === "ok").length };
  const critico = alarmas.some((a) => a.severidad === "critico");
  const colAlerta = alarmas.length ? (critico ? SEV_COLOR.critico : SEV_COLOR.advertencia) : SEV_COLOR.ok;
  const tile = "flex flex-col justify-between gap-1 rounded-xl border border-slate-800 bg-[#0e1930] px-4 py-3";
  const tabs: ["equipos" | "calidad" | "eventos", string, number | null][] = [
    ["equipos", "Equipos", equipos.length],
    ...(cal.length ? ([["calidad", "Calidad de energía", nCal.bad + nCal.warn]] as ["calidad", string, number][]) : []),
    ["eventos", "Eventos", alarmas.length],
  ];
  return (
    <section aria-label={`Sede ${sede.nombre}`} className="entrar flex flex-col gap-4">
      {/* encabezado de la sede */}
      <div className="panel flex flex-wrap items-stretch gap-5 p-5">
        <div className="flex min-w-[260px] flex-[1_1_280px] flex-col justify-center gap-2">
          <span className="eyebrow">Sede · <span className="mono">{sede.ip}</span></span>
          <h2 className="text-3xl font-semibold tracking-tight text-slate-50">{sede.nombre}</h2>
          <div className="flex flex-wrap gap-1.5">
            {grupo && <span className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold text-slate-100" style={{ background: `${grupo.color}26`, boxShadow: `inset 0 0 0 1px ${grupo.color}66` }}><span className="h-2 w-2 rounded-[3px]" style={{ background: grupo.color }} />{grupo.nombre}</span>}
            <span className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold" style={{ background: `${COLOR[sede.nivel]}22`, color: COLOR[sede.nivel] }}><span className="h-2 w-2 rounded-full" style={{ background: COLOR[sede.nivel] }} />{NIVEL_TXT[sede.nivel]}</span>
            <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${gravix || nueva ? "bg-emerald-950 text-emerald-300" : "bg-slate-800 text-slate-300"}`}>
              {nueva ? `${webGravix ? "Gravix de sede" : "Agente Go"} · ${equipos.length} equipos leídos directo por su IP` : gravix ? `Piloto Gravix · ${equipos.filter((e) => e.pilotDirect).length} de ${equipos.length} leídos directo por su IP` : "Vía EBO AS-P → api-SIASA (Gravix todavía no)"}
            </span>
          </div>
          {!enSala && (esAdmin || nueva) && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {webGravix ? (
                <a href={webGravix} target="_blank" rel="noreferrer" title="Buscar y agregar equipos, ficha y umbrales se hacen en la web local de la sede" className="flex min-h-[34px] items-center rounded-lg bg-sky-600 px-3 text-xs font-bold text-white hover:bg-sky-500">Abrir Gravix de la sede ↗</a>
              ) : nueva && esAdmin && onBuscarEquipos && <button type="button" onClick={onBuscarEquipos} className="min-h-[34px] rounded-lg bg-sky-600 px-3 text-xs font-bold text-white hover:bg-sky-500">Buscar equipos</button>}
              {nueva && <BotonJsonV1 sedeId={sede.id} nombre={sede.nombre} />}
              {esAdmin && onEditar && <button type="button" onClick={onEditar} className="min-h-[34px] rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs font-semibold text-slate-200 hover:bg-slate-800">{nueva ? "Editar sede" : "Cambiar fase"}</button>}
              {esAdmin && nueva && onQuitar && <button type="button" onClick={onQuitar} className="min-h-[34px] rounded-lg border border-rose-900 px-3 text-xs font-semibold text-rose-300 hover:bg-rose-950/40">Quitar sede</button>}
            </div>
          )}
        </div>
        <div className="grid flex-[2_1_520px] gap-3 [grid-template-columns:repeat(auto-fit,minmax(140px,1fr))]">
          <div className={tile}>
            <small className="text-[11.5px] font-semibold text-slate-400">En línea</small>
            <b className="mono text-2xl text-slate-50">{sede.sin_respuesta ? "—" : <>{en}<span className="text-base text-slate-500">/{equipos.length}</span></>}</b>
            <span className="h-1 overflow-hidden rounded bg-slate-800"><span className="block h-full rounded" style={{ width: `${equipos.length ? (en / equipos.length) * 100 : 0}%`, background: en === equipos.length ? SEV_COLOR.ok : SEV_COLOR.critico }} /></span>
          </div>
          <div className={tile}>
            <small className="text-[11.5px] font-semibold text-slate-400">Potencia ahora</small>
            <b className="mono text-2xl text-slate-50">{fmt(kw, 1)}<span className="text-sm text-slate-500"> kW</span></b>
            <small className="text-[11px] text-slate-500">vía EBO</small>
          </div>
          {cal.length > 0 && (
            <button type="button" onClick={() => setTab("calidad")} className={`${tile} text-left hover:border-sky-700`}>
              <small className="text-[11.5px] font-semibold text-slate-400">Calidad de energía</small>
              <span className="mono flex items-baseline gap-3 text-2xl font-bold">
                <span style={{ color: "#fca5a5" }}>{nCal.bad}</span><span style={{ color: "#fbbf24" }}>{nCal.warn}</span><span style={{ color: "#4ade80" }}>{nCal.ok}</span>
              </span>
              <small className="text-[11px] text-slate-500">atender · vigilar · bien</small>
            </button>
          )}
          {/* campana de la sede */}
          <button
            type="button"
            onClick={() => onAlertas(null)}
            aria-label={alarmas.length ? `Alertas de la sede: ${alarmas.length} activas` : "Alertas de la sede: sin alertas activas"}
            className={`flex flex-col justify-between gap-1 rounded-xl border px-4 py-3 text-left ${alarmas.length ? (critico ? "campana-roja" : "campana-ambar") : ""}`}
            style={{ borderColor: `${colAlerta}66`, background: `${colAlerta}12` }}
          >
            <span className="flex items-center justify-between text-[11.5px] font-semibold" style={{ color: colAlerta }}>Alertas de la sede <IconoCampana size={18} color={colAlerta} /></span>
            <b className="mono text-2xl text-slate-50">{alarmas.length}</b>
            <small className="text-[11px] text-slate-400">{alarmas.length ? "activas · tocar para ver" : "sin alertas · ver historial"}</small>
          </button>
        </div>
      </div>

      {sede.sin_respuesta && <div className="rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">La sede no responde ({sede.error ?? "sin datos"}). Se muestran los últimos datos recibidos.</div>}

      {/* Modo sala de control (pantalla fija, sin clics): las alertas de la sede quedan a la vista. */}
      {enSala && alarmas.filter((a) => a.evento !== "SEDE_SIN_RESPUESTA").map((a) => (
        <div key={a.codigo} className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm ${a.severidad === "critico" ? "border-rose-900 bg-rose-950/40" : "border-amber-900 bg-amber-950/30"}`}>
          <span className="h-2 w-2 rounded-full" style={{ background: SEV_COLOR[a.severidad] }} />
          <span><b className="text-slate-100">{a.inventario ?? a.dispositivo}</b> · {EVENTO_TXT[a.evento] ?? a.titulo} · hace {haceCorto(a.desde)}</span>
        </div>
      ))}

      {/* pestañas de la sede */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Contenido de la sede" className="flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
          {tabs.map(([k, t, n]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`flex min-h-[38px] items-center gap-2 rounded-lg px-4 text-sm font-bold ${tab === k ? "bg-[#16264a] text-white" : "text-slate-300 hover:bg-slate-800"}`}>
              {t}
              {n != null && <span className={`mono rounded-full px-2 py-px text-[11px] ${tab === k ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"}`}>{n}</span>}
            </button>
          ))}
        </div>
        {tab === "equipos" && (
          <div role="group" aria-label="Filtrar equipos" className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
            {([["todos", "Todos"], ["ion", "ION7400"], ["pm", "PM2130"], ["gen", "Generadores"]] as const).map(([k, t]) => (
              <button key={k} type="button" aria-pressed={filtro === k} onClick={() => setFiltro(k)} className={`min-h-[34px] rounded-md px-3 text-[13px] font-semibold ${filtro === k ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}>{t}</button>
            ))}
          </div>
        )}
      </div>

      {tab === "calidad" && <CalidadSede equipos={equipos} onAbrir={onAbrir} />}

      {tab === "eventos" && (
        <div className="panel flex flex-col gap-1 p-2">
          {alarmas.length === 0 && <p className="px-3 py-8 text-center text-sm text-slate-400">Sin eventos abiertos en esta sede.</p>}
          {alarmas.map((a) => (
            <button key={a.codigo} type="button" onClick={() => onAlertas(a.codigo)} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl px-4 py-3 text-left hover:bg-slate-800/50">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SEV_COLOR[a.severidad] }} />
              <span className="min-w-[220px] flex-1">
                <b className="text-sm text-slate-100">{a.inventario ?? a.dispositivo ?? sede.nombre}</b> <span className="text-sm text-slate-300">· {EVENTO_TXT[a.evento] ?? a.titulo}</span>
                <span className="mono block text-[11px] text-slate-500">{a.codigo}</span>
              </span>
              <span className="text-xs text-slate-400">{fechaHora(a.desde)} · hace {haceCorto(a.desde)}</span>
              <span className="text-xs font-semibold text-sky-300">Ver detalle →</span>
            </button>
          ))}
          <button type="button" onClick={() => onAlertas(null)} className="mx-2 mb-1 mt-1 self-start rounded-lg px-2 py-1.5 text-xs font-semibold text-sky-300 hover:bg-slate-800">Abrir el centro de alertas (incluye historial) →</button>
        </div>
      )}

      {tab === "equipos" && (
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(232px,1fr))]">
        {lista.map((e) => {
          const l = e.central?.lectura;
          const directo = esDirecto(e);
          const r = e.art.readings as Record<string, number | undefined>;
          const kwVal = e.kind === "gen" ? (r.gen_kw_total_metering ?? l?.kw) : e.kind === "pm" ? (r.demand_total ?? l?.kw) : (r.active_power_total ?? l?.kw);
          // Voltaje y corriente: la lectura del equipo si Gravix lo lee (promedio de las fases con valor);
          // si no, el promedio que entrega el monitoreo central.
          const prom = (ks: string[]) => {
            const xs = ks.map((k) => r[k]).filter((x): x is number => typeof x === "number" && x > 0);
            return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
          };
          const vVal = e.pilot ? prom(["voltage_a_n", "voltage_b_n", "voltage_c_n"]) : l?.v_prom ?? null;
          const aVal = e.pilot ? prom(["current_a", "current_b", "current_c"]) : l?.a_prom ?? null;
          return (
            <button key={e.key} type="button" onClick={() => onAbrir(e)} aria-label={`Abrir ${e.nombre}`} className={`flex flex-col overflow-hidden rounded-xl border bg-slate-950/60 text-left transition-colors hover:border-sky-600 ${e.ok ? "border-slate-800" : "border-rose-900"}`}>
              <span className="eq-art block w-full">
                <MiniEquipo device={e.art} />
                <span className={`absolute right-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${directo ? "bg-emerald-950 text-emerald-300" : "bg-slate-800 text-slate-300"}`}>{directo ? "DIRECTO" : "EBO"}</span>
                {!e.ok && <span className="absolute left-2 top-2 rounded bg-rose-950 px-1.5 py-0.5 text-[10px] font-bold text-rose-300">● ALARMA</span>}
              </span>
              <span className="flex flex-col gap-1 p-3">
                <span className="flex justify-between gap-2"><strong className="truncate text-[13px] text-slate-100">{e.nombre}</strong><span className={`shrink-0 text-[11px] font-bold ${e.ok ? "text-emerald-300" : "text-rose-300"}`}>{e.estadoTxt}</span></span>
                <span className="truncate text-[11px] text-slate-400">{[e.inventario, e.area].filter(Boolean).join(" · ") || "—"}</span>
                <span className="mono flex flex-wrap items-baseline justify-between gap-x-3">
                  <b className="text-base text-slate-100">{e.kind === "gen" && !kwVal ? "En espera" : `${fmt(kwVal, 1)} kW`}</b>
                  {e.kind !== "gen" && (vVal != null || aVal != null) && <span className="text-[11px] text-slate-300">{fmt(vVal, 1)} V · {fmt(aVal, 1)} A</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      )}
    </section>
  );
}

/* ---------------- ventana del equipo ---------------- */
type Pestana = "equipo" | "tendencias" | "calidad" | "comparativo" | "alarmas" | "bitacora" | "info";

function VentanaEquipo({ equipo, equiposSede, access, tabInicial = "equipo", onCerrar }: { equipo: Equipo; equiposSede: Equipo[]; access: Access; tabInicial?: Pestana; onCerrar: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onCerrar]);
  // Pestaña pedida por Gravix; si el equipo no la tiene (p. ej. calidad sin Gravix), abre "Equipo".
  const [tab, setTab] = useState<Pestana>(() =>
    (tabInicial === "calidad" && !(equipo.pilot && equipo.kind !== "gen")) || (tabInicial === "comparativo" && !equipo.pilotDirect) ? "equipo" : tabInicial,
  );
  const [screen, setScreen] = useState<ScreenState>(initialScreen());
  const dev = equipo.art;
  const kind = kindOf(dev);
  const ref = equipo.inventario ?? equipo.central?.nombre ?? equipo.nombre;
  // Las alarmas con correo son de las sedes del monitoreo central (api-SIASA); una sede nueva no las tiene.
  const eventos = useCentroEventos(equipo.directo ? null : equipo.sedeId, ref, 30);
  const gaps = usePilotGaps(equipo.pilot?.id ?? null, 30);
  const activas = (eventos.data?.eventos ?? []).filter((e) => !e.fin).length;
  const tabs: [Pestana, string, string?][] = [
    ["equipo", "Equipo"],
    ["tendencias", "Tendencias"],
    ...(equipo.pilot && equipo.kind !== "gen" ? ([["calidad", "Calidad de energía", calidadAlertas(equipo) ? String(calidadAlertas(equipo)) : undefined]] as [Pestana, string, string?][]) : []),
    ...(equipo.pilotDirect ? ([["comparativo", "Directo vs EBO"]] as [Pestana, string][]) : []),
    ["alarmas", "Alarmas y correos", activas ? String(activas) : undefined],
    ["bitacora", "Bitácora"],
    ["info", "Información"],
  ];
  const rows = metricRows(dev, kind, screen);

  return (
    <div className="cm-modal" role="presentation" onClick={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="caja cm" role="dialog" aria-label={`${equipo.nombre} · ${equipo.sedeNombre}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-800 px-4 py-3">
          <div className="min-w-[220px] flex-1">
            <strong className="block text-base text-slate-50">{equipo.nombre} · {kind === "ion" ? "ION7400" : kind === "pm" ? "PM2130" : "Generador"}</strong>
            <span className="text-xs text-slate-400">{[equipo.sedeNombre, equipo.area, equipo.inventario].filter(Boolean).join(" · ")}</span>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${equipo.ok ? "bg-emerald-950 text-emerald-300" : "bg-rose-950 text-rose-300"}`}>{equipo.estadoTxt}</span>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${esDirecto(equipo) ? "bg-emerald-950 text-emerald-300" : "bg-slate-800 text-slate-300"}`}>{equipo.pilotDirect ? "Directo · Agente Go (Gravix)" : equipo.directo ? "Directo · Agente Go" : "EBO → api-SIASA"}</span>
          <button type="button" onClick={onCerrar} aria-label="Cerrar" className="grid h-10 w-10 place-items-center rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800">✕</button>
        </div>
        <div role="tablist" aria-label="Secciones del equipo" className="flex flex-wrap gap-1 border-b border-slate-800 px-4 py-2">
          {tabs.map(([k, t, badge]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`min-h-[38px] rounded-lg px-3.5 text-sm font-bold ${tab === k ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}>
              {t}
              {badge && <span className="ml-1.5 text-[11px] text-rose-300">{badge}</span>}
            </button>
          ))}
        </div>

        {tab === "equipo" && (
          <div className="flex flex-wrap">
            <div className="gx min-w-0 flex-[999_1_600px]" style={{ background: "transparent" }}>
              <Stage3D device={dev} screen={screen} onKey={(k) => setScreen((s) => pressKey(kind, s, k))} />
            </div>
            <aside className="flex min-w-0 flex-[1_1_280px] flex-col gap-2 border-l border-slate-800 p-4">
              <span className="eyebrow">Pantalla: {screenTitle(kind, screen)}</span>
              {rows.map((r) => (
                <div key={r.label} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                  <span className="text-sm text-slate-300">{r.label}</span>
                  <b className={`mono text-sm ${r.tone === "bad" ? "text-rose-300" : r.tone === "warn" ? "text-amber-300" : "text-slate-100"}`}>{r.text}</b>
                  <span className="col-span-2 h-1.5 overflow-hidden rounded bg-slate-800"><span className="block h-full bg-sky-500 transition-[width] duration-500" style={{ width: `${Math.round(r.frac * 100)}%` }} /></span>
                </div>
              ))}
              {!equipo.pilot && <p className="text-xs text-slate-500">Esta sede se lee por el EBO: el monitoreo central solo entrega kW, voltaje y corriente promedio.</p>}
              <button type="button" onClick={() => setTab("tendencias")} className="mt-1 min-h-[40px] rounded-lg border border-slate-700 bg-slate-900 text-sm font-bold text-sky-300 hover:bg-slate-800">Ver tendencias e historial →</button>
            </aside>
            {kind === "ion" && ION_HARM_SCREENS.includes(screen.ion.scr) && (equipo.pilotDirect ?? equipo.pilot) && (
              <div className="w-full border-t border-slate-800 p-4">
                <ArmonicosPanel device={(equipo.pilot ?? equipo.pilotDirect)!} direct={equipo.pilotDirect} />
              </div>
            )}
            {kind === "ion" && ION_HARM_SCREENS.includes(screen.ion.scr) && !(equipo.pilotDirect ?? equipo.pilot) && (
              <p className="w-full border-t border-slate-800 p-4 text-sm text-slate-400">Esta sede se lee por el EBO y el monitoreo central no entrega armónicos. La gráfica de armónicos está disponible en los equipos leídos directo (Escuintla).</p>
            )}
          </div>
        )}
        {tab === "tendencias" && <Tendencias equipo={equipo} equiposSede={equiposSede} puedeExcel={access.actions.includes("excel")} />}
        {tab === "calidad" && <CalidadEnergia equipo={equipo} />}
        {tab === "comparativo" && equipo.pilot && (
          <div className="gx p-4" style={{ background: "transparent" }}>
            <CompareTab device={equipo.pilot} />
          </div>
        )}
        {tab === "alarmas" && <AlarmasCorreos eventos={eventos.data?.eventos} cargando={eventos.isLoading} error={eventos.isError ? extractErrorMessage(eventos.error) : null} />}
        {tab === "bitacora" && <Bitacora equipo={equipo} eventos={eventos.data?.eventos ?? []} gaps={gaps.data ?? []} />}
        {tab === "info" && <Informacion equipo={equipo} />}
      </div>
    </div>
  );
}

/* ---- tendencias ---- */
const RANGOS_PILOT: [number, string][] = [[60, "1 h"], [1440, "24 h"], [10080, "7 días"]];
const RANGOS_CENTRO: [number, string][] = [[60, "1 h"], [1440, "24 h"], [10080, "7 días"], [43200, "30 días"]];

/** Resumen arriba de la grafica: ultimo, promedio, maximo y minimo de la serie principal. */
function Resumen({ s, unidad, dec }: { s: ChartSeries | undefined; unidad: string; dec: number }) {
  const vals = (s?.points ?? []).map((p) => p.v).filter((x): x is number => x != null && Number.isFinite(x));
  if (!vals.length) return null;
  const prom = vals.reduce((a, x) => a + x, 0) / vals.length;
  return (
    <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(120px,1fr))]">
      {([["Último", vals[vals.length - 1]], ["Promedio", prom], ["Máximo", Math.max(...vals)], ["Mínimo", Math.min(...vals)]] as [string, number][]).map(([l, x]) => (
        <div key={l} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"><span className="block text-[11px] text-slate-400">{l}</span><b className="mono text-base text-slate-100">{fmt(x, dec)} {unidad}</b></div>
      ))}
    </div>
  );
}

type Comparar = "ninguno" | "ebo" | "anterior" | `equipo:${string}`;
const COLOR_COMP = "#f59e0b";

function SelectComparar({ value, onChange, opciones }: { value: Comparar; onChange: (c: Comparar) => void; opciones: [Comparar, string][] }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-300">
      Comparar con
      <select value={value} onChange={(e) => onChange(e.target.value as Comparar)} className="min-h-[38px] max-w-[260px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100">
        {opciones.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
      </select>
    </label>
  );
}

/** Corre una serie "periodo anterior" hacia adelante para encimarla con la actual. */
function desplazar(points: { t: string; v: number | null }[], desdeMs: number, corrimiento: number) {
  return points.filter((p) => new Date(p.t).getTime() < desdeMs).map((p) => ({ t: new Date(p.t).getTime() + corrimiento, v: p.v }));
}

function Tendencias({ equipo, equiposSede, puedeExcel }: { equipo: Equipo; equiposSede: Equipo[]; puedeExcel: boolean }) {
  const pilotDev = equipo.pilotDirect ?? equipo.pilot;
  return pilotDev ? <TendenciasPilot equipo={equipo} device={pilotDev} equiposSede={equiposSede} puedeExcel={puedeExcel} /> : <TendenciasCentro equipo={equipo} equiposSede={equiposSede} puedeExcel={puedeExcel} />;
}

function TendenciasPilot({ equipo, device, equiposSede, puedeExcel }: { equipo: Equipo; device: PilotDevice; equiposSede: Equipo[]; puedeExcel: boolean }) {
  const kind = kindOf(device);
  const metricas = useMemo(() => Object.keys(device.readings).filter((k) => typeof device.readings[k] === "number" && !k.startsWith("harm_")).sort((a, b) => (METRIC_LABEL[a] ? 0 : 1) - (METRIC_LABEL[b] ? 0 : 1) || a.localeCompare(b)), [device]);
  const [metric, setMetric] = useState(POWER_METRIC[kind]);
  const [min, setMin] = useState(1440);
  const [comp, setComp] = useState<Comparar>("ninguno");
  const m = metricas.includes(metric) ? metric : metricas[0] ?? POWER_METRIC[kind];
  const [label, unidad] = METRIC_LABEL[m] ?? [m, ""];
  const dec = unidad === "Hz" || unidad === "" ? 3 : 2;

  const otros = equiposSede.filter((e) => e.key !== equipo.key && e.kind === equipo.kind && (e.pilotDirect ?? e.pilot));
  const compDev = comp === "ebo" && equipo.pilotDirect ? equipo.pilot : comp.startsWith("equipo:") ? (() => { const o = otros.find((e) => e.key === comp.slice(7)); return o ? o.pilotDirect ?? o.pilot : null; })() : null;
  const anteriorOk = min * 2 <= 10080;
  const serie = usePilotSeries(device.id, m, comp === "anterior" && anteriorOk ? min * 2 : min);
  const serieComp = usePilotSeries(compDev?.id ?? null, m, min);

  const ahora = Date.now();
  const pts = serie.data?.points ?? [];
  const principal: ChartSeries = { name: `${equipo.nombre}${equipo.pilotDirect ? " (directo)" : ""}`, color: "#4c8dff", points: pts.filter((p) => new Date(p.t).getTime() >= ahora - min * 60_000).map((p) => ({ t: new Date(p.t).getTime(), v: p.v })) };
  const series: ChartSeries[] = [principal];
  if (comp === "anterior" && anteriorOk) series.push({ name: "Periodo anterior", color: COLOR_COMP, dashed: true, points: desplazar(pts, ahora - min * 60_000, min * 60_000) });
  if (compDev) series.push({ name: comp === "ebo" ? `${equipo.nombre} (por el EBO)` : compDev.name, color: comp === "ebo" ? "#94a3b8" : COLOR_COMP, dashed: comp === "ebo", points: (serieComp.data?.points ?? []).map((p) => ({ t: new Date(p.t).getTime(), v: p.v })) });
  const bands = (serie.data?.gaps ?? []).map((g) => ({ from: new Date(g.startedAt).getTime(), to: g.endedAt ? new Date(g.endedAt).getTime() : ahora, label: "Hueco" }));

  const opciones: [Comparar, string][] = [
    ["ninguno", "Nada"],
    ...(equipo.pilotDirect && equipo.pilot ? ([["ebo", "La lectura por el EBO"]] as [Comparar, string][]) : []),
    ...(anteriorOk ? ([["anterior", min === 60 ? "La hora anterior" : "El día anterior"]] as [Comparar, string][]) : []),
    ...otros.map((e) => [`equipo:${e.key}` as Comparar, e.nombre] as [Comparar, string]),
  ];
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-300">
            Variable
            <select value={m} onChange={(e) => setMetric(e.target.value)} className="min-h-[38px] max-w-[260px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100">
              {metricas.map((k) => <option key={k} value={k}>{METRIC_LABEL[k]?.[0] ?? k}</option>)}
            </select>
          </label>
          <SelectComparar value={opciones.some((o) => o[0] === comp) ? comp : "ninguno"} onChange={setComp} opciones={opciones} />
        </div>
        <Rangos rangos={RANGOS_PILOT} min={min} setMin={setMin} />
      </div>
      <Resumen s={principal} unidad={unidad} dec={dec} />
      {serie.isLoading ? <p className="py-10 text-center text-sm text-slate-500">Cargando…</p> : <InteractiveChart series={series} unit={unidad} dec={dec} bands={bands} />}
      <p className="text-xs text-slate-500">{label} · lectura {equipo.pilotDirect ? "directa del equipo (Gravix)" : "por el EBO"} · TimescaleDB{bands.length ? ` · ${bands.length} hueco(s) en el periodo` : ""}</p>
      {puedeExcel ? <ExcelPilot device={device} metricas={metricas} actual={m} /> : <p className="text-xs text-slate-500">Su perfil no tiene permiso para descargar el historial a Excel.</p>}
    </div>
  );
}

function TendenciasCentro({ equipo, equiposSede, puedeExcel }: { equipo: Equipo; equiposSede: Equipo[]; puedeExcel: boolean }) {
  const [min, setMin] = useState(1440);
  const [varK, setVarK] = useState<"kw" | "v" | "a">("kw");
  const [comp, setComp] = useState<Comparar>("ninguno");
  const otros = equiposSede.filter((e) => e.key !== equipo.key && e.central);
  const compEq = comp.startsWith("equipo:") ? otros.find((e) => e.key === comp.slice(7)) ?? null : null;
  const h = useCentroHistorial(equipo.sedeId, equipo.central?.id ?? null, comp === "anterior" ? min * 2 : min);
  const hc = useCentroHistorial(compEq?.sedeId ?? null, compEq?.central?.id ?? null, min);
  const VARS = { kw: ["Potencia", "kW"], v: ["Voltaje L-N promedio", "V"], a: ["Corriente promedio", "A"] } as const;
  const ahora = Date.now();
  const pts = (h.data?.points ?? []).map((p) => ({ t: p.t, v: p[varK] }));
  const principal: ChartSeries = { name: equipo.nombre, color: "#4c8dff", points: pts.filter((p) => new Date(p.t).getTime() >= ahora - min * 60_000).map((p) => ({ t: new Date(p.t).getTime(), v: p.v })) };
  const series: ChartSeries[] = [principal];
  if (comp === "anterior") series.push({ name: "Periodo anterior", color: COLOR_COMP, dashed: true, points: desplazar(pts, ahora - min * 60_000, min * 60_000) });
  if (compEq) series.push({ name: compEq.nombre, color: COLOR_COMP, points: (hc.data?.points ?? []).map((p) => ({ t: new Date(p.t).getTime(), v: p[varK] })) });
  const bands = (h.data?.points ?? []).filter((p) => p.fuera).map((p) => ({ from: new Date(p.t).getTime(), to: new Date(p.t).getTime() + (h.data?.bucketSeconds ?? 60) * 1000, label: "Fuera de línea" }));
  const opciones: [Comparar, string][] = [["ninguno", "Nada"], ["anterior", min === 60 ? "La hora anterior" : min === 1440 ? "El día anterior" : min === 10080 ? "La semana anterior" : "El mes anterior"], ...otros.map((e) => [`equipo:${e.key}` as Comparar, e.nombre] as [Comparar, string])];
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="Variable" className="flex flex-wrap gap-1.5">
            {(Object.keys(VARS) as ("kw" | "v" | "a")[]).map((k) => (
              <button key={k} type="button" aria-pressed={varK === k} onClick={() => setVarK(k)} className={`min-h-[36px] rounded-full border px-3 text-[13px] font-semibold ${varK === k ? "border-sky-500 bg-sky-950 text-white" : "border-slate-700 text-slate-300"}`}>{VARS[k][0]}</button>
            ))}
          </div>
          <SelectComparar value={comp} onChange={setComp} opciones={opciones} />
        </div>
        <Rangos rangos={RANGOS_CENTRO} min={min} setMin={setMin} />
      </div>
      <Resumen s={principal} unidad={VARS[varK][1]} dec={1} />
      {h.isLoading ? <p className="py-10 text-center text-sm text-slate-500">Cargando…</p> : <InteractiveChart series={series} unit={VARS[varK][1]} dec={1} bands={bands} emptyText="Todavía no hay historial guardado en este periodo: Nodivo guarda un dato por minuto desde el 10/11/2026." />}
      <p className="text-xs text-slate-500">
        Origen: monitoreo central → EBO de la sede. Nodivo guarda una foto por minuto{h.data?.desde ? ` desde ${fechaHora(h.data.desde)}` : ""}.
      </p>
      {puedeExcel ? <ExcelCentro equipo={equipo} /> : <p className="text-xs text-slate-500">Su perfil no tiene permiso para descargar el historial a Excel.</p>}
    </div>
  );
}

function Rangos({ rangos, min, setMin }: { rangos: [number, string][]; min: number; setMin: (n: number) => void }) {
  return (
    <div role="group" aria-label="Periodo" className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
      {rangos.map(([m, t]) => (
        <button key={m} type="button" aria-pressed={min === m} onClick={() => setMin(m)} className={`min-h-[34px] rounded-md px-3 text-[13px] font-bold ${min === m ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}>{t}</button>
      ))}
    </div>
  );
}

const PERIODOS: [number, string][] = [[60, "Última hora"], [1440, "Últimas 24 horas"], [10080, "Últimos 7 días"], [43200, "Últimos 30 días"], [129600, "Últimos 90 días"]];
const PASOS: [number, string][] = [[60, "1 minuto"], [900, "15 minutos"], [3600, "1 hora"], [86400, "1 día (promedio)"]];

function ExcelPanel({ children, onDescargar, ocupado, error }: { children: React.ReactNode; onDescargar: () => void; ocupado: boolean; error: string | null }) {
  return (
    <section aria-label="Descargar historial a Excel" className="flex flex-col gap-3 rounded-xl border border-emerald-900 bg-emerald-950/30 p-4">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-green-700 text-sm font-extrabold text-white" aria-hidden="true">X</span>
        <div><b className="block text-slate-100">Descargar historial a Excel</b><small className="text-emerald-200/70">Archivo .xlsx con fecha y hora, una columna por variable, huecos e información del equipo</small></div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {children}
        <button type="button" onClick={onDescargar} disabled={ocupado} className="min-h-[42px] rounded-lg bg-green-700 px-5 text-sm font-extrabold text-white hover:bg-green-600 disabled:opacity-50">
          {ocupado ? "Preparando…" : "⬇ Descargar Excel"}
        </button>
        {error && <span className="text-sm text-rose-300">{error}</span>}
      </div>
    </section>
  );
}

function SelectExcel({ label, value, onChange, opts }: { label: string; value: number; onChange: (n: number) => void; opts: [number, string][] }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-emerald-200/80">
      {label}
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} className="min-h-[40px] rounded-lg border border-emerald-900 bg-slate-950 px-2 text-sm text-slate-100">
        {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </label>
  );
}

function useDescarga() {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setOcupado(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setOcupado(false);
    }
  };
  return { ocupado, error, run };
}

function ExcelPilot({ device, metricas, actual }: { device: PilotDevice; metricas: string[]; actual: string }) {
  const [sel, setSel] = useState<string[]>([actual]);
  const [per, setPer] = useState(10080);
  const [paso, setPaso] = useState(900);
  const { ocupado, error, run } = useDescarga();
  const elegidas = sel.filter((m) => metricas.includes(m));
  return (
    <ExcelPanel ocupado={ocupado || !elegidas.length} error={error} onDescargar={() => void run(() => downloadFile(`/pilot/devices/${device.id}/excel`, { metrics: elegidas.join(","), labels: elegidas.map((m) => METRIC_LABEL[m]?.[0] ?? m).join("|"), minutes: per, step: paso }, `${device.name}_historial.xlsx`))}>
      <fieldset className="flex max-h-40 min-w-[240px] flex-col overflow-y-auto rounded-lg border border-emerald-900 p-2">
        <legend className="px-1 text-xs font-bold uppercase tracking-wider text-emerald-200/80">Variables</legend>
        {metricas.map((m) => (
          <label key={m} className="flex min-h-[30px] items-center gap-2 text-[13px] text-slate-200">
            <input type="checkbox" className="h-4 w-4 accent-green-600" checked={sel.includes(m)} onChange={() => setSel((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m]))} />
            {METRIC_LABEL[m]?.[0] ?? m}
          </label>
        ))}
      </fieldset>
      <SelectExcel label="Periodo" value={per} onChange={setPer} opts={PERIODOS} />
      <SelectExcel label="Un dato cada" value={paso} onChange={setPaso} opts={PASOS} />
    </ExcelPanel>
  );
}

function ExcelCentro({ equipo }: { equipo: Equipo }) {
  const [per, setPer] = useState(10080);
  const [paso, setPaso] = useState(900);
  const { ocupado, error, run } = useDescarga();
  return (
    <ExcelPanel ocupado={ocupado} error={error} onDescargar={() => void run(() => downloadFile(`/centro/sedes/${equipo.sedeId}/medidores/${encodeURIComponent(equipo.central?.id ?? "")}/excel`, { minutes: per, step: paso, nombre: equipo.nombre }, `${equipo.nombre}_historial.xlsx`))}>
      <span className="text-[13px] text-slate-300">Potencia, voltaje y corriente promedio</span>
      <SelectExcel label="Periodo" value={per} onChange={setPer} opts={PERIODOS} />
      <SelectExcel label="Un dato cada" value={paso} onChange={setPaso} opts={PASOS} />
    </ExcelPanel>
  );
}

/* ---- alarmas y correos ---- */
function AlarmasCorreos({ eventos, cargando, error }: { eventos: CentroEvento[] | undefined; cargando: boolean; error: string | null }) {
  if (cargando) return <p className="p-6 text-sm text-slate-500">Consultando las alarmas en la sede…</p>;
  if (error) return <p className="p-6 text-sm text-rose-300">{error}</p>;
  const lista = eventos ?? [];
  const correos = lista.flatMap((e) => [
    ...(e.notificado_en ? [{ k: `${e.codigo}-a`, t: e.notificado_en, asunto: `${e.severidad === "critico" ? "CRÍTICO" : e.severidad === "advertencia" ? "ADVERTENCIA" : "AVISO"} · ${EVENTO_TXT[e.evento] ?? e.evento}`, tipo: "Apertura", color: e.severidad === "critico" ? COLOR.critico : COLOR.advertencia }] : []),
    ...(e.cierre_notificado_en ? [{ k: `${e.codigo}-c`, t: e.cierre_notificado_en, asunto: `NORMAL · ${EVENTO_TXT[e.evento] ?? e.evento} (duró ${duracion(e.duracion_s)})`, tipo: "Cierre", color: COLOR.ok }] : []),
  ]).sort((a, b) => b.t.localeCompare(a.t));
  return (
    <div className="flex flex-col gap-5 p-4">
      <section className="flex flex-col gap-2">
        <span className="eyebrow">Alarmas de este equipo · últimos 30 días</span>
        {lista.length === 0 && <p className="text-sm text-emerald-300">Sin alarmas en los últimos 30 días.</p>}
        {lista.map((e) => (
          <div key={e.codigo} className="grid grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <span className="h-9 w-1.5 rounded" style={{ background: e.fin ? "#475569" : e.severidad === "critico" ? COLOR.critico : COLOR.advertencia }} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <b className="text-sm text-slate-100">{EVENTO_TXT[e.evento] ?? e.evento}</b>
              <small className="text-xs text-slate-400">
                {fechaHora(e.inicio)} · duró {duracion(e.duracion_s)} · {e.notificado_en ? `correo ${fechaHora(e.notificado_en)}` : "sin correo"}
                {e.cierre_notificado_en ? ` · cierre ${fechaHora(e.cierre_notificado_en)}` : ""}
              </small>
            </span>
            <span className={`text-xs font-bold ${e.fin ? "text-emerald-300" : e.severidad === "critico" ? "text-rose-300" : "text-amber-300"}`}>{e.fin ? "Normalizada" : "Activa"}</span>
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-2">
        <span className="eyebrow">Correos enviados por este equipo</span>
        {correos.length === 0 && <p className="text-sm text-slate-500">Sin correos en los últimos 30 días.</p>}
        <div className="flex flex-col overflow-hidden rounded-lg border border-slate-800">
          {correos.map((c) => (
            <div key={c.k} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-slate-800/80 px-3 py-2.5 first:border-t-0 md:grid-cols-[200px_minmax(0,1fr)_90px]">
              <span className="mono hidden text-xs text-slate-300 md:block">{fechaHora(c.t)}</span>
              <span className="flex items-center gap-2 text-sm text-slate-100"><span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: c.color }} />{c.asunto}<small className="text-slate-500 md:hidden">· {fechaHora(c.t)}</small></span>
              <span className="text-xs font-bold" style={{ color: c.color }}>{c.tipo}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500">Los envía la sede (api-SIASA) desde su buzón de alarmas a su lista configurada. Fuente: base de eventos de la sede.</p>
      </section>
    </div>
  );
}

/* ---- bitacora ---- */
function Bitacora({ equipo, eventos, gaps }: { equipo: Equipo; eventos: CentroEvento[]; gaps: { id: string; startedAt: string; endedAt: string | null; minutes: number; cause: string; status: string }[] }) {
  const items = [
    ...eventos.flatMap((e) => [
      { t: e.inicio, tipo: "Alarma", txt: `Se abrió: ${EVENTO_TXT[e.evento] ?? e.evento}`, quien: "Reglas de la sede (api-SIASA)", color: e.severidad === "critico" ? COLOR.critico : COLOR.advertencia },
      ...(e.notificado_en ? [{ t: e.notificado_en, tipo: "Correo", txt: "Correo de apertura enviado", quien: "Buzón de alarmas de la sede", color: "#a78bfa" }] : []),
      ...(e.fin ? [{ t: e.fin, tipo: "Alarma", txt: `Se normalizó: ${EVENTO_TXT[e.evento] ?? e.evento} (duró ${duracion(e.duracion_s)})`, quien: "Reglas de la sede (api-SIASA)", color: COLOR.ok }] : []),
      ...(e.cierre_notificado_en ? [{ t: e.cierre_notificado_en, tipo: "Correo", txt: "Correo de cierre enviado", quien: "Buzón de alarmas de la sede", color: "#a78bfa" }] : []),
    ]),
    ...gaps.flatMap((g) => [
      { t: g.startedAt, tipo: "Hueco", txt: `Hueco de datos: ${g.cause}`, quien: "Piloto Gravix", color: COLOR.critico },
      ...(g.endedAt ? [{ t: g.endedAt, tipo: g.status === "recovered" ? "Recuperación" : "Hueco", txt: `Fin del hueco (${g.minutes} min · ${g.status === "recovered" ? "recuperado" : g.status === "partial" ? "recuperado parcial" : "cerrado"})`, quien: "Piloto Gravix", color: g.status === "recovered" ? COLOR.ok : "#94a3b8" }] : []),
    ]),
    ...(equipo.pilot?.historySince ? [{ t: equipo.pilot.historySince, tipo: "Sistema", txt: "Inicio del historial en TimescaleDB", quien: "Piloto Gravix · Fase A", color: "#94a3b8" }] : []),
  ].sort((a, b) => b.t.localeCompare(a.t));
  return (
    <div className="flex flex-col gap-2 p-4">
      <span className="eyebrow">Bitácora del equipo · todo lo que pasó y cuándo</span>
      {items.length === 0 && <p className="text-sm text-slate-500">Sin registros en los últimos 30 días.</p>}
      <div className="ml-2 flex flex-col border-l-2 border-slate-800 pl-2">
        {items.map((b, i) => (
          <div key={i} className="relative flex flex-col gap-0.5 py-2 pl-4">
            <span className="absolute -left-[15px] top-3.5 h-3 w-3 rounded-full border-2 border-slate-950" style={{ background: b.color }} />
            <span className="flex flex-wrap items-baseline gap-2"><b className="text-sm text-slate-100">{b.txt}</b><span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-bold text-slate-300">{b.tipo}</span></span>
            <small className="text-xs text-slate-500">{fechaHora(b.t)} · {b.quien}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- informacion ---- */
function Informacion({ equipo }: { equipo: Equipo }) {
  const p = equipo.pilotDirect ?? equipo.pilot;
  const dc = equipo.pilot?.directConnection;
  const attrs = (equipo.pilotDirect?.attributes ?? {}) as Record<string, unknown>;
  const datos: [string, string][] = [
    ["Modelo", equipo.kind === "ion" ? "PowerLogic ION7400" : equipo.kind === "pm" ? "PM2130 (frente EM6400NG+)" : "Generador"],
    ["Sede · área", [equipo.sedeNombre, equipo.area].filter(Boolean).join(" · ")],
    ["Código", equipo.inventario ?? "—"],
    ["Origen del dato", equipo.pilotDirect ? "Directo · Agente Go (Gravix) + EBO para comparar" : "EBO AS-P → api-SIASA de la sede"],
    ["Conexión directa", dc ? `${dc.ip}:${dc.port} · ID ${dc.unitId ?? "por defecto"}` : attrs.via === "directo" ? "leído por el agente de prueba" : "—"],
    ["Protocolo", "Modbus TCP · solo lectura (función 03)"],
    ["Estado en la sede", equipo.central ? ESTADO_TXT[equipo.central.estado] ?? equipo.central.estado : "—"],
    ["Último cambio en la sede", equipo.central?.ultimo_cambio ? fechaHora(equipo.central.ultimo_cambio) : "—"],
    ["Última lectura (Nodivo)", p?.updatedAt ? hace(p.updatedAt) : "—"],
    ["Historial desde", equipo.pilot?.historySince ? fechaHora(equipo.pilot.historySince) : "se guarda desde la instalación del centro de mando"],
    ["Datos completos 7 días", equipo.pilot?.completeness != null ? `${equipo.pilot.completeness.toFixed(1)} %` : "—"],
    ["Huecos 7 días", equipo.pilot ? `${equipo.pilot.gaps.total} (${equipo.pilot.gaps.pending} pendientes)` : "—"],
  ];
  return (
    <div className="grid gap-2 p-4 [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
      {datos.map(([l, v]) => (
        <div key={l} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><span className="block text-[11px] text-slate-400">{l}</span><b className="mono text-sm text-slate-100">{v}</b></div>
      ))}
    </div>
  );
}

/* ================= calidad de energia con semaforo (lectura directa Gravix) ================= */
type Semaforo = "ok" | "warn" | "bad";
interface Indicador { k: string; label: string; valor: string; nivel: Semaforo; detalle: string; consejo: string }
const SEM_COLOR: Record<Semaforo, string> = { ok: "#22c55e", warn: "#f59e0b", bad: "#ef4444" };
const SEM_TXT: Record<Semaforo, string> = { ok: "Bien", warn: "Vigilar", bad: "Atender" };

function indicadores(e: Equipo): Indicador[] {
  const d = e.pilotDirect ?? e.pilot;
  if (!d || e.kind === "gen") return [];
  const r = d.readings as Record<string, unknown>;
  const n = (k: string) => (typeof r[k] === "number" && Number.isFinite(r[k] as number) ? (r[k] as number) : null);
  const fases = (ks: string[]) => ks.map(n).filter((x): x is number => x != null && x > 0);
  const desbalance = (xs: number[]) => {
    if (xs.length < 2) return null;
    const p = xs.reduce((a, x) => a + x, 0) / xs.length;
    return p > 0 ? (Math.max(...xs.map((x) => Math.abs(x - p))) / p) * 100 : null;
  };
  const sem = (v: number, ok: number, warn: number, mayorEsMejor = false): Semaforo =>
    mayorEsMejor ? (v >= ok ? "ok" : v >= warn ? "warn" : "bad") : v < ok ? "ok" : v < warn ? "warn" : "bad";
  const out: Indicador[] = [];
  const vs = fases(["voltage_a_n", "voltage_b_n", "voltage_c_n"]);
  const dv = desbalance(vs);
  if (dv != null) out.push({ k: "dv", label: "Desbalance de voltaje", valor: `${dv.toFixed(2)} %`, nivel: sem(dv, 2, 3), detalle: `Fases: ${vs.map((x) => x.toFixed(1)).join(" / ")} V · límite recomendado 2 %`, consejo: "Revisar la distribución de cargas monofásicas entre fases y las conexiones del tablero." });
  const as = fases(["current_a", "current_b", "current_c"]);
  const di = desbalance(as);
  const iProm = as.length ? as.reduce((a, x) => a + x, 0) / as.length : 0;
  if (di != null && iProm > 5) out.push({ k: "di", label: "Desbalance de corriente", valor: `${di.toFixed(1)} %`, nivel: sem(di, 10, 20), detalle: `Fases: ${as.map((x) => x.toFixed(1)).join(" / ")} A`, consejo: "Redistribuir circuitos entre fases para bajar la corriente del neutro y el calentamiento." });
  const pf = n("power_factor_total") ?? n("power_factor_a");
  if (pf != null && pf !== 0) out.push({ k: "fp", label: "Factor de potencia", valor: Math.abs(pf).toFixed(3), nivel: sem(Math.abs(pf), 0.92, 0.85, true), detalle: "Recomendado 0.92 o más", consejo: "Revisar el banco de capacitores o las cargas inductivas (motores, aire acondicionado)." });
  const thdV = fases(["thd_voltage_v1_high", "thd_voltage_v2_high", "thd_voltage_v3_high"]);
  if (thdV.length) out.push({ k: "thdv", label: "THD de voltaje (máx.)", valor: `${Math.max(...thdV).toFixed(2)} %`, nivel: sem(Math.max(...thdV), 5, 8), detalle: "Límite usual 5 % (IEEE 519)", consejo: "Hay armónicos en la red: revisar variadores, UPS y fuentes electrónicas; considerar filtros." });
  const thdI = fases(["thd_current_a_high", "thd_current_b_high", "thd_current_c_high"]);
  if (thdI.length) out.push({ k: "thdi", label: "THD de corriente (máx.)", valor: `${Math.max(...thdI).toFixed(1)} %`, nivel: sem(Math.max(...thdI), 15, 25), detalle: "Depende del tipo de carga; arriba de 15 % conviene vigilar", consejo: "Cargas no lineales importantes: vigilar el calentamiento del neutro y del transformador." });
  const pst = fases(["short_term_flicker_pst_a_n", "short_term_flicker_pst_b_n", "short_term_flicker_pst_c_n"]);
  if (pst.length) out.push({ k: "pst", label: "Flicker Pst (máx.)", valor: Math.max(...pst).toFixed(2), nivel: sem(Math.max(...pst), 0.8, 1), detalle: "Límite 1.0 (EN 50160)", consejo: "Variaciones rápidas de voltaje: revisar arranques de motores o soldadoras cerca." });
  const hz = n("frequency");
  if (hz != null && hz > 0) out.push({ k: "hz", label: "Frecuencia", valor: `${hz.toFixed(3)} Hz`, nivel: Math.abs(hz - 60) <= 0.2 ? "ok" : Math.abs(hz - 60) <= 0.5 ? "warn" : "bad", detalle: "Normal 60 ± 0.2 Hz", consejo: "Frecuencia fuera de lo normal: confirmar si la sede está con el generador." });
  const cap = Number((e.pilot?.attributes as Record<string, unknown> | undefined)?.capacityKva) || 0;
  const kva = n("apparent_power_total");
  if (cap > 0 && kva != null) {
    const pct = (kva / cap) * 100;
    out.push({ k: "carga", label: "Carga del transformador", valor: `${pct.toFixed(0)} %`, nivel: sem(pct, 80, 90), detalle: `${kva.toFixed(1)} de ${cap} kVA`, consejo: "Cerca de su capacidad: planificar reparto de cargas o ampliación." });
  }
  return out;
}
const calidadAlertas = (e: Equipo) => indicadores(e).filter((i) => i.nivel !== "ok").length;

function CalidadEnergia({ equipo }: { equipo: Equipo }) {
  const ind = indicadores(equipo);
  const peor: Semaforo = ind.some((i) => i.nivel === "bad") ? "bad" : ind.some((i) => i.nivel === "warn") ? "warn" : "ok";
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: `${SEM_COLOR[peor]}55`, background: `${SEM_COLOR[peor]}12` }}>
        <span className="h-4 w-4 rounded-full" style={{ background: SEM_COLOR[peor], boxShadow: `0 0 12px ${SEM_COLOR[peor]}` }} />
        <b className="text-slate-50">{peor === "ok" ? "Calidad de energía bien" : peor === "warn" ? "Hay indicadores para vigilar" : "Hay indicadores que atender"}</b>
        <span className="text-sm text-slate-400">Calculado con la lectura directa del equipo (en vivo). El EBO no entrega estos datos bien.</span>
      </div>
      {!ind.length && <p className="text-sm text-slate-500">Este equipo no entrega variables de calidad todavía.</p>}
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
        {ind.map((i) => (
          <div key={i.k} className="flex flex-col gap-1.5 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-slate-300">{i.label}</span>
              <span className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ color: SEM_COLOR[i.nivel], background: `${SEM_COLOR[i.nivel]}1f` }}>
                <span className="h-2 w-2 rounded-full" style={{ background: SEM_COLOR[i.nivel] }} />{SEM_TXT[i.nivel]}
              </span>
            </div>
            <b className="mono text-xl text-slate-50">{i.valor}</b>
            <small className="text-xs text-slate-500">{i.detalle}</small>
            {i.nivel !== "ok" && <small className="text-xs text-amber-200/90">→ {i.consejo}</small>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Equipos de la sede con lectura directa y sus indicadores, con el peor nivel de cada uno. */
function filasCalidad(equipos: Equipo[]) {
  return equipos
    .filter((e) => e.pilot && e.kind !== "gen")
    .map((e) => {
      const ind = indicadores(e);
      const peor: Semaforo = ind.some((i) => i.nivel === "bad") ? "bad" : ind.some((i) => i.nivel === "warn") ? "warn" : "ok";
      return { e, ind, peor };
    })
    .filter((x) => x.ind.length);
}
const SEM_RANK: Record<Semaforo, number> = { bad: 2, warn: 1, ok: 0 };
/** Texto claro sobre fondo oscuro (contraste suficiente para los valores). */
const SEM_TEXTO: Record<Semaforo, string> = { ok: "#4ade80", warn: "#fbbf24", bad: "#fca5a5" };

/** Semaforo de todos los equipos de la sede (solo donde hay lectura directa). Clic en una fila = abrir el equipo. */
function CalidadSede({ equipos, onAbrir }: { equipos: Equipo[]; onAbrir: (e: Equipo) => void }) {
  const filas = filasCalidad(equipos).sort((a, b) => SEM_RANK[b.peor] - SEM_RANK[a.peor]);
  if (!filas.length) return null;
  const cols = ["dv", "di", "fp", "thdv", "thdi", "pst", "carga"];
  const nombres: Record<string, string> = { dv: "Desb. V", di: "Desb. I", fp: "FP", thdv: "THD V", thdi: "THD I", pst: "Flicker", carga: "Carga" };
  const cuenta = (s: Semaforo) => filas.filter((f) => f.peor === s).length;
  return (
    <section aria-label="Calidad de energía" className="panel entrar overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div>
          <strong className="block text-base text-slate-50">Calidad de energía · semáforo en vivo</strong>
          <span className="text-xs text-slate-400">Lectura directa de {filas.length} equipos · del que más atención requiere al que menos · toque una fila para abrir el equipo</span>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          {(["bad", "warn", "ok"] as Semaforo[]).map((s) => (
            <span key={s} className="flex items-center gap-1.5 rounded-full px-2.5 py-1" style={{ color: SEM_TEXTO[s], background: `${SEM_COLOR[s]}1f` }}>
              <b className="mono">{cuenta(s)}</b> {SEM_TXT[s].toLowerCase()}
            </span>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="bg-[#0a1222] text-[11px] uppercase tracking-wider text-slate-400">
              <th className="px-5 py-3 text-left font-bold">Equipo</th>
              <th className="px-2 py-3 text-left font-bold">Estado</th>
              {cols.map((c) => <th key={c} className="px-2 py-3 text-center font-bold">{nombres[c]}</th>)}
            </tr>
          </thead>
          <tbody>
            {filas.map(({ e, ind, peor }) => (
              <tr
                key={e.key}
                tabIndex={0}
                aria-label={`Abrir ${e.nombre}`}
                className="cursor-pointer border-t border-slate-800/80 outline-none hover:bg-slate-800/40 focus-visible:bg-slate-800/50"
                onClick={() => onAbrir(e)}
                onKeyDown={(k) => { if (k.key === "Enter" || k.key === " ") { k.preventDefault(); onAbrir(e); } }}
              >
                <td className="px-5 py-2.5">
                  <b className="block text-slate-100">{e.nombre}</b>
                  <small className="text-[11px] text-slate-400">{[e.kind === "ion" ? "ION7400" : "PM2130", e.inventario, e.area].filter(Boolean).join(" · ")}</small>
                </td>
                <td className="px-2 py-2.5">
                  <span className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: SEM_TEXTO[peor] }}><span className="h-2 w-2 rounded-full" style={{ background: SEM_COLOR[peor] }} />{SEM_TXT[peor]}</span>
                </td>
                {cols.map((c) => {
                  const i = ind.find((x) => x.k === c);
                  return (
                    <td key={c} className="px-2 py-2 text-center" title={i ? `${i.label}: ${i.valor} · ${i.detalle}` : "sin dato"}>
                      {i ? (
                        <span className="mono inline-block min-w-[68px] rounded-lg border px-2.5 py-1 text-xs font-semibold" style={{ color: SEM_TEXTO[i.nivel], background: `${SEM_COLOR[i.nivel]}17`, borderColor: `${SEM_COLOR[i.nivel]}4d` }}>{i.valor}</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-slate-800 px-5 py-2.5 text-[11px] text-slate-500">Límites: desbalance V 2 %, THD V 5 % (IEEE 519), FP 0.92, flicker 1.0 (EN 50160). El detalle y la recomendación de cada indicador están en el equipo → «Calidad de energía».</p>
    </section>
  );
}

/* ================= linea de tiempo de incidentes ================= */
interface Incidente { id: string; inicio: number; fin: number; items: CentroVista["actividad"]; sedes: string[]; nivel: "critico" | "advertencia" | "info"; resuelto: boolean }

function agruparIncidentes(actividad: CentroVista["actividad"]): Incidente[] {
  const items = [...actividad].sort((a, b) => a.t.localeCompare(b.t));
  const out: Incidente[] = [];
  for (const a of items) {
    const t = new Date(a.t).getTime();
    const cur = out[out.length - 1];
    if (!cur || t - cur.fin > 20 * 60_000) out.push({ id: a.id, inicio: t, fin: t, items: [a], sedes: [], nivel: "info", resuelto: true });
    else { cur.items.push(a); cur.fin = t; }
  }
  for (const i of out) {
    i.sedes = [...new Set(i.items.map((x) => x.sede))];
    i.nivel = i.items.some((x) => x.tipo === "critico" || x.tipo === "sin_respuesta") ? "critico" : i.items.some((x) => x.tipo === "advertencia") ? "advertencia" : "info";
    const ultimo = new Map<string, string>();
    i.items.forEach((x) => ultimo.set(x.sede_id, x.tipo));
    i.resuelto = [...ultimo.values()].every((t) => t === "ok" || t === "info");
  }
  // Un incidente que quedo abierto se cierra con la normalizacion posterior de esa sede (aunque
  // llegue horas despues): asi se ve la duracion real y la normalizacion no queda como incidente aparte.
  const absorbidos = new Set<string>();
  for (const i of out) {
    if (i.resuelto) continue;
    const pendientes = new Set(i.items.filter((x) => x.tipo !== "ok" && x.tipo !== "info").map((x) => x.sede_id));
    for (const sedeId of pendientes) {
      const ok = items.find((x) => x.sede_id === sedeId && x.tipo === "ok" && new Date(x.t).getTime() > i.fin);
      if (!ok) continue;
      absorbidos.add(ok.id);
      i.items.push(ok);
      i.fin = Math.max(i.fin, new Date(ok.t).getTime());
      pendientes.delete(sedeId);
    }
    i.resuelto = pendientes.size === 0;
  }
  return out.filter((i) => !(i.items.every((x) => absorbidos.has(x.id)))).reverse();
}

function Incidentes({ vista, onIr }: { vista: CentroVista; onIr: (sede: string) => void }) {
  const inc = useMemo(() => agruparIncidentes(vista.actividad), [vista.actividad]);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; txt: string } | null>(null);
  const fin = Date.now(), ini = fin - 7 * 86_400_000;
  const sedes = vista.sedes;
  const W2 = 1000, filaH = 26, top = 24, alto = top + sedes.length * filaH + 8;
  const X = (t: number) => 120 + ((t - ini) / (fin - ini)) * (W2 - 130);
  const col = (tipo: string) => (tipo === "ok" ? "#22c55e" : tipo === "advertencia" ? "#f59e0b" : tipo === "info" ? "#8ab8ff" : "#ef4444");
  const dias = Array.from({ length: 8 }, (_, i) => ini + i * 86_400_000);
  return (
    <div className="flex flex-col gap-4">
      <section className="panel flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="eyebrow">Últimos 7 días · cada punto es un evento, cada franja un incidente</span>
          <span className="text-[11px] text-slate-500">Pase el mouse sobre un punto · clic en el nombre abre la sede</span>
        </div>
        <div className="relative overflow-x-auto">
          <svg viewBox={`0 0 ${W2} ${alto}`} className="min-w-[760px]" width="100%" role="img" aria-label="Eventos de las sedes en los últimos 7 días">
            {dias.map((d, i) => (
              <g key={i}>
                <line x1={X(d)} x2={X(d)} y1={top - 6} y2={alto - 6} stroke="#16223a" />
                <text x={X(d)} y={14} textAnchor="middle" fontSize="11" fill="#7b8aa3">{new Date(d).toLocaleDateString("es-GT", { weekday: "short", day: "2-digit" })}</text>
              </g>
            ))}
            {inc.map((i) => (
              <rect key={i.id} x={X(i.inicio) - 3} y={top - 4} width={Math.max(6, X(i.fin) - X(i.inicio) + 6)} height={sedes.length * filaH} rx="3" fill={i.nivel === "critico" ? "#ef4444" : i.nivel === "advertencia" ? "#f59e0b" : "#8ab8ff"} opacity={abierto === i.id ? 0.22 : 0.07} />
            ))}
            {sedes.map((s, r) => {
              const y = top + r * filaH + filaH / 2;
              return (
                <g key={s.id}>
                  <text x={8} y={y + 4} fontSize="12" fill="#cbd5e1" style={{ cursor: "pointer" }} onClick={() => onIr(s.id)}>{s.nombre}</text>
                  <line x1={120} x2={W2 - 10} y1={y} y2={y} stroke="#111c30" />
                  {vista.actividad.filter((a) => a.sede_id === s.id).map((a) => {
                    const t = new Date(a.t).getTime();
                    if (t < ini) return null;
                    return (
                      <circle key={a.id} cx={X(t)} cy={y} r="5" fill={col(a.tipo)} stroke="#0b1220" strokeWidth="1.5" style={{ cursor: "pointer" }}
                        onMouseEnter={(e) => { const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); setTip({ x: e.clientX - box.left, y: e.clientY - box.top, txt: `${s.nombre} · ${a.titulo} · ${fechaHora(a.t)}` }); }}
                        onMouseLeave={() => setTip(null)} />
                    );
                  })}
                </g>
              );
            })}
          </svg>
          {tip && <div className="pointer-events-none absolute z-10 max-w-[320px] rounded-lg border border-slate-700 bg-slate-900/95 px-2.5 py-1.5 text-xs text-slate-100 shadow-xl" style={{ left: tip.x + 12, top: tip.y + 8 }}>{tip.txt}</div>}
        </div>
      </section>
      <section className="panel flex flex-col gap-2 p-4">
        <span className="eyebrow">Incidentes · eventos agrupados (lo que pasó junto)</span>
        {!inc.length && <p className="text-sm text-emerald-300">Sin incidentes en los últimos 7 días.</p>}
        {inc.map((i) => {
          const c = i.nivel === "critico" ? "#ef4444" : i.nivel === "advertencia" ? "#f59e0b" : "#8ab8ff";
          const dur = Math.round((i.fin - i.inicio) / 60_000);
          return (
            <div key={i.id} className="rounded-xl border border-slate-800 bg-slate-950/50" onMouseEnter={() => setAbierto(i.id)} onMouseLeave={() => setAbierto((a) => (a === i.id ? null : a))}>
              <button type="button" onClick={() => setAbierto((a) => (a === `x${i.id}` ? null : `x${i.id}`))} aria-expanded={abierto === `x${i.id}`} className="grid w-full grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-3 p-3 text-left">
                <span className="h-10 w-1.5 rounded" style={{ background: c }} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <b className="text-sm text-slate-100">{i.sedes.length > 1 ? `${i.sedes.length} sedes afectadas a la vez` : i.sedes[0]} · {i.items.length} evento{i.items.length > 1 ? "s" : ""}</b>
                  <small className="text-xs text-slate-400">{fechaHora(new Date(i.inicio).toISOString())} · {dur ? `duró ${dur < 60 ? `${dur} min` : `${Math.floor(dur / 60)} h ${dur % 60} min`}` : "evento puntual"} · {i.sedes.join(", ")}</small>
                </span>
                <span className={`text-xs font-bold ${i.resuelto ? "text-emerald-300" : "text-rose-300"}`}>{i.resuelto ? "Resuelto" : "Abierto"}</span>
              </button>
              {abierto === `x${i.id}` && (
                <div className="ml-6 flex flex-col border-l-2 border-slate-800 pb-3 pl-3">
                  {i.items.map((a) => (
                    <button key={a.id} type="button" onClick={() => onIr(a.sede_id)} className="flex items-center gap-2 py-1 text-left text-xs text-slate-300 hover:text-white">
                      <span className="h-2 w-2 rounded-full" style={{ background: col(a.tipo) }} />
                      <span className="mono text-slate-500">{new Date(a.t).toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit" })}</span>
                      <b>{a.sede}</b> · {a.titulo}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

/* ================= ranking de sedes ================= */
function Ranking({ vista, equipos, onIr }: { vista: CentroVista; equipos: Map<string, Equipo[]>; onIr: (sede: string) => void }) {
  type K = "disp" | "eventos" | "criticos" | "linea" | "ms";
  const [orden, setOrden] = useState<{ k: K; asc: boolean }>({ k: "disp", asc: true });
  const filas = vista.sedes.map((s) => {
    const h = s.historial.filter((x) => x.nivel != null);
    const disp = h.length ? (h.filter((x) => x.nivel === "ok").length / h.length) * 100 : null;
    const dias = Object.values(s.por_dia);
    const lista = equipos.get(s.id) ?? [];
    return { s, disp, eventos: dias.reduce((a, d) => a + d.total, 0), criticos: dias.reduce((a, d) => a + d.criticos, 0), linea: lista.length ? (lista.filter((e) => e.ok).length / lista.length) * 100 : 0, enTxt: `${lista.filter((e) => e.ok).length}/${lista.length}`, ms: s.latencia_ms };
  });
  const val = (f: (typeof filas)[number]) => (f[orden.k] ?? (orden.asc ? Infinity : -Infinity)) as number;
  filas.sort((a, b) => (orden.asc ? val(a) - val(b) : val(b) - val(a)));
  const maxEv = Math.max(1, ...filas.map((f) => f.eventos));
  const th = (k: K, t: string) => (
    <th className="py-2 text-left font-semibold">
      <button type="button" onClick={() => setOrden((o) => ({ k, asc: o.k === k ? !o.asc : k === "disp" || k === "linea" }))} className="flex items-center gap-1 uppercase hover:text-slate-200" aria-sort={orden.k === k ? (orden.asc ? "ascending" : "descending") : "none"}>
        {t}{orden.k === k ? (orden.asc ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
  return (
    <section className="panel flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow">Ranking de sedes · clic en una columna para ordenar</span>
        <span className="text-[11px] text-slate-500">Disponibilidad = horas "operando" de las últimas 24 h · eventos de los últimos 7 días</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="text-[11px] tracking-wider text-slate-500">
            <tr><th className="py-2 text-left font-semibold">#</th><th className="py-2 text-left font-semibold">SEDE</th>{th("disp", "Disponibilidad 24 h")}<th className="py-2 text-left font-semibold">ÚLTIMAS 24 H</th>{th("eventos", "Eventos 7 d")}{th("criticos", "Críticos")}{th("linea", "En línea")}{th("ms", "Respuesta")}</tr>
          </thead>
          <tbody>
            {filas.map((f, i) => (
              <tr key={f.s.id} className="cursor-pointer border-t border-slate-800/80 hover:bg-slate-800/40" onClick={() => onIr(f.s.id)}>
                <td className="py-2 text-slate-500">{i + 1}</td>
                <td className="py-2"><span className="flex items-center gap-2 font-semibold text-slate-100"><span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR[f.s.nivel] }} />{f.s.nombre}</span></td>
                <td className="py-2"><span className="flex items-center gap-2"><span className="h-1.5 w-24 overflow-hidden rounded bg-slate-800"><span className="block h-full" style={{ width: `${f.disp ?? 0}%`, background: (f.disp ?? 0) >= 98 ? "#22c55e" : (f.disp ?? 0) >= 90 ? "#f59e0b" : "#ef4444" }} /></span><b className="mono text-slate-100">{f.disp == null ? "—" : `${f.disp.toFixed(0)} %`}</b></span></td>
                <td className="py-2"><span className="flex h-4 gap-px">{f.s.historial.slice(-24).map((h) => <i key={h.hora} title={`${new Date(h.hora).toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit" })}: ${h.nivel ? NIVEL_TXT[h.nivel] : "sin datos"}`} className="block w-1.5 rounded-sm" style={{ background: h.nivel ? COLOR[h.nivel] : "#1e293b" }} />)}</span></td>
                <td className="py-2"><span className="flex items-center gap-2"><span className="h-1.5 w-16 overflow-hidden rounded bg-slate-800"><span className="block h-full bg-sky-500" style={{ width: `${(f.eventos / maxEv) * 100}%` }} /></span><b className="mono text-slate-200">{f.eventos}</b></span></td>
                <td className={`mono py-2 font-bold ${f.criticos ? "text-rose-300" : "text-slate-400"}`}>{f.criticos}</td>
                <td className="mono py-2 text-slate-200">{f.enTxt}</td>
                <td className="mono py-2 text-slate-300">{f.ms != null ? `${f.ms} ms` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ================= modo sala de control ================= */
function SalaControl({ vista, equipos, onSalir }: { vista: CentroVista; equipos: Map<string, Equipo[]>; onSalir: () => void }) {
  const conProblema = vista.sedes.filter((s) => s.nivel !== "ok");
  const ronda = conProblema.length ? conProblema : vista.sedes;
  const [i, setI] = useState(0);
  const [pausa, setPausa] = useState(false);
  const [tick, setTick] = useState(0);
  const SEG = 12;
  useEffect(() => {
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => {});
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSalir();
      if (e.key === "ArrowRight") { setI((x) => x + 1); setTick(0); }
      if (e.key === "ArrowLeft") { setI((x) => x - 1 + ronda.length); setTick(0); }
      if (e.key === " ") setPausa((p) => !p);
    };
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("keydown", k); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (pausa) return;
    const t = setInterval(() => setTick((x) => { if (x + 1 >= SEG) { setI((y) => y + 1); return 0; } return x + 1; }), 1000);
    return () => clearInterval(t);
  }, [pausa]);
  const sede = ronda[((i % ronda.length) + ronda.length) % ronda.length];
  const [ahora, setAhora] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setAhora(new Date()), 1000); return () => clearInterval(t); }, []);
  return (
    <div className="cm fixed inset-0 z-[80] flex flex-col gap-4 overflow-y-auto bg-[#070c16] p-5">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-col">
          <span className="eyebrow">Sala de control · Energía IGSS</span>
          <strong className="text-2xl text-slate-50">{sede?.nombre}</strong>
        </div>
        <span className="text-sm text-slate-400">{conProblema.length ? `Recorriendo ${conProblema.length} sede(s) con problema` : "Todo en orden: recorriendo las 10 sedes"} · cambia cada {SEG} s</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="mono text-xl text-slate-100">{ahora.toLocaleTimeString("es-GT")}</span>
          <button type="button" onClick={() => { setI((x) => x - 1 + ronda.length); setTick(0); }} className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-slate-200" aria-label="Sede anterior">◀</button>
          <button type="button" onClick={() => setPausa((p) => !p)} className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm font-bold text-slate-200">{pausa ? "Reanudar" : "Pausar"}</button>
          <button type="button" onClick={() => { setI((x) => x + 1); setTick(0); }} className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-slate-200" aria-label="Sede siguiente">▶</button>
          <button type="button" onClick={onSalir} className="h-10 rounded-lg bg-sky-600 px-4 text-sm font-bold text-white">Salir (Esc)</button>
        </div>
      </div>
      <div className="h-1 overflow-hidden rounded bg-slate-800"><div className="h-full bg-sky-500 transition-[width] duration-1000 ease-linear" style={{ width: `${(tick / SEG) * 100}%` }} /></div>
      <div className="flex flex-wrap gap-2">
        {vista.sedes.map((s) => (
          <button key={s.id} type="button" onClick={() => { setI(Math.max(0, ronda.indexOf(s))); setTick(0); }} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${s.id === sede?.id ? "border-sky-500 bg-sky-950 text-white" : "border-slate-800 bg-slate-900 text-slate-300"}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${s.nivel !== "ok" ? "latido" : ""}`} style={{ background: COLOR[s.nivel] }} />{s.nombre}
          </button>
        ))}
      </div>
      {sede && <SedeVista key={sede.id} enSala sede={sede} equipos={equipos.get(sede.id) ?? []} alarmas={alarmasActivas(vista).filter((a) => a.sedeId === sede.id)} filtro="todos" setFiltro={() => {}} onAbrir={() => {}} onAlertas={() => {}} />}
    </div>
  );
}
