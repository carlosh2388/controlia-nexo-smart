import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { sanitizeDevice } from "../devices/device-secrets.util";

@Injectable()
export class AreasService {
  constructor(private readonly prisma: PrismaService) {}

  /** De momento hay un unico tenant activo; cuando se agreguen mas, este filtro se vuelve un parametro. */
  private async currentTenant() {
    const tenant = await this.prisma.tenant.findFirst({ orderBy: { createdAt: "asc" } });
    if (!tenant) {
      throw new NotFoundException("No hay ningun tenant configurado todavia");
    }
    return tenant;
  }

  async findAll() {
    const tenant = await this.currentTenant();
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
