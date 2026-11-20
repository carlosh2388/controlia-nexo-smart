import { useEffect, useRef, useState } from "react";
import { useCentroAnalitica, type CentroAnalitica, type CentroVista, type HallazgoRiesgo } from "../../api/centro";
import { buscarEquipo, buscarSede, interpretar, MENU, normalizar, PESTANA_NOMBRE, quitarDespertar, usaContexto, type Accion, type Pestana, type PestanaEquipo, type VistaRed } from "./comandos";
import { useAuthStore } from "../../store/auth.store";
import { apiClient } from "../../api/client";

/** Pantalla que pide Gravix IA (por nombres; la web la resuelve a sus ids). */
interface AccionIA {
  destino: "inicio" | "vista" | "sede" | "equipo" | "alertas" | "aplicacion";
  vista?: string;
  sede?: string;
  equipo?: string;
  pestana?: string;
  aplicacion?: string;
}
const APP_A_PESTANA: Record<string, Pestana> = {
  centro: "centro",
  operativa: "classic",
  edificio: "building",
  gestion: "automations",
  sedes: "sedes",
  equipos: "equipos",
  piloto: "gravix",
  usuarios: "usuarios",
};
/** Preguntas que la analitica propia no responde (por que, comparaciones, periodos...): con IA activa van a Claude. */
const COMPLEJA =
  /\b(por que|porque|compara|comparar|comparacion|comparado|diferencia|cuando|semana pasada|mes pasado|ayer|anoche|promedio|maximo|minimo|pico|historial|historico|evolucion|explica por que|cuanto subio|cuanto bajo|cual fue|cuales fueron|desde)\b/;
/** Ordenes que siempre se resuelven aqui (rapido y sin costo), aunque la IA este activa. */
const SIEMPRE_LOCAL = new Set<Accion["tipo"]>(["detalle", "pestana", "sede", "equipo", "alertas", "vista", "inicio", "sala", "cerrar", "callar", "avisos", "gracias", "adios", "menu", "saludo", "pedir_sede", "pedir_telemetria"]);
import "./gravix-asistente.css";

/**
 * Gravix: asistente de voz de la aplicacion (sin IA ni licencias: todo corre aqui).
 *  - Vive en el marco de la aplicacion: maneja todas las pestañas y, dentro del Centro de mando,
 *    sedes, equipos, alertas y vistas.
 *  - Analitica predictiva calculada en la API propia (/centro/analitica): que puede fallar, con su
 *    probabilidad, tendencia y recomendacion; y lo que paso en las ultimas 24 horas por sede.
 *  - Escucha (reconocimiento de voz del navegador) o lee lo que se escribe, entiende la frase con
 *    comandos.ts y lleva a la pantalla pedida; responde hablando (voces del sistema) y por escrito.
 *  - Conversa: da la bienvenida, pregunta que desea hacer, pide el dato que falta (que sede, que
 *    telemetria), recuerda de que se hablaba ("¿y sus alarmas?") y propone los siguientes pasos.
 *  - Avisa con un pitido y en voz alta cuando aparece una alarma critica nueva.
 * Solo lee y navega: no envia comandos a ningun equipo ni cambia configuracion.
 */

export interface GravixEquipo {
  key: string;
  sedeId: string;
  sedeNombre: string;
  nombre: string;
  inventario: string | null;
  estadoTxt: string;
  ok: boolean;
  kind: "ion" | "pm" | "gen";
  /** Ultima lectura del monitoreo central o del Agente Go (kW, fuente, voltaje). */
  central: { estado: string; lectura: { kw: number | null; fuente: "comercial" | "generador" | null; v_prom: number | null } | null } | null;
}

/** De que se esta hablando y que dato espera Gravix. */
interface Conversacion {
  sedeId: string | null;
  grupoId: string | null;
  esperando: "sede" | "telemetria" | null;
}

/** Mañana 5:00-11:59, tarde 12:00-18:59, noche 19:00-4:59 (hora de la computadora). */
const saludoHora = () => {
  const h = new Date().getHours();
  return h >= 5 && h < 12 ? "Buenos días" : h >= 12 && h < 19 ? "Buenas tardes" : "Buenas noches";
};
const NIVEL_COLOR: Record<string, string> = { alto: "#ef4444", medio: "#f59e0b", bajo: "#38bdf8" };
const NIVEL_NOMBRE: Record<string, string> = { alto: "Riesgo alto", medio: "Riesgo medio", bajo: "Riesgo bajo" };
/** "chernandez" -> "Chernandez"; "juan.perez@x" -> "Juan". */
const nombreCorto = (u: string | null | undefined) => {
  const base = (u ?? "").split(/[@.\s_]/)[0];
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "";
};
const kw = (v: number) => (v >= 100 ? Math.round(v).toLocaleString("es-GT") : v.toFixed(1));
export interface GravixAlarma {
  codigo: string;
  titulo: string;
  severidad: "critico" | "advertencia" | "info";
  dispositivo: string | null;
  sedeId: string;
  sedeNombre: string;
}

interface Props {
  vista: CentroVista;
  equipos: Map<string, GravixEquipo[]>;
  alarmas: GravixAlarma[];
  esAdmin: boolean;
  sedeActual: string | null;
  /** Telemetrias (grupos de sedes) y a cual pertenece cada sede. */
  grupos: { id: string; nombre: string }[];
  grupoDe: (sedeId: string) => string | null;
  /** Ejecuta la navegacion en el Centro de mando (si hace falta, cambia antes a esa pestaña). */
  ejecutar: (a: Accion) => void;
  /** Pestañas que el perfil puede ver, la actual y como cambiar de pestaña. */
  pestanas: Pestana[];
  pestanaActual: Pestana;
  irPestana: (p: Pestana) => void;
  /** false = todavia no hay datos del Centro de mando (otra pestaña de inicio). */
  conDatos: boolean;
}

interface Mensaje {
  id: number;
  de: "yo" | "gravix";
  texto: string;
  boton?: { label: string; accion: Accion };
  /** Tarjetas de riesgo (analitica predictiva). */
  tarjetas?: HallazgoRiesgo[];
}

interface Prefs {
  voz: boolean;
  avisos: boolean;
  continua: boolean;
  /** Nombre de la voz elegida (null = la recomendada). */
  vozNombre: string | null;
  /** Usar Gravix IA (modelo local o Claude, segun el servidor) cuando el servidor la tiene activada; false = solo analitica propia. */
  ia: boolean;
}

/* ---------- reconocimiento de voz del navegador (tipos minimos) ---------- */
interface ResultadoVoz {
  isFinal: boolean;
  0: { transcript: string };
}
interface EventoVoz {
  resultIndex: number;
  results: ArrayLike<ResultadoVoz>;
}
interface Reconocedor {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: EventoVoz) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type ConstructorReconocedor = new () => Reconocedor;
const Reconocimiento: ConstructorReconocedor | undefined =
  typeof window === "undefined"
    ? undefined
    : ((window as unknown as { SpeechRecognition?: ConstructorReconocedor; webkitSpeechRecognition?: ConstructorReconocedor }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: ConstructorReconocedor }).webkitSpeechRecognition);
const IDIOMA = typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("es") ? navigator.language : "es-MX";

const PREFS_KEY = "gravix.prefs";
const PREFS_INI: Prefs = { voz: true, avisos: true, continua: false, vozNombre: null, ia: true };
function leerPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...PREFS_INI, ...(JSON.parse(raw) as Partial<Prefs>) } : PREFS_INI;
  } catch {
    return PREFS_INI;
  }
}
function guardarPrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* sin almacenamiento: las preferencias duran solo esta visita */
  }
}

const VISTA_TXT: Record<VistaRed, string> = {
  mapa: "el mapa en vivo",
  incidentes: "la línea de tiempo de incidentes",
  ranking: "el ranking de sedes",
  normas: "normas y cumplimiento",
  prediccion: "la predicción",
  analitica: "la analítica: métricas por sede, últimas 24 horas y riesgos",
  alarmas: "alarmas y correos",
};
const PESTANA_TXT: Record<PestanaEquipo, string> = {
  equipo: "",
  tendencias: " en tendencias",
  calidad: " en calidad de energía",
  comparativo: " en el comparativo directo contra EBO",
  alarmas: " en sus alarmas y correos",
  bitacora: " en la bitácora",
  info: " en la información del equipo",
};
const NIVEL_TXT: Record<string, string> = { ok: "operando normal", advertencia: "con advertencias", critico: "en estado crítico", sin_respuesta: "sin respuesta" };
const SI = new Set(["si", "si por favor", "claro", "dale", "ok", "okay", "va", "por favor", "hazlo", "adelante", "de acuerdo", "simon", "sale"]);
const NO = new Set(["no", "no gracias", "despues", "luego", "ahorita no"]);

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/* ---------- sonido: pitido corto con Web Audio (sin archivos) ---------- */
let audioCtx: AudioContext | null = null;
function pitido(urgente: boolean) {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const tonos = urgente ? [880, 660, 880] : [660, 880];
    tonos.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const t0 = ctx.currentTime + i * 0.18;
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.17);
    });
  } catch {
    /* el navegador no permite audio todavia (falta un clic) */
  }
}

