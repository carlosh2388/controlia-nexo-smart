import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards, Version } from "@nestjs/common";
import { Role } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/guards/auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { AreasService } from "./areas.service";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { CreateAreaDto } from "./dto/create-area.dto";

@Controller("areas")
@UseGuards(AuthGuard, RolesGuard)
export class AreasController {
  constructor(private readonly areasService: AreasService) {}

  @Version("1")
  @Get("tenants")
  listTenants() {
    return this.areasService.listTenants();
  }

  @Version("1")
  @Post("tenants")
  @Roles(Role.admin)
  createTenant(@Body() dto: CreateTenantDto) {
    return this.areasService.createTenant(dto);
  }

  @Version("1")
  @Get("all")
  findAllFlat() {
    return this.areasService.findAllFlat();
  }

  @Version("1")
  @Get()
  findAll(@Query("tenantId") tenantId?: string) {
    return this.areasService.findAll(tenantId);
  }

  @Version("1")
  @Post()
  @Roles(Role.admin)
  createArea(@Body() dto: CreateAreaDto) {
    return this.areasService.createArea(dto);
  }

  /** Sube la foto de un area (multipart/form-data, campo "file"). Devuelve { imageFile } listo para usar al crear/editar el area. */
  @Version("1")
  @Post("upload-image")
  @Roles(Role.admin)
  async uploadImage(@Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) {
      throw new BadRequestException('No se recibio ningun archivo (campo esperado: "file")');
    }
    const imageFile = await this.areasService.saveAreaImage(file);
    return { imageFile };
  }

  @Version("1")
  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.areasService.findOne(id);
  }
}
