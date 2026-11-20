/**
 * Gravix · motor de comandos (fase 1, sin IA): convierte una frase en español en una accion del
 * Centro de mando. Todo corre en el navegador; no llama a ningun servicio externo.
 * Solo navega y lee: ninguna accion envia comandos a los equipos.
 */

export type VistaRed = "mapa" | "incidentes" | "ranking" | "normas" | "prediccion" | "alarmas";
export type PestanaEquipo = "equipo" | "tendencias" | "calidad" | "comparativo" | "alarmas" | "bitacora" | "info";

export interface SedeRef {
  id: string;
  nombre: string;
}
export interface EquipoRef {
  key: string;
  sedeId: string;
  nombre: string;
  inventario: string | null;
}

export type Accion =
  | { tipo: "ayuda" }
  | { tipo: "resumen" }
  | { tipo: "contar_alarmas"; sedeId: string | null; grupoId?: string | null }
  | { tipo: "leer_alarmas"; sedeId: string | null; grupoId?: string | null }
  | { tipo: "fuera_de_linea"; sedeId: string | null; grupoId?: string | null }
  | { tipo: "sin_respuesta"; grupoId?: string | null }
  /** Estado de una telemetria (grupo de sedes) o, con null, de todas comparadas. */
  | { tipo: "grupo"; grupoId: string | null }
  | { tipo: "alertas"; sedeId: string | null }
  | { tipo: "vista"; vista: VistaRed }
  | { tipo: "inicio" }
  | { tipo: "sede"; sedeId: string; estado: boolean }
  | { tipo: "equipo"; equipoKey: string; pestana: PestanaEquipo }
  | { tipo: "sala"; activar: boolean }
  | { tipo: "cerrar" }
  | { tipo: "callar" }
  | { tipo: "avisos"; activar: boolean }
  | { tipo: "saludo" }
  /** Dialogo: menu de opciones, pedir la sede o la telemetria que falta, cortesias. */
  | { tipo: "menu" }
  | { tipo: "pedir_sede" }
  | { tipo: "pedir_telemetria" }
  | { tipo: "gracias" }
  | { tipo: "adios" }
  /** Potencia actual (kW) de una sede, una telemetria o toda la red. */
  | { tipo: "consumo"; sedeId: string | null; grupoId?: string | null }
  /** Generadores en marcha y sedes alimentadas por generador. */
  | { tipo: "generadores"; sedeId: string | null; grupoId?: string | null }
  | { tipo: "desconocido"; texto: string };

/** Palabra para despertar a Gravix y como suele oirla el reconocedor de voz. */
const DESPERTAR = /\b(?:oye\s+|hola\s+|ok\s+)?(?:gravix|gravis|grabix|grabis|gravic|graviks|gravi|grávix)\b[,.:]?\s*/;

const NUMEROS: Record<string, string> = {
  uno: "1", una: "1", primero: "1", primer: "1", dos: "2", segundo: "2", tres: "3", tercero: "3", cuatro: "4", cinco: "5",
  seis: "6", siete: "7", ocho: "8", nueve: "9", diez: "10",
};

/** Minusculas, sin tildes ni signos, numeros hablados a digitos. */
export function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUMEROS[w] ?? w)
    .join(" ")
    // "tr 1" y "tr1" se tratan igual
    .replace(/([a-z])\s?(\d)/g, "$1 $2");
}

/** Si la frase menciona a Gravix, devuelve lo que viene despues; si no, null. */
export function quitarDespertar(texto: string): string | null {
  const t = texto.toLowerCase();
  const m = DESPERTAR.exec(t);
  if (!m) return null;
  return texto.slice(m.index + m[0].length).trim();
}

const tiene = (t: string, ...pal: string[]) => pal.some((p) => new RegExp(`\\b${p}\\b`).test(t));

/** Sede mencionada en la frase (por nombre completo, id o palabra distintiva del nombre). */
export function buscarSede(t: string, sedes: SedeRef[]): SedeRef | null {
  let mejor: { s: SedeRef; largo: number } | null = null;
  for (const s of sedes) {
    const candidatos = new Set<string>([normalizar(s.nombre), normalizar(s.id.replace(/[-_]/g, " "))]);
    // "Hospital de Escuintla" -> "escuintla"; "La Gomera" -> "gomera"
    for (const w of normalizar(s.nombre).split(" ")) if (w.length >= 5) candidatos.add(w);
    for (const c of candidatos) {
      if (c && new RegExp(`\\b${c}\\b`).test(t) && (!mejor || c.length > mejor.largo)) mejor = { s, largo: c.length };
    }
  }
  return mejor?.s ?? null;
}

