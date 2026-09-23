import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import { PrismaService } from "../prisma/prisma.service";
import { sanitizeDevice } from "../devices/device-secrets.util";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { CreateAreaDto } from "./dto/create-area.dto";
import { getAreaUploadsDir, AREA_UPLOADS_URL_PREFIX } from "./area-uploads.util";

const ALLOWED_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** "Sala Reuniones" -> "sala-reuniones"; sin acentos ni caracteres especiales. */
function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

@Injectable()
export class AreasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Guarda la foto subida para una area y devuelve la ruta publica (/uploads/areas/<archivo>) a usar como imageFile. */
  async saveAreaImage(file: MultipartFile): Promise<string> {
    const ext = ALLOWED_MIME_TO_EXT[file.mimetype];
    if (!ext) {
      throw new BadRequestException("Formato no soportado. Usa JPG, PNG o WEBP.");
    }

    const uploadsDir = getAreaUploadsDir(this.config);
    const filename = `${randomUUID()}${ext}`;
    const dest = path.join(uploadsDir, filename);
    try {
      await pipeline(file.file, fs.createWriteStream(dest));
    } catch (err) {
      await fs.promises.unlink(dest).catch(() => undefined);
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        throw new BadRequestException("La imagen supera el tamaño maximo permitido (8MB).");
      }
      throw err;
    }

    return `${AREA_UPLOADS_URL_PREFIX}${filename}`;
  }

  /** Sin tenantId explicito, se usa el primero creado (comportamiento original de un solo tenant). */
  private async resolveTenant(tenantId?: string) {
    const tenant = tenantId
      ? await this.prisma.tenant.findUnique({ where: { id: tenantId } })
      : await this.prisma.tenant.findFirst({ orderBy: { createdAt: "asc" } });
    if (!tenant) {
      throw new NotFoundException("No hay ningun tenant configurado todavia");
    }
    return tenant;
  }

  async listTenants() {
    return this.prisma.tenant.findMany({ orderBy: { createdAt: "asc" } });
  }

  async findAll(tenantId?: string) {
    const tenant = await this.resolveTenant(tenantId);
    const areas = await this.prisma.area.findMany({
      where: { tenantId: tenant.id },
      orderBy: { order: "asc" },
      include: { devices: { include: { state: true } } },
    });

    return {
      tenant,
      areas: areas.map((area) => ({
        ...area,
        devices: area.devices.map(sanitizeDevice),
      })),
    };
  }

  /** Todas las areas de todos los tenants, para selectores globales (ej. asignar area a un dispositivo). */
  async findAllFlat() {
    return this.prisma.area.findMany({
      orderBy: [{ tenant: { createdAt: "asc" } }, { order: "asc" }],
      select: {
        id: true,
        name: true,
        tenantId: true,
        tenant: { select: { level: true } },
      },
    });
  }

  async createTenant(dto: CreateTenantDto) {
    return this.prisma.tenant.create({ data: dto });
  }

  async createArea(dto: CreateAreaDto) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: dto.tenantId } });
    if (!tenant) {
      throw new NotFoundException("Tenant no encontrado");
    }

    const baseSlug = slugify(dto.name);
    let slug = baseSlug;
    let suffix = 2;
    while (await this.prisma.area.findFirst({ where: { tenantId: dto.tenantId, slug } })) {
      slug = `${baseSlug}-${suffix++}`;
    }
    if (!baseSlug) {
      throw new ConflictException("El nombre del area debe incluir al menos una letra o numero");
    }

    const maxOrder = await this.prisma.area.aggregate({
      where: { tenantId: dto.tenantId },
      _max: { order: true },
    });

    return this.prisma.area.create({
      data: {
        tenantId: dto.tenantId,
        name: dto.name,
        slug,
        imageFile: dto.imageFile || "",
        order: dto.order ?? (maxOrder._max.order ?? -1) + 1,
      },
    });
  }

  async findOne(id: string) {
    const area = await this.prisma.area.findUnique({
      where: { id },
      include: { devices: { include: { state: true } } },
    });
    if (!area) {
      throw new NotFoundException("Area no encontrada");
    }
    return { ...area, devices: area.devices.map(sanitizeDevice) };
  }
}
