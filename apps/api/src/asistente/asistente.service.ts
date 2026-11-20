import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Anthropic from "@anthropic-ai/sdk";
import { HERRAMIENTAS, type AccionNavegar } from "./herramientas";
import type { PreguntaDto } from "./asistente.dto";

/**
 * Gravix IA (fase 2 del asistente del Centro de mando): preguntas libres en español respondidas por
 * Claude con herramientas de solo lectura sobre esta misma API.
 *  - Sin ANTHROPIC_API_KEY el asistente queda "no disponible" y la web usa solo los comandos fijos.
 *  - Cada herramienta llama a la API local con el token del usuario: ve solo lo que el usuario puede ver.
 *  - Nada aqui envia comandos a los equipos ni cambia configuracion.
 */

const SISTEMA = `Usted es Gravix, el asistente del Centro de mando de Nodivo-SIASA: la plataforma que monitorea la energía eléctrica de las sedes hospitalarias del IGSS en Guatemala (medidores ION7400 y PM2130, generadores, transferencias del ATS, calidad de energía).

Cómo trabaja:
- Responde preguntas sobre el estado y el historial de las sedes, sus equipos, alarmas, consumo, calidad de energía y las telemetrías (grupos de sedes por fase: Telemetría 1, 2, 3...).
- Antes de responder, consulte los datos con las herramientas; no invente cifras ni equipos. Si un dato no está disponible, dígalo.
- Para preguntas sobre toda la red o una telemetría, empiece con red_resumen. Las sedes del monitoreo central se consultan con centro_eventos y centro_historial_medidor; las sedes leídas por Agentes Go (y Escuintla en directo), con piloto_* y eventos_sede usando su buildingKey.
- Para qué puede fallar, tendencias, mantenimiento o lo ocurrido en las últimas 24 horas, use analitica_riesgos (ya trae probabilidades y recomendaciones calculadas con el historial).
- Usted solo lee y navega. No puede enviar comandos a los equipos, reconocer alarmas ni cambiar configuración; si se lo piden, explique que eso se hace desde la sede o por un administrador.
- Use la herramienta navegar cuando el usuario pida ver, abrir o ir a algo, o cuando mostrarle la pantalla ayude.

Cómo responde:
- La respuesta se lee en voz alta: español formal (trate de "usted"), claro y breve, normalmente de 2 a 5 oraciones.
- Sin markdown, viñetas, tablas, emojis ni códigos internos (diga "vigilantes desconectados", no MEDIDOR_VIGILANTES_DESCONECTADOS).
- Dé números redondeados con su unidad (kW, V, A, %, horas) y nombres de sedes y equipos como aparecen en los datos.
- Si la pregunta es ambigua, responda lo más útil con los datos y ofrezca una aclaración en una frase.`;

/** Recorte explicito de resultados muy grandes (se le avisa al modelo para que pida menos datos). */
const MAX_RESULTADO = 60_000;
const MAX_VUELTAS = 8;

/** Credencial de quien pregunta, reenviada tal cual a la API local (sesion o API key): ve solo lo suyo. */
export type Credencial = Record<string, string>;

interface Respuesta {
  respuesta: string;
  acciones: AccionNavegar[];
}

/**
 * IA local (Ollama en la red del IGSS, sin licencia y sin que los datos salgan): un modelo pequeño
 * responde SOLO con un resumen compacto que arma este servidor con los datos reales (estado de las
 * sedes, ultimas 24 h, riesgos y metricas de 14 dias). No usa herramientas: asi es rapido y no inventa.
 */