function vocesEspanol(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === "undefined") return [];
  return speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("es"));
}

/**
 * Voz recomendada: formal, clara y no muy grave. Primero las voces neuronales ("Natural"/"Online"
 * de Edge, "Google") en español latino, luego voces conocidas de tono medio, luego cualquier español.
 */
const VOCES_PREFERIDAS = ["dalia", "paloma", "sabina", "renata", "elena", "helena", "laura", "elvira", "google español de estados unidos", "google español"];
const ACENTOS = ["es-mx", "es-us", "es-419", "es-gt", "es-co", "es-es"];
function puntaje(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase();
  let s = 0;
  if (/natural|online|neural/.test(n)) s += 100;
  const i = VOCES_PREFERIDAS.findIndex((x) => n.includes(x));
  if (i >= 0) s += 50 - i;
  const a = ACENTOS.indexOf(v.lang.toLowerCase());
  if (a >= 0) s += 20 - a * 2;
  return s;
}
function vozEspanol(nombre: string | null): SpeechSynthesisVoice | null {
  const voces = vocesEspanol();
  if (nombre) {
    const v = voces.find((x) => x.name === nombre);
    if (v) return v;
  }
  return [...voces].sort((a, b) => puntaje(b) - puntaje(a))[0] ?? null;
}

