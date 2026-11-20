import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
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

interface Respuesta {
  respuesta: string;
  acciones: AccionNavegar[];
}

@Injectable()
export class AsistenteService {
  private readonly log = new Logger(AsistenteService.name);
  private readonly client: Anthropic | null;
  private readonly modelo: string;
  private readonly esfuerzo: "low" | "medium" | "high" | "xhigh" | "max";
  private readonly base: string;

  constructor(config: ConfigService) {
    const key = config.get<string>("ANTHROPIC_API_KEY");
    this.client = key ? new Anthropic({ apiKey: key, timeout: 120_000, maxRetries: 2 }) : null;
    this.modelo = config.get<string>("ASISTENTE_MODELO") || "claude-opus-5-5";
    const e = config.get<string>("ASISTENTE_ESFUERZO") || "medium";
    this.esfuerzo = (["low", "medium", "high", "xhigh", "max"].includes(e) ? e : "medium") as AsistenteService["esfuerzo"];
    this.base = `http://127.0.0.1:${config.get<number>("API_PORT", 3000)}/api/v1`;
  }

  estado() {
    return { disponible: !!this.client, modelo: this.client ? this.modelo : null };
  }

  async preguntar(dto: PreguntaDto, autorizacion: string): Promise<Respuesta> {
    if (!this.client) throw new ServiceUnavailableException("Gravix IA no está activado en este servidor (falta ANTHROPIC_API_KEY).");
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

  /* ---------------- herramientas ---------------- */

  private async ejecutar(nombre: string, inp: Record<string, unknown>, auth: string, acciones: AccionNavegar[]): Promise<string> {
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
  private async redResumen(auth: string) {
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

  private async get(path: string, query: Record<string, string | number | undefined>, auth: string): Promise<any> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(30_000) });
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
