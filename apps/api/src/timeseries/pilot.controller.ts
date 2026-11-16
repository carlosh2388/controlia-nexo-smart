import { Body, Controller, Get, Param, Post, Put, Query, Res, UseGuards, Version } from "@nestjs/common";
import { Role } from "@prisma/client";
import type { FastifyReply } from "fastify";
import { AuthGuard } from "../auth/guards/auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { ActionGuard, RequireAction } from "../access/action.guard";
import { buildXlsx } from "../common/xlsx";
import { PilotService } from "./pilot.service";
import { CompareQueryDto, CumplimientoQueryDto, DirectConnectionDto, ExcelQueryDto, GapsQueryDto, ProbarLecturaDto, PronosticoQueryDto, SeriesQueryDto, UmbralesDto } from "./dto/pilot.dto";
import { QualityService } from "./quality.service";
import { NORMAS, type Limites } from "./normas";

const HUMANS = [Role.admin, Role.operator, Role.viewer];

/** Pestaña Piloto Gravix: equipos de energia de una sede, historial y huecos. */
@Controller("pilot")
@UseGuards(AuthGuard, RolesGuard, ActionGuard)
export class PilotController {
  constructor(
    private readonly pilot: PilotService,
    private readonly calidad: QualityService,
  ) {}

  /** Normas y cumplimiento: % de intervalos de 10 min dentro del limite, por equipo e indicador. */
  @Version("1")
  @Roles(...HUMANS)
  @Get("normas")
  normas() {
    return NORMAS;
  }

  @Version("1")
  @Roles(...HUMANS)
  @Get(":buildingKey/cumplimiento")
  cumplimiento(@Param("buildingKey") buildingKey: string, @Query() q: CumplimientoQueryDto) {
    return this.calidad.cumplimiento(buildingKey, q.dias ?? 7, q.norma ?? "ntsd");
  }

  /** Prediccion: historia por hora + pronostico con su banda. */
  @Version("1")
  @Roles(...HUMANS)
  @Get("devices/:id/pronostico")
  pronostico(@Param("id") id: string, @Query() q: PronosticoQueryDto) {
    return this.calidad.pronostico(id, q.metric, q.dias ?? 14, q.horizonte ?? 7);
  }

  @Version("1")
  @Roles(...HUMANS)
  @Get("devices/:id/umbrales")
  async umbrales(@Param("id") id: string) {
    return this.calidad.umbralesDe((await this.pilot.metadataOf(id)) ?? null);
  }

  @Version("1")
  @Roles(Role.admin, Role.operator)
  @RequireAction("agentes")
  @Put("devices/:id/umbrales")
  guardarUmbrales(@Param("id") id: string, @Body() dto: UmbralesDto) {
    return this.calidad.guardarUmbrales(id, dto.norma, (dto.limites ?? {}) as Partial<Limites>);
  }

  /** Prueba de conexion: una lectura Modbus de solo lectura (funcion 03) al equipo. */
  @Version("1")
  @Roles(Role.admin, Role.operator)
  @RequireAction("agentes")
  @Post("devices/:id/probar")
  probar(@Body() dto: ProbarLecturaDto) {
    return this.calidad.probarLectura(dto.ip, dto.port, dto.unitId, dto.perfil);
  }

  @Version("1")
  @Roles(...HUMANS)
  @Get(":buildingKey/devices")
  devices(@Param("buildingKey") buildingKey: string) {
    return this.pilot.devices(buildingKey);
  }

  @Version("1")
  @Roles(...HUMANS)
  @Get("devices/:id/series")
  series(@Param("id") id: string, @Query() query: SeriesQueryDto) {
    return this.pilot.series(id, query.metric, query.minutes ?? 60);
  }

  /** Espectro de armonicos guardado (ultimo hasta ?at=ISO, o el mas reciente). */
  @Version("1")
  @Roles(...HUMANS)
  @Get("devices/:id/espectro")
  espectro(@Param("id") id: string, @Query("at") at?: string) {
    return this.pilot.spectrum(id, at ? new Date(at) : undefined);
  }

