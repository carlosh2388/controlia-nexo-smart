#!/usr/bin/env node
/**
 * Servidor MCP de SIASA IoT (solo lectura).
 *
 * Expone como "herramientas" MCP los endpoints GET de la API (apps/api) para que Claude
 * pueda consultar agentes, dispositivos, eventos de sede, centro de mando y piloto Gravix.
 * No tiene ninguna herramienta que escriba, borre o mande comandos a los equipos.
 *
 * Se comunica con el cliente MCP por stdin/stdout (transporte stdio): el cliente
 * (Claude Code, Claude Desktop, etc.) lo arranca como proceso hijo.
 *
 * Configuracion (variables de entorno, o archivo apps/mcp/.env):
 *   SIASA_API_URL      Base de la API, con /api/v1. Por defecto http://localhost:3010/api/v1
 *                      (en el servidor SIASA: http://192.168.70.4:3010/api/v1)
 *   SIASA_API_KEY      API key con rol "viewer" (se crea con POST /api/v1/api-keys, ver README). Obligatoria.
 *   SIASA_TIMEOUT_MS   Tiempo maximo por peticion. Por defecto 20000.
 *
 * Prueba rapida sin cliente MCP:  node server.js --check
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const API_URL = (process.env.SIASA_API_URL || "http://localhost:3010/api/v1").replace(/\/+$/, "");
const API_KEY = process.env.SIASA_API_KEY || "";
const TIMEOUT_MS = Number(process.env.SIASA_TIMEOUT_MS) || 20000;
/** Limite de texto devuelto a Claude por llamada, para no saturar su contexto. */
const MAX_CHARS = 60000;

// Todo lo que se escriba a stdout rompe el protocolo: los mensajes van a stderr.
const log = (...a) => console.error("[siasa-mcp]", ...a);

class ApiError extends Error {}

