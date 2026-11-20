import { Body, Controller, Get, Headers, Post, UseGuards, Version } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthGuard } from "../auth/guards/auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { AsistenteService } from "./asistente.service";
import { PreguntaDto } from "./asistente.dto";

const HUMANS = [Role.admin, Role.operator, Role.viewer];

/** Gravix IA: preguntas libres sobre el Centro de mando (solo lectura). */
@Controller("asistente")
@UseGuards(AuthGuard, RolesGuard)
export class AsistenteController {
  constructor(private readonly asistente: AsistenteService) {}

  /** La web pregunta si hay IA; sin clave configurada usa solo los comandos fijos. */
  @Version("1")
  @Roles(...HUMANS)
  @Get("estado")
  estado() {
    return this.asistente.estado();
  }

  @Version("1")
  @Roles(...HUMANS)
  @Post("preguntar")
  preguntar(@Body() dto: PreguntaDto, @Headers("authorization") autorizacion: string) {
    return this.asistente.preguntar(dto, autorizacion);
  }
}
