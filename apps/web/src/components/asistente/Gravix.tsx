import { useEffect, useRef, useState } from "react";
import type { CentroVista } from "../../api/centro";
import { buscarEquipo, buscarSede, interpretar, normalizar, quitarDespertar, SUGERENCIAS, type Accion, type PestanaEquipo, type VistaRed } from "./comandos";
import { apiClient } from "../../api/client";

/** Pantalla que pide Gravix IA (por nombres; la web la resuelve a sus ids). */
interface AccionIA {
  destino: "inicio" | "vista" | "sede" | "equipo" | "alertas";
  vista?: string;
  sede?: string;
  equipo?: string;
  pestana?: string;
}

/** Preguntas de analisis (consumo, historial, comparaciones, por que...): con IA activada van a Gravix IA. */
const ANALITICA =
  /\b(mes|semana|semanas|ayer|anoche|hoy|horas?|dias?|historial|historico|consumo|consumio|consume|kw|kwh|potencia|voltaje|tension|corriente|promedio|maximo|minimo|pico|compara|comparar|comparacion|por que|porque|cuando|tendencia|energia|factor|thd|armonicos|frecuencia|explica|explicame|analiza|analisis|cuanto|cuanta|mayor|menor|peor|mejor|mas|menos|ultimo|ultima|ultimos|ultimas)\b/;
const esAnalitica = (n: string) => ANALITICA.test(n);
import "./gravix-asistente.css";

/**
 * Gravix: asistente de voz del Centro de mando (fase 1, sin IA).
 *  - Escucha (reconocimiento de voz del navegador) o lee lo que se escribe, entiende la frase con
 *    comandos.ts y lleva a la pantalla pedida; responde hablando (voces del sistema) y por escrito.
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
}
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
  /** Ejecuta la navegacion en el Centro de mando. */
  ejecutar: (a: Accion) => void;
}

interface Mensaje {
  id: number;
  de: "yo" | "gravix";
  texto: string;
  boton?: { label: string; accion: Accion };
}