const SISTEMA_LOCAL = `Usted es Gravix, el asistente del Centro de mando de Nodivo-SIASA: monitorea la energía eléctrica de las sedes hospitalarias del IGSS en Guatemala (analizadores ION7400, medidores PM2130, generadores).

Reglas:
- Responda SOLO con los DATOS ACTUALES que vienen abajo. No invente cifras, sedes ni equipos. Si la respuesta no está en los datos, dígalo en una frase y sugiera dónde verla en la aplicación (pestaña Analítica, o Tendencias del equipo para el detalle por hora).
- Para "por qué", proponga la causa más probable según los datos y diga que es una hipótesis.
- Usted solo lee datos: no puede enviar comandos a los equipos, reconocer alarmas ni cambiar configuración.
- Responda en español formal (trate de "usted"), claro y breve: de 2 a 5 oraciones. La respuesta se lee en voz alta: sin markdown, sin listas, sin asteriscos, sin emojis.
- Números redondeados con su unidad (kW, V, A, %, minutos). Nombres de sedes y equipos tal como aparecen en los datos.
- Atribuya cada dato al equipo y la sede exactos donde aparece; no lo pase a otro equipo.

Glosario:
- V = voltios (tensión), kW = kilovatios (potencia o demanda), A = amperios (corriente). Nunca diga "vatios" para el voltaje.
- "Vigilantes desconectados": los relés que le indican al medidor si la sede está con energía comercial o de generador están desconectados. No deja a la sede sin energía ni es un riesgo para las personas; solo impide detectar las transferencias. Es una advertencia.
- Riesgo alto, medio o bajo y su probabilidad salen del análisis estadístico del historial: son estimaciones.`;

/** Textos de los eventos del monitoreo central (igual que la web). */
const EVENTO_TXT: Record<string, string> = {
  MEDIDOR_FUERA_DE_LINEA: "medidor fuera de línea",
  MEDIDOR_EN_CERO: "voltaje en cero",
  MEDIDOR_SIN_CAMBIO: "valores sin cambio",
  GENERADOR_EN_MARCHA: "generador en marcha",
  DATOS_CONGELADOS: "datos congelados",
  LECTURA_ATASCADA: "lectura atascada",
  RECONEXIONES_FRECUENTES: "reconexiones frecuentes",
  MEDIDOR_VIGILANTES_DESCONECTADOS: "vigilantes desconectados (comercial / generador)",
};

@Injectable()
export class AsistenteService {
  private readonly log = new Logger(AsistenteService.name);
  private readonly client: Anthropic | null;
  private readonly modelo: string;
  private readonly esfuerzo: "low" | "medium" | "high" | "xhigh" | "max";
  private readonly base: string;
  /** IA local (Ollama). Si esta configurada, tiene prioridad sobre Claude. */
  private readonly ollamaUrl: string | null;
  private readonly ollamaModelo: string;
  private readonly proveedor: "ollama" | "claude" | null;

  constructor(config: ConfigService) {
    const key = config.get<string>("ANTHROPIC_API_KEY");
    this.client = key ? new Anthropic({ apiKey: key, timeout: 120_000, maxRetries: 2 }) : null;
    this.modelo = config.get<string>("ASISTENTE_MODELO") || "claude-opus-5-5";
    const e = config.get<string>("ASISTENTE_ESFUERZO") || "medium";
    this.esfuerzo = (["low", "medium", "high", "xhigh", "max"].includes(e) ? e : "medium") as AsistenteService["esfuerzo"];
    this.base = `http://127.0.0.1:${config.get<number>("API_PORT", 3000)}/api/v1`;
    this.ollamaUrl = (config.get<string>("OLLAMA_URL") || "").replace(/\/$/, "") || null;
    this.ollamaModelo = config.get<string>("OLLAMA_MODELO") || "qwen3.5:4b";
    const elegido = (config.get<string>("ASISTENTE_PROVEEDOR") || "").toLowerCase();
    this.proveedor =
      elegido === "claude" && this.client ? "claude" : elegido === "ollama" && this.ollamaUrl ? "ollama" : this.ollamaUrl ? "ollama" : this.client ? "claude" : null;
    if (this.proveedor) this.log.log(`Gravix IA: ${this.proveedor === "ollama" ? `modelo local ${this.ollamaModelo} en ${this.ollamaUrl}` : `Claude ${this.modelo}`}`);
  }

