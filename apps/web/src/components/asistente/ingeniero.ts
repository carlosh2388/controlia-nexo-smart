import type { CentroAnalitica, CentroHistorial, CentroVista } from "../../api/centro";
import type { Cumplimiento, Limites, Pronostico } from "../../api/calidad";
import type { PilotDevice, PilotGap, PilotSeries, PilotSpectrum } from "../../api/pilot";
import type { AgentSummary } from "../../api/agents";
import type { PreExportar } from "../../store/gravix.store";
import type { GravixAlarma, GravixEquipo } from "./Gravix";
import { buscarEquipo, buscarSede, normalizar, usaContexto, type Accion, type SedeRef } from "./comandos";

/**
 * Gravix · ingeniero de turno. Se consulta ANTES del motor de comandos: si reconoce la frase, abre la
 * ventana que corresponde y responde con datos calculados aqui (conclusion, detalle, causa probable,
 * que revisar y fuente). Si no la reconoce devuelve null y todo sigue por el camino de siempre.
 * Solo lee y navega: nunca manda nada a los equipos ni cambia configuracion.
 */

export interface Rango {
  desde: Date;
  hasta: Date;
  texto: string;
}
export type Consulta =
  | { tipo: "deshacer" }
  | { tipo: "control" }
  | { tipo: "informe" }
  | { tipo: "arquitectura" }
  | { tipo: "exportar"; equipo: GravixEquipo | null; sedeId: string | null; rango: Rango; armonicos: boolean }
  | { tipo: "comparar"; a: string; b: string }
  | { tipo: "armonicos"; equipo: GravixEquipo | null }
  | { tipo: "huecos"; sedeId: string | null; equipo: GravixEquipo | null }
  | { tipo: "cumplimiento" }
  | { tipo: "pronostico"; equipo: GravixEquipo }
  | { tipo: "estadistica"; equipo: GravixEquipo; magnitud: "kw" | "v" | "a"; rango: Rango }
  | { tipo: "agentes" }
  | { tipo: "diagnostico"; sedeId: string };

export interface Analisis {
  titulo: string;
  puntos: { k: string; v: string }[];
  fuente: string;
  /** Frases que se ofrecen como siguiente paso. */
  sigue: string[];
}

export interface ContextoIng {
  sedes: SedeRef[];
  equipos: GravixEquipo[];
  sedeActual: string | null;
  /** Sede de la que se venia hablando. */
  sedeConversada: string | null;
}