/** Equipo mencionado: todas las palabras de su nombre (o su inventario) aparecen en la frase. */
export function buscarEquipo(t: string, equipos: EquipoRef[]): EquipoRef | null {
  let mejor: { e: EquipoRef; largo: number } | null = null;
  for (const e of equipos) {
    for (const c of [e.nombre, e.inventario].filter((x): x is string => !!x).map(normalizar)) {
      const pal = c.split(" ").filter(Boolean);
      if (pal.length && pal.every((p) => new RegExp(`\\b${p}\\b`).test(t)) && (!mejor || c.length > mejor.largo)) mejor = { e, largo: c.length };
    }
  }
  return mejor?.e ?? null;
}

function pestanaDe(t: string): PestanaEquipo | null {
  if (tiene(t, "tendencia", "tendencias", "grafica", "graficas", "historial", "historico")) return "tendencias";
  if (tiene(t, "calidad", "armonicos", "armonico", "thd")) return "calidad";
  if (tiene(t, "comparativo", "comparar", "compara", "directo")) return "comparativo";
  if (tiene(t, "bitacora")) return "bitacora";
  if (tiene(t, "informacion", "info", "datos del equipo")) return "info";
  if (tiene(t, "alarma", "alarmas", "alerta", "alertas", "correos")) return "alarmas";
  return null;
}

/** Telemetria (grupo de sedes: Telemetria 1, 2, 3...) mencionada por su nombre. */
export function buscarGrupo(t: string, grupos: SedeRef[]): SedeRef | null {
  let mejor: { g: SedeRef; largo: number } | null = null;
  for (const g of grupos) {
    const c = normalizar(g.nombre);
    if (c && new RegExp(`\\b${c}\\b`).test(t) && (!mejor || c.length > mejor.largo)) mejor = { g, largo: c.length };
  }
  return mejor?.g ?? null;
}

export interface Contexto {
  /** Telemetrias (grupos de sedes). */
  grupos?: SedeRef[];
  sedes: SedeRef[];
  equipos: EquipoRef[];
  /** Sede abierta ahora (para "abre el TR 1" sin decir la sede). */
  sedeActual: string | null;
  esAdmin: boolean;
}

