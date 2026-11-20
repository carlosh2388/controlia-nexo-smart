/**
 * Configuracion del motor de alarmas del Gravix de sede. Mismas variables y mismos valores por
 * defecto que api-SIASA (monitoreo/eventos_modbus.js), para que una sede se configure igual.
 * Variables propias de Gravix: ALERTAS_SEDE, ALARMAS_ACTIVAS, ALARMAS_AGENTES,
 * ALERTA_REGLAS_VIGILANTES y ALERTA_ION_SIN_VIGILANTES.
 */

function num(value: string | undefined, fallback: number) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(String(value).split("#")[0].trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback = false) {
  if (value == null || String(value).trim() === "") return fallback;
  return /^(1|true|si|yes)$/i.test(String(value).trim());
}

function lista(value: string | undefined, porDefecto = "") {
  return String(value ?? porDefecto).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function leerConfig(env: NodeJS.ProcessEnv = process.env) {
  const sede = env.ALERTAS_SEDE || env.SEDE_NOMBRE || "Sede";
  return {
    /** false = el motor no evalua nada (por ejemplo, una sede que todavia no tiene equipos). */
    activas: bool(env.ALARMAS_ACTIVAS, true),
    sede,
    prefijo: `${(env.SEDE_PREFIJO || sede).replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "SED"}G`,
    zona: env.ALERTAS_ZONA_HORARIA || "America/Guatemala",
    urlEstado: env.ALERTAS_URL_ESTADO || "",
    urlMonitoreo: env.ALERTAS_URL_MONITOREO || "",
    /** buildingKey de los agentes cuyos medidores se vigilan (vacio = todos los de esta base). */
    agentes: lista(env.ALARMAS_AGENTES),
    congeladoMs: num(env.ALERTA_CONGELADO_MIN, 5) * 60000,
    degradadoMs: num(env.ALERTA_DEGRADADO_S, 60) * 1000,
    sinCambioMs: num(env.ALERTA_SIN_CAMBIO_MIN, 15) * 60000,
    fueraDeLineaMs: num(env.ALERTA_FUERA_DE_LINEA_MIN, 3) * 60000,
    offlinePorCongeladoMs: num(env.ALERTA_OFFLINE_SIN_CAMBIO_MIN, 5) * 60000,
    transferenciaConfirmacionMs: num(env.ALERTA_TRANSFERENCIA_CONFIRMACION_S, 60) * 1000,
    enCeroMs: num(env.ALERTA_EN_CERO_MIN, 3) * 60000,
    medidoresGenerador: lista(env.MEDIDORES_GENERADOR),
    generadorConfirmacionMs: num(env.ALERTA_GENERADOR_CONFIRMACION_S, 60) * 1000,
    generadorCorreo: bool(env.ALERTA_GENERADOR_CORREO, true),
    recordatorioMs: num(env.ALERTA_RECORDATORIO_HORAS, 4) * 3600000,
    esperaRestauracionMs: num(env.ALERTA_ESPERA_RESTAURACION_S, 60) * 1000,
    agruparAdvertenciasMs: num(env.ALERTA_AGRUPAR_ADVERTENCIAS_MIN, 15) * 60000,
    maxCorreosPorHora: num(env.ALERTA_MAX_CORREOS_POR_HORA, 20),
    resumenDiarioHora: env.ALERTA_RESUMEN_DIARIO_HORA || "07:00",
    resumenDiarioCorreo: bool(env.ALERTA_RESUMEN_DIARIO_CORREO, true),
    retencionMeses: num(env.EVENTOS_RETENCION_MESES, 12),
    /** Reglas de los vigilantes S1/S2 de los ION (en api-SIASA solo corren en la sede "Escuintla"). */
    reglasVigilantes: bool(env.ALERTA_REGLAS_VIGILANTES, /escuintla/i.test(sede)),
    /** ION cuyos vigilantes no estan conectados fisicamente (regla "ION desconectado"). */
    ionSinVigilantes: lista(env.ALERTA_ION_SIN_VIGILANTES, "ion_7400_3,ion_7400_4"),
    correo: {
      activo: bool(env.ALERTAS_CORREO_ACTIVO, false),
      host: env.SMTP_HOST || "",
      port: num(env.SMTP_PORT, 587),
      secure: bool(env.SMTP_SEGURO, false),
      user: env.SMTP_USUARIO || "",
      pass: env.SMTP_CLAVE || "",
      de: env.ALERTAS_CORREO_DE || env.SMTP_USUARIO || "",
      para: env.ALERTAS_CORREO_PARA || "",
      cc: env.ALERTAS_CORREO_CC || "",
    },
  };
}

export type ConfigAlarmas = ReturnType<typeof leerConfig>;

/**
 * Variables que se pueden cambiar desde el Centro de mando (modulo "Alarmas y correos"), con su tipo.
 * Lo guardado en alarma_config tiene prioridad sobre el .env de la sede.
 */
export const EDITABLES: Record<string, "bool" | "num" | "texto" | "hora" | "clave"> = {
  ALARMAS_ACTIVAS: "bool",
  ALERTAS_CORREO_ACTIVO: "bool",
  ALERTAS_CORREO_PARA: "texto",
  ALERTAS_CORREO_CC: "texto",
  ALERTAS_CORREO_DE: "texto",
  SMTP_HOST: "texto",
  SMTP_PORT: "num",
  SMTP_SEGURO: "bool",
  SMTP_USUARIO: "texto",
  SMTP_CLAVE: "clave",
  ALERTA_FUERA_DE_LINEA_MIN: "num",
  ALERTA_OFFLINE_SIN_CAMBIO_MIN: "num",
  ALERTA_EN_CERO_MIN: "num",
  ALERTA_SIN_CAMBIO_MIN: "num",
  ALERTA_CONGELADO_MIN: "num",
  ALERTA_TRANSFERENCIA_CONFIRMACION_S: "num",
  ALERTA_RECORDATORIO_HORAS: "num",
  ALERTA_MAX_CORREOS_POR_HORA: "num",
  ALERTA_RESUMEN_DIARIO_CORREO: "bool",
  ALERTA_RESUMEN_DIARIO_HORA: "hora",
  MEDIDORES_GENERADOR: "texto",
};

/** Valida y normaliza un cambio de configuracion. Devuelve el mapa limpio o lanza un mensaje de error. */
export function validarCambios(entrada: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entrada ?? {})) {
    const tipo = EDITABLES[k];
    if (!tipo) throw new Error(`No se puede cambiar ${k} desde el Centro de mando`);
    const s = v == null ? "" : String(v).trim();
    if (tipo === "bool" && !/^(true|false)$/.test(s)) throw new Error(`${k} debe ser true o false`);
    if (tipo === "num" && (s === "" || !Number.isFinite(Number(s)) || Number(s) < 0 || Number(s) > 100000)) throw new Error(`${k} debe ser un número mayor o igual a 0`);
    if (tipo === "hora" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error(`${k} debe tener formato HH:MM`);
    if (s.length > 1000) throw new Error(`${k} es demasiado largo`);
    if ((k === "ALERTAS_CORREO_PARA" || k === "ALERTAS_CORREO_CC") && s && !s.split(",").every((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.trim()))) {
      throw new Error(`${k}: escriba correos válidos separados por coma`);
    }
    out[k] = s;
  }
  return out;
}