const directo = (e: GravixEquipo | null | undefined): PilotDevice | null => e?.pilotDirect ?? e?.pilot ?? null;
const DIA = 86_400_000;
const hora = (s: string | Date) => new Date(s).toLocaleString("es-GT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const num = (v: number, d = 1) => v.toLocaleString("es-GT", { minimumFractionDigits: 0, maximumFractionDigits: d });
const cuantos = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const lista = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} y ${xs[xs.length - 1]}`);

/** Periodo que se menciona en la frase (ya normalizada). */
export function rangoDe(t: string, ahora = new Date()): Rango | null {
  const hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const menos = (d: number) => new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - d);
  if (/\b(antier|anteayer|antes de ayer)\b/.test(t)) return { desde: menos(2), hasta: menos(1), texto: "antier" };
  if (/\banoche\b/.test(t)) return { desde: new Date(menos(1).getTime() + 18 * 3600_000), hasta: new Date(hoy.getTime() + 6 * 3600_000), texto: "anoche, de 18:00 a 06:00" };
  if (/\bayer\b/.test(t)) return { desde: menos(1), hasta: hoy, texto: "ayer" };
  const m = /\bultim[oa]s? (\d+) (hora|dia|semana)s?\b/.exec(t);
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === "hora" ? 3600_000 : m[2] === "dia" ? DIA : 7 * DIA;
    if (n > 0) return { desde: new Date(ahora.getTime() - n * ms), hasta: ahora, texto: n === 1 ? `la última ${m[2] === "dia" ? "jornada (24 h)" : m[2]}` : `${m[2] === "dia" ? "los últimos" : "las últimas"} ${n} ${m[2] === "dia" ? "días" : `${m[2]}s`}` };
  }
  if (/\bultima hora\b/.test(t)) return { desde: new Date(ahora.getTime() - 3600_000), hasta: ahora, texto: "la última hora" };
  if (/\b(semana pasada|ultima semana)\b/.test(t)) return { desde: new Date(ahora.getTime() - 7 * DIA), hasta: ahora, texto: "los últimos 7 días" };
  if (/\besta semana\b/.test(t)) return { desde: menos((hoy.getDay() + 6) % 7), hasta: ahora, texto: "esta semana" };
  if (/\b(mes pasado|mes anterior)\b/.test(t)) return { desde: new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1), hasta: new Date(hoy.getFullYear(), hoy.getMonth(), 1), texto: "el mes pasado" };
  if (/\beste mes\b/.test(t)) return { desde: new Date(hoy.getFullYear(), hoy.getMonth(), 1), hasta: ahora, texto: "este mes" };
  if (/\bhoy\b/.test(t)) return { desde: hoy, hasta: ahora, texto: "hoy" };
  return null;
}

const CORTESIA = "(?:(?:por favor|puedes|puede|podrias|quiero que|necesito que|ahora) )*";
const CONTROL = [
  new RegExp(`^${CORTESIA}(?:apaga|apagar|apague|apagues|apagame|enciende|encender|encienda|enciendas|prende|prender|prenda|arranca|arrancar|arranques|arranque|deten|detener|detenga|reinicia|reiniciar|reinicie|reinicies|detengas|desconectes|desconecta|desconectar|conecta|conectar|transfiere|transferir|resetea|resetear|reconoce|reconocer)\\b.*\\b(?:generador|generadores|planta|medidor|medidores|equipo|equipos|interruptor|breaker|transferencia|sede|agente|agentes|energia|luz|alarma|alarmas|servidor)\\b`),
  new RegExp(`^${CORTESIA}(?:abre|abrir|cierra|cerrar) (?:el |los )?(?:interruptor|interruptores|breaker)\\b`),
  new RegExp(`^${CORTESIA}(?:borra|borrar|elimina|eliminar|cambia|cambiar|modifica|modificar|configura|configurar)\\b.*\\b(?:configuracion|umbral|umbrales|sede|usuario|usuarios|clave|ip|equipo|medidor|agente|correos|alarmas)\\b`),
];

/** Todas las sedes que se mencionan en la frase. */
function sedesMencionadas(t: string, sedes: SedeRef[]): SedeRef[] {
  const out: SedeRef[] = [];
  let resto = sedes;
  for (let i = 0; i < 3; i++) {
    const s = buscarSede(t, resto);
    if (!s) break;
    out.push(s);
    resto = resto.filter((x) => x.id !== s.id);
  }
  return out;
}

export function interpretarIngeniero(frase: string, ctx: ContextoIng): Consulta | null {
  const t = normalizar(frase);
  if (!t) return null;
  if (/^(deshacer|deshaz|deshazlo|regresa a donde estaba|vuelve a donde estaba|ventana anterior|pantalla anterior)\b/.test(t)) return { tipo: "deshacer" };
  if (CONTROL.some((re) => re.test(t))) return { tipo: "control" };

  const sedes = sedesMencionadas(t, ctx.sedes);
  const sede = sedes[0] ?? null;
  const enContexto = !sede && (usaContexto(t) || /\b(aqui|esta sede)\b/.test(t)) ? ctx.sedeActual ?? ctx.sedeConversada : null;
  const sedeId = sede?.id ?? enContexto;
  const buscar = (xs: GravixEquipo[]): GravixEquipo | null => {
    const donde = sedeId ?? ctx.sedeActual;
    const e = (donde ? buscarEquipo(t, xs.filter((x) => x.sedeId === donde)) : null) ?? (sede ? null : buscarEquipo(t, xs));
    return e ? xs.find((x) => x.key === e.key) ?? null : null;
  };

  if (/\b(informe|entrega de turno|cambio de turno|reporte (de|del) (turno|dia|red))\b/.test(t)) return { tipo: "informe" };

  const armonico = /\b(armonicos?|armonicas?|espectro)\b/.test(t);
  if (/\b(exporta\w*|descarga\w*|excel)\b/.test(t)) {
    const e = (armonico ? buscar(ctx.equipos.filter((x) => x.kind === "ion" && directo(x))) : null) ?? buscar(ctx.equipos);
    const hoy = new Date();
    const r = rangoDe(t) ?? { desde: new Date(hoy.getTime() - 7 * DIA), hasta: hoy, texto: "los últimos 7 días" };
    return { tipo: "exportar", equipo: e, sedeId: e?.sedeId ?? sedeId, rango: r, armonicos: armonico };
  }
  if (/\b(arquitectura|unifilar)\b/.test(t)) return { tipo: "arquitectura" };
  if (sedes.length >= 2 && /\b(compara|comparar|comparame|comparacion|contra|versus|diferencia)\b/.test(t)) return { tipo: "comparar", a: sedes[0].id, b: sedes[1].id };
  if (armonico || (/\bthd\b/.test(t) && !/\bnorma/.test(t))) {
    const ion = ctx.equipos.filter((x) => x.kind === "ion" && directo(x));
    return { tipo: "armonicos", equipo: buscar(ion) };
  }
  if (/\b(huecos?|datos perdidos|lecturas perdidas|perdida de datos|completitud)\b/.test(t)) {
    const e = buscar(ctx.equipos.filter((x) => directo(x)));
    return { tipo: "huecos", sedeId: e?.sedeId ?? sedeId, equipo: e };
  }
  if (!/normas y cumplimiento/.test(t) && /\b(cumple|cumplen|cumpliendo|cumplimiento)\b/.test(t)) return { tipo: "cumplimiento" };

  const equipo = buscar(ctx.equipos);
  if (equipo && directo(equipo) && /\b(pronostico|proyeccion|prediccion|predice|consumira|va a consumir)\b/.test(t)) return { tipo: "pronostico", equipo };
  if (equipo && /\b(maxim[oa]s?|minim[oa]s?|promedio|pico|consumio|consumo|consume|demanda|potencia|voltaje|tension|corriente|amperios)\b/.test(t)) {
    const magnitud = /\b(voltaje|tension|voltios)\b/.test(t) ? "v" : /\b(corriente|amperios|amperaje)\b/.test(t) ? "a" : "kw";
    const ahora = new Date();
    return { tipo: "estadistica", equipo, magnitud, rango: rangoDe(t) ?? { desde: new Date(ahora.getTime() - DIA), hasta: ahora, texto: "las últimas 24 horas" } };
  }
  if (/\bagentes?\b/.test(t) && /\b(como|estado|reporta|reportan|reportando|version|versiones|funciona|funcionan|activos?|caidos?)\b/.test(t)) return { tipo: "agentes" };

  // "¿que paso en Retalhuleu?" (con "ultimas N horas" se deja el resumen de siempre)
  if (sedeId && !equipo && !/\bhoras?\b/.test(t) && /\b(que (le )?(paso|pasa|sucede|sucedio|ocurre|ocurrio|tiene|falla)|por que|diagnostic\w*|causa|analiza|analizar|analisis)\b/.test(t)) return { tipo: "diagnostico", sedeId };
  return null;
}

/* ---------------- analisis ---------------- */

export interface Deps {
  vista: CentroVista;
  equipos: Map<string, GravixEquipo[]>;
  alarmas: GravixAlarma[];
  esAdmin: boolean;
  puedeExcel: boolean;
  analitica: CentroAnalitica | undefined;
  get: <T>(url: string, params?: Record<string, unknown>) => Promise<T>;
  potencia: (eqs: GravixEquipo[]) => { total: number; n: number };
  /** Abre una pantalla (queda en el historial para "deshacer"). */
  abrir: (a: Accion) => boolean;
  prepararExportacion: (x: PreExportar) => void;
  mostrarInforme: (i: Informe) => void;
  /** Marca como hecho el paso anterior y anuncia el siguiente. */
  paso: (t: string) => void;
}

export interface Informe {
  generado: string;
  resumen: { k: string; v: string; tono: "ok" | "adv" | "crit" | "info" }[];
  secciones: { titulo: string; filas: string[] }[];
}

const KW = ["active_power_total", "demand_total", "gen_kw_total_metering"];

/** Causa probable de una sede con problemas, por reglas (siempre se presenta como hipotesis). */
export function causaProbable(x: { sinRespuesta: boolean; fuera: GravixEquipo[]; total: number; eventos: string[] }): { causa: string; revisar: string[] } {
  if (x.sinRespuesta)
    return { causa: "El centro no alcanza la sede. Lo más común es el enlace o el equipo que publica los datos; los medidores pueden seguir operando sin que los veamos.", revisar: ["Enlace o VPN hacia la sede.", "Que el servidor de la sede (api-SIASA o Gravix) esté encendido.", "Que el medidor siga midiendo, en sitio."] };
  if (x.total > 1 && x.fuera.length === x.total)
    return { causa: "Todos los medidores fallan y la sede sí responde: apunta a algo común a ellos, como la red del tablero o el convertidor de comunicación.", revisar: ["Alimentación y red del tablero de medición.", "Convertidor o puente de comunicación.", "Cada medidor en sitio."] };
  if (x.fuera.length > 1)
    return { causa: "Fallan varios medidores y otros siguen bien: podría ser un tramo de cableado o un puente que comparten.", revisar: [`Si comparten conexión: ${lista(x.fuera.slice(0, 4).map((e) => e.nombre))}.`, "Alimentación de ese tramo.", "Cada medidor en sitio."] };
  if (x.fuera.length === 1) return { causa: "Falla un solo medidor y el resto responde: apunta al equipo o a su conexión.", revisar: [`Alimentación y cable de ${x.fuera[0].nombre}.`, "Su dirección IP o número Modbus."] };
  if (x.eventos.some((e) => /VIGILANTE/i.test(e))) return { causa: "Los relés que indican energía comercial o de generador están desconectados. No deja sin energía a la sede; solo impide ver las transferencias.", revisar: ["Cableado de los vigilantes S1 y S2 en el ION."] };
  if (x.eventos.some((e) => /GENERADOR/i.test(e))) return { causa: "Hay un generador en marcha: puede ser un corte de energía comercial o una prueba.", revisar: ["Si hay energía comercial en la acometida.", "Combustible y carga del generador."] };
  if (x.eventos.some((e) => /CONGELAD|SIN_CAMBIO|ATASCADA/i.test(e))) return { causa: "Las lecturas dejaron de cambiar: la comunicación parece activa, pero el dato no se actualiza.", revisar: ["El lector de la sede.", "Que el medidor muestre valores que cambian."] };
  if (x.eventos.some((e) => /CERO/i.test(e))) return { causa: "Un medidor reporta voltaje en cero: puede ser falta de energía en ese circuito o sus señales de voltaje.", revisar: ["Si el circuito tiene energía.", "Fusibles y señales de voltaje del medidor."] };
  return { causa: "No hay un patrón claro con los datos actuales.", revisar: ["El detalle de cada alarma."] };
}

/** THD y armonicos mas altos de una señal y fase (valores en V o A). */
export function analizarEspectro(v: Record<string, number>, senal: "v" | "i", fase: "a" | "b" | "c") {
  const h1 = v[`harm_${senal}_${fase}_01`];
  if (!h1 || h1 <= 0) return null;
  const hs: { n: number; pct: number; val: number }[] = [];
  let suma = 0;
  for (let n = 2; n <= 63; n++) {
    const x = v[`harm_${senal}_${fase}_${String(n).padStart(2, "0")}`];
    if (typeof x !== "number") continue;
    suma += x * x;
    hs.push({ n, val: x, pct: (x / h1) * 100 });
  }
  if (!hs.length) return null;
  return { h1, thd: (Math.sqrt(suma) / h1) * 100, hasta: Math.max(...hs.map((h) => h.n)), top: hs.sort((a, b) => b.pct - a.pct).slice(0, 3) };
}

export async function resolver(q: Exclude<Consulta, { tipo: "deshacer" }>, d: Deps): Promise<Analisis> {
  const sedeDe = (id: string) => d.vista.sedes.find((s) => s.id === id) ?? null;
  const abrirEquipo = (e: GravixEquipo, pestana: "equipo" | "tendencias" | "calidad") => d.abrir({ tipo: "equipo", equipoKey: e.key, pestana });

  switch (q.tipo) {
    case "control":
      return {
        titulo: "No puedo hacer ese cambio: solo consulto y preparo información.",
        puntos: [
          { k: "Por qué", v: "Una orden mal escuchada podría afectar la energía de un hospital o borrar una configuración." },
          { k: "Qué sí puedo hacer", v: "Mostrarle el estado y abrir la pantalla para que una persona autorizada decida." },
        ],
        fuente: "regla de seguridad de Gravix",
        sigue: ["Generadores en marcha", "Revisar alarmas", "Dame el informe del turno"],
      };

    case "arquitectura":
      if (!d.esAdmin) return soloAdmin("Arquitectura");
      d.paso("Abriendo la arquitectura");
      d.abrir({ tipo: "vista", vista: "arquitectura" });
      return { titulo: "Le muestro cómo está conectada la solución.", puntos: [{ k: "Detalle", v: "Haga clic en un bloque para ver qué hace, su puerto y cuánto guarda." }], fuente: "Centro de mando, Arquitectura", sigue: ["Volver al mapa", "¿Cómo están los agentes?"] };

    case "exportar": {
      if (!d.esAdmin || !d.puedeExcel) return soloAdmin("Exportar historial");
      d.paso("Identificando equipos, métricas y fechas");
      const eqs = q.equipo ? [q.equipo] : q.sedeId ? d.equipos.get(q.sedeId) ?? [] : [];
      const elegidos = q.armonicos && !q.equipo ? eqs.filter((e) => e.kind === "ion") : eqs;
      const horas = (q.rango.hasta.getTime() - q.rango.desde.getTime()) / 3600_000;
      d.prepararExportacion({ sedes: [...new Set(elegidos.map((e) => e.sedeId))], equipos: elegidos.slice(0, 40).map((e) => e.key), armonicos: q.armonicos, desde: q.rango.desde.getTime(), hasta: q.rango.hasta.getTime(), paso: horas <= 48 ? 900 : horas <= 31 * 24 ? 3600 : 86400 });
      d.paso("Preparando la exportación");
      d.abrir({ tipo: "vista", vista: "exportar" });
      return {
        titulo: elegidos.length ? "Dejé lista la exportación. Revísela y confirme la descarga." : "Abrí la exportación. Falta elegir la sede y los equipos.",
        puntos: [
          { k: "Equipos", v: elegidos.length ? `${lista(elegidos.slice(0, 4).map((e) => e.nombre))}${elegidos.length > 4 ? ` y ${elegidos.length - 4} más` : ""}` : "sin elegir" },
          { k: "Métricas", v: q.armonicos ? "armónicos de voltaje y corriente, fases A, B y C" : "las básicas (potencia, voltaje, corriente, factor de potencia y frecuencia)" },
          { k: "Periodo", v: `${q.rango.texto}: del ${hora(q.rango.desde)} al ${hora(q.rango.hasta)}` },
        ],
        fuente: "Exportar historial",
        sigue: ["Deshacer", ...(q.equipo && q.armonicos ? [`Armónicos del ${q.equipo.nombre}`] : [])],
      };
    }

    case "comparar": {
      d.paso("Leyendo las dos sedes");
      const fila = (id: string) => {
        const s = sedeDe(id)!;
        const eqs = d.equipos.get(id) ?? [];
        const al = d.alarmas.filter((a) => a.sedeId === id);
        const pot = d.potencia(eqs);
        return { s, ok: eqs.filter((e) => e.ok).length, total: eqs.length, crit: al.filter((a) => a.severidad === "critico").length, al: al.length, pot };
      };
      const a = fila(q.a);
      const b = fila(q.b);
      const txt = (x: typeof a) => `${x.s.sin_respuesta ? "no responde; " : ""}${x.ok} de ${x.total} medidores en línea, ${cuantos(x.crit, "crítica", "críticas")}, ${cuantos(x.al - x.crit, "advertencia", "advertencias")}${x.pot.n ? `, ${num(x.pot.total)} kW` : ""}`;
      d.abrir({ tipo: "inicio" });
      const peor = a.crit !== b.crit ? (a.crit > b.crit ? a : b) : a.total - a.ok !== b.total - b.ok ? (a.total - a.ok > b.total - b.ok ? a : b) : null;
      return {
        titulo: peor ? `${peor.s.nombre} necesita más atención que ${peor === a ? b.s.nombre : a.s.nombre}.` : `${a.s.nombre} y ${b.s.nombre} están en condiciones parecidas.`,
        puntos: [{ k: a.s.nombre, v: txt(a) }, { k: b.s.nombre, v: txt(b) }],
        fuente: "Centro de mando, lectura actual",
        sigue: [`¿Qué pasa en ${(peor ?? a).s.nombre}?`, "Volver al mapa"],
      };
    }

    case "diagnostico": {
      const s = sedeDe(q.sedeId)!;
      d.paso("Leyendo el estado de la sede");
      const eqs = d.equipos.get(s.id) ?? [];
      const fuera = eqs.filter((e) => !e.ok);
      const al = d.alarmas.filter((a) => a.sedeId === s.id);
      d.paso("Cruzando alarmas, equipos y riesgos");
      const fechas = s.abiertos.filter((x) => x.severidad !== "info").map((x) => x.desde);
      const desde = s.sin_respuesta ? s.ultima_consulta_ok : fechas.sort()[0] ?? null;
      const riesgo = d.analitica?.hallazgos.find((h) => h.sedeId === s.id) ?? null;
      d.paso(`Abriendo ${s.nombre}`);
      d.abrir({ tipo: "sede", sedeId: s.id, estado: true });
      if (!s.sin_respuesta && !fuera.length && !al.length)
        return {
          titulo: `${s.nombre} está operando normal: ${eqs.length} de ${eqs.length} medidores en línea y sin alarmas.`,
          puntos: riesgo ? [{ k: "Lo que conviene vigilar", v: `${riesgo.titulo}. ${riesgo.recomendacion}` }] : [],
          fuente: "Centro de mando y análisis del historial",
          sigue: [`¿Cuánto consume ${s.nombre}?`, "Dame el informe del turno"],
        };
      const c = causaProbable({ sinRespuesta: s.sin_respuesta, fuera, total: eqs.length, eventos: s.abiertos.map((x) => x.evento) });
      const crit = al.filter((a) => a.severidad === "critico").length;
      return {
        titulo: s.sin_respuesta ? `${s.nombre} no responde.` : fuera.length ? `${s.nombre} responde, pero ${eqs.length - fuera.length} de ${eqs.length} medidores están en línea.` : `${s.nombre} tiene todos sus medidores en línea y ${cuantos(al.length, "aviso activo", "avisos activos")}.`,
        puntos: [
          ...(desde ? [{ k: s.sin_respuesta ? "Último contacto" : "Desde", v: hora(desde) }] : []),
          { k: "Alarmas", v: `${cuantos(crit, "crítica", "críticas")} y ${cuantos(al.length - crit, "advertencia", "advertencias")}${al[0] ? `. La primera: ${al[0].titulo}${al[0].dispositivo ? ` en ${al[0].dispositivo}` : ""}` : ""}` },
          ...(fuera.length ? [{ k: "Equipos afectados", v: `${lista(fuera.slice(0, 5).map((e) => `${e.nombre} (${e.estadoTxt.toLowerCase()})`))}${fuera.length > 5 ? ` y ${fuera.length - 5} más` : ""}` }] : []),
          { k: "Causa probable (hipótesis)", v: c.causa },
          { k: "Revisar primero", v: c.revisar.map((r, i) => `${i + 1}. ${r}`).join(" ") },
          ...(riesgo ? [{ k: "Historial", v: riesgo.titulo }] : []),
        ],
        fuente: "Centro de mando, alarmas abiertas y análisis del historial",
        sigue: [`Alarmas de ${s.nombre}`, "Dame el informe del turno", "Volver al mapa"],
      };
    }

    case "armonicos": {
      const e = q.equipo;
      const dev = directo(e);
      if (!e || !dev) {
        const ion = [...d.equipos.values()].flat().filter((x) => x.kind === "ion" && directo(x));
        return { titulo: ion.length ? "¿De cuál analizador quiere los armónicos?" : "No hay analizadores con armónicos guardados.", puntos: ion.length ? [{ k: "Disponibles", v: lista(ion.map((x) => x.nombre)) }] : [], fuente: "equipos ION7400 leídos directo", sigue: ion.slice(0, 5).map((x) => `Armónicos del ${x.nombre}`) };
      }
      // El espectro lo guarda la lectura directa; la del AS-P no lo trae.
      const ids = [e.pilotDirect?.id, e.pilot?.id].filter((x): x is string => !!x);
      d.paso("Abriendo calidad de energía");
      abrirEquipo(e, "calidad");
      d.paso(`Leyendo el espectro de ${e.nombre}`);
      let sp: PilotSpectrum | null = null;
      for (const id of ids) {
        const r = await d.get<PilotSpectrum>(`/pilot/devices/${id}/espectro`);
        if (r?.readAt) {
          sp = r;
          break;
        }
      }
      d.paso("Calculando la distorsión");
      const um = await d.get<{ limites: Limites }>(`/pilot/devices/${dev.id}/umbrales`).catch(() => null);
      if (!sp) return { titulo: `${e.nombre} no tiene un espectro guardado en los últimos 2 días.`, puntos: [], fuente: "espectro del ION7400", sigue: [`Huecos del ${e.nombre}`, "Volver al mapa"] };
      const fases = (["a", "b", "c"] as const);
      const v = fases.map((f) => ({ f, r: analizarEspectro(sp!.values, "v", f) })).filter((x) => x.r);
      const i = fases.map((f) => ({ f, r: analizarEspectro(sp!.values, "i", f) })).filter((x) => x.r);
      const peorV = [...v].sort((a, b) => b.r!.thd - a.r!.thd)[0];
      const lim = um?.limites?.thdV ?? null;
      const frase = (xs: typeof v) => xs.map((x) => `${x.f.toUpperCase()} ${num(x.r!.thd, 2)} %`).join(", ");
      return {
        titulo: peorV
          ? lim == null
            ? `La distorsión de voltaje más alta de ${e.nombre} es ${num(peorV.r!.thd, 2)} %, en la fase ${peorV.f.toUpperCase()}.`
            : `${e.nombre} ${peorV.r!.thd <= lim ? "está dentro" : "está fuera"} del límite de distorsión de voltaje: ${num(peorV.r!.thd, 2)} % en la fase ${peorV.f.toUpperCase()}, límite ${num(lim)} %.`
          : `${e.nombre} no trae la fundamental de voltaje en su último espectro.`,
        puntos: [
          ...(v.length ? [{ k: "THD de voltaje por fase", v: frase(v) }] : []),
          ...(i.length ? [{ k: "THD de corriente por fase", v: frase(i) }] : []),
          ...(peorV ? [{ k: `Armónicos mayores, voltaje fase ${peorV.f.toUpperCase()}`, v: peorV.r!.top.map((h) => `H${h.n} ${num(h.pct, 2)} % (${num(h.val, 2)} V)`).join(", ") }] : []),
          ...(peorV && lim != null ? [{ k: "Alcance", v: `Es una lectura puntual con H2 a H${peorV.r!.hasta}; para declarar cumplimiento use Normas, que evalúa varios días.` }] : []),
        ],
        fuente: `espectro del ${hora(sp.readAt!)}, leído directo del ION7400`,
        sigue: [`Descarga los armónicos del ${e.nombre} de ayer`, "¿Cumple la norma?", "Volver al mapa"],
      };
    }

    case "huecos": {
      d.paso("Revisando los datos faltantes");
      const dev = directo(q.equipo);
      if (q.equipo && dev) abrirEquipo(q.equipo, "tendencias");
      if (q.equipo && dev) {
        const g = await d.get<PilotGap[]>(`/pilot/devices/${dev.id}/gaps`, { days: 7 });
        const pend = g.filter((x) => x.status === "open" || x.status === "closed");
        const min = pend.reduce((n, x) => n + x.minutes, 0);
        const mayor = [...pend].sort((a, b) => b.minutes - a.minutes)[0];
        return {
          titulo: pend.length ? `${q.equipo.nombre} tiene ${cuantos(pend.length, "hueco", "huecos")} sin recuperar en 7 días: ${num(min, 0)} minutos.` : `${q.equipo.nombre} no tiene huecos pendientes en los últimos 7 días.`,
          puntos: mayor ? [{ k: "El mayor", v: `${num(mayor.minutes, 0)} min desde ${hora(mayor.startedAt)}. Causa registrada: ${mayor.cause}` }] : [],
          fuente: "huecos detectados en el historial",
          sigue: [`Promedio del ${q.equipo.nombre} ayer`, "Volver al mapa"],
        };
      }
      const eqs = (q.sedeId ? d.equipos.get(q.sedeId) ?? [] : [...d.equipos.values()].flat()).filter((e) => directo(e));
      const con = eqs.map((e) => ({ e, m: directo(e)!.gaps?.missingMinutes ?? 0 })).filter((x) => x.m > 0).sort((a, b) => b.m - a.m);
      if (q.sedeId) d.abrir({ tipo: "sede", sedeId: q.sedeId, estado: true });
      return {
        titulo: !eqs.length ? "Los huecos solo se miden en los equipos leídos directo, y aquí no hay." : con.length ? `${con.length} de ${eqs.length} equipos tienen datos faltantes en los últimos 7 días.` : `Los ${eqs.length} equipos leídos directo no tienen datos faltantes.`,
        puntos: con.length ? [{ k: "Los de más minutos", v: con.slice(0, 5).map((x) => `${x.e.nombre} de ${x.e.sedeNombre}: ${num(x.m, 0)} min`).join("; ") }] : [],
        fuente: "huecos detectados en el historial",
        sigue: con.slice(0, 2).map((x) => `Huecos del ${x.e.nombre}`).concat("Volver al mapa"),
      };
    }

    case "cumplimiento": {
      d.abrir({ tipo: "vista", vista: "normas" });
      d.paso("Consultando 7 días de calidad de energía");
      const c = await d.get<Cumplimiento>("/pilot/igss-escuintla/cumplimiento", { dias: 7, norma: "ntsd" });
      const mal = c.equipos.flatMap((e) => Object.entries(e.indicadores).filter(([, x]) => x && !x.cumple).map(([k, x]) => ({ e: e.nombre, k, pct: x!.pct }))).sort((a, b) => a.pct - b.pct);
      const N: Record<string, string> = { tension: "tensión", desbalance: "desbalance", thdV: "THD de voltaje", thdI: "THD de corriente", pst: "flicker", fp: "factor de potencia", freq: "frecuencia" };
      return {
        titulo: c.resumen.evaluados ? `En Escuintla se cumplen ${c.resumen.cumplen} de ${c.resumen.evaluados} indicadores evaluados con ${c.normaNombre}.` : "Todavía no hay datos suficientes para evaluar la norma.",
        puntos: mal.length ? [{ k: "Fuera de límite", v: mal.slice(0, 5).map((x) => `${x.e}, ${N[x.k] ?? x.k} (${num(x.pct)} % del tiempo dentro)`).join("; ") }] : [],
        fuente: `${c.normaNombre}, últimos ${c.dias} días, promedios de 10 min. Solo Escuintla se evalúa`,
        sigue: mal[0] ? [`Armónicos del ${mal[0].e}`, "Volver al mapa"] : ["Volver al mapa"],
      };
    }

    case "pronostico": {
      const dev = directo(q.equipo)!;
      const metric = KW.find((k) => typeof dev.readings[k] === "number") ?? KW[0];
      abrirEquipo(q.equipo, "tendencias");
      d.paso(`Analizando 14 días de ${q.equipo.nombre}`);
      const r = await d.get<Pronostico>(`/pilot/devices/${dev.id}/pronostico`, { metric, dias: 14, horizonte: 7 });
      const pico = [...r.pronostico].sort((a, b) => b.v - a.v)[0];
      if (!r.suficiente || !pico) return { titulo: `Todavía no hay historia suficiente para pronosticar ${q.equipo.nombre}.`, puntos: [], fuente: "historial del equipo", sigue: [`Promedio del ${q.equipo.nombre} ayer`] };
      return {
        titulo: `El pico esperado de ${q.equipo.nombre} en los próximos 7 días es ${num(pico.v)} kW, el ${hora(pico.t)}.`,
        puntos: [
          { k: "Banda esperada en ese momento", v: `de ${num(pico.min)} a ${num(pico.max)} kW` },
          ...(typeof r.pendienteDiaria === "number" ? [{ k: "Tendencia", v: `${r.pendienteDiaria >= 0 ? "sube" : "baja"} ${num(Math.abs(r.pendienteDiaria), 2)} kW por día` }] : []),
        ],
        fuente: "pronóstico estadístico con 14 días de historia; es una estimación",
        sigue: [`Máximo del ${q.equipo.nombre} esta semana`, "Volver al mapa"],
      };
    }

    case "estadistica": {
      const { equipo: e, magnitud } = q;
      const dev = directo(e);
      const unidad = magnitud === "kw" ? "kW" : magnitud === "v" ? "V" : "A";
      const que = magnitud === "kw" ? "potencia" : magnitud === "v" ? "voltaje" : "corriente";
      d.paso("Abriendo tendencias");
      abrirEquipo(e, "tendencias");
      d.paso(`Leyendo el historial de ${e.nombre}`);
      const min = Math.ceil((Date.now() - q.rango.desde.getTime()) / 60_000);
      let pts: { t: string; v: number }[] = [];
      let nota = "";
      if (dev) {
        const claves = magnitud === "kw" ? KW : magnitud === "v" ? ["voltage_a_n"] : ["current_a"];
        const metric = claves.find((k) => typeof dev.readings[k] === "number") ?? claves[0];
        pts = (await d.get<PilotSeries>(`/pilot/devices/${dev.id}/series`, { metric, minutes: Math.min(10_080, Math.max(5, min)) })).points;
        if (magnitud !== "kw") nota = "fase A";
        if (min > 10_080) nota = [nota, "solo los últimos 7 días"].filter(Boolean).join(", ");
      } else if (e.central) {
        const h = await d.get<CentroHistorial>(`/centro/sedes/${e.sedeId}/medidores/${encodeURIComponent(e.central.id ?? "")}/historial`, { minutes: Math.min(129_600, Math.max(5, min)) });
        pts = h.points.map((x) => ({ t: x.t, v: x[magnitud] })).filter((x): x is { t: string; v: number } => typeof x.v === "number");
        if (magnitud !== "kw") nota = "promedio de fases";
      }
      pts = pts.filter((x) => new Date(x.t) >= q.rango.desde && new Date(x.t) <= q.rango.hasta);
      if (!pts.length) return { titulo: `No hay datos de ${que} de ${e.nombre} para ${q.rango.texto}.`, puntos: [], fuente: "historial del equipo", sigue: [`Huecos del ${e.nombre}`, "Volver al mapa"] };
      const max = pts.reduce((a, b) => (b.v > a.v ? b : a));
      const mn = pts.reduce((a, b) => (b.v < a.v ? b : a));
      const prom = pts.reduce((s, x) => s + x.v, 0) / pts.length;
      return {
        titulo: `${e.nombre}: ${que} promedio de ${num(prom)} ${unidad} (${q.rango.texto}).`,
        puntos: [
          { k: "Máximo", v: `${num(max.v)} ${unidad}, el ${hora(max.t)}` },
          { k: "Mínimo", v: `${num(mn.v)} ${unidad}, el ${hora(mn.t)}` },
          { k: "Último", v: `${num(pts[pts.length - 1].v)} ${unidad}` },
        ],
        fuente: `${pts.length} intervalos promediados del historial${nota ? ` (${nota})` : ""}`,
        sigue: [...(dev ? [`Pronóstico del ${e.nombre}`] : []), "Volver al mapa"],
      };
    }

    case "agentes": {
      d.paso("Consultando los agentes");
      const ag = await d.get<AgentSummary[]>("/agents");
      const mins = (a: AgentSummary) => (a.lastSync?.syncedAt ? (Date.now() - new Date(a.lastSync.syncedAt).getTime()) / 60_000 : Infinity);
      const ok = ag.filter((a) => mins(a) <= 5);
      const mal = ag.filter((a) => mins(a) > 5);
      d.abrir({ tipo: "pestana", pestana: "equipos" });
      const d1 = (a: AgentSummary) => `${a.buildingKey}${a.lastSync ? ` (desde ${hora(a.lastSync.syncedAt)})` : " (nunca)"}`;
      return {
        titulo: !ag.length ? "No hay agentes registrados." : mal.length ? `${ok.length} de ${ag.length} agentes reportan; ${cuantos(mal.length, "no reporta", "no reportan")}.` : `Los ${ag.length} agentes están reportando.`,
        puntos: [
          ...(mal.length ? [{ k: "Sin reportar hace más de 5 min", v: `${mal.slice(0, 6).map(d1).join("; ")}` }] : []),
          ...(ok.length ? [{ k: "Reportando", v: ok.slice(0, 6).map((a) => `${a.buildingKey}${a.lastSync?.agentVersion ? ` v${a.lastSync.agentVersion}` : ""}`).join(", ") }] : []),
          ...(ag.some((a) => a.applyError) ? [{ k: "Con error de configuración", v: lista(ag.filter((a) => a.applyError).map((a) => a.buildingKey)) }] : []),
        ],
        fuente: "último envío de cada Agente Go. Puede incluir agentes en pausa",
        sigue: ["Centro de mando", "Huecos de datos"],
      };
    }

    case "informe": {
      d.paso("Reuniendo alarmas y estado de las sedes");
      const inf = await armarInforme(d);
      d.paso("Abriendo el informe");
      d.mostrarInforme(inf);
      const atender = inf.secciones[0]?.filas ?? [];
      return {
        titulo: d.alarmas.some((a) => a.severidad === "critico") || d.vista.sedes.some((s) => s.sin_respuesta) ? "El turno tiene puntos críticos por atender." : "El turno está sin puntos críticos.",
        puntos: [{ k: "Resumen", v: inf.resumen.map((r) => `${r.k}: ${r.v}`).join(" · ") }, { k: "Atender primero", v: atender.slice(0, 3).join(" ") }],
        fuente: "Centro de mando, alarmas, análisis, normas y huecos",
        sigue: ["¿Qué puede fallar?", "Revisar alarmas"],
      };
    }
  }
}

function soloAdmin(que: string): Analisis {
  return { titulo: `${que} requiere perfil de administrador${que.startsWith("Exportar") ? " con permiso de Excel" : ""}.`, puntos: [{ k: "Qué puede hacer", v: "Pedir el permiso a un administrador en Usuarios y permisos." }], fuente: "permisos de su usuario", sigue: ["Volver al mapa"] };
}

async function armarInforme(d: Deps): Promise<Informe> {
  const t = d.vista.totales;
  const crit = d.alarmas.filter((a) => a.severidad === "critico");
  const adv = d.alarmas.filter((a) => a.severidad !== "critico");
  const porSede = (xs: GravixAlarma[]) => {
    const m = new Map<string, number>();
    for (const a of xs) m.set(a.sedeNombre, (m.get(a.sedeNombre) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  d.paso("Calculando consumo, calidad y riesgos");
  const kw = d.vista.sedes.map((s) => ({ s, p: d.potencia(d.equipos.get(s.id) ?? []) })).filter((x) => x.p.n).sort((a, b) => b.p.total - a.p.total);
  const cumpl = await d.get<Cumplimiento>("/pilot/igss-escuintla/cumplimiento", { dias: 7, norma: "ntsd" }).catch(() => null);
  const an = d.analitica;
  const directos = [...d.equipos.values()].flat().filter((e) => directo(e));
  const huecos = directos.map((e) => ({ e, m: directo(e)!.gaps?.missingMinutes ?? 0 })).filter((x) => x.m > 0).sort((a, b) => b.m - a.m);
  const caidas = d.vista.sedes.filter((s) => s.sin_respuesta);
  const s24 = an?.sedes24h.filter((s) => s.nivel !== "estable") ?? [];
  return {
    generado: new Date().toLocaleString("es-GT"),
    resumen: [
      { k: "Sedes", v: `${t.sedes_responden}/${t.sedes}`, tono: t.sedes_responden < t.sedes ? "crit" : "ok" },
      { k: "Medidores", v: `${t.medidores_ok}/${t.medidores}`, tono: t.medidores_ok < t.medidores ? "adv" : "ok" },
      { k: "Críticas", v: String(crit.length), tono: crit.length ? "crit" : "ok" },
      { k: "Advertencias", v: String(adv.length), tono: adv.length ? "adv" : "ok" },
    ],
    secciones: [
      { titulo: "Atender primero", filas: [...caidas.map((s) => `${s.nombre} no responde${s.ultima_consulta_ok ? ` desde ${hora(s.ultima_consulta_ok)}` : ""}.`), ...crit.filter((a) => !caidas.some((s) => s.id === a.sedeId)).slice(0, 10).map((a) => `${a.sedeNombre}: ${a.titulo}${a.dispositivo ? ` en ${a.dispositivo}` : ""}.`)].concat(caidas.length || crit.length ? [] : ["Nada crítico en este momento."]) },
      { titulo: "Vigilar", filas: adv.length ? porSede(adv).map(([s, n]) => `${s}: ${cuantos(n, "advertencia", "advertencias")}.`) : ["Sin advertencias."] },
      { titulo: "Novedades de 24 horas", filas: !an ? ["El análisis todavía no está listo."] : s24.length ? s24.map((s) => `${s.sedeNombre}: ${cuantos(s.caidas, "desconexión", "desconexiones")}, ${num(s.minSinDatos, 0)} min sin datos, ${cuantos(s.cortesComunicacion, "corte de comunicación", "cortes de comunicación")}.`) : ["Todas las sedes estables."] },
      { titulo: "Consumo actual por sede", filas: kw.length ? kw.map((x) => `${x.s.nombre}: ${num(x.p.total)} kW.`) : ["Sin lecturas de potencia."] },
      { titulo: "Calidad de energía (Escuintla, 7 días)", filas: [cumpl && cumpl.resumen.evaluados ? `${cumpl.resumen.cumplen} de ${cumpl.resumen.evaluados} indicadores cumplen ${cumpl.normaNombre}.` : "Sin datos de cumplimiento disponibles."] },
      { titulo: "Qué puede fallar", filas: !an ? ["El análisis todavía no está listo."] : an.hallazgos.length ? an.hallazgos.slice(0, 6).map((h) => `${h.titulo}${h.probabilidad != null ? ` (${Math.round(h.probabilidad * 100)} % en 7 días, estimado)` : ""}.`) : ["Sin riesgos detectados."] },
      { titulo: "Huecos de datos (7 días)", filas: huecos.length ? huecos.slice(0, 8).map((x) => `${x.e.nombre} de ${x.e.sedeNombre}: ${num(x.m, 0)} min.`) : [directos.length ? "Sin huecos en los equipos leídos directo." : "No hay equipos leídos directo."] },
    ],
  };
}

/** Ventana que conviene mostrar mientras se responde una pregunta del motor de siempre. */
export function ventanaDe(a: Accion): Accion | null {
  switch (a.tipo) {
    case "leer_alarmas":
    case "contar_alarmas":
      return a.grupoId ? null : { tipo: "alertas", sedeId: a.sedeId };
    case "fuera_de_linea":
      return a.sedeId ? { tipo: "sede", sedeId: a.sedeId, estado: true } : null;
    case "consumo":
    case "generadores":
      return a.sedeId ? { tipo: "sede", sedeId: a.sedeId, estado: true } : null;
    case "riesgos":
      return a.sedeId ? { tipo: "sede", sedeId: a.sedeId, estado: true } : { tipo: "vista", vista: "analitica" };
    case "sin_respuesta":
    case "resumen":
      return { tipo: "inicio" };
    default:
      return null;
  }
}
