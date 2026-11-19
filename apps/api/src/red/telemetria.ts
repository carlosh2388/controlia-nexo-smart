import type { PrismaService } from "../prisma/prisma.service";

/**
 * Armado de la respuesta v1 de Telemetria 1 (api-SIASA): { devices: [...], lectura }.
 * Lo usan el servidor central (GET /red/sedes/:id/telemetria) y el Gravix de sede (GET /sede/telemetria).
 */

/** Ficha del dispositivo: los mismos campos que la respuesta v1 de Telemetria 1 (api-SIASA). */
export const FICHA = ["area", "building", "floor", "group", "room", "fase_energy", "code_inventory", "capacity"] as const;

export interface DeviceMeta {
  model?: string | null;
  attributes?: Record<string, unknown>;
  agent?: { buildingKey?: string };
}

/** Unidad de una metrica a partir de su clave (las claves del agente son las mismas del perfil EBO). */
export function unidad(k: string): string {
  if (/^harm_/.test(k)) return /^harm_v/.test(k) ? "V" : "A";
  if (/thd|load_metering|fuel_level/.test(k)) return "%";
  if (/power_factor|pf_/.test(k)) return "";
  if (/^energy_active|_kwh$/.test(k)) return "kWh";
  if (/^energy_reactive|_kvarh$/.test(k)) return "kVArh";
  if (/^energy_apparent|_kvah$/.test(k)) return "kVAh";
  if (/reactive_power/.test(k)) return "kVAr";
  if (/apparent_power|kva/.test(k)) return "kVA";
  if (/active_power|demand|_kw_|kw_total/.test(k)) return "kW";
  if (/voltage/.test(k)) return "V";
  if (/current/.test(k)) return "A";
  if (/frequency/.test(k)) return "Hz";
  if (/flicker|pst/.test(k)) return "Pst";
  if (/temp/.test(k)) return "°C";
  if (/pressure/.test(k)) return "psi";
  if (/speed/.test(k)) return "RPM";
  return "";
}

/**
 * Equipos Modbus de los agentes indicados con su estado. `agentes === null` = todos los equipos que
 * envio cualquier agente (en un Gravix de sede la base solo tiene los de esa sede).
 */
export async function equiposDeAgentes(prisma: PrismaService, agentes: string[] | null) {
  if (agentes && !agentes.length) return [];
  return prisma.device.findMany({
    where: agentes
      ? { protocol: "modbus", OR: agentes.map((k) => ({ metadata: { path: ["agent", "buildingKey"], equals: k } })) }
      : { protocol: "modbus" },
    include: { state: true },
    orderBy: { name: "asc" },
  });
}

type Equipo = Awaited<ReturnType<typeof equiposDeAgentes>>[number];

/** Tipo de equipo (ion, pm, generator) a partir del modelo, igual que en Telemetria 1. */
export function tipoDe(meta: DeviceMeta) {
  const a = meta.attributes ?? {};
  const modelo = String(meta.model ?? a.model ?? "");
  const tipo = /7400|ION/i.test(modelo) ? "ion" : /2130|PM/i.test(modelo) ? "pm" : /gen/i.test(modelo) || a.category === "generator" ? "generator" : "unknown";
  return { tipo, modelo };
}

export function armarTelemetria(equipos: Equipo[], sede: { nombre: string; codigo: string }) {
  const cuenta: Record<string, number> = {};
  const devices = equipos.map((d) => {
    const meta = (d.metadata as DeviceMeta | null) ?? {};
    const a = meta.attributes ?? {};
    const { tipo, modelo } = tipoDe(meta);
    const model = tipo === "ion" ? "7400" : tipo === "pm" ? "2130" : modelo;
    cuenta[tipo] = (cuenta[tipo] ?? 0) + 1;
    const base = tipo === "ion" ? "ion_7400" : tipo === "pm" ? "pm_2130" : tipo === "generator" ? "generador" : "equipo";
    const ficha: Record<string, unknown> = {};
    for (const k of FICHA) if (a[k] !== undefined && a[k] !== "") ficha[k] = a[k];
    // Compatibilidad con los atributos que ya usaban los equipos de Escuintla.
    if (ficha.fase_energy === undefined && a.phase) ficha.fase_energy = a.phase;
    if (ficha.code_inventory === undefined && a.code) ficha.code_inventory = a.code;
    if (ficha.capacity === undefined && a.capacityKva) ficha.capacity = a.capacityKva;
    const readings = (d.state?.readings as Record<string, unknown> | null) ?? {};
    const metrics: Record<string, { value: number; unit: string }> = {};
    for (const [k, v] of Object.entries(readings)) {
      if (typeof v === "number" && Number.isFinite(v) && !/^harm_/.test(k) && k !== "harm_read_at") metrics[k] = { value: v, unit: unidad(k) };
    }
    return {
      device_id: String(a.device_id ?? `${base}_${cuenta[tipo]}`),
      name: d.name,
      type: tipo,
      model,
      online: String(d.state?.state === "online"),
      ...ficha,
      metrics,
    };
  });
  return { devices, lectura: { sede: sede.nombre, codigo: sede.codigo, generado: new Date().toISOString() } };
}
