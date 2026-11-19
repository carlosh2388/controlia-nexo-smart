import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards, Version } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthGuard } from "../auth/guards/auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { RedService } from "./red.service";
import { GrupoDto, SedeDto } from "./dto/red.dto";

const HUMANS = [Role.admin, Role.operator, Role.viewer];

/** Red del centro de mando: grupos por fase (Telemetria 1, 2, 3) y sedes nuevas leidas por Agentes Go. */
@Controller("red")
@UseGuards(AuthGuard, RolesGuard)
export class RedController {
  constructor(private readonly red: RedService) {}

  @Version("1")
  @Roles(...HUMANS)
  @Get()
  listar() {
    return this.red.listar();
  }

  @Version("1")
  @Roles(Role.admin)
  @Post("grupos")
  crearGrupo(@Body() dto: GrupoDto) {
    return this.red.crearGrupo(dto);
  }

  @Version("1")
  @Roles(Role.admin)
  @Patch("grupos/:id")
  editarGrupo(@Param("id") id: string, @Body() dto: GrupoDto) {
    return this.red.editarGrupo(id, dto);
  }

  @Version("1")
  @Roles(Role.admin)
  @Delete("grupos/:id")
  borrarGrupo(@Param("id") id: string) {
    return this.red.borrarGrupo(id);
  }

  @Version("1")
  @Roles(Role.admin)
  @Put("sedes/:id")
  guardarSede(@Param("id") id: string, @Body() dto: SedeDto) {
    return this.red.guardarSede(id, dto);
  }

  @Version("1")
  @Roles(Role.admin)
  @Delete("sedes/:id")
  borrarSede(@Param("id") id: string) {
    return this.red.borrarSede(id);
  }

  /** Respuesta de la sede en el formato v1 de Telemetria 1 (devices con su ficha y metricas). */
  @Version("1")
  @Roles(...HUMANS)
  @Get("sedes/:id/telemetria")
  telemetria(@Param("id") id: string) {
    return this.red.telemetria(id);
  }
}
