import { Body, Controller, Get, Param, ParseIntPipe, DefaultValuePipe, Post, Put, Query, UseGuards, Version } from "@nestjs/common";
import { Role } from "@prisma/client";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { AuthGuard } from "../../auth/guards/auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { GestionService } from "./gestion.service";
import { OrdenesAgenteService } from "./ordenes-agente.service";
import { PlanAgenteService } from "./plan-agente.service";

class ResultadoOrdenDto {
  @IsBoolean()
  ok!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  error?: string;
}

class AsignarGestionDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @Type(() => String)
  deviceIds!: string[];

  /** "agente" = lo maneja el Agente_Go de esta ruta; "api" = vuelve a la API central. */
  @IsIn(["agente", "api"])
  gestor!: "agente" | "api";
}

const HUMANS = [Role.admin, Role.operator, Role.viewer];

/**
 * Equipos que maneja un Agente_Go (lectura y ordenes) en lugar de la API central. Se pasan uno por
 * uno desde la web; si el agente se cae, la API los retoma sola (ver GestionService).
 */
@Controller("agents")
@UseGuards(AuthGuard, RolesGuard)
export class GestionController {
  constructor(
    private readonly gestion: GestionService,
    private readonly ordenes: OrdenesAgenteService,
    private readonly plan: PlanAgenteService,
  ) {}

  /** El agente pide sus ordenes: si no hay, la peticion espera hasta `esperar` segundos (max 25). */
  @Version("1")
  @Roles(Role.agent)
  @Get(":buildingKey/ordenes")
  tomar(
    @Param("buildingKey") buildingKey: string,
    @Query("esperar", new DefaultValuePipe(25), ParseIntPipe) esperar: number,
  ) {
    return this.ordenes.tomar(buildingKey, Math.min(Math.max(esperar, 0), 25) * 1000);
  }

  @Version("1")
  @Roles(Role.agent)
  @Post(":buildingKey/ordenes/:id/resultado")
  resultado(@Param("buildingKey") buildingKey: string, @Param("id") id: string, @Body() dto: ResultadoOrdenDto) {
    return this.ordenes.resultado(buildingKey, id, dto.ok, dto.error);
  }

  /** Que tiene que leer el agente y como (misma configuracion que usan los adaptadores de la API). */
  @Version("1")
  @Roles(Role.agent, Role.admin)
  @Get(":buildingKey/plan")
  verPlan(@Param("buildingKey") buildingKey: string) {
    return this.plan.plan(buildingKey);
  }

  /** Para la web: equipos que puede manejar este agente y quien los maneja hoy. */
  @Version("1")
  @Roles(...HUMANS)
  @Get(":buildingKey/gestion")
  verGestion(@Param("buildingKey") buildingKey: string) {
    return this.plan.listaGestion(buildingKey, this.ordenes.canalVivo(buildingKey));
  }

  @Version("1")
  @Roles(Role.admin)
  @Put(":buildingKey/gestion")
  async asignar(@Param("buildingKey") buildingKey: string, @Body() dto: AsignarGestionDto) {
    const cambiados = await this.gestion.asignar(dto.deviceIds, dto.gestor === "agente" ? buildingKey : null);
    return { cambiados };
  }
}
