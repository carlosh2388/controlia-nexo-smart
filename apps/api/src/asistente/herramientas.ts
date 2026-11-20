import type Anthropic from "@anthropic-ai/sdk";

/**
 * Herramientas de Gravix IA. Todas son de SOLO LECTURA: consultan esta misma API con el token del
 * usuario que pregunta (asi respetan sus permisos y sedes). Ninguna envia comandos a los equipos.
 * "navegar" no lee nada: le pide a la web que abra una pantalla del Centro de mando.
 */
export const HERRAMIENTAS: Anthropic.Beta.BetaTool[] = [
  {
    name: "red_resumen",
    description:
      "Estado actual de TODA la red del Centro de mando: telemetrías (grupos de sedes: Telemetría 1, 2, 3...), cada sede " +
      "con su telemetría, nivel, si responde, medidores, alarmas abiertas y cada equipo con su estado y última lectura " +
      "(kW, voltaje y corriente promedio, fuente comercial/generador). También lista las sedes nuevas leídas por Agentes Go " +
      "con sus buildingKey (úselos en piloto_equipos y eventos_sede). Úsela primero para casi cualquier pregunta.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "centro_eventos",
    description: "Alarmas/eventos de una sede del monitoreo central en los últimos N días (abiertos y cerrados, con duración y correos enviados). Opcionalmente de un equipo.",
    input_schema: {
      type: "object",
      properties: {
        sede: { type: "string", description: "id de la sede, como en red_resumen (p. ej. escuintla)" },
        dispositivo: { type: "string", description: "Inventario o nombre del equipo (opcional)" },
        dias: { type: "integer", minimum: 1, maximum: 90, description: "Días hacia atrás (por defecto 30)" },
      },
      required: ["sede"],
      additionalProperties: false,
    },
  },
  {
    name: "centro_historial_medidor",
    description: "Historial de un medidor de una sede del monitoreo central: kW, voltaje y corriente promedio por intervalo.",
    input_schema: {
      type: "object",
      properties: {
        sede: { type: "string" },
        medidor: { type: "string", description: "Inventario o nombre del medidor, como en red_resumen" },
        minutos: { type: "integer", minimum: 5, maximum: 129600, description: "Ventana hacia atrás (por defecto 1440 = 24 h; máx. 90 días)" },
      },
      required: ["sede", "medidor"],
      additionalProperties: false,
    },
  },
  {
    name: "piloto_equipos",
    description: "Equipos de energía (ION7400, PM2130, generadores) leídos directo por el Agente Go de una sede, con sus métricas disponibles y últimas lecturas.",
    input_schema: {
      type: "object",
      properties: { buildingKey: { type: "string", description: "Agente de la sede, p. ej. igss-escuintla o igss-escuintla-directo" } },
      required: ["buildingKey"],
      additionalProperties: false,
    },
  },
  {
    name: "piloto_serie",
    description: "Serie de tiempo de una métrica de un equipo (p. ej. active_power_total, voltage_a_n, current_a, thd_voltage_a, frequency).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "id del equipo (de piloto_equipos)" },
        metrica: { type: "string" },
        minutos: { type: "integer", minimum: 5, maximum: 10080, description: "Ventana hacia atrás (por defecto 60; máx. 7 días)" },
      },
      required: ["id", "metrica"],
      additionalProperties: false,
    },
  },
  {
    name: "piloto_comparar",
    description: "Compara la lectura directa del equipo (Modbus del Agente Go) con la del EBO/AS-P para las mismas variables.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, minutos: { type: "integer", minimum: 5, maximum: 10080 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "piloto_huecos",
    description: "Periodos sin datos (huecos) de un equipo, con su causa y estado.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, dias: { type: "integer", minimum: 1, maximum: 90 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "piloto_cumplimiento",
    description: "Porcentaje de intervalos de 10 min dentro de los límites de una norma de calidad de energía, por equipo e indicador.",
    input_schema: {
      type: "object",
      properties: {
        buildingKey: { type: "string" },
        dias: { type: "integer", minimum: 1, maximum: 31 },
        norma: { type: "string", enum: ["ntsd", "ieee519", "en50160"] },
      },
      required: ["buildingKey"],
      additionalProperties: false,
    },
  },
  {
    name: "piloto_pronostico",
    description: "Historia por hora y pronóstico (con banda) de una métrica de un equipo.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        metrica: { type: "string" },
        dias: { type: "integer", minimum: 3, maximum: 60, description: "Días de historia usados" },
        horizonte: { type: "integer", minimum: 1, maximum: 14, description: "Días a pronosticar" },
      },
      required: ["id", "metrica"],
      additionalProperties: false,
    },
  },
  {
    name: "piloto_umbrales",
    description: "Norma y límites efectivos (tensión, desbalance, THD, flicker, FP...) configurados para un equipo.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "normas",
    description: "Catálogo de normas de calidad de energía (NTSD, IEEE 519, EN 50160) con sus límites por defecto.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "eventos_sede",
    description: "Eventos detectados por el Agente Go de una sede (cambio a planta, generador, voltaje, puertas, sensores sin comunicación...), del más reciente al más antiguo.",
    input_schema: {
      type: "object",
      properties: {
        buildingKey: { type: "string" },
        desde: { type: "string", description: "Fecha/hora ISO 8601 de inicio" },
        hasta: { type: "string", description: "Fecha/hora ISO 8601 de fin" },
        tipo: { type: "string", description: "Prefijo del tipo, p. ej. generator o energy.source" },
        severidad: { type: "string", enum: ["info", "warning", "critical"] },
        limite: { type: "integer", minimum: 1, maximum: 300 },
      },
      required: ["buildingKey"],
      additionalProperties: false,
    },
  },
  {
    name: "analitica_riesgos",
    description:
      "Analítica predictiva calculada en este servidor con el historial por minuto de cada medidor (últimos 14 días): " +
      "riesgos por equipo (desconexión con su probabilidad en 7 días, voltaje fuera o hacia el límite, aumento de demanda, " +
      "cortes de comunicación de la sede, lecturas congeladas, arranques de generador) con detalle y recomendación, y " +
      "sedes24h: lo ocurrido en las últimas 24 horas por sede. Úsela para preguntas de qué puede fallar, tendencias o mantenimiento.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "navegar",
    description:
      "Abre una pantalla en la web del usuario. Úsela cuando el usuario pida ver, abrir o ir a algo, o cuando mostrar la " +
      "pantalla ayude a su respuesta. Destinos del Centro de mando: inicio (mapa de la red), vista (incidentes, ranking, " +
      "normas, prediccion, alarmas = alarmas y correos, solo administradores), sede, equipo (de una sede, con pestaña opcional) " +
      "o alertas (centro de alertas, de toda la red o de una sede). Destino aplicacion: otra pestaña de la aplicación " +
      "(centro, operativa, edificio, gestion, sedes, equipos, piloto, usuarios). Solo cambia la pantalla.",
    input_schema: {
      type: "object",
      properties: {
        destino: { type: "string", enum: ["inicio", "vista", "sede", "equipo", "alertas", "aplicacion"] },
        vista: { type: "string", enum: ["mapa", "incidentes", "ranking", "normas", "prediccion", "alarmas"] },
        sede: { type: "string", description: "id o nombre de la sede" },
        equipo: { type: "string", description: "Nombre o inventario del equipo" },
        pestana: { type: "string", enum: ["equipo", "tendencias", "calidad", "comparativo", "alarmas", "bitacora", "info"] },
        aplicacion: { type: "string", enum: ["centro", "operativa", "edificio", "gestion", "sedes", "equipos", "piloto", "usuarios"] },
      },
      required: ["destino"],
      additionalProperties: false,
    },
  },
];

/** Pantalla que la web debe abrir (la arma la herramienta "navegar"). */
export interface AccionNavegar {
  destino: "inicio" | "vista" | "sede" | "equipo" | "alertas" | "aplicacion";
  vista?: string;
  sede?: string;
  equipo?: string;
  pestana?: string;
  aplicacion?: string;
}