  @Version("1")
  @Roles(...HUMANS)
  @Get("devices/:id/compare")
  compare(@Param("id") id: string, @Query() query: CompareQueryDto) {
    return this.pilot.compare(id, query.minutes ?? 60);
  }

  @Version("1")
  @Roles(...HUMANS)
  @Get("devices/:id/gaps")
  gaps(@Param("id") id: string, @Query() query: GapsQueryDto) {
    return this.pilot.gaps(id, query.days ?? 7);
  }

  /** Historial del equipo en Excel: varias variables, una columna por variable (y la del EBO si hay pareja). */
  @Version("1")
  @Roles(...HUMANS)
  @RequireAction("excel")
  @Get("devices/:id/excel")
  async excel(@Param("id") id: string, @Query() q: ExcelQueryDto, @Res() res: FastifyReply) {
    const minutes = q.minutes ?? 10080;
    let step = q.step ?? 900;
    while ((minutes * 60) / step > 50_000 && step < 86400) step = step === 60 ? 900 : step === 900 ? 3600 : 86400;
    const metrics = q.metrics.split(",").map((m) => m.trim()).filter(Boolean).slice(0, 20);
    const labels = (q.labels ?? "").split("|");
    const { device, pairId, isDirect, rows, gaps } = await this.pilot.exportRows(id, metrics, minutes, step);
    const byTime = new Map<number, Map<string, { v: number; q: string }>>();
    for (const r of rows) {
      const k = r.t.getTime();
      if (!byTime.has(k)) byTime.set(k, new Map());
      byTime.get(k)!.set(`${r.deviceId === id ? "a" : "b"}:${r.metric}`, { v: r.v, q: r.q });
    }
    const own = isDirect ? "directo" : "por el EBO";
    const other = isDirect ? "por el EBO" : "directo";
    const head: (string | number | Date | null)[] = ["Fecha y hora (Guatemala)"];
    metrics.forEach((m, i) => {
      head.push(`${labels[i] || m} (${own})`);
      if (pairId) head.push(`${labels[i] || m} (${other})`);
    });
    head.push("Calidad");
    const out = [head];
    for (const [k, vals] of [...byTime.entries()].sort((x, y) => x[0] - y[0])) {
      const row: (string | number | Date | null)[] = [new Date(k)];
      let qual = "real";
      metrics.forEach((m) => {
        const a = vals.get(`a:${m}`);
        row.push(a ? Math.round(a.v * 1000) / 1000 : null);
        if (a && a.q !== "real") qual = a.q;
        if (pairId) { const b = vals.get(`b:${m}`); row.push(b ? Math.round(b.v * 1000) / 1000 : null); }
      });
      row.push(qual);
      out.push(row);
    }
    const huecos = [["Inicio", "Fin", "Minutos", "Causa", "Estado"] as (string | number | Date | null)[]].concat(
      gaps.map((g) => [new Date(g.startedAt), g.endedAt ? new Date(g.endedAt) : "abierto", g.minutes, g.cause, g.status]),
    );
    const info: (string | number | Date | null)[][] = [
      ["Dato", "Valor"], ["Equipo", device.name], ["Periodo", `últimos ${Math.round(minutes / 60)} h`], ["Un dato cada", `${step / 60} min (promedio)`],
      ["Lectura de este equipo", own], ["Columna comparada", pairId ? other : "sin pareja"], ["Generado", new Date()],
    ];
    const buf = buildXlsx([
      { name: "Historial", rows: out, widths: [22, ...head.slice(1).map(() => 20)] },
      { name: "Huecos", rows: huecos, widths: [20, 20, 10, 30, 14] },
      { name: "Información", rows: info, widths: [26, 40] },
    ]);
    const archivo = `${device.name}_historial.xlsx`.replace(/[^\w.-]+/g, "_");
    res
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="${archivo}"`)
      .send(buf);
  }

  @Version("1")
  @Roles(Role.admin)
  @Put("devices/:id/connection")
  saveConnection(@Param("id") id: string, @Body() dto: DirectConnectionDto) {
    return this.pilot.saveConnection(id, dto);
  }
}
