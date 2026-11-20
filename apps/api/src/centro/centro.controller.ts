import { Controller, Get, Header, Param, Query, Res, UseGuards, Version } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import type { FastifyReply } from "fastify";
import { AuthGuard } from "../auth/guards/auth.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { AccessService } from "../access/access.service";
import { ActionGuard, RequireAction } from "../access/action.guard";
import { buildXlsx } from "../common/xlsx";
import { CentroService } from "./centro.service";
import { AnaliticaService } from "./analitica.service";

class EventosQuery {
  @IsString() dispositivo!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) dias?: number;
}
class HistorialQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(129600) minutes?: number;
}
class ExportQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(129600) minutes?: number;
  /** Un dato cada N segundos (60, 900, 3600, 86400). */
  @IsOptional() @Type(() => Number) @IsIn([60, 900, 3600, 86400]) step?: number;
  @IsOptional() @IsString() nombre?: string;
}

@Controller("centro")
@UseGuards(AuthGuard, ActionGuard)
export class CentroController {
  constructor(
    private readonly centro: CentroService,
    private readonly access: AccessService,
    private readonly analitica: AnaliticaService,
  ) {}

  @Version("1")
  @Get("vista")
  async vista(@CurrentUser() user: AuthenticatedUser) {
    return this.centro.vistaPara(await this.access.forUser(user));
  }

  /** Analitica predictiva (asistente Gravix): riesgos de desconexion, voltaje, carga y comunicacion. */
  @Version("1")
  @Get("analitica")
  async analiticaRiesgos(@CurrentUser() user: AuthenticatedUser) {
    return this.analitica.para(await this.access.forUser(user));
  }

  @Version("1")
  @Get("sedes/:sede/eventos")
  async eventos(@CurrentUser() user: AuthenticatedUser, @Param("sede") sede: string, @Query() q: EventosQuery) {
    return this.centro.eventos(await this.access.forUser(user), sede, q.dispositivo, q.dias ?? 30);
  }

  @Version("1")
  @Get("sedes/:sede/medidores/:medidor/historial")
  async historial(@CurrentUser() user: AuthenticatedUser, @Param("sede") sede: string, @Param("medidor") medidor: string, @Query() q: HistorialQuery) {
    return this.centro.historial(await this.access.forUser(user), sede, medidor, q.minutes ?? 1440);
  }

  /** Historial del medidor en Excel (kW, V y A promedio por intervalo). */
  @Version("1")
  @RequireAction("excel")
  @Get("sedes/:sede/medidores/:medidor/excel")
  @Header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  async excel(@CurrentUser() user: AuthenticatedUser, @Param("sede") sede: string, @Param("medidor") medidor: string, @Query() q: ExportQuery, @Res() res: FastifyReply) {
    const minutes = q.minutes ?? 10080;
    let step = q.step ?? 900;
    while ((minutes * 60) / step > 50_000 && step < 86400) step = step === 60 ? 900 : step === 900 ? 3600 : 86400;
    const h = await this.centro.historial(await this.access.forUser(user), sede, medidor, minutes, step);
    const nombre = q.nombre || medidor;
    const rows = [["Fecha y hora (Guatemala)", "Potencia kW", "Voltaje L-N prom. (V)", "Corriente prom. (A)", "Estado"] as (string | number | Date | null)[]].concat(
      h.points.map((p) => [new Date(p.t), p.kw, p.v, p.a, p.fuera ? "fuera de línea" : "en línea"]),
    );
    const info = [
      ["Dato", "Valor"],
      ["Sede", sede],
      ["Equipo", nombre],
      ["Periodo", `últimos ${Math.round(minutes / 60)} h`],
      ["Un dato cada", `${step / 60} min (promedio)`],
      ["Origen", "Monitoreo central → EBO de la sede (api-SIASA)"],
      ["Historial guardado desde", h.desde ? new Date(h.desde) : "sin datos"],
      ["Generado", new Date()],
    ];
    const buf = buildXlsx([
      { name: "Historial", rows, widths: [22, 14, 20, 20, 14] },
      { name: "Información", rows: info, widths: [26, 46] },
    ]);
    const archivo = `${sede}_${nombre}_historial.xlsx`.replace(/[^\w.-]+/g, "_");
    res.header("Content-Disposition", `attachment; filename="${archivo}"`).send(buf);
  }
}
