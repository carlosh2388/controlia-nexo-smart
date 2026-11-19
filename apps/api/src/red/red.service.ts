import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { GrupoDto, SedeDto } from "./dto/red.dto";

/** Ficha del dispositivo: los mismos campos que la respuesta v1 de Telemetria 1 (api-SIASA). */
const FICHA = ["area", "building", "floor", "group", "room", "fase_energy", "code_inventory", "capacity"] as const;

interface DeviceMeta {
  model?: string | null;
  attributes?: Record<string, unknown>;
  agent?: { buildingKey?: string };
}

const slug = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Unidad de una metrica a partir de su clave (las claves del agente son las mismas del perfil EBO). */
function unidad(k: string): string {
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

@Injectable()
export class RedService {
  constructor(private readonly prisma: PrismaService) {}

  async listar() {
    const [grupos, sedes] = await Promise.all([
      this.prisma.redGrupo.findMany({ orderBy: [{ orden: "asc" }, { nombre: "asc" }] }),
      this.prisma.redSede.findMany({ orderBy: [{ orden: "asc" }, { nombre: "asc" }] }),
    ]);
    return { grupos, sedes };
  }

  async crearGrupo(dto: GrupoDto) {
    if (!dto.nombre) throw new BadRequestException("Falta el nombre del grupo");
    let id = slug(dto.nombre).slice(0, 36) || "grupo";
    if (await this.prisma.redGrupo.findUnique({ where: { id } })) id = `${id}_${Date.now().toString(36)}`;
    const max = await this.prisma.redGrupo.aggregate({ _max: { orden: true } });
    return this.prisma.redGrupo.create({
      data: { id, nombre: dto.nombre, color: dto.color ?? "#64748b", orden: dto.orden ?? (max._max.orden ?? 0) + 1 },
    });
  }

  async editarGrupo(id: string, dto: GrupoDto) {
    await this.existeGrupo(id);
    return this.prisma.redGrupo.update({ where: { id }, data: { nombre: dto.nombre, color: dto.color, orden: dto.orden } });
  }

  /** Borra el grupo; sus sedes quedan sin grupo (las del monitoreo central vuelven a Telemetria 1). */
  async borrarGrupo(id: string) {
    await this.existeGrupo(id);
    await this.prisma.redGrupo.delete({ where: { id } });
    return { ok: true };
  }

  async guardarSede(id: string, dto: SedeDto) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) throw new BadRequestException("Código de sede inválido (minúsculas, números y guiones)");
    if (dto.grupoId) await this.existeGrupo(dto.grupoId);
    const data = {
      nombre: dto.nombre,
      origen: dto.origen,
      grupoId: dto.grupoId ?? null,
      agentes: dto.agentes ?? [],
      lat: dto.lat ?? null,
      lon: dto.lon ?? null,
      plantilla: dto.plantilla ?? null,
      orden: dto.orden ?? 0,
    };
    return this.prisma.redSede.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  async borrarSede(id: string) {
    const s = await this.prisma.redSede.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("La sede no existe");
    await this.prisma.redSede.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Respuesta de la sede con el formato v1 de Telemetria 1 (api-SIASA): { devices: [...], lectura }.
   * Cada equipo lleva su ficha (area, building, floor, group, room, fase_energy, code_inventory, capacity)
   * tal como se cargo al agregarlo, y sus metricas { valor, unidad } de la ultima lectura.
   */
  async telemetria(id: string) {
    const sede = await this.prisma.redSede.findUnique({ where: { id } });
    if (!sede) throw new NotFoundException("La sede no existe");
    const keys = sede.agentes;
    const devices = keys.length
      ? await this.prisma.device.findMany({
          where: { protocol: "modbus", OR: keys.map((k) => ({ metadata: { path: ["agent", "buildingKey"], equals: k } })) },
          include: { state: true },
          orderBy: { name: "asc" },
        })
      : [];
    const cuenta: Record<string, number> = {};
    const out = devices.map((d) => {
      const meta = (d.metadata as DeviceMeta | null) ?? {};
      const a = meta.attributes ?? {};
      const modelo = String(meta.model ?? a.model ?? "");
      const tipo = /7400|ION/i.test(modelo) ? "ion" : /2130|PM/i.test(modelo) ? "pm" : /gen/i.test(modelo) || a.category === "generator" ? "generator" : "unknown";
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
    return { devices: out, lectura: { sede: sede.nombre, codigo: sede.id, generado: new Date().toISOString() } };
  }

  private async existeGrupo(id: string) {
    const g = await this.prisma.redGrupo.findUnique({ where: { id } });
    if (!g) throw new NotFoundException("El grupo no existe");
    return g;
  }
}