export default function Gravix(props: Props) {
  const p = useRef(props);
  p.current = props;

  const [abierto, setAbierto] = useState(false);
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [texto, setTexto] = useState("");
  const [escuchando, setEscuchando] = useState(false);
  const [parcial, setParcial] = useState("");
  const [hablando, setHablando] = useState(false);
  const [prefs, setPrefsState] = useState<Prefs>(leerPrefs);
  const [errorMic, setErrorMic] = useState<{ texto: string; url?: string } | null>(null);
  /** Analitica predictiva (se calcula en la API y se refresca cada 10 min). */
  const analitica = useCentroAnalitica();
  const analiticaRef = useRef<CentroAnalitica | undefined>(analitica.data);
  analiticaRef.current = analitica.data;
  /** Ultima lista de riesgos mostrada (para "explicame el segundo"). */
  const ultimosRiesgos = useRef<HallazgoRiesgo[]>([]);
  /** Texto que no se pudo decir porque el navegador aun no permite audio (falta el primer clic). */
  const vozPendiente = useRef<string | null>(null);
  const [globo, setGlobo] = useState<{ texto: string; accion?: Accion; bienvenida?: boolean; aviso?: boolean } | null>(null);
  /** Atajos que se muestran bajo la conversacion; cambian segun el tema. */
  const [sugerencias, setSugerencias] = useState<string[]>(MENU);
  const conv = useRef<Conversacion>({ sedeId: null, grupoId: null, esperando: null });
  const usuario = useAuthStore((s) => s.user?.username);

  const mensajesRef = useRef(mensajes);
  mensajesRef.current = mensajes;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const idRef = useRef(0);
  const pendienteRef = useRef<Accion | null>(null);
  const recRef = useRef<Reconocedor | null>(null);
  /** Despues de decir solo "Gravix", la siguiente frase se toma como orden durante unos segundos. */
  const atentoHasta = useRef(0);
  const listaRef = useRef<HTMLDivElement>(null);

  const setPrefs = (cambio: Partial<Prefs>) =>
    setPrefsState((ant) => {
      const n = { ...ant, ...cambio };
      guardarPrefs(n);
      return n;
    });

  useEffect(() => {
    listaRef.current?.scrollTo({ top: listaRef.current.scrollHeight, behavior: "smooth" });
  }, [mensajes, parcial]);

  // Las voces del sistema cargan tarde en algunos navegadores.
  const [voces, setVoces] = useState<SpeechSynthesisVoice[]>(vocesEspanol);
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const cargar = () => setVoces(vocesEspanol());
    cargar();
    speechSynthesis.addEventListener?.("voiceschanged", cargar);
    return () => speechSynthesis.removeEventListener?.("voiceschanged", cargar);
  }, []);
  const vozActual = vozEspanol(prefs.vozNombre);

  const hablar = (t: string, forzar = false) => {
    if ((!prefsRef.current.voz && !forzar) || typeof speechSynthesis === "undefined") return;
    // Chrome/Edge no dejan hablar antes de que el usuario toque la pagina: se dice en el primer clic.
    const activacion = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (activacion && !activacion.hasBeenActive) {
      vozPendiente.current = t;
      return;
    }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(t.replace(/[«»]/g, ""));
      u.lang = "es-MX";
      const v = vozEspanol(prefsRef.current.vozNombre);
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      }
      // Tono formal: pausado y con altura normal (ni grave ni aguda).
      u.rate = 0.95;
      u.pitch = 1.05;
      u.onstart = () => setHablando(true);
      u.onend = () => setHablando(false);
      u.onerror = () => setHablando(false);
      speechSynthesis.speak(u);
    } catch {
      setHablando(false);
    }
  };
  const callar = () => {
    vozPendiente.current = null;
    try {
      speechSynthesis.cancel();
    } catch {
      /* nada */
    }
    setHablando(false);
  };
  useEffect(() => {
    const alPrimerClic = () => {
      const t = vozPendiente.current;
      vozPendiente.current = null;
      if (t) window.setTimeout(() => hablar(t), 50);
    };
    document.addEventListener("pointerdown", alPrimerClic, { once: true });
    document.addEventListener("keydown", alPrimerClic, { once: true });
    return () => {
      document.removeEventListener("pointerdown", alPrimerClic);
      document.removeEventListener("keydown", alPrimerClic);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agregar = (de: Mensaje["de"], t: string, boton?: Mensaje["boton"], tarjetas?: HallazgoRiesgo[]) =>
    setMensajes((m) => [...m.slice(-40), { id: ++idRef.current, de, texto: t, boton, tarjetas }]);

  /** true cuando la ultima orden abrio algo: el panel se minimiza para dejar ver la pantalla. */
  const minimizar = useRef(false);
  const abiertoRef = useRef(abierto);
  abiertoRef.current = abierto;

  const decir = (t: string, boton?: Mensaje["boton"], atajos?: string[], tarjetas?: HallazgoRiesgo[]) => {
    agregar("gravix", t, boton, tarjetas);
    pendienteRef.current = boton?.accion ?? null;
    if (atajos) setSugerencias(atajos);
    hablar(t);
    // Si abrio una pantalla, o si el panel esta cerrado, la respuesta se ve en un globo junto al orbe.
    if (minimizar.current || !abiertoRef.current) {
      minimizar.current = false;
      setAbierto(false);
      setGlobo({ texto: t, aviso: true });
    }
  };

  /** Ultima sede consultada por este usuario (para personalizar el saludo). */
  const claveUltima = `gravix.ultima.${usuario ?? "anon"}`;
  const recordarSede = (id: string) => {
    try {
      localStorage.setItem(claveUltima, id);
    } catch {
      /* sin almacenamiento */
    }
  };
  const ultimaSede = () => {
    try {
      return localStorage.getItem(claveUltima);
    } catch {
      return null;
    }
  };

  /** Abre el equipo de un hallazgo (lo busca por inventario o nombre en su sede). */
  const accionDeHallazgo = (h: HallazgoRiesgo): Accion => {
    const lista = p.current.equipos.get(h.sedeId) ?? [];
    const ref = normalizar(h.inventario ?? h.equipo ?? "");
    const e = ref ? lista.find((x) => normalizar(x.inventario ?? "") === ref || normalizar(x.nombre) === ref) ?? buscarEquipo(ref, lista) : null;
    return e ? { tipo: "equipo", equipoKey: e.key, pestana: h.tipo === "voltaje" || h.tipo === "carga" ? "tendencias" : "equipo" } : { tipo: "sede", sedeId: h.sedeId, estado: true };
  };

  /** Atajos de seguimiento segun el tema: una sede, una telemetria o el menu. */
  const atajosSede = (nombre: string) => [`¿Qué alarmas tiene ${nombre}?`, `¿Cuánto consume ${nombre}?`, `Equipos fuera de línea en ${nombre}`, `Generadores de ${nombre}`, "Volver al mapa"];
  const atajosGrupo = (nombre: string) => [`¿Qué alarmas hay en ${nombre}?`, `Consumo de ${nombre}`, `Sedes que no responden en ${nombre}`, "Comparar telemetrías", "Menú"];

  /** Potencia actual de un conjunto de equipos: suma de analizadores ION7400 (o PM2130 si no hay ION). */
  const potencia = (eqs: GravixEquipo[]) => {
    const conKw = (k: GravixEquipo["kind"]) => eqs.filter((e) => e.kind === k && typeof e.central?.lectura?.kw === "number");
    const base = conKw("ion").length ? conKw("ion") : conKw("pm");
    const total = base.reduce((s, e) => s + (e.central!.lectura!.kw as number), 0);
    const mayor = [...base].sort((a, b) => (b.central!.lectura!.kw as number) - (a.central!.lectura!.kw as number))[0] ?? null;
    const gens = conKw("gen").filter((e) => (e.central!.lectura!.kw as number) > 0.5);
    return { total, n: base.length, tipo: base[0]?.kind === "pm" ? "medidores PM2130" : "analizadores ION7400", mayor, genKw: gens.reduce((s, e) => s + (e.central!.lectura!.kw as number), 0) };
  };
  const enMarcha = (e: GravixEquipo) => e.kind === "gen" && (e.central?.estado === "generador_en_marcha" || (e.central?.lectura?.kw ?? 0) > 0.5);

  /* ---------- respuestas con los datos del Centro de mando ---------- */
  const estadoRed = () => {
    const { vista, alarmas } = p.current;
    const t = vista.totales;
    const crit = alarmas.filter((a) => a.severidad === "critico");
    const adv = alarmas.length - crit.length;
    let s = `${t.sedes_responden} de ${t.sedes} sedes responden y ${t.medidores_ok} de ${t.medidores} medidores están en línea. `;
    if (!alarmas.length) return { texto: s + "No hay alarmas activas. Todo en orden.", boton: undefined };
    s += crit.length ? `Hay ${plural(crit.length, "alarma crítica", "alarmas críticas")}` : "No hay alarmas críticas";
    s += adv ? ` y ${plural(adv, "advertencia", "advertencias")}. ` : ". ";
    const porSede = new Map<string, number>();
    for (const a of crit.length ? crit : alarmas) porSede.set(a.sedeNombre, (porSede.get(a.sedeNombre) ?? 0) + 1);
    const peor = [...porSede.entries()].sort((a, b) => b[1] - a[1])[0];
    if (peor) s += `La sede más afectada es ${peor[0]}. `;
    const primera = crit[0] ?? alarmas[0];
    if (primera) s += `La primera: ${primera.titulo}${primera.dispositivo ? ` en ${primera.dispositivo}` : ""}, ${primera.sedeNombre}. `;
    s += crit.length ? "¿Quiere ver las alarmas críticas?" : "¿Quiere ver las alertas?";
    return { texto: s, boton: { label: "Ver alertas", accion: { tipo: "alertas", sedeId: null } as Accion } };
  };

  const responder = (a: Accion) => {
    const { vista, equipos, alarmas: todas, esAdmin, ejecutar: ejecutarNav, grupos, grupoDe } = p.current;
    /** Navega y deja marcado que el panel se minimice para que se vea lo que se abrio. */
    const ejecutar = (x: Accion) => {
      ejecutarNav(x);
      minimizar.current = true;
    };
    const nombreSede = (id: string | null) => vista.sedes.find((s) => s.id === id)?.nombre ?? id ?? "";
    const nombreGrupo = (id: string | null | undefined) => grupos.find((g) => g.id === id)?.nombre ?? "sin grupo";
    // Con telemetria pedida, todo se limita a las sedes de esa telemetria.
    const gid = "grupoId" in a ? a.grupoId ?? null : null;
    const enGrupo = (sedeId: string) => !gid || grupoDe(sedeId) === gid;
    const alarmas = todas.filter((x) => enGrupo(x.sedeId));
    const deGrupo = gid ? ` en ${nombreGrupo(gid)}` : "";
    /** Una telemetria en una frase: sedes, respuesta, medidores y alarmas. */
    const frasaGrupo = (id: string | null, detalle: boolean) => {
      const sedes = vista.sedes.filter((s) => grupoDe(s.id) === id);
      if (!sedes.length) return `${nombreGrupo(id)} todavía no tiene sedes.`;
      const responden = sedes.filter((s) => !s.sin_respuesta).length;
      const eqs = sedes.flatMap((s) => equipos.get(s.id) ?? []);
      const ids = new Set(sedes.map((s) => s.id));
      const al = todas.filter((x) => ids.has(x.sedeId));
      const crit = al.filter((x) => x.severidad === "critico").length;
      const pot = potencia(eqs);
      let f = `${nombreGrupo(id)}: ${plural(sedes.length, "sede", "sedes")}, ${responden} responden, ${eqs.filter((e) => e.ok).length} de ${eqs.length} medidores en línea${pot.n ? `, ${kw(pot.total)} kW en este momento` : ""}, ${plural(crit, "crítica", "críticas")} y ${plural(al.length - crit, "advertencia", "advertencias")}.`;
      if (detalle) {
        f += ` Sedes: ${sedes.map((s) => s.nombre).join(", ")}.`;
        const problemas = sedes.filter((s) => s.sin_respuesta || s.nivel !== "ok");
        if (problemas.length) f += ` Con novedades: ${problemas.map((s) => `${s.nombre} (${NIVEL_TXT[s.nivel] ?? s.nivel})`).join(", ")}.`;
      }
      return f;
    };
    // Recordar el tema para las preguntas de seguimiento.
    if ("sedeId" in a && a.sedeId) conv.current = { sedeId: a.sedeId, grupoId: null, esperando: null };
    else if (gid) conv.current = { sedeId: null, grupoId: gid, esperando: null };
    else conv.current = { ...conv.current, esperando: null };
    switch (a.tipo) {
      case "grupo": {
        if (a.grupoId) {
          ejecutar({ tipo: "inicio" });
          const conAlarmas = alarmas.length;
          return decir(
            `${frasaGrupo(a.grupoId, true)} ¿Desea revisar sus alarmas o el consumo?`,
            conAlarmas ? { label: "Ver sus alarmas", accion: { tipo: "leer_alarmas", sedeId: null, grupoId: a.grupoId } } : undefined,
            atajosGrupo(nombreGrupo(a.grupoId)),
          );
        }
        const ids = [...grupos.map((g) => g.id as string | null), ...(vista.sedes.some((s) => !grupoDe(s.id)) ? [null] : [])];
        if (!ids.length) return decir("Todavía no hay telemetrías configuradas.");
        return decir(`Estado por telemetría. ${ids.map((id) => frasaGrupo(id, false)).join(" ")} ¿Quiere el detalle de alguna?`, undefined, [...grupos.map((g) => `¿Cómo está ${g.nombre}?`), "Menú"]);
      }
      case "saludo": {
        const t = vista.totales;
        const crit = todas.filter((x) => x.severidad === "critico");
        const adv = todas.length - crit.length;
        const nombre = nombreCorto(usuario);
        let estado: string;
        if (!todas.length) estado = `La red está en orden: ${t.sedes_responden} de ${t.sedes} sedes responden y no hay alarmas activas.`;
        else {
          const porSede = new Map<string, number>();
          for (const x of crit.length ? crit : todas) porSede.set(x.sedeNombre, (porSede.get(x.sedeNombre) ?? 0) + 1);
          const peor = [...porSede.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
          estado = `En este momento hay ${crit.length ? `${plural(crit.length, "alarma crítica", "alarmas críticas")}${adv ? ` y ${plural(adv, "advertencia", "advertencias")}` : ""}` : plural(adv, "advertencia", "advertencias")}${peor ? `, la mayoría en ${peor}` : ""}.`;
        }
        // Personal: el riesgo mas alto que encontro la analitica y la ultima sede que consulto.
        const an = analiticaRef.current;
        const top = an?.hallazgos.find((h) => h.nivel === "alto") ?? null;
        const aviso = top
          ? ` Mi análisis encontró algo importante: ${top.titulo}${top.probabilidad != null ? `, con ${Math.round(top.probabilidad * 100)} % de probabilidad en los próximos 7 días` : ""}.`
          : an && an.hallazgos.length
            ? ` Mi análisis de los últimos ${an.diasAnalizados} días no encontró riesgos altos.`
            : "";
        const ult = ultimaSede();
        const ultNombre = ult ? vista.sedes.find((s) => s.id === ult)?.nombre : null;
        const atajos = [...(top ? ["¿Qué puede fallar?"] : []), ...(ultNombre ? [`¿Cómo está ${ultNombre}?`] : []), ...MENU.filter((m) => m !== "¿Qué puede fallar?")];
        if (!p.current.conDatos)
          return decir(`${saludoHora()}${nombre ? `, ${nombre}` : ""}. Soy Gravix, su asistente. Puedo llevarlo a cualquier pestaña o consultarle el Centro de mando. ¿Qué desea hacer hoy?`, undefined, MENU);
        return decir(
          `${saludoHora()}${nombre ? `, ${nombre}` : ""}. Soy Gravix, su asistente. ${estado}${aviso}${ultNombre ? ` La última vez revisó ${ultNombre}.` : ""} ¿Qué desea hacer hoy?`,
          top ? { label: "Ver el análisis", accion: { tipo: "riesgos", sedeId: null } } : crit.length ? { label: "Ver alarmas críticas", accion: { tipo: "leer_alarmas", sedeId: null } } : undefined,
          atajos.slice(0, 7),
        );
      }
      case "menu":
        return decir(
          "Puedo analizar qué puede fallar en los próximos días, revisar las alarmas, darle el estado de cada telemetría, consultar una sede, el consumo de energía, los generadores en marcha o los equipos fuera de línea. También lo llevo a cualquier pestaña: Vista Operativa, Vista de Edificio, Gestión Inteligente, Sedes, Equipos, Piloto Gravix o Usuarios. ¿Qué desea hacer?",
          undefined,
          MENU,
        );
      case "pestana": {
        const { pestanas, irPestana, pestanaActual } = p.current;
        if (!pestanas.includes(a.pestana)) return decir(`Su perfil no tiene acceso a ${PESTANA_NOMBRE[a.pestana]}.`, undefined, MENU);
        if (pestanaActual === a.pestana) return decir(`Ya está en ${PESTANA_NOMBRE[a.pestana]}. ¿Qué desea hacer aquí?`, undefined, MENU);
        irPestana(a.pestana);
        minimizar.current = true;
        return decir(`Le abro ${PESTANA_NOMBRE[a.pestana]}.${a.pestana === "centro" ? "" : " Cuando quiera volver, diga «centro de mando»."}`, undefined, a.pestana === "centro" ? MENU : ["Centro de mando", "Menú"]);
      }
      case "riesgos": {
        const an = analiticaRef.current;
        if (!an) {
          void analitica.refetch();
          return decir("Estoy terminando el análisis de los datos. Pregúnteme de nuevo en unos segundos.", undefined, ["¿Qué puede fallar?", "Menú"]);
        }
        const enAlcance = (sedeId: string) => (a.sedeId ? sedeId === a.sedeId : enGrupo(sedeId));
        const lista = an.hallazgos.filter((h) => enAlcance(h.sedeId));
        ultimosRiesgos.current = lista.slice(0, 5);
        const donde = a.sedeId ? ` de ${nombreSede(a.sedeId)}` : gid ? ` de ${nombreGrupo(gid)}` : " de la red";
        const futuro = (n: number) =>
          lista
            .slice(0, n)
            .map((h, i) => `${i + 1}. ${h.titulo}${h.probabilidad != null ? ` (${Math.round(h.probabilidad * 100)} % en 7 días)` : ""}.`)
            .join(" ");
        const sigue = lista.length ? ` ¿Quiere que le explique alguno?` : "";
        const atajosR = [...(lista.length ? ["Explícame el primero"] : []), ...(lista.length > 1 ? ["Explícame el segundo"] : []), ...(lista[0] ? [`¿Cómo está ${lista[0].sedeNombre}?`] : []), "Menú"];

        // Ultimas N horas: que paso en cada sede y lo que puede ocurrir.
        if (a.horas) {
          const s24 = an.sedes24h.filter((s) => enAlcance(s.sedeId));
          const novedades = s24.filter((s) => s.nivel !== "estable");
          const frase = (s: (typeof s24)[number]) => {
            const partes: string[] = [];
            if (s.criticas) partes.push(plural(s.criticas, "alarma crítica abierta", "alarmas críticas abiertas"));
            if (s.advertencias) partes.push(plural(s.advertencias, "advertencia", "advertencias"));
            if (s.caidas) partes.push(`${plural(s.caidas, "desconexión", "desconexiones")} de medidores (${Math.round(s.minSinDatos)} min sin datos)`);
            if (s.cortesComunicacion) partes.push(`${plural(s.cortesComunicacion, "corte", "cortes")} de comunicación`);
            if (s.caidasTension.length) partes.push(`caídas de tensión en ${s.caidasTension.join(", ")}`);
            if (s.cambioConsumo != null && Math.abs(s.cambioConsumo) >= 10) partes.push(`consumo ${s.cambioConsumo > 0 ? "subió" : "bajó"} ${Math.round(Math.abs(s.cambioConsumo))} %`);
            if (!partes.length && s.riesgo) partes.push(`riesgo ${s.riesgo.nivel}: ${s.riesgo.titulo.charAt(0).toLowerCase()}${s.riesgo.titulo.slice(1)}`);
            return `${s.sedeNombre} (${s.nivel === "critico" ? "crítico" : "advertencia"}): ${partes.join(", ")}`;
          };
          const estables = s24.length - novedades.length;
          const pasado = novedades.length
            ? `En las últimas 24 horas${donde}: ${novedades.slice(0, 5).map(frase).join(". ")}.${estables ? ` ${plural(estables, "sede estuvo estable", "sedes estuvieron estables")}.` : ""}`
            : `En las últimas 24 horas${donde} todas las sedes estuvieron estables.`;
          const pron = lista.length ? ` Lo que puede ocurrir: ${futuro(3)}` : " No veo riesgos para los próximos días.";
          return decir(`${pasado}${pron}${sigue}`, undefined, atajosR, lista.slice(0, 5));
        }

        if (!lista.length)
          return decir(`Analicé ${an.equiposAnalizados} equipos con ${an.diasAnalizados} días de historia y no encontré riesgos${donde}. Todo se ve estable.`, undefined, MENU);
        const altos = lista.filter((h) => h.nivel === "alto").length;
        const medios = lista.filter((h) => h.nivel === "medio").length;
        return decir(
          `Analicé ${an.equiposAnalizados} equipos con ${an.diasAnalizados} días de historia. Encontré ${plural(altos, "riesgo alto", "riesgos altos")} y ${plural(medios, "medio", "medios")}${donde}. Lo más importante: ${futuro(3)}${sigue}`,
          undefined,
          atajosR,
          lista.slice(0, 5),
        );
      }
      case "detalle": {
        const h = ultimosRiesgos.current[a.n - 1];
        if (!h) return decir("Primero pídame el análisis: diga «¿qué puede fallar?».", undefined, ["¿Qué puede fallar?", "Menú"]);
        conv.current = { sedeId: h.sedeId, grupoId: null, esperando: null };
        return decir(
          `${h.titulo}, en ${h.sedeNombre}. ${h.detalle} Recomendación: ${h.recomendacion}`,
          { label: h.equipo ? `Abrir ${h.equipo}` : `Abrir ${h.sedeNombre}`, accion: accionDeHallazgo(h) },
          [...(ultimosRiesgos.current[a.n] ? [`Explícame el ${["primero", "segundo", "tercero", "cuarto", "quinto"][a.n] ?? a.n + 1}`] : []), `¿Cómo está ${h.sedeNombre}?`, "¿Qué puede fallar?", "Menú"],
          [h],
        );
      }
      case "pedir_sede": {
        conv.current = { ...conv.current, esperando: "sede" };
        // Primero las sedes con novedades, para ofrecerlas como atajos.
        const orden = [...vista.sedes].sort((x, y) => Number(y.sin_respuesta || y.nivel !== "ok") - Number(x.sin_respuesta || x.nivel !== "ok"));
        const conProblema = orden.filter((s) => s.sin_respuesta || s.nivel !== "ok");
        return decir(
          `¿Qué sede desea consultar?${conProblema.length ? ` Con novedades están ${conProblema.slice(0, 3).map((s) => s.nombre).join(", ")}.` : ""}`,
          undefined,
          orden.slice(0, 8).map((s) => s.nombre),
        );
      }
      case "pedir_telemetria": {
        conv.current = { ...conv.current, esperando: "telemetria" };
        if (!grupos.length) return decir("Todavía no hay telemetrías configuradas.");
        return decir(`¿Qué telemetría? Tengo ${grupos.map((g) => g.nombre).join(", ")}.`, undefined, [...grupos.map((g) => g.nombre), "Comparar telemetrías"]);
      }
      case "gracias":
        return decir("Con gusto. ¿Desea algo más?", undefined, MENU);
      case "adios":
        decir(`Hasta luego${nombreCorto(usuario) ? `, ${nombreCorto(usuario)}` : ""}. Aquí estaré si me necesita.`, undefined, MENU);
        window.setTimeout(() => setAbierto(false), 2500);
        return;
      case "consumo": {
        const sedeSel = a.sedeId ? vista.sedes.find((s) => s.id === a.sedeId) ?? null : null;
        if (sedeSel) {
          const pot = potencia(equipos.get(sedeSel.id) ?? []);
          if (!pot.n) return decir(`${sedeSel.nombre} no tiene lecturas de potencia en este momento.`, undefined, atajosSede(sedeSel.nombre));
          let f = `En ${sedeSel.nombre}, sus ${pot.tipo} suman ${kw(pot.total)} kW en este momento.`;
          if (pot.mayor && pot.n > 1) f += ` El de mayor carga es ${pot.mayor.nombre}, con ${kw(pot.mayor.central!.lectura!.kw as number)} kW.`;
          if (pot.genKw > 0) f += ` Además, sus generadores entregan ${kw(pot.genKw)} kW.`;
          return decir(`${f} Para ver el consumo por horas, abra el equipo en Tendencias. ¿Desea algo más de ${sedeSel.nombre}?`, undefined, atajosSede(sedeSel.nombre));
        }
        // Telemetria o toda la red: total y las sedes de mayor consumo.
        const sedes = vista.sedes.filter((s) => enGrupo(s.id));
        const filas = sedes.map((s) => ({ s, pot: potencia(equipos.get(s.id) ?? []) })).filter((x) => x.pot.n);
        if (!filas.length) return decir(`No hay lecturas de potencia${deGrupo || " en la red"} en este momento.`);
        const total = filas.reduce((x, f) => x + f.pot.total, 0);
        const top = [...filas].sort((x, y) => y.pot.total - x.pot.total).slice(0, 3);
        return decir(
          `${gid ? nombreGrupo(gid) : "La red"} suma ${kw(total)} kW en este momento, con lecturas de ${plural(filas.length, "sede", "sedes")}. Las de mayor consumo: ${top.map((x) => `${x.s.nombre} con ${kw(x.pot.total)} kW`).join(", ")}. ¿Desea el detalle de alguna?`,
          { label: `Abrir ${top[0].s.nombre}`, accion: { tipo: "sede", sedeId: top[0].s.id, estado: true } },
          [...top.map((x) => `¿Cuánto consume ${x.s.nombre}?`), ...(gid ? [] : ["Comparar telemetrías"]), "Menú"],
        );
      }
      case "generadores": {
        const sedes = vista.sedes.filter((s) => (a.sedeId ? s.id === a.sedeId : enGrupo(s.id)));
        const eqs = sedes.flatMap((s) => equipos.get(s.id) ?? []);
        const gens = eqs.filter((e) => e.kind === "gen");
        const marcha = gens.filter(enMarcha);
        const enPlanta = [...new Set(eqs.filter((e) => e.central?.lectura?.fuente === "generador").map((e) => e.sedeNombre))];
        const donde = a.sedeId ? ` en ${nombreSede(a.sedeId)}` : deGrupo || " en la red";
        if (!gens.length) return decir(`No tengo generadores registrados${donde}.`, undefined, a.sedeId ? atajosSede(nombreSede(a.sedeId)) : MENU);
        let f = marcha.length
          ? `Hay ${plural(marcha.length, "generador en marcha", "generadores en marcha")}${donde}: ${marcha.map((e) => `${e.nombre}${a.sedeId ? "" : ` de ${e.sedeNombre}`}${e.central?.lectura?.kw ? ` con ${kw(e.central.lectura.kw)} kW` : ""}`).join(", ")}.`
          : `Ninguno de los ${plural(gens.length, "generador", "generadores")}${donde} está en marcha.`;
        if (enPlanta.length) f += ` Alimentadas por generador: ${enPlanta.join(", ")}.`;
        else f += " Todas las sedes están con energía comercial.";
        const primero = marcha[0];
        return decir(
          `${f}${primero ? ` ¿Abro ${primero.nombre}?` : ""}`,
          primero ? { label: `Abrir ${primero.nombre}`, accion: { tipo: "equipo", equipoKey: primero.key, pestana: "equipo" } } : undefined,
          a.sedeId ? atajosSede(nombreSede(a.sedeId)) : MENU,
        );
      }
      case "ayuda":
        return decir(
          "Puedo llevarlo a cualquier parte del Centro de mando y decirle cómo está la red. Diga, por ejemplo: «resumen», «menú», «consultar una sede», «cuánto consume Escuintla», «generadores en marcha», «qué alarmas hay», «qué medidores están fuera de línea», «qué sedes no responden», «abre Escuintla», «cómo está Cobán», «alarmas de Escuintla», «ranking de sedes», «predicción», «abre el TR 1 en tendencias», «modo sala» o «cerrar». Para que lo escuche sin tocar el botón, active la escucha continua y empiece con «Gravix».",
        );
      case "resumen": {
        const e = estadoRed();
        return decir(e.texto, e.boton);
      }
      case "contar_alarmas": {
        const lista = a.sedeId ? alarmas.filter((x) => x.sedeId === a.sedeId) : alarmas;
        const crit = lista.filter((x) => x.severidad === "critico").length;
        const donde = a.sedeId ? ` en ${nombreSede(a.sedeId)}` : deGrupo || " en la red";
        if (!lista.length) return decir(`No hay alarmas activas${donde}.`);
        return decir(`Hay ${plural(lista.length, "alarma activa", "alarmas activas")}${donde}: ${plural(crit, "crítica", "críticas")} y ${plural(lista.length - crit, "advertencia", "advertencias")}. ¿Las abro?`, {
          label: "Abrir alertas",
          accion: { tipo: "alertas", sedeId: a.sedeId },
        });
      }
      case "leer_alarmas": {
        const lista = a.sedeId ? alarmas.filter((x) => x.sedeId === a.sedeId) : alarmas;
        const donde = a.sedeId ? ` en ${nombreSede(a.sedeId)}` : deGrupo;
        if (!lista.length) return decir(`No hay alarmas activas${donde}.`);
        const top = lista.slice(0, 5).map((x, i) => `${i + 1}. ${x.severidad === "critico" ? "Crítica" : "Advertencia"}: ${x.titulo}${x.dispositivo ? ` en ${x.dispositivo}` : ""}${a.sedeId ? "" : `, ${x.sedeNombre}`}.`);
        const resto = lista.length > 5 ? ` Y ${plural(lista.length - 5, "más", "más")}.` : "";
        return decir(`Hay ${plural(lista.length, "alarma activa", "alarmas activas")}${donde}. ${top.join(" ")}${resto} ¿Abro el centro de alertas?`, {
          label: "Abrir alertas",
          accion: { tipo: "alertas", sedeId: a.sedeId },
        });
      }
      case "fuera_de_linea": {
        const lista = (a.sedeId ? equipos.get(a.sedeId) ?? [] : [...equipos.values()].flat().filter((e) => enGrupo(e.sedeId))).filter((e) => !e.ok);
        const donde = a.sedeId ? ` en ${nombreSede(a.sedeId)}` : deGrupo || " en la red";
        if (!lista.length) return decir(`Todos los medidores${donde} están en línea.`);
        const nombres = lista.slice(0, 6).map((e) => `${e.nombre}${a.sedeId ? "" : ` de ${e.sedeNombre}`} (${e.estadoTxt.toLowerCase()})`);
        const resto = lista.length > 6 ? ` y ${plural(lista.length - 6, "otro", "otros")}` : "";
        const primero = lista[0];
        return decir(`Hay ${plural(lista.length, "medidor con problema", "medidores con problema")}${donde}: ${nombres.join(", ")}${resto}. ¿Abro ${primero.nombre}?`, {
          label: `Abrir ${primero.nombre}`,
          accion: { tipo: "equipo", equipoKey: primero.key, pestana: "equipo" },
        });
      }
      case "sin_respuesta": {
        const caidas = vista.sedes.filter((s) => s.sin_respuesta && enGrupo(s.id));
        if (!caidas.length) return decir(gid ? `Todas las sedes${deGrupo} responden.` : `Todas las sedes responden: ${vista.totales.sedes_responden} de ${vista.totales.sedes}.`);
        return decir(`${plural(caidas.length, "sede no responde", "sedes no responden")}: ${caidas.map((s) => s.nombre).join(", ")}. ¿Abro ${caidas[0].nombre}?`, {
          label: `Abrir ${caidas[0].nombre}`,
          accion: { tipo: "sede", sedeId: caidas[0].id, estado: true },
        });
      }
      case "alertas":
        ejecutar(a);
        return decir(`Abro el centro de alertas${a.sedeId ? ` de ${nombreSede(a.sedeId)}` : ""}.`);
      case "vista":
        if (a.vista === "alarmas" && !esAdmin) return decir("Alarmas y correos solo está disponible para administradores. Puedo abrirle el centro de alertas.", { label: "Abrir alertas", accion: { tipo: "alertas", sedeId: null } });
        ejecutar(a);
        return decir(`Le muestro ${VISTA_TXT[a.vista]}.`);
      case "inicio":
        ejecutar(a);
        return decir("Vuelvo al mapa de la red.");
      case "sede": {
        const s = vista.sedes.find((x) => x.id === a.sedeId);
        ejecutar(a);
        recordarSede(a.sedeId);
        if (!s) return decir(`Abro ${nombreSede(a.sedeId)}.`);
        const n = s.abiertos.length;
        const lista = equipos.get(s.id) ?? [];
        const medidores = lista.length ? `${s.medidores.ok || lista.length - s.medidores.fuera} de ${s.medidores.total || lista.length} medidores en línea` : "sin equipos todavía";
        const estado = s.sin_respuesta ? "La sede no responde en este momento." : `Está ${NIVEL_TXT[s.nivel] ?? s.nivel}, ${medidores}, ${n ? plural(n, "alarma activa", "alarmas activas") : "sin alarmas activas"}.`;
        return decir(
          `Abro ${s.nombre}. ${estado} ¿Quiere ver sus alarmas, el consumo o los equipos fuera de línea?`,
          n ? { label: "Ver sus alertas", accion: { tipo: "alertas", sedeId: s.id } } : undefined,
          atajosSede(s.nombre),
        );
      }
      case "equipo": {
        const e = [...equipos.values()].flat().find((x) => x.key === a.equipoKey);
        ejecutar(a);
        if (!e) return decir("Abro el equipo.");
        return decir(`Abro ${e.nombre} de ${e.sedeNombre}${PESTANA_TXT[a.pestana]}. Estado: ${e.estadoTxt}.`);
      }
      case "sala":
        ejecutar(a);
        return decir(a.activar ? "Activo el modo sala de control." : "Salgo del modo sala.");
      case "cerrar":
        ejecutar(a);
        return decir("Listo.");
      case "callar":
        callar();
        pendienteRef.current = null;
        return;
      case "avisos":
        setPrefs({ avisos: a.activar });
        return decir(a.activar ? "Avisos con sonido activados." : "Avisos con sonido desactivados.");
      case "desconocido":
        return decir(`Disculpe, no entendí «${a.texto}». Puede elegir una de estas opciones o decirme, por ejemplo, «¿cuánto consume Escuintla?».`, undefined, MENU);
    }
  };

  /** Procesa una frase (hablada o escrita). */
  const procesar = (frase: string) => {
    const limpia = frase.trim();
    if (!limpia) return;
    agregar("yo", limpia);
    const sinNombre = quitarDespertar(limpia);
    const orden = sinNombre ?? limpia;
    const n = normalizar(orden);
    if (pendienteRef.current && SI.has(n)) {
      const a = pendienteRef.current;
      pendienteRef.current = null;
      return responder(a);
    }
    if (pendienteRef.current && NO.has(n)) {
      pendienteRef.current = null;
      return decir("Entendido. Aquí estoy si me necesita.");
    }
    const { vista, equipos, sedeActual, esAdmin, grupos } = p.current;
    let accion = interpretar(orden, {
      grupos,
      sedes: vista.sedes.map((s) => ({ id: s.id, nombre: s.nombre })),
      equipos: [...equipos.values()].flat(),
      sedeActual,
      esAdmin,
    });
    const c = conv.current;
    // Respuesta a "¿Qué telemetría?": basta con "la dos" o "2".
    if (c.esperando === "telemetria" && accion.tipo === "desconocido") {
      const num = /\b(\d+)\b/.exec(n)?.[1];
      const g = num ? grupos.find((x) => normalizar(x.nombre).endsWith(` ${num}`)) : null;
      if (g) accion = { tipo: "grupo", grupoId: g.id };
    }
    // Seguimiento: "¿y sus alarmas?", "¿y el consumo de esa sede?" usan la sede o telemetria de la que se hablaba.
    if (usaContexto(n) && (c.sedeId || c.grupoId)) {
      const sinLugar = "sedeId" in accion && !accion.sedeId && !("grupoId" in accion && accion.grupoId);
      if (sinLugar) {
        if (accion.tipo === "alertas") accion = { tipo: "leer_alarmas", sedeId: null };
        accion = { ...accion, sedeId: c.sedeId, ...(c.grupoId ? { grupoId: c.grupoId } : {}) } as Accion;
      } else if (accion.tipo === "resumen" && c.sedeId) accion = { tipo: "sede", sedeId: c.sedeId, estado: true };
      else if (accion.tipo === "resumen" && c.grupoId) accion = { tipo: "grupo", grupoId: c.grupoId };
    }
    // Con Gravix IA activa: lo que no entiende, o las preguntas que piden razonar (por que, comparar,
    // periodos), van a Claude; abrir pantallas y las consultas conocidas siguen aqui, sin costo.
    if (iaRef.current && prefsRef.current.ia && (accion.tipo === "desconocido" || (COMPLEJA.test(n) && !SIEMPRE_LOCAL.has(accion.tipo)))) {
      void preguntarIA(orden);
      return;
    }
    responder(accion);
  };

  /* ---------- Gravix IA (opcional: solo con clave en el servidor y el interruptor "Usar IA") ---------- */
  const [iaDisponible, setIaDisponible] = useState(false);
  const iaRef = useRef(false);
  iaRef.current = iaDisponible;
  const [pensando, setPensando] = useState(false);
  useEffect(() => {
    let vivo = true;
    apiClient
      .get<{ disponible: boolean }>("/asistente/estado")
      .then((r) => vivo && setIaDisponible(!!r.data?.disponible))
      .catch(() => vivo && setIaDisponible(false));
    return () => {
      vivo = false;
    };
  }, []);

  /** Convierte la pantalla pedida por Gravix IA (por nombres) en una accion de la web. */
  const accionDeIA = (a: AccionIA): Accion | null => {
    const { vista, equipos } = p.current;
    const sedes = vista.sedes.map((s) => ({ id: s.id, nombre: s.nombre }));
    const sede = a.sede ? sedes.find((s) => s.id === a.sede) ?? buscarSede(normalizar(a.sede), sedes) : null;
    switch (a.destino) {
      case "aplicacion":
        return a.aplicacion && APP_A_PESTANA[a.aplicacion] ? { tipo: "pestana", pestana: APP_A_PESTANA[a.aplicacion] } : null;
      case "inicio":
        return { tipo: "inicio" };
      case "vista":
        return a.vista && a.vista !== "mapa" ? { tipo: "vista", vista: a.vista as VistaRed } : { tipo: "inicio" };
      case "alertas":
        return { tipo: "alertas", sedeId: sede?.id ?? null };
      case "sede":
        return sede ? { tipo: "sede", sedeId: sede.id, estado: false } : null;
      case "equipo": {
        if (!a.equipo) return sede ? { tipo: "sede", sedeId: sede.id, estado: false } : null;
        const lista = sede ? equipos.get(sede.id) ?? [] : [...equipos.values()].flat();
        const e = buscarEquipo(normalizar(a.equipo), lista);
        if (!e) return sede ? { tipo: "sede", sedeId: sede.id, estado: false } : null;
        return { tipo: "equipo", equipoKey: e.key, pestana: (a.pestana as PestanaEquipo) ?? "equipo" };
      }
    }
    return null;
  };

  const preguntarIA = async (pregunta: string) => {
    setPensando(true);
    pendienteRef.current = null;
    // Turnos anteriores en texto (la pregunta actual va aparte; el estado aun no la incluye).
    const historial = mensajesRef.current.slice(-8).map((m) => ({ rol: m.de === "yo" ? ("usuario" as const) : ("gravix" as const), texto: m.texto.slice(0, 3900) }));
    try {
      const { data } = await apiClient.post<{ respuesta: string; acciones: AccionIA[] }>(
        "/asistente/preguntar",
        { pregunta, historial, sedeActual: p.current.sedeActual ?? undefined },
        { timeout: 180_000 },
      );
      for (const a of data.acciones ?? []) {
        const nav = accionDeIA(a);
        if (!nav) continue;
        if (nav.tipo === "pestana") {
          if (p.current.pestanas.includes(nav.pestana)) p.current.irPestana(nav.pestana);
        } else p.current.ejecutar(nav);
        minimizar.current = true;
      }
      decir(data.respuesta, undefined, MENU);
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if (status === 503) {
        setIaDisponible(false);
        decir("Gravix IA no está activada en el servidor. Sigo con mi análisis propio: pida «menú» para ver lo que puedo hacer.", undefined, MENU);
      } else decir("No pude completar la consulta con la IA en este momento. Intente de nuevo, o desactive «Usar IA» para trabajar solo con el análisis propio.", undefined, MENU);
    } finally {
      setPensando(false);
    }
  };
  const procesarRef = useRef(procesar);
  procesarRef.current = procesar;

  /* ---------- microfono ---------- */
  const detener = () => {
    const r = recRef.current;
    recRef.current = null;
    try {
      r?.abort();
    } catch {
      /* nada */
    }
    setEscuchando(false);
    setParcial("");
  };

  const iniciar = async (continuo: boolean) => {
    if (!Reconocimiento) {
      setErrorMic({ texto: "Este navegador no reconoce voz. Use Chrome o Edge, o escriba la orden." });
      return;
    }
    if (!window.isSecureContext) {
      // La pagina se abrio por http: el navegador bloquea el microfono. La version segura es el puerto 5443.
      setErrorMic({
        texto: "Está usando la dirección sin seguridad (http). El navegador solo permite el micrófono en la dirección segura (https). Ábrala con el botón; la primera vez el navegador avisa del certificado: «Configuración avanzada» → «Continuar».",
        url: `https://${window.location.hostname}:5443${window.location.pathname}`,
      });
      if (continuo) setPrefs({ continua: false });
      return;
    }
    // Pide el permiso del microfono antes de escuchar: asi el error dice exactamente que pasa.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (err) {
      const n = (err as DOMException).name;
      setErrorMic({
        texto:
          n === "NotAllowedError"
            ? "El micrófono está bloqueado para esta página. Haga clic en el candado junto a la dirección → «Micrófono» → «Permitir», y recargue la página."
            : n === "NotFoundError"
              ? "No se encontró un micrófono conectado a esta computadora."
              : n === "NotReadableError"
                ? "Otro programa está usando el micrófono (Teams, Zoom...). Ciérrelo e intente de nuevo."
                : `No se pudo abrir el micrófono (${n}).`,
      });
      if (continuo) setPrefs({ continua: false });
      return;
    }
    detener();
    setErrorMic(null);
    const r = new Reconocimiento();
    r.lang = IDIOMA;
    r.continuous = continuo;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      let interino = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res[0].transcript;
        if (!res.isFinal) {
          interino += t;
          continue;
        }
        if (!continuo) {
          procesarRef.current(t);
          continue;
        }
        // Escucha continua: solo frases que empiezan con "Gravix" (o justo despues de llamarlo).
        if (speechSynthesis?.speaking) continue; // no escucharse a si mismo
        const resto = quitarDespertar(t);
        if (resto !== null) {
          if (resto) procesarRef.current(t);
          else {
            atentoHasta.current = Date.now() + 8000;
            pitido(false);
            setAbierto(true);
          }
        } else if (Date.now() < atentoHasta.current) {
          atentoHasta.current = 0;
          procesarRef.current(t);
        }
      }
      setParcial(interino);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setErrorMic({ texto: "El navegador no permitió el reconocimiento de voz. Haga clic en el candado junto a la dirección → «Micrófono» → «Permitir», y recargue la página." });
        setPrefs({ continua: false });
        recRef.current = null;
      } else if (e.error === "network") {
        setErrorMic({ texto: "El reconocimiento de voz de Chrome/Edge necesita internet en esta computadora y no lo encontró. Puede escribir la orden." });
      } else if (e.error === "audio-capture") {
        setErrorMic({ texto: "No se encontró un micrófono." });
      } else if (e.error === "language-not-supported") {
        setErrorMic({ texto: "El navegador no reconoce voz en español. Actualice Chrome o Edge." });
      }
    };
    r.onend = () => {
      setParcial("");
      if (recRef.current !== r) return;
      if (continuo && prefsRef.current.continua) {
        window.setTimeout(() => {
          if (recRef.current === r) {
            try {
              r.start();
            } catch {
              /* ya estaba escuchando */
            }
          }
        }, 300);
      } else {
        recRef.current = null;
        setEscuchando(false);
      }
    };
    recRef.current = r;
    try {
      r.start();
      setEscuchando(true);
    } catch {
      recRef.current = null;
      setEscuchando(false);
    }
  };

  const pulsarMic = () => {
    if (escuchando && !prefs.continua) return detener();
    callar();
    iniciar(false);
  };

  useEffect(() => {
    if (prefs.continua) iniciar(true);
    else if (recRef.current?.continuous) detener();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.continua]);
  useEffect(() => () => detener(), []);

  /* ---------- avisos de alarmas criticas nuevas ---------- */
  const vistos = useRef<Set<string> | null>(null);
  const codigos = props.alarmas.map((a) => a.codigo).join("|");
  useEffect(() => {
    const crit = p.current.alarmas.filter((a) => a.severidad === "critico");
    if (!vistos.current) {
      vistos.current = new Set(p.current.alarmas.map((a) => a.codigo));
      return;
    }
    const nuevas = crit.filter((a) => !vistos.current!.has(a.codigo));
    vistos.current = new Set(p.current.alarmas.map((a) => a.codigo));
    if (!nuevas.length) return;
    const a = nuevas[0];
    const t =
      nuevas.length === 1
        ? `Atención: alarma crítica en ${a.sedeNombre}. ${a.titulo}${a.dispositivo ? ` en ${a.dispositivo}` : ""}.`
        : `Atención: ${nuevas.length} alarmas críticas nuevas. La primera en ${a.sedeNombre}: ${a.titulo}.`;
    const accion: Accion = { tipo: "alertas", sedeId: nuevas.length === 1 ? a.sedeId : null };
    if (prefsRef.current.avisos) pitido(true);
    setGlobo({ texto: t, accion });
    agregar("gravix", t, { label: "Ver alerta", accion });
    pendienteRef.current = accion;
    hablar(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codigos]);
  useEffect(() => {
    if (!globo) return;
    const id = window.setTimeout(() => setGlobo(null), 25_000);
    return () => window.clearTimeout(id);
  }, [globo]);

  const abrirPanel = () => {
    const abrir = !abierto;
    abiertoRef.current = abrir;
    setAbierto(abrir);
    setGlobo(null);
    if (abrir && mensajes.length === 0) responder({ tipo: "saludo" });
  };

  // Bienvenida: al entrar (una vez por sesion del navegador) Gravix abre su panel, saluda segun la hora
  // y pregunta que desea hacer. Espera unos segundos a que llegue la analitica para incluir su aviso.
  // La voz suena en cuanto el navegador lo permite (primer clic o tecla en la pagina).
  useEffect(() => {
    let visto = false;
    try {
      visto = sessionStorage.getItem("gravix.bienvenida") === "1";
      sessionStorage.setItem("gravix.bienvenida", "1");
    } catch {
      /* sin almacenamiento: se saluda igual */
    }
    if (visto) return;
    const id = window.setTimeout(() => {
      abiertoRef.current = true;
      setAbierto(true);
      setGlobo(null);
      setMensajes((m) => {
        if (!m.length) window.setTimeout(() => responder({ tipo: "saludo" }), 0);
        return m;
      });
    }, 2500);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enviar = (e: React.FormEvent) => {
    e.preventDefault();
    callar();
    procesar(texto);
    setTexto("");
  };

  const estadoOrbe = escuchando ? "escuchando" : hablando ? "hablando" : "";
  const sinVoz = !Reconocimiento;

  return (
    <div className="gravix-asistente cm">
      {globo && !abierto && globo.aviso && (
        // Respuesta de Gravix con el panel minimizado: se ve lo que abrio y se puede volver a hablar.
        <div role="status" className="gx-globo gx-globo-info">
          <p className="text-[13px] leading-snug text-slate-100">{escuchando ? (parcial ? `${parcial}…` : "Escuchando…") : globo.texto}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={pulsarMic} className={`flex min-h-[32px] items-center gap-1.5 rounded-lg px-3 text-xs font-bold text-white ${escuchando ? "bg-rose-600 gx-pulso" : "bg-sky-600 hover:bg-sky-500"}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
              </svg>
              {escuchando ? "Escuchando" : "Hablar"}
            </button>
            <button type="button" onClick={() => { setGlobo(null); abiertoRef.current = true; setAbierto(true); }} className="min-h-[32px] rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-200 hover:bg-slate-800">Ver conversación</button>
            <button type="button" onClick={() => { setGlobo(null); callar(); }} aria-label="Cerrar" className="min-h-[32px] rounded-lg px-2 text-xs text-slate-400 hover:bg-slate-800">✕</button>
          </div>
        </div>
      )}
      {globo && !abierto && !globo.aviso && (
        <div role={globo.bienvenida ? "status" : "alert"} className={globo.bienvenida ? "gx-globo gx-globo-info" : "gx-globo"}>
          <p className="text-[13px] leading-snug text-slate-100">{globo.texto}</p>
          <div className="mt-2 flex gap-2">
            {globo.bienvenida ? (
              <button type="button" onClick={abrirPanel} className="min-h-[32px] rounded-lg bg-sky-600 px-3 text-xs font-bold text-white hover:bg-sky-500">Sí, ayúdame</button>
            ) : (
              <button type="button" onClick={() => { if (globo.accion) p.current.ejecutar(globo.accion); setGlobo(null); }} className="min-h-[32px] rounded-lg bg-rose-600 px-3 text-xs font-bold text-white hover:bg-rose-500">Ver</button>
            )}
            <button type="button" onClick={() => { setGlobo(null); callar(); }} className="min-h-[32px] rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-300 hover:bg-slate-800">{globo.bienvenida ? "Ahora no" : "Después"}</button>
          </div>
        </div>
      )}

      {abierto && (
        <section aria-label="Asistente Gravix" className="gx-panel">
          <header className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
            <span className={`gx-orbe gx-orbe-mini ${estadoOrbe}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <strong className="flex items-center gap-1.5 text-sm tracking-wide text-slate-50">
                GRAVIX
                {iaDisponible && prefs.ia && <span title="Preguntas libres con IA activadas" className="rounded bg-sky-900 px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider text-sky-200">IA</span>}
              </strong>
              <span className="text-[11px] text-slate-400">
                {pensando && "Consultando los datos… "}
                {escuchando
                  ? prefs.continua
                    ? "Escucha continua · diga «Gravix…»"
                    : "Escuchando…"
                  : hablando
                    ? "Hablando…"
                    : analitica.data
                      ? `Analizando ${analitica.data.equiposAnalizados} equipos · ${analitica.data.resumen.alto} riesgos altos`
                      : "Su asistente de Nodivo-SIASA"}
              </span>
            </div>
            {hablando && (
              <button type="button" onClick={callar} className="rounded-md px-2 py-1 text-xs text-slate-300 hover:bg-slate-800" title="Dejar de hablar">Silencio</button>
            )}
            <button type="button" onClick={() => setAbierto(false)} aria-label="Cerrar Gravix" className="grid h-8 w-8 place-items-center rounded-lg text-slate-300 hover:bg-slate-800">✕</button>
          </header>

          <div ref={listaRef} className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-3" aria-live="polite">
            {mensajes.map((m) => (
              <div key={m.id} className={m.de === "yo" ? "gx-msg gx-yo" : "gx-msg gx-el"}>
                <p>{m.texto}</p>
                {m.tarjetas?.map((h, i) => (
                  <TarjetaRiesgo
                    key={h.id}
                    h={h}
                    n={i + 1}
                    onAbrir={() => { callar(); p.current.ejecutar(accionDeHallazgo(h)); }}
                    onDetalle={() => { callar(); ultimosRiesgos.current = m.tarjetas!; procesar(`Explícame el ${i + 1}`); }}
                  />
                ))}
                {m.boton && (
                  <button type="button" onClick={() => { callar(); responder(m.boton!.accion); }} className="mt-2 min-h-[30px] rounded-lg bg-sky-600 px-3 text-xs font-bold text-white hover:bg-sky-500">
                    {m.boton.label}
                  </button>
                )}
              </div>
            ))}
            {parcial && <div className="gx-msg gx-yo opacity-60"><p>{parcial}…</p></div>}
            {pensando && <div className="gx-msg gx-el"><p className="gx-pensando">Consultando con la IA<span>.</span><span>.</span><span>.</span></p></div>}
          </div>

          {/* Atajos en una sola fila desplazable: la conversacion conserva el espacio. */}
          <div className="gx-atajos flex gap-1.5 overflow-x-auto px-4 pb-2 pt-1">
            {sugerencias.map((s) => (
              <button key={s} type="button" onClick={() => { callar(); procesar(s); }} className="shrink-0 whitespace-nowrap rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11.5px] text-slate-300 hover:border-sky-600 hover:text-white">{s}</button>
            ))}
          </div>

          {errorMic && (
            <div className="mx-4 mb-2 rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-[12px] text-amber-200">
              <p>{errorMic.texto}</p>
              {errorMic.url && (
                <a href={errorMic.url} className="mt-2 inline-flex min-h-[30px] items-center rounded-lg bg-amber-500 px-3 text-xs font-bold text-slate-950 hover:bg-amber-400">
                  Abrir la dirección segura (micrófono)
                </a>
              )}
            </div>
          )}

          <form onSubmit={enviar} className="flex items-center gap-2 border-t border-slate-800 px-3 py-3">
            <button
              type="button"
              onClick={pulsarMic}
              disabled={sinVoz}
              aria-pressed={escuchando}
              aria-label={escuchando ? "Dejar de escuchar" : "Hablar con Gravix"}
              title={sinVoz ? "Este navegador no reconoce voz (use Chrome o Edge)" : "Hablar"}
              className={`grid h-11 w-11 shrink-0 place-items-center rounded-full border ${escuchando ? "border-rose-500 bg-rose-600 text-white gx-pulso" : "border-slate-700 bg-slate-900 text-slate-100 hover:border-sky-500"} disabled:opacity-40`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
              </svg>
            </button>
            <input
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Escriba o hable: «abre Escuintla»"
              aria-label="Orden para Gravix"
              className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            />
            <button type="submit" className="min-h-[44px] rounded-xl bg-sky-600 px-3 text-sm font-bold text-white hover:bg-sky-500">Ir</button>
          </form>

          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-800 px-4 py-2 text-[11.5px] text-slate-400">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={prefs.voz} onChange={(e) => { setPrefs({ voz: e.target.checked }); if (!e.target.checked) callar(); }} /> Voz de Gravix</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={prefs.avisos} onChange={(e) => setPrefs({ avisos: e.target.checked })} /> Avisos con sonido</label>
            <label className="flex items-center gap-1.5" title="Escucha siempre y responde cuando la frase empieza con «Gravix»">
              <input type="checkbox" checked={prefs.continua} disabled={sinVoz} onChange={(e) => setPrefs({ continua: e.target.checked })} /> Escucha continua
            </label>
            {iaDisponible && (
              <label className="flex items-center gap-1.5" title="Desactivado: Gravix trabaja solo con su análisis propio, sin usar la IA">
                <input
                  type="checkbox"
                  checked={prefs.ia}
                  onChange={(e) => {
                    setPrefs({ ia: e.target.checked });
                    decir(e.target.checked ? "IA activada: las preguntas libres las respondo con la inteligencia artificial." : "IA desactivada: trabajo solo con mi análisis propio.", undefined, MENU);
                  }}
                />{" "}
                Usar IA
              </label>
            )}
            {voces.length > 0 && (
              <div className="flex w-full items-center gap-2 pt-1">
                <label htmlFor="gx-voz" className="shrink-0">Voz</label>
                <select
                  id="gx-voz"
                  value={vozActual?.name ?? ""}
                  onChange={(e) => {
                    setPrefs({ vozNombre: e.target.value || null });
                    prefsRef.current = { ...prefsRef.current, vozNombre: e.target.value || null };
                    hablar("Buenos días. Soy Gravix, asistente del Centro de mando.", true);
                  }}
                  className="min-h-[30px] min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 text-[11.5px] text-slate-200"
                >
                  {[...voces].sort((x, y) => puntaje(y) - puntaje(x)).map((v) => (
                    <option key={v.name} value={v.name}>{v.name.replace(/^Microsoft\s+/, "").replace(/\s*-\s*Spanish.*$/i, "")} · {v.lang}</option>
                  ))}
                </select>
                <button type="button" onClick={() => hablar("Buenos días. Soy Gravix, asistente del Centro de mando.", true)} className="shrink-0 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800">Probar</button>
              </div>
            )}
          </div>
        </section>
      )}

      <button type="button" onClick={abrirPanel} aria-label={abierto ? "Ocultar Gravix" : "Abrir Gravix, asistente del Centro de mando"} title="Gravix · asistente de voz" className={`gx-orbe ${estadoOrbe} ${props.alarmas.some((a) => a.severidad === "critico") ? "alerta" : ""}`}>
        <span className="gx-letra">G</span>
      </button>
    </div>
  );
}

/** Tarjeta de un riesgo: nivel, probabilidad, mini grafica de los ultimos dias y acciones. */
export function TarjetaRiesgo({ h, n, onAbrir, onDetalle }: { h: HallazgoRiesgo; n: number; onAbrir: () => void; onDetalle: () => void }) {
  const color = NIVEL_COLOR[h.nivel];
  const vals = h.serie?.valores ?? [];
  const nums = vals.filter((v): v is number => v != null);
  const min = nums.length ? Math.min(...nums) : 0;
  const max = nums.length ? Math.max(...nums) : 1;
  const W = 120;
  const H = 30;
  const puntos = vals
    .map((v, i) => (v == null ? null : `${(i / Math.max(1, vals.length - 1)) * W},${H - 3 - ((v - min) / (max - min || 1)) * (H - 6)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <div className="gx-tarjeta" style={{ borderLeftColor: color }}>
      <div className="flex items-start gap-2">
        <span className="mono mt-0.5 text-[11px] text-slate-500">{n}</span>
        <div className="min-w-0 flex-1">
          <b className="block text-[12.5px] leading-snug text-slate-50">{h.titulo}</b>
          <span className="text-[11px] text-slate-400">{h.sedeNombre}{h.inventario ? ` · ${h.inventario}` : ""}</span>
        </div>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-extrabold" style={{ background: `${color}22`, color }}>{NIVEL_NOMBRE[h.nivel]}</span>
      </div>
      {h.probabilidad != null && (
        <div className="mt-2">
          <div className="flex justify-between text-[10.5px] text-slate-400">
            <span>Probabilidad en 7 días</span>
            <b style={{ color }}>{Math.round(h.probabilidad * 100)} %</b>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full rounded-full" style={{ width: `${Math.max(4, Math.round(h.probabilidad * 100))}%`, background: color }} />
          </div>
        </div>
      )}
      {h.serie && nums.length > 1 && (
        <div className="mt-2 flex items-center gap-2">
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${h.serie.etiqueta}: de ${nums[0]} a ${nums[nums.length - 1]} ${h.serie.unidad}`}>
            <polyline points={puntos} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          <span className="text-[10.5px] leading-tight text-slate-400">
            {h.serie.etiqueta}
            <br />
            <b className="text-slate-200">{nums[nums.length - 1]} {h.serie.unidad}</b> hoy
          </span>
        </div>
      )}
      <div className="mt-2 flex gap-1.5">
        <button type="button" onClick={onDetalle} className="min-h-[28px] rounded-md border border-slate-700 px-2.5 text-[11px] font-semibold text-slate-200 hover:bg-slate-800">¿Por qué?</button>
        <button type="button" onClick={onAbrir} className="min-h-[28px] rounded-md bg-sky-700 px-2.5 text-[11px] font-bold text-white hover:bg-sky-600">{h.equipo ? "Ver equipo" : "Ver sede"}</button>
      </div>
    </div>
  );
}
