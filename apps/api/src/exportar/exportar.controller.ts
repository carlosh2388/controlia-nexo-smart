import { Controller, Get, Query, Res, UseGuards, Version } from "@nestjs/common";
import { Role } from "@prisma/client";
import type { FastifyReply } from "fastify";
import { AuthGuard } from "../auth/guards/auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { ActionGuard, RequireAction } from "../access/action.guard";
import { ExportarHistorialDto } from "./exportar.dto";
import { ExportarService } from "./exportar.service";

/** Exportacion de historial de metricas por sede y equipo (solo administradores). */
@Controller("exportar")
@UseGuards(AuthGuard, RolesGuard, ActionGuard)
export class ExportarController {
  constructor(private readonly exportar: ExportarService) {}

  @Version("1")
  @Roles(Role.admin)
  @RequireAction("excel")
  @Get("historial")
  async historial(@CurrentUser() user: AuthenticatedUser, @Query() q: ExportarHistorialDto, @Res() res: FastifyReply) {
    const { buf, archivo } = await this.exportar.historial(q, user?.username ?? "admin");
    res
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="${archivo}"`)
      .send(buf);
  }
}
