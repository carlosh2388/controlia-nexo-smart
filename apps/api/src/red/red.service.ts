import { BadRequestException, BadGatewayException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { GrupoDto, ProbarGravixDto, SedeDto } from "./dto/red.dto";
import { armarTelemetria, equiposDeAgentes } from "./telemetria";
import { GravixService } from "./gravix.service";

const slug = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

@Injectable()
export class RedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gravix: GravixService,
  ) {}

  /** Grupos y sedes. De las sedes Gravix: direccion, final de la clave y estado; nunca la clave. */
  async listar() {
    const [grupos, filas] = await Promise.all([
      this.prisma.redGrupo.findMany({ orderBy: [{ orden: "asc" }, { nombre: "asc" }] }),
      this.prisma.redSede.findMany({ orderBy: [{ orden: "asc" }, { nombre: "asc" }] }),
    ]);
    const sedes = filas.map(({ apiKeyEnc, ...s }) =>
      s.origen === "gravix" ? { ...s, claveFinal: this.gravix.finalDeClave(apiKeyEnc), estado: this.gravix.estadoDe(s.id) } : s,
    );
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
    const anterior = await this.prisma.redSede.findUnique({ where: { id }, select: { alarmasFuente: true } });
    const alarmasFuente = dto.alarmasFuente ?? anterior?.alarmasFuente ?? "api-siasa";
    if (alarmasFuente === "gravix" && dto.origen !== "gravix") {
      throw new BadRequestException("Las alarmas solo se pueden leer de Gravix si la sede tiene su propio Gravix");
    }
    const data = {
      alarmasFuente,
      nombre: dto.nombre,
      origen: dto.origen,
      grupoId: dto.grupoId ?? null,
      agentes: dto.agentes ?? [],
      lat: dto.lat ?? null,
      lon: dto.lon ?? null,
      plantilla: dto.plantilla ?? null,
      orden: dto.orden ?? 0,
      url: null as string | null,
      apiKeyEnc: null as string | null,
    };
    if (dto.origen === "gravix") {
      // Sede con su propio Gravix: se prueba la conexion y sus agentes salen de la propia sede.
      const previa = await this.prisma.redSede.findUnique({ where: { id } });
      const url = (dto.url ?? previa?.url ?? "").replace(/\/$/, "");
      if (!url) throw new BadRequestException("Falta la dirección del Gravix de la sede (ej. http://10.20.5.10:3010)");
      const key = dto.apiKey ?? (previa?.apiKeyEnc ? this.gravix.descifrar(previa.apiKeyEnc) : null);
      if (!key) throw new BadRequestException("Falta la clave de consulta de la sede (CENTRO_API_KEY de su .env)");
      const salud = await this.gravix.probar(url, key);
      data.url = url;
      data.apiKeyEnc = dto.apiKey || !previa?.apiKeyEnc ? this.gravix.cifrar(key) : previa.apiKeyEnc;
      data.agentes = [...new Set(salud.agentes.map((a) => a.buildingKey))].sort();
    }
    const fila = await this.prisma.redSede.upsert({ where: { id }, update: data, create: { id, ...data } });
    if (dto.origen === "gravix" || fila.origen === "gravix") await this.gravix.recargar();
    const { apiKeyEnc, ...out } = fila;
    return { ...out, claveFinal: this.gravix.finalDeClave(apiKeyEnc) };
  }

  async borrarSede(id: string) {
    const s = await this.prisma.redSede.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("La sede no existe");
    await this.prisma.redSede.delete({ where: { id } });
    if (s.origen === "gravix") await this.gravix.recargar();
    return { ok: true };
  }

  async probarGravix(dto: ProbarGravixDto) {
    let key = dto.apiKey;
    if (!key && dto.sedeId) {
      const s = await this.prisma.redSede.findUnique({ where: { id: dto.sedeId } });
      if (s?.apiKeyEnc) key = this.gravix.descifrar(s.apiKeyEnc);
    }
    if (!key) throw new BadRequestException("Escriba la clave de consulta de la sede (CENTRO_API_KEY de su .env)");
    return this.gravix.probar(dto.url, key);
  }

  /**
   * Respuesta de la sede con el formato v1 de Telemetria 1 (api-SIASA): { devices: [...], lectura }.
   * Cada equipo lleva su ficha (area, building, floor, group, room, fase_energy, code_inventory, capacity)
   * tal como se cargo al agregarlo, y sus metricas { valor, unidad } de la ultima lectura.
   * Si la sede tiene su propio Gravix, la respuesta la arma la sede.
   */
  async telemetria(id: string) {
    const sede = await this.prisma.redSede.findUnique({ where: { id } });
    if (!sede) throw new NotFoundException("La sede no existe");
    if (sede.origen === "gravix") {
      const r = await this.gravix.reenviar(id, "/api/v1/sede/telemetria");
      if (r.status !== 200) throw new BadGatewayException(`La sede ${id} no entregó su JSON v1 (HTTP ${r.status})`);
      return JSON.parse(r.body.toString("utf8"));
    }
    const equipos = await equiposDeAgentes(this.prisma, sede.agentes);
    return armarTelemetria(equipos, { nombre: sede.nombre, codigo: sede.id });
  }

  private async existeGrupo(id: string) {
    const g = await this.prisma.redGrupo.findUnique({ where: { id } });
    if (!g) throw new NotFoundException("El grupo no existe");
    return g;
  }
}
