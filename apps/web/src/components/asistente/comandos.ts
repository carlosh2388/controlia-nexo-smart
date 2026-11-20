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
  | { tipo: "contar_alarmas"; sedeId: string | null }
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

export interface Contexto {
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
  if (tiene(t, "ayuda", "que puedes hacer", "que sabes hacer", "comandos", "opciones")) return { tipo: "ayuda" };
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

  // "Alarmas y correos" es solo para administradores: Gravix le explica al resto por que no entra.
  if (tiene(t, "correos", "correo", "configurar alarmas", "reglas")) return { tipo: "vista", vista: "alarmas" };
  if (tiene(t, "cuantas", "cuantos", "numero de", "hay alarmas", "hay alertas")) return { tipo: "contar_alarmas", sedeId };
  if (tiene(t, "alarma", "alarmas", "alerta", "alertas", "campana", "criticas", "critica", "advertencias")) return { tipo: "alertas", sedeId };

  if (tiene(t, "incidentes", "incidente", "linea de tiempo")) return { tipo: "vista", vista: "incidentes" };
  if (tiene(t, "ranking", "clasificacion", "peores sedes", "mejores sedes")) return { tipo: "vista", vista: "ranking" };
  if (tiene(t, "normas", "norma", "cumplimiento")) return { tipo: "vista", vista: "normas" };
  if (tiene(t, "prediccion", "pronostico", "proyeccion")) return { tipo: "vista", vista: "prediccion" };

  if (sede) return { tipo: "sede", sedeId: sede.id, estado: tiene(t, "como esta", "como va", "estado", "resumen", "que pasa", "que tiene") };

  if (tiene(t, "mapa", "inicio", "red igss", "toda la red", "volver", "regresa", "regresar", "atras")) return { tipo: "inicio" };
  if (tiene(t, "resumen", "como esta", "como va", "estado", "novedades", "que hay", "que pasa", "que necesito", "que hago", "reporte"))
    return { tipo: "resumen" };
  if (tiene(t, "hola", "buenos dias", "buenas tardes", "buenas noches", "buenas")) return { tipo: "saludo" };

  return { tipo: "desconocido", texto: frase };
}

/** Ejemplos que se muestran como atajos en la ventana de Gravix. */
export const SUGERENCIAS = ["Resumen de la red", "¿Cuántas alarmas hay?", "Llévame a las alarmas", "Abre Escuintla", "Ranking de sedes", "Predicción"];