/** GET a la API con la API key. Devuelve el JSON ya parseado. */
async function api(path, query = {}) {
  if (!API_KEY) throw new ApiError("Falta SIASA_API_KEY en apps/mcp/.env: cree una API key con rol viewer (ver apps/mcp/README.md, paso 2).");
  const url = new URL(API_URL + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, {
      headers: { "x-api-key": API_KEY, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ApiError(`No se pudo conectar con la API en ${API_URL} (${e.name === "TimeoutError" ? "tiempo agotado" : e.message}).`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      // El filtro de errores de la API anida el mensaje: { message: { message: "...", error, statusCode } }
      let m = JSON.parse(text).message;
      if (m && typeof m === "object" && !Array.isArray(m)) m = m.message;
      msg = Array.isArray(m) ? m.join("; ") : m ?? text;
    } catch {}
    const hint = res.status === 401 ? " (API key inválida o revocada)" : res.status === 403 ? " (la API key no tiene permiso; use rol viewer u operator)" : "";
    throw new ApiError(`La API respondió ${res.status}${hint}: ${String(msg).slice(0, 500)}`);
  }
  try { return JSON.parse(text); } catch { return text; }
}

const enc = encodeURIComponent;

function asText(data) {
  let s = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  if (s.length > MAX_CHARS) {
    s = s.slice(0, MAX_CHARS) + `\n\n[... respuesta recortada: ${s.length} caracteres en total. Pida un rango de tiempo más corto o un filtro más específico.]`;
  }
  return s;
}

/** Envuelve un handler: convierte errores en una respuesta de error legible para Claude. */
const tool = (fn) => async (args) => {
  try {
    return { content: [{ type: "text", text: asText(await fn(args ?? {})) }] };
  } catch (e) {
    if (!(e instanceof ApiError)) log(e);
    return { isError: true, content: [{ type: "text", text: e instanceof ApiError ? e.message : `Error interno: ${e.message}` }] };
  }
};

const server = new McpServer({ name: "siasa-iot", version: "0.1.0" });
const RO = { readOnlyHint: true, openWorldHint: false };
const reg = (name, title, description, inputSchema, fn) =>
  server.registerTool(name, { title, description, inputSchema, annotations: { ...RO, title } }, tool(fn));

// ---------------------------------------------------------------- Agentes
reg(
  "agentes",
  "Agentes Go",
  "Lista los Agentes Go de las sedes (buildingKey), su versión de configuración guardada/aplicada y su último sync. " +
    "Úselo para saber qué sedes existen y si su agente está reportando.",
  {},
  async () => {
    const [agentes, estado] = await Promise.all([api("/agents"), api("/devices/agent-status")]);
    return { agentes, ultimoSyncPorSede: estado };
  },
);

// ---------------------------------------------------------------- Dispositivos
reg(
  "dispositivos",
  "Buscar dispositivos",
  "Lista dispositivos en forma resumida (id, nombre, protocolo, tipo, sede y última actualización). " +
    "Filtre por sede (buildingKey), protocolo o texto en el nombre. Use el id devuelto en las demás herramientas.",
  {
    buildingKey: z.string().optional().describe("Sede del Agente Go, p. ej. igss-escuintla"),
    protocolo: z.string().optional().describe("Protocolo(s) separados por coma: mqtt, http, modbus, bacnet, lorawan..."),
    buscar: z.string().optional().describe("Texto que debe aparecer en el nombre (sin distinguir mayúsculas)"),
    limite: z.number().int().min(1).max(500).default(100),
  },
  async ({ buildingKey, protocolo, buscar, limite }) => {
    const all = await api("/devices", { protocol: protocolo });
    const q = buscar?.toLowerCase();
    const rows = all
      .filter((d) => !buildingKey || d.metadata?.agent?.buildingKey === buildingKey)
      .filter((d) => !q || d.name?.toLowerCase().includes(q))
      .map((d) => ({
        id: d.id,
        nombre: d.name,
        protocolo: d.protocol,
        tipo: d.kind,
        sede: d.metadata?.agent?.buildingKey ?? null,
        estado: d.state?.state ?? null,
        actualizado: d.state?.updatedAt ?? null,
      }));
    return { total: rows.length, mostrados: Math.min(rows.length, limite), dispositivos: rows.slice(0, limite) };
  },
);

reg(
  "dispositivo",
  "Detalle de dispositivo",
  "Detalle completo de un dispositivo: metadata, estado actual y últimas lecturas (los secretos vienen enmascarados).",
  { id: z.string().describe("id del dispositivo") },
  ({ id }) => api(`/devices/${enc(id)}`),
);

reg(
  "historial_dispositivo",
  "Historial de dispositivo",
  "Historial de estados/lecturas de un dispositivo en un rango predefinido.",
  {
    id: z.string(),
    rango: z.enum(["1h", "24h", "today", "7d", "15d", "30d"]).default("24h"),
  },
  ({ id, rango }) => api(`/devices/${enc(id)}/history`, { range: rango }),
);

// ---------------------------------------------------------------- Eventos de sede
reg(
  "eventos_sede",
  "Eventos de sede",
  "Eventos detectados por el Agente Go de una sede (cambio a planta, puertas, alarmas, sede sin datos...), del más reciente al más antiguo.",
  {
    buildingKey: z.string().describe("Sede del Agente Go, p. ej. igss-escuintla"),
    desde: z.string().optional().describe("Fecha/hora ISO 8601 de inicio"),
    hasta: z.string().optional().describe("Fecha/hora ISO 8601 de fin"),
    deviceId: z.string().optional(),
    tipo: z.string().optional().describe("Prefijo de tipo, p. ej. generator o energy.source"),
    severidad: z.enum(["info", "warning", "critical"]).optional(),
    limite: z.number().int().min(1).max(1000).default(100),
  },
  ({ buildingKey, desde, hasta, deviceId, tipo, severidad, limite }) =>
    api(`/sites/${enc(buildingKey)}/events`, { from: desde, to: hasta, deviceId, type: tipo, severity: severidad, limit: limite }),
);

// ---------------------------------------------------------------- Centro de mando
reg(
  "centro_vista",
  "Centro de mando",
  "Vista general del centro de mando: sedes monitoreadas, medidores, estado en línea y alarmas actuales.",
  {},
  () => api("/centro/vista"),
);

reg(
  "centro_eventos",
  "Eventos del centro de mando",
  "Eventos de un dispositivo de una sede del centro de mando en los últimos N días.",
  {
    sede: z.string().describe("id de la sede tal como aparece en centro_vista"),
    dispositivo: z.string().describe("id del dispositivo/medidor en esa sede"),
    dias: z.number().int().min(1).max(90).default(30),
  },
  ({ sede, dispositivo, dias }) => api(`/centro/sedes/${enc(sede)}/eventos`, { dispositivo, dias }),
);

reg(
  "centro_historial_medidor",
  "Historial de medidor",
  "Historial de un medidor del centro de mando: kW, voltaje y corriente promedio por intervalo.",
  {
    sede: z.string(),
    medidor: z.string(),
    minutos: z.number().int().min(5).max(129600).default(1440).describe("Ventana hacia atrás (máx. 90 días)"),
  },
  ({ sede, medidor, minutos }) => api(`/centro/sedes/${enc(sede)}/medidores/${enc(medidor)}/historial`, { minutes: minutos }),
);

// ---------------------------------------------------------------- Piloto Gravix / series de tiempo
reg(
  "piloto_equipos",
  "Equipos de energía de una sede",
  "Equipos de energía (medidores, analizadores) de una sede en el piloto Gravix, con sus métricas disponibles.",
  { buildingKey: z.string() },
  ({ buildingKey }) => api(`/pilot/${enc(buildingKey)}/devices`),
);

reg(
  "piloto_serie",
  "Serie de tiempo",
  "Serie de tiempo de una métrica de un equipo (p. ej. active_power_total, voltage_a_n, current_a, thd_voltage_a).",
  {
    id: z.string().describe("id del dispositivo"),
    metrica: z.string().describe("Clave de la métrica, ver piloto_equipos"),
    minutos: z.number().int().min(5).max(10080).default(60).describe("Ventana hacia atrás (máx. 7 días)"),
  },
  ({ id, metrica, minutos }) => api(`/pilot/devices/${enc(id)}/series`, { metric: metrica, minutes: minutos }),
);

reg(
  "piloto_comparar",
  "Comparar directo vs EBO",
  "Compara la lectura directa del equipo (Modbus) con la del EBO/AS-P para la misma variable.",
  { id: z.string(), minutos: z.number().int().min(5).max(10080).default(60) },
  ({ id, minutos }) => api(`/pilot/devices/${enc(id)}/compare`, { minutes: minutos }),
);

reg(
  "piloto_huecos",
  "Huecos de datos",
  "Periodos sin datos (huecos) de un equipo, con su causa y estado.",
  { id: z.string(), dias: z.number().int().min(1).max(90).default(7) },
  ({ id, dias }) => api(`/pilot/devices/${enc(id)}/gaps`, { days: dias }),
);

reg(
  "piloto_cumplimiento",
  "Cumplimiento de normas",
  "Porcentaje de intervalos de 10 min dentro de los límites de una norma de calidad de energía, por equipo e indicador.",
  {
    buildingKey: z.string(),
    dias: z.number().int().min(1).max(31).default(7),
    norma: z.enum(["ntsd", "ieee519", "en50160"]).default("ntsd"),
  },
  ({ buildingKey, dias, norma }) => api(`/pilot/${enc(buildingKey)}/cumplimiento`, { dias, norma }),
);

reg(
  "piloto_pronostico",
  "Pronóstico",
  "Historia por hora y pronóstico (con banda) de una métrica de un equipo.",
  {
    id: z.string(),
    metrica: z.string(),
    dias: z.number().int().min(3).max(60).default(14).describe("Días de historia usados"),
    horizonte: z.number().int().min(1).max(14).default(7).describe("Días a pronosticar"),
  },
  ({ id, metrica, dias, horizonte }) => api(`/pilot/devices/${enc(id)}/pronostico`, { metric: metrica, dias, horizonte }),
);

reg(
  "piloto_espectro",
  "Espectro de armónicos",
  "Espectro de armónicos guardado de un equipo: el más reciente o el último antes de una fecha.",
  { id: z.string(), hasta: z.string().optional().describe("Fecha/hora ISO 8601; vacío = el más reciente") },
  ({ id, hasta }) => api(`/pilot/devices/${enc(id)}/espectro`, { at: hasta }),
);

reg(
  "piloto_umbrales",
  "Umbrales de un equipo",
  "Norma y límites efectivos (tensión, desbalance, THD, flicker, FP...) configurados para un equipo.",
  { id: z.string() },
  ({ id }) => api(`/pilot/devices/${enc(id)}/umbrales`),
);

reg(
  "normas",
  "Normas de calidad de energía",
  "Catálogo de normas (NTSD, IEEE 519, EN 50160) con sus límites por defecto.",
  {},
  () => api("/pilot/normas"),
);

// ---------------------------------------------------------------- Arranque
if (process.argv.includes("--check")) {
  // Prueba de conexion fuera de un cliente MCP: node server.js --check
  try {
    const agentes = await api("/agents");
    console.log(`OK: API ${API_URL} responde; ${Array.isArray(agentes) ? agentes.length : "?"} agente(s).`);
    process.exit(0);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

await server.connect(new StdioServerTransport());
log(`listo; API ${API_URL}${API_KEY ? "" : " (SIN SIASA_API_KEY)"}`);