export const SEVERIDAD_TEXTO: Record<string, string> = { critico: "CRÍTICO", advertencia: "ADVERTENCIA", info: "INFORMATIVO" };

export interface Guia {
  titulo: string;
  tituloCierre?: string;
  causa: string | null;
  accion: string[];
}

/**
 * Causa probable y accion sugerida por tipo de evento (lo que llega en el correo). Mismos eventos que
 * api-SIASA. Donde api-SIASA habla del EBO/WorkStation (lee los medidores a traves del AS-P), aqui
 * se habla de la lectura directa del Agente Go, que es como lee Gravix.
 */
export const GUIA: Record<string, Guia> = {
  DATOS_CONGELADOS: {
    titulo: "Datos congelados: Gravix no recibe lecturas del Agente Go",
    causa: "El Agente Go de la sede está detenido o no alcanza a Gravix (contenedor caído, red interna de la VM, o la VM se reinició).",
    accion: [
      "En la VM de la sede: docker compose ps (el servicio 'agente' debe estar 'Up').",
      "Revisar el log del agente: docker compose logs --tail 50 agente.",
      "Mientras dure, los valores del Centro de mando NO son actuales. El agente guarda lo leído y lo reenvía cuando vuelve.",
    ],
  },
  MEDIDOR_SIN_CAMBIO: {
    titulo: "Medidor sin cambio",
    causa: "El medidor responde pero repite los mismos valores.",
    accion: [
      "Revisar en la pantalla del medidor si los valores cambian.",
      "Si en la pantalla sí cambian: escalar a soporte SIASA (falla de lectura de Gravix).",
    ],
  },
  MEDIDOR_FUERA_DE_LINEA: {
    titulo: "Medidor fuera de línea",
    tituloCierre: "Medidor en línea de nuevo",
    causa: "El Agente Go no obtiene lecturas del medidor: medidor apagado, cable de red o RS-485, gateway Modbus, o dirección/unit ID.",
    accion: [
      "Verificar que la pantalla del medidor esté encendida.",
      "Revisar la red hacia la IP del medidor (o de su gateway RS-485).",
      "Revisar alimentación y cableado (técnico de campo).",
    ],
  },
  MEDIDOR_SIN_TRANSFERENCIA: {
    titulo: "Medidor sin transferencia: S1 y S2 en false",
    tituloCierre: "Transferencia restablecida: medidor con fuente activa",
    causa: "El ION informa S1 y S2 en false y todas sus mediciones en cero: no hay fuente activa.",
    accion: ["Revisar las señales S1 y S2 del ION.", "Confirmar con mantenimiento el estado real de la transferencia."],
  },
  MEDIDOR_VIGILANTES_DESCONECTADOS: {
    titulo: "Vigilantes desconectados: S1 y S2 en cero",
    tituloCierre: "Vigilantes restablecidos",
    causa: "S1 y S2 estan en cero, pero el ION entrega mediciones.",
    accion: ["Verificar el equipo y las conexiones de los vigilantes S1 y S2."],
  },
  MEDIDOR_ION_DESCONECTADO: {
    titulo: "ION desconectado: comercial en 1 sin mediciones",
    tituloCierre: "ION con mediciones nuevamente",
    causa: "S1 (comercial) esta en 1 y S2 en 0, pero todas las metricas del ION estan en cero. Los vigilantes S1 y S2 de este ION no estan conectados fisicamente; S1 en 1 no confirma comunicacion del ION.",
    accion: ["Se sugiere revisar el dispositivo ION, su alimentacion y su comunicacion."],
  },
  MEDIDOR_EN_CERO: {
    titulo: "Medidor con voltaje en cero",
    causa: "Corte de energía real en ese tablero, o falla de lectura.",
    accion: ["Confirmar con mantenimiento si hubo corte en ese tablero.", "Si es un corte real: seguir el protocolo eléctrico del hospital."],
  },
  GENERADOR_EN_MARCHA: {
    titulo: "Generador en marcha",
    tituloCierre: "Generador apagado",
    causa: "Este medidor solo registra voltaje cuando el generador está encendido: hubo transferencia a generador (corte de la red comercial o prueba programada).",
    accion: [
      "Confirmar con mantenimiento si es un corte de la energía comercial o una prueba del generador.",
      "Si es un corte: seguir el protocolo eléctrico del hospital y vigilar el combustible y el tiempo de marcha.",
    ],
  },
  API_REINICIADA: {
    titulo: "Gravix reiniciado",
    causa: "Reinicio manual, de la VM o actualización de Gravix.",
    accion: ["Verificar que el estado vuelva a 'ok' en menos de 1 minuto."],
  },
};