interface Prefs {
  voz: boolean;
  avisos: boolean;
  continua: boolean;
  /** Nombre de la voz elegida (null = la recomendada). */
  vozNombre: string | null;
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
const PREFS_INI: Prefs = { voz: true, avisos: true, continua: false, vozNombre: null };
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
  const [errorMic, setErrorMic] = useState<string | null>(null);
  const [globo, setGlobo] = useState<{ texto: string; accion: Accion } | null>(null);

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
    try {
      speechSynthesis.cancel();
    } catch {
      /* nada */
    }
    setHablando(false);
  };

  const agregar = (de: Mensaje["de"], t: string, boton?: Mensaje["boton"]) =>
    setMensajes((m) => [...m.slice(-40), { id: ++idRef.current, de, texto: t, boton }]);

  const decir = (t: string, boton?: Mensaje["boton"]) => {
    agregar("gravix", t, boton);
    pendienteRef.current = boton?.accion ?? null;
    hablar(t);
  };

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
    const { vista, equipos, alarmas: todas, esAdmin, ejecutar, grupos, grupoDe } = p.current;
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
      let f = `${nombreGrupo(id)}: ${plural(sedes.length, "sede", "sedes")}, ${responden} responden, ${eqs.filter((e) => e.ok).length} de ${eqs.length} medidores en línea, ${plural(crit, "crítica", "críticas")} y ${plural(al.length - crit, "advertencia", "advertencias")}.`;
      if (detalle) {
        f += ` Sedes: ${sedes.map((s) => s.nombre).join(", ")}.`;
        const problemas = sedes.filter((s) => s.sin_respuesta || s.nivel !== "ok");
        if (problemas.length) f += ` Con novedades: ${problemas.map((s) => `${s.nombre} (${NIVEL_TXT[s.nivel] ?? s.nivel})`).join(", ")}.`;
      }
      return f;
    };
    switch (a.tipo) {
      case "grupo": {
        if (a.grupoId) {
          ejecutar({ tipo: "inicio" });
          const conAlarmas = alarmas.length;
          return decir(frasaGrupo(a.grupoId, true), conAlarmas ? { label: "Ver sus alarmas", accion: { tipo: "leer_alarmas", sedeId: null, grupoId: a.grupoId } } : undefined);
        }
        const ids = [...grupos.map((g) => g.id as string | null), ...(vista.sedes.some((s) => !grupoDe(s.id)) ? [null] : [])];
        if (!ids.length) return decir("Todavía no hay telemetrías configuradas.");
        return decir(`Estado por telemetría. ${ids.map((id) => frasaGrupo(id, false)).join(" ")}`);
      }
      case "saludo": {
        const e = estadoRed();
        return decir(`Hola, soy Gravix. ${e.texto.endsWith("?") ? e.texto : `${e.texto} ¿Qué necesita hacer en el Centro de mando?`}`, e.boton);
      }
      case "ayuda":
        return decir(
          "Puedo llevarlo a cualquier parte del Centro de mando y decirle cómo está la red. Diga, por ejemplo: «resumen», «qué alarmas hay», «qué medidores están fuera de línea», «qué sedes no responden», «abre Escuintla», «cómo está Cobán», «alarmas de Escuintla», «ranking de sedes», «predicción», «abre el TR 1 en tendencias», «modo sala» o «cerrar». Para que lo escuche sin tocar el botón, active la escucha continua y empiece con «Gravix».",
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
        if (!s) return decir(`Abro ${nombreSede(a.sedeId)}.`);
        const n = s.abiertos.length;
        const lista = equipos.get(s.id) ?? [];
        const medidores = lista.length ? `${s.medidores.ok || lista.length - s.medidores.fuera} de ${s.medidores.total || lista.length} medidores en línea` : "sin equipos todavía";
        const estado = s.sin_respuesta ? "La sede no responde en este momento." : `Está ${NIVEL_TXT[s.nivel] ?? s.nivel}, ${medidores}, ${n ? plural(n, "alarma activa", "alarmas activas") : "sin alarmas activas"}.`;
        return decir(`Abro ${s.nombre}. ${estado}`, n ? { label: "Ver sus alertas", accion: { tipo: "alertas", sedeId: s.id } } : undefined);
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
        return decir(`No entendí «${a.texto}». Pruebe con «resumen», «abre Escuintla», «alarmas» o pida «ayuda».`);
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
    const accion = interpretar(orden, {
      grupos,
      sedes: vista.sedes.map((s) => ({ id: s.id, nombre: s.nombre })),
      equipos: [...equipos.values()].flat(),
      sedeActual,
      esAdmin,
    });
    // Preguntas libres o de analisis van a Gravix IA (si esta activada); las ordenes fijas se resuelven aqui.
    if (iaRef.current && (accion.tipo === "desconocido" || esAnalitica(n))) return void preguntarIA(orden);
    responder(accion);
  };

  /* ---------- Gravix IA (fase 2: preguntas libres, solo lectura) ---------- */
  const [ia, setIa] = useState(false);
  const iaRef = useRef(false);
  iaRef.current = ia;
  const [pensando, setPensando] = useState(false);
  useEffect(() => {
    let vivo = true;
    apiClient
      .get<{ disponible: boolean }>("/asistente/estado")
      .then((r) => vivo && setIa(!!r.data?.disponible))
      .catch(() => vivo && setIa(false));
    return () => {
      vivo = false;
    };
  }, []);

  const preguntarIA = async (pregunta: string) => {
    setPensando(true);
    pendienteRef.current = null;
    // Turnos anteriores (la pregunta actual va aparte; el estado aun no la incluye).
    const historial = mensajesRef.current
      .slice(-8)
      .map((m) => ({ rol: m.de === "yo" ? ("usuario" as const) : ("gravix" as const), texto: m.texto.slice(0, 3900) }));
    try {
      const { data } = await apiClient.post<{ respuesta: string; acciones: AccionIA[] }>(
        "/asistente/preguntar",
        { pregunta, historial, sedeActual: p.current.sedeActual ?? undefined },
        { timeout: 180_000 },
      );
      for (const a of data.acciones ?? []) {
        const nav = accionDeIA(a);
        if (nav) p.current.ejecutar(nav);
      }
      decir(data.respuesta);
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if (status === 503) {
        setIa(false);
        decir("Gravix IA no está activado en este servidor. Puedo ayudarle con las órdenes del Centro de mando: pida «ayuda» para verlas.");
      } else decir("No pude completar la consulta en este momento. Intente de nuevo en unos segundos.");
    } finally {
      setPensando(false);
    }
  };

  /** Convierte la pantalla pedida por Gravix IA (por nombres) en una accion de la web. */
  const accionDeIA = (a: AccionIA): Accion | null => {
    const { vista, equipos } = p.current;
    const sedes = vista.sedes.map((s) => ({ id: s.id, nombre: s.nombre }));
    const sede = a.sede ? sedes.find((s) => s.id === a.sede) ?? buscarSede(normalizar(a.sede), sedes) : null;
    switch (a.destino) {
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

  const iniciar = (continuo: boolean) => {
    if (!Reconocimiento) {
      setErrorMic("Este navegador no reconoce voz. Use Chrome o Edge, o escriba la orden.");
      return;
    }
    if (!window.isSecureContext) {
      setErrorMic("El navegador solo permite el micrófono en HTTPS o en localhost. Puede escribir la orden mientras tanto.");
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
        setErrorMic("No hay permiso para usar el micrófono. Revise el permiso del sitio en el navegador.");
        setPrefs({ continua: false });
        recRef.current = null;
      } else if (e.error === "network") {
        setErrorMic("El reconocimiento de voz del navegador necesita internet. Puede escribir la orden.");
      } else if (e.error === "audio-capture") {
        setErrorMic("No se encontró un micrófono.");
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
    setAbierto((x) => !x);
    setGlobo(null);
    if (!abierto && mensajes.length === 0) responder({ tipo: "saludo" });
  };

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
      {globo && !abierto && (
        <div role="alert" className="gx-globo">
          <p className="text-[13px] leading-snug text-slate-100">{globo.texto}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => { p.current.ejecutar(globo.accion); setGlobo(null); }} className="min-h-[32px] rounded-lg bg-rose-600 px-3 text-xs font-bold text-white hover:bg-rose-500">Ver</button>
            <button type="button" onClick={() => { setGlobo(null); callar(); }} className="min-h-[32px] rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-300 hover:bg-slate-800">Después</button>
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
                {ia && <span title="Preguntas libres con IA activadas" className="rounded bg-sky-900 px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider text-sky-200">IA</span>}
              </strong>
              <span className="text-[11px] text-slate-400">
                {pensando ? "Consultando los datos…" : escuchando ? (prefs.continua ? "Escucha continua · diga «Gravix…»" : "Escuchando…") : hablando ? "Hablando…" : ia ? "Pregúnteme lo que necesite" : "Asistente del Centro de mando"}
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
                {m.boton && (
                  <button type="button" onClick={() => { callar(); responder(m.boton!.accion); }} className="mt-2 min-h-[30px] rounded-lg bg-sky-600 px-3 text-xs font-bold text-white hover:bg-sky-500">
                    {m.boton.label}
                  </button>
                )}
              </div>
            ))}
            {parcial && <div className="gx-msg gx-yo opacity-60"><p>{parcial}…</p></div>}
            {pensando && <div className="gx-msg gx-el"><p className="gx-pensando">Consultando los datos de las sedes<span>.</span><span>.</span><span>.</span></p></div>}
          </div>

          <div className="flex flex-wrap gap-1.5 px-4 pb-2">
            {SUGERENCIAS.map((s) => (
              <button key={s} type="button" onClick={() => { callar(); procesar(s); }} className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11.5px] text-slate-300 hover:border-sky-600 hover:text-white">{s}</button>
            ))}
          </div>

          {errorMic && <p className="mx-4 mb-2 rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-[12px] text-amber-200">{errorMic}</p>}

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
              placeholder={ia ? "Pregunte: «¿qué sede consumió más hoy?»" : "Escriba o hable: «abre Escuintla»"}
              aria-label="Orden para Gravix"
              className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            />
            <button type="submit" disabled={pensando} className="min-h-[44px] rounded-xl bg-sky-600 px-3 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-50">Ir</button>
          </form>

          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-800 px-4 py-2 text-[11.5px] text-slate-400">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={prefs.voz} onChange={(e) => { setPrefs({ voz: e.target.checked }); if (!e.target.checked) callar(); }} /> Voz de Gravix</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={prefs.avisos} onChange={(e) => setPrefs({ avisos: e.target.checked })} /> Avisos con sonido</label>
            <label className="flex items-center gap-1.5" title="Escucha siempre y responde cuando la frase empieza con «Gravix»">
              <input type="checkbox" checked={prefs.continua} disabled={sinVoz} onChange={(e) => setPrefs({ continua: e.target.checked })} /> Escucha continua
            </label>
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