/** Interpreta una frase (ya sin la palabra "Gravix"). */
export function interpretar(frase: string, ctx: Contexto): Accion {
  const t = normalizar(frase);
  if (!t) return { tipo: "saludo" };

  if (tiene(t, "silencio", "callate", "calla", "basta", "para de hablar", "deja de hablar")) return { tipo: "callar" };
  if (tiene(t, "ayuda", "comandos", "que sabes hacer")) return { tipo: "ayuda" };
  if (tiene(t, "menu", "opciones", "que puedes hacer", "que puedo hacer", "que hago", "que me recomiendas", "ayudame", "en que me ayudas")) return { tipo: "menu" };
  if (tiene(t, "gracias", "muchas gracias", "te agradezco", "perfecto gracias")) return { tipo: "gracias" };
  if (tiene(t, "adios", "hasta luego", "hasta pronto", "nos vemos", "eso es todo", "nada mas")) return { tipo: "adios" };
  if (/\b(silencia|silenciar|desactiva|desactivar|apaga|apagar|quita|quitar)\b.*\b(aviso|avisos|sonido|sonidos)\b/.test(t)) return { tipo: "avisos", activar: false };
  if (/\b(activa|activar|enciende|encender|pon|poner)\b.*\b(aviso|avisos|sonido|sonidos)\b/.test(t)) return { tipo: "avisos", activar: true };

  if (tiene(t, "sala de control", "modo sala")) return { tipo: "sala", activar: !tiene(t, "sal", "salir", "quita", "quitar", "cierra", "cerrar") };
  if (tiene(t, "cierra", "cerrar", "cierralo", "cierrala")) return { tipo: "cerrar" };

  const sede = buscarSede(t, ctx.sedes);
  const sedeId = sede?.id ?? null;

  // Equipo: primero en la sede mencionada o abierta, luego en toda la red.
  const enSede = sedeId ?? ctx.sedeActual;
  const equipo =
    (enSede ? buscarEquipo(t, ctx.equipos.filter((e) => e.sedeId === enSede)) : null) ??
    (sede ? null : buscarEquipo(t, ctx.equipos));
  if (equipo) return { tipo: "equipo", equipoKey: equipo.key, pestana: pestanaDe(t) ?? "equipo" };

  // Telemetrias: "telemetria 2", "las tres telemetrias", "por telemetria".
  const grupo = sede ? null : buscarGrupo(t, ctx.grupos ?? []);
  const grupoId = grupo?.id ?? null;
  const todasTelemetrias = !grupo && (tiene(t, "telemetrias", "por telemetria", "cada telemetria", "todas las telemetrias", "fases", "por fase"));

  // Falta un dato: "consultar una sede", "ver una telemetria" -> Gravix pregunta cual.
  // (normalizar convierte "una" en "1")
  if (!sede && /\b(1|alguna|otra|cierta)\s+sede\b/.test(t)) return { tipo: "pedir_sede" };
  if (!grupo && !todasTelemetrias && /\b(1|alguna|otra)\s+telemetria\b|^(ver |consultar |revisar )?(la )?telemetria$/.test(t)) return { tipo: "pedir_telemetria" };

  // Consultas: listas que Gravix lee en voz alta.
  if (/\b(sedes?)\b.*\b(no responde|no responden|sin respuesta|caida|caidas)\b/.test(t) || tiene(t, "sedes sin respuesta", "que sede no responde")) return { tipo: "sin_respuesta", grupoId };
  if (tiene(t, "fuera de linea", "desconectado", "desconectados", "caido", "caidos", "sin datos", "sin comunicacion", "no reportan", "no reporta", "fallando"))
    return { tipo: "fuera_de_linea", sedeId, grupoId };
  if (tiene(t, "generador", "generadores", "planta", "plantas", "planta electrica", "en planta"))
    return { tipo: "generadores", sedeId, grupoId };
  if (!tiene(t, "calidad") && tiene(t, "consumo", "consume", "consumen", "consumiendo", "potencia", "kw", "kilovatios", "carga", "demanda", "energia", "gasto de energia"))
    return { tipo: "consumo", sedeId, grupoId };
  if (/\b(cuales|que|lee|leeme|dime|lista|listame|detalle|detalla|menciona|revisar|revisa|repasa|repasar)\b.*\b(alarma|alarmas|alerta|alertas|criticas|advertencias)\b/.test(t) && !tiene(t, "cuantas", "cuantos"))
    return { tipo: "leer_alarmas", sedeId, grupoId };
  if (grupo && tiene(t, "cuantas", "cuantos")) return { tipo: "contar_alarmas", sedeId: null, grupoId };
  if (grupo && tiene(t, "alarma", "alarmas", "alerta", "alertas")) return { tipo: "leer_alarmas", sedeId: null, grupoId };
  if (grupo || todasTelemetrias) return { tipo: "grupo", grupoId };

  // "Alarmas y correos" es solo para administradores: Gravix le explica al resto por que no entra.
  if (tiene(t, "correos", "correo", "configurar alarmas", "reglas")) return { tipo: "vista", vista: "alarmas" };
  if (tiene(t, "cuantas", "cuantos", "numero de", "hay alarmas", "hay alertas")) return { tipo: "contar_alarmas", sedeId };
  if (tiene(t, "alarma", "alarmas", "alerta", "alertas", "campana", "criticas", "critica", "advertencias")) return { tipo: "alertas", sedeId };

  if (tiene(t, "incidentes", "incidente", "linea de tiempo")) return { tipo: "vista", vista: "incidentes" };
  if (tiene(t, "ranking", "clasificacion", "peores sedes", "mejores sedes")) return { tipo: "vista", vista: "ranking" };
  if (tiene(t, "normas", "norma", "cumplimiento", "calidad")) return { tipo: "vista", vista: "normas" };
  if (tiene(t, "prediccion", "pronostico", "proyeccion")) return { tipo: "vista", vista: "prediccion" };

  if (sede) return { tipo: "sede", sedeId: sede.id, estado: tiene(t, "como esta", "como va", "estado", "resumen", "que pasa", "que tiene") };

  if (tiene(t, "mapa", "inicio", "red igss", "toda la red", "volver", "regresa", "regresar", "atras")) return { tipo: "inicio" };
  if (tiene(t, "resumen", "como esta", "como va", "estado", "novedades", "que hay", "que pasa", "que necesito", "que hago", "reporte"))
    return { tipo: "resumen" };
  if (tiene(t, "hola", "buenos dias", "buenas tardes", "buenas noches", "buenas")) return { tipo: "saludo" };

  return { tipo: "desconocido", texto: frase };
}

/** Frases de seguimiento que se refieren a lo ultimo que se hablo ("¿y sus alarmas?", "¿y el consumo de esa sede?"). */
// ("esta"/"este" solos no cuentan: "¿como esta la red?" no se refiere a nada anterior)
export const usaContexto = (t: string) => /^y\b/.test(t) || /\b(su|sus|esa|ese|ahi|alli|alla|la misma|el mismo|esta sede|este equipo|esta telemetria)\b/.test(t);

/** Menu principal: atajos que Gravix ofrece al saludar o cuando no hay un tema en curso. */
export const MENU = ["Revisar alarmas", "Estado por telemetría", "Consultar una sede", "Consumo de energía", "Generadores en marcha", "Equipos fuera de línea"];