  estado() {
    return {
      disponible: !!this.proveedor,
      proveedor: this.proveedor,
      modelo: this.proveedor === "ollama" ? this.ollamaModelo : this.proveedor === "claude" ? this.modelo : null,
    };
  }

  async preguntar(dto: PreguntaDto, autorizacion: Credencial): Promise<Respuesta> {
    if (this.proveedor === "ollama") return this.preguntarLocal(dto, autorizacion);
    if (!this.client) throw new ServiceUnavailableException("Gravix IA no está activada en este servidor (falta OLLAMA_URL o ANTHROPIC_API_KEY).");
    const client = this.client;
    const acciones: AccionNavegar[] = [];

    // Historial en texto plano: turnos alternados que empiezan con el usuario.
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const t of dto.historial ?? []) {
      const role = t.rol === "usuario" ? "user" : "assistant";
      if (!messages.length && role === "assistant") continue;
      const prev = messages[messages.length - 1];
      if (prev && prev.role === role) prev.content = `${prev.content as string}\n${t.texto}`;
      else messages.push({ role, content: t.texto });
    }
    const ahora = new Date().toLocaleString("es-GT", { timeZone: "America/Guatemala", dateStyle: "full", timeStyle: "short" });
    const contexto = `[Fecha y hora en Guatemala: ${ahora}.${dto.sedeActual ? ` Sede abierta en pantalla: ${dto.sedeActual}.` : ""}]`;
    const pregunta = `${contexto}\n${dto.pregunta}`;
    if (messages.length && messages[messages.length - 1].role === "user") messages.pop();
    messages.push({ role: "user", content: pregunta });

    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      const r = await client.beta.messages.create({
        model: this.modelo,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: this.esfuerzo },
        system: [{ type: "text", text: SISTEMA, cache_control: { type: "ephemeral" } }],
        tools: HERRAMIENTAS,
        messages,
      });

      if (r.stop_reason === "refusal") {
        return { respuesta: "No puedo responder esa consulta. Pruebe a preguntarla de otra forma.", acciones };
      }
      if (r.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: r.content });
        continue;
      }
      const usos = r.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (r.stop_reason !== "tool_use" || !usos.length) {
        const texto = r.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return { respuesta: texto || "No encontré una respuesta para eso.", acciones };
      }

      messages.push({ role: "assistant", content: r.content });
      const resultados = await Promise.all(
        usos.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          try {
            return { type: "tool_result", tool_use_id: u.id, content: await this.ejecutar(u.name, (u.input ?? {}) as Record<string, unknown>, autorizacion, acciones) };
          } catch (e) {
            return { type: "tool_result", tool_use_id: u.id, content: e instanceof Error ? e.message : String(e), is_error: true };
          }
        }),
      );
      messages.push({ role: "user", content: resultados });
    }
    this.log.warn("Gravix IA: la pregunta agotó las vueltas de herramientas");
    return { respuesta: "La consulta necesitó demasiados pasos. Pruebe con una pregunta más concreta, por ejemplo de una sede o un equipo.", acciones };
  }

  /* ---------------- IA local (Ollama) ---------------- */

  private async preguntarLocal(dto: PreguntaDto, auth: Credencial): Promise<Respuesta> {
    const contexto = await this.contextoCompacto(auth);
    const ahora = new Date().toLocaleString("es-GT", { timeZone: "America/Guatemala", dateStyle: "full", timeStyle: "short" });
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [{ role: "system", content: `${SISTEMA_LOCAL}\n\nDATOS ACTUALES:\n${contexto}` }];
    for (const t of (dto.historial ?? []).slice(-6)) messages.push({ role: t.rol === "usuario" ? "user" : "assistant", content: t.texto });
    messages.push({ role: "user", content: `[Fecha y hora en Guatemala: ${ahora}.${dto.sedeActual ? ` Sede abierta en pantalla: ${dto.sedeActual}.` : ""}]\n${dto.pregunta}` });

    let r: Response;
    try {
      r = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.ollamaModelo,
          messages,
          stream: false,
          // Sin "pensamiento" visible: respuesta directa y rapida para la voz.
          think: false,
          options: { num_ctx: 16384, temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new BadGatewayException(`El servidor de IA local no respondió: ${(e as Error).message}`);
    }
    if (!r.ok) throw new BadGatewayException(`El servidor de IA local respondió HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { message?: { content?: string } };
    const texto = (j.message?.content ?? "")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/\*\*|__|`/g, "")
      .replace(/^\s*[-*•]\s+/gm, "")
      .replace(/^#+\s*/gm, "")
      .replace(/\n{2,}/g, "\n")
      .trim();
    return { respuesta: texto || "No encontré la respuesta en los datos disponibles.", acciones: [] };
  }

  /** Resumen verificado de los datos para el modelo local (unos 15 000 caracteres como maximo). */
  private async contextoCompacto(auth: Credencial): Promise<string> {
    const [vista, red, an] = await Promise.all([
      this.get(`/centro/vista`, {}, auth),
      this.get(`/red`, {}, auth).catch(() => null),
      this.get(`/centro/analitica`, {}, auth).catch(() => null),
    ]);
    const n = (x: unknown, d = 0) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "—");
    const grupos: { id: string; nombre: string }[] = red?.grupos ?? [];
    const filas: { id: string; grupoId: string | null }[] = red?.sedes ?? [];
    const telemetria = (id: string) => {
      const f = filas.find((x) => x.id === id);
      return grupos.find((g) => g.id === (f ? f.grupoId : "t1"))?.nombre ?? "sin telemetría";
    };
    const sedes = (vista?.sedes ?? []) as Array<Record<string, any>>;
    const t = vista?.totales ?? {};
    const L: string[] = [];
    L.push(`Red: ${t.sedes_responden ?? "—"} de ${t.sedes ?? "—"} sedes responden; ${t.medidores_ok ?? "—"} de ${t.medidores ?? "—"} medidores en línea.`);
    if (grupos.length) L.push(`Telemetrías: ${grupos.map((g) => `${g.nombre}: ${sedes.filter((s) => telemetria(s.id) === g.nombre).map((s) => s.nombre).join(", ") || "sin sedes"}`).join(". ")}.`);

    // Puntos clave ya calculados aqui (el modelo pequeño no tiene que deducirlos): sedes ordenadas por
    // riesgo, equipos con riesgo y su motivo.
    type H = { nivel: string; sedeNombre: string; equipo: string | null; inventario: string | null; titulo: string; probabilidad: number | null };
    const hs: H[] = an?.hallazgos ?? [];
    const riesgoDe = new Map<string, string[]>();
    for (const h of hs) {
      if (!h.equipo) continue;
      const k = `${h.sedeNombre}|${h.equipo}`;
      riesgoDe.set(k, [...(riesgoDe.get(k) ?? []), `${h.titulo} (riesgo ${h.nivel})`]);
    }
    if (hs.length) {
      const peso: Record<string, number> = { alto: 3, medio: 2, bajo: 1 };
      const porSede = new Map<string, { puntos: number; alto: number; medio: number; bajo: number }>();
      for (const h of hs) {
        const x = porSede.get(h.sedeNombre) ?? { puntos: 0, alto: 0, medio: 0, bajo: 0 };
        x.puntos += peso[h.nivel] ?? 0;
        (x as Record<string, number>)[h.nivel] += 1;
        porSede.set(h.sedeNombre, x);
      }
      const orden = [...porSede.entries()].sort((a, b) => b[1].puntos - a[1].puntos);
      L.push("", "PUNTOS CLAVE (calculados con el historial; úselos para preguntas de qué sede está peor o qué revisar primero):");
      L.push(`- Sedes de más a menos riesgo: ${orden.map(([s, x]) => `${s} (${x.alto} altos, ${x.medio} medios, ${x.bajo} bajos)`).join("; ")}.`);
      for (const [s] of orden.slice(0, 4)) {
        const top = hs.filter((h) => h.sedeNombre === s).slice(0, 3);
        L.push(`- Lo más importante en ${s}: ${top.map((h) => `${h.titulo}${h.probabilidad != null ? ` (${Math.round(h.probabilidad * 100)} %)` : ""}`).join("; ")}.`);
      }
      const anomalos = hs.filter((h) => /Voltaje anómalo/.test(h.titulo));
      if (anomalos.length) L.push(`- Equipos con voltaje anómalo (revisar en sitio): ${anomalos.map((h) => `${h.equipo} de ${h.sedeNombre}`).join(", ")}. Los demás equipos tienen voltaje normal.`);
    }

    L.push("", "ESTADO ACTUAL POR SEDE (potencia = suma de analizadores ION7400; V y A promedio por fase):");
    for (const s of sedes) {
      const disp = (s.dispositivos ?? []) as Array<Record<string, any>>;
      const ion = disp.filter((d) => /ion/i.test(`${d.id} ${d.nombre}`) && typeof d.lectura?.kw === "number");
      const pot = ion.reduce((a, d) => a + d.lectura.kw, 0);
      const al = ((s.abiertos ?? []) as Array<Record<string, any>>).map((a) => {
        const sev = a.severidad === "critico" && !/VIGILANTE/i.test(`${a.evento} ${a.titulo}`) ? "crítica" : "advertencia";
        return `${EVENTO_TXT[a.evento] ?? a.titulo} en ${a.inventario ?? a.dispositivo ?? "la sede"} (${sev})`;
      });
      L.push(
        `- ${s.nombre} (${telemetria(s.id)}): ${s.sin_respuesta ? "NO RESPONDE" : `estado ${s.nivel}`}; medidores en línea ${s.medidores?.ok ?? "—"}/${s.medidores?.total ?? "—"}; potencia ahora ${ion.length ? `${n(pot)} kW` : "sin dato"}; alarmas abiertas: ${al.length ? al.join("; ") : "ninguna"}.`,
      );
      for (const d of disp) {
        const l = d.lectura ?? {};
        const r = riesgoDe.get(`${s.nombre}|${d.nombre}`);
        L.push(
          `  · ${d.nombre}${d.inventario ? ` [${d.inventario}]` : ""}${d.area ? ` (${d.area})` : ""}: ${String(d.estado).replace(/_/g, " ")}, ${n(l.kw, 1)} kW, ${n(l.v_prom, 1)} voltios, ${n(l.a_prom, 1)} amperios${l.fuente === "generador" ? ", con generador" : ""}${r ? `; RIESGO: ${r.join("; ")}` : ""}`,
        );
      }
    }

    if (an) {
      L.push("", `ÚLTIMAS 24 HORAS POR SEDE:`);
      for (const s of an.sedes24h ?? []) {
        L.push(
          `- ${s.sedeNombre}: ${s.nivel}; desconexiones de medidores ${s.caidas} (${n(s.minSinDatos)} min sin datos); cortes de comunicación ${s.cortesComunicacion}; caídas de tensión: ${s.caidasTension?.length ? s.caidasTension.join(", ") : "ninguna"}; alarmas ${s.criticas} críticas y ${s.advertencias} advertencias; consumo contra el día anterior ${s.cambioConsumo == null ? "sin dato" : `${s.cambioConsumo > 0 ? "+" : ""}${n(s.cambioConsumo, 1)} %`}.`,
        );
      }
      L.push("", `RIESGOS PARA LOS PRÓXIMOS 7 DÍAS (análisis estadístico de ${an.diasAnalizados} días de historia; de mayor a menor):`);
      for (const h of (an.hallazgos ?? []).slice(0, 15)) {
        L.push(`- [${h.nivel}] ${h.sedeNombre}: ${h.titulo}${h.probabilidad != null ? ` (probabilidad ${Math.round(h.probabilidad * 100)} %)` : ""}. ${h.detalle} Recomendación: ${h.recomendacion}`);
      }
      const m = an.metricas;
      if (m?.dias?.length) {
        const dias = (m.dias as string[]).map((d) => new Date(d).toLocaleDateString("es-GT", { timeZone: "America/Guatemala", day: "2-digit", month: "2-digit" }));
        L.push("", `MÉTRICAS DIARIAS POR SEDE (días: ${dias.join(", ")}; kW = demanda promedio del día, kW máx = máximo del día, V = voltaje promedio, sin datos = minutos):`);
        for (const s of m.sedes ?? []) {
          const fila = (xs: (number | null)[], d = 0) => xs.map((x) => (x == null ? "—" : n(x, d))).join(" ");
          L.push(`- ${s.sedeNombre}: kW ${fila(s.kwProm)} | kW máx ${fila(s.kwMax)} | V ${fila(s.vProm, 1)} | sin datos ${fila(s.minSinDatos)}`);
        }
      }
    }
    L.push("", "Nota: las sedes nuevas leídas por Agentes Go no están en este resumen.");
    return L.join("\n").slice(0, 15_000);
  }

  /* ---------------- herramientas ---------------- */

  private async ejecutar(nombre: string, inp: Record<string, unknown>, auth: Credencial, acciones: AccionNavegar[]): Promise<string> {
    const s = (k: string) => (typeof inp[k] === "string" && (inp[k] as string).trim() ? (inp[k] as string).trim() : undefined);
    const n = (k: string, def?: number) => (typeof inp[k] === "number" && Number.isFinite(inp[k]) ? Math.round(inp[k] as number) : def);
    const req = (k: string) => {
      const v = s(k);
      if (!v) throw new Error(`Falta el parámetro "${k}".`);
      return encodeURIComponent(v);
    };
    switch (nombre) {
      case "red_resumen":
        return this.json(await this.redResumen(auth));
      case "centro_eventos":
        return this.json(await this.get(`/centro/sedes/${req("sede")}/eventos`, { dispositivo: s("dispositivo"), dias: n("dias", 30) }, auth));
      case "centro_historial_medidor":
        return this.json(await this.get(`/centro/sedes/${req("sede")}/medidores/${req("medidor")}/historial`, { minutes: n("minutos", 1440) }, auth));
      case "piloto_equipos":
        return this.json(await this.get(`/pilot/${req("buildingKey")}/devices`, {}, auth));
      case "piloto_serie":
        return this.json(await this.get(`/pilot/devices/${req("id")}/series`, { metric: s("metrica"), minutes: n("minutos", 60) }, auth));
      case "piloto_comparar":
        return this.json(await this.get(`/pilot/devices/${req("id")}/compare`, { minutes: n("minutos", 60) }, auth));
      case "piloto_huecos":
        return this.json(await this.get(`/pilot/devices/${req("id")}/gaps`, { days: n("dias", 7) }, auth));
      case "piloto_cumplimiento":
        return this.json(await this.get(`/pilot/${req("buildingKey")}/cumplimiento`, { dias: n("dias", 7), norma: s("norma") ?? "ntsd" }, auth));
      case "piloto_pronostico":
        return this.json(await this.get(`/pilot/devices/${req("id")}/pronostico`, { metric: s("metrica"), dias: n("dias", 14), horizonte: n("horizonte", 7) }, auth));
      case "piloto_umbrales":
        return this.json(await this.get(`/pilot/devices/${req("id")}/umbrales`, {}, auth));
      case "normas":
        return this.json(await this.get(`/pilot/normas`, {}, auth));
      case "eventos_sede":
        return this.json(
          await this.get(`/sites/${req("buildingKey")}/events`, { from: s("desde"), to: s("hasta"), type: s("tipo"), severity: s("severidad"), limit: n("limite", 100) }, auth),
        );
      case "analitica_riesgos":
        return this.json(await this.get(`/centro/analitica`, {}, auth));
      case "navegar": {
        const destino = s("destino") as AccionNavegar["destino"] | undefined;
        if (!destino || !["inicio", "vista", "sede", "equipo", "alertas", "aplicacion"].includes(destino)) throw new Error("destino inválido");
        if ((destino === "sede" || destino === "equipo") && !s("sede") && !s("equipo")) throw new Error("Indique la sede o el equipo.");
        if (destino === "aplicacion" && !s("aplicacion")) throw new Error("Indique la pestaña de la aplicación.");
        acciones.push({ destino, vista: s("vista"), sede: s("sede"), equipo: s("equipo"), pestana: s("pestana"), aplicacion: s("aplicacion") });
        return "Listo: la pantalla se abrirá al terminar la respuesta.";
      }
      default:
        throw new Error(`Herramienta desconocida: ${nombre}`);
    }
  }

  /** Vista del centro + red (telemetrias y sedes nuevas), resumida para el modelo. */
  private async redResumen(auth: Credencial) {
    const [vista, red] = await Promise.all([this.get(`/centro/vista`, {}, auth), this.get(`/red`, {}, auth).catch(() => null)]);
    type Fila = { id: string; nombre: string; origen: string; grupoId: string | null; agentes: string[] };
    const grupos: { id: string; nombre: string }[] = red?.grupos ?? [];
    const filas: Fila[] = red?.sedes ?? [];
    const nombreGrupo = (id: string | null | undefined) => grupos.find((g) => g.id === id)?.nombre ?? null;
    // Igual que la web: una sede central sin fila en la red pertenece a Telemetria 1 ("t1").
    const grupoDe = (id: string) => {
      const f = filas.find((x) => x.id === id);
      return nombreGrupo(f ? f.grupoId : "t1") ?? "Sin grupo";
    };
    const sedes = (vista?.sedes ?? []) as Array<Record<string, any>>;
    return {
      generado: vista?.generado,
      totales: vista?.totales,
      telemetrias: grupos.map((g) => g.nombre),
      sedes_monitoreo_central: sedes.map((s) => ({
        id: s.id,
        nombre: s.nombre,
        telemetria: grupoDe(s.id),
        nivel: s.nivel,
        sin_respuesta: s.sin_respuesta,
        ultima_consulta_ok: s.ultima_consulta_ok,
        medidores: s.medidores,
        alarmas_abiertas: (s.abiertos ?? []).map((a: any) => ({ titulo: a.titulo, evento: a.evento, severidad: a.severidad, equipo: a.inventario ?? a.dispositivo, desde: a.desde })),
        equipos: (s.dispositivos ?? []).map((d: any) => ({
          nombre: d.nombre,
          inventario: d.inventario,
          area: d.area,
          estado: d.estado,
          evento: d.evento,
          generador: d.generador,
          lectura: d.lectura,
          ultimo_cambio: d.ultimo_cambio,
        })),
      })),
      sedes_agentes_go: filas
        .filter((f) => f.origen !== "central")
        .map((f) => ({ id: f.id, nombre: f.nombre, origen: f.origen, telemetria: nombreGrupo(f.grupoId) ?? "Sin grupo", buildingKeys: f.agentes })),
      nota: "Escuintla también tiene equipos leídos directo (buildingKey igss-escuintla-directo) y por EBO (igss-escuintla) en piloto_equipos.",
    };
  }

  private async get(path: string, query: Record<string, string | number | undefined>, auth: Credencial): Promise<any> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(30_000) });
    const txt = await res.text();
    if (!res.ok) throw new Error(`La consulta ${path} respondió ${res.status}: ${txt.slice(0, 300)}`);
    return txt ? JSON.parse(txt) : null;
  }

  private json(v: unknown): string {
    const t = JSON.stringify(v);
    if (t.length <= MAX_RESULTADO) return t;
    return `${t.slice(0, MAX_RESULTADO)}\n[Resultado recortado a ${MAX_RESULTADO} caracteres de ${t.length}: pida una ventana de tiempo menor o un equipo concreto.]`;
  }
}
