import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, NotFoundException, Param, Post, Put, Query, Req, UseGuards, Version } from "@nestjs/common";
import { Role } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { AuthGuard } from "../auth/guards/auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { AlarmasService } from "../alarmas/alarmas.service";
import { SedeService } from "./sede.service";

const HUMANS = [Role.admin, Role.operator, Role.viewer];

/**
 * API del Gravix de sede para el Centro de mando (x-api-key de solo lectura).
 * Historial, huecos y comparacion usan las rutas que ya existen: /pilot/...
 * Las alarmas tienen el mismo formato que api-SIASA (/api/ebo/modbus-auto/eventos y /estado).
 */
@Controller("sede")
@UseGuards(AuthGuard, RolesGuard)
export class SedeController {
  constructor(
    private readonly sede: SedeService,
    private readonly alarmas: AlarmasService,
  ) {}

  @Version("1")
  @Roles(...HUMANS)
  @Get("salud")
  salud() {
    return this.sede.salud();
  }

  @Version("1")
  @Roles(...HUMANS)
  @Get("vista")
  vista() {
    return this.sede.vista();
  }

  /** Formato v1 de Telemetria 1 (devices con su ficha y metricas). */
  @Version("1")
  @Roles(...HUMANS)
  @Get("telemetria")
  telemetria() {
    return this.sede.telemetria();
  }

  /** Alarmas guardadas, mismas columnas que api_eventos de api-SIASA. ?dispositivo=&desde=&hasta=&abiertos=true&limite= */
  @Version("1")
  @Roles(...HUMANS)
  @Get("eventos")
  eventos(@Query("desde") desde?: string, @Query("hasta") hasta?: string, @Query("dispositivo") dispositivo?: string, @Query("abiertos") abiertos?: string, @Query("limite") limite?: string) {
    return this.alarmas.consultarEventos({ desde, hasta, dispositivo, abiertos, limite: limite ? Number(limite) : undefined });
  }

  /** Estado del motor de alarmas (como /api/ebo/modbus-auto/estado de api-SIASA). */
  @Version("1")
  @Roles(...HUMANS)
  @Get("alarmas/estado")
  estadoAlarmas() {
    return this.alarmas.obtenerEstado();
  }

  /** Correos que preparo Gravix: enviados o, en modo paralelo, solo preparados. */
  @Version("1")
  @Roles(...HUMANS)
  @Get("alarmas/correos")
  correos(@Query("dias") dias?: string) {
    return this.alarmas.correos(dias ? Number(dias) : 7);
  }

  @Version("1")
  @Roles(...HUMANS)
  @Get("alarmas/correos/:id")
  @Header("Content-Type", "text/html; charset=utf-8")
  async correo(@Param("id") id: string) {
    const html = await this.alarmas.correoHtml(id);
    if (!html) throw new NotFoundException("Correo no encontrado");
    return html;
  }

  /** Configuracion de alarmas y correos (modulo "Alarmas y correos" del Centro de mando). */
  @Version("1")
  @Roles(...HUMANS)
  @Get("alarmas/config")
  config() {
    return this.alarmas.configuracion();
  }

  /** Guarda cambios de la configuracion. Solo un admin de la sede o la clave del Centro de mando. */
  @Version("1")
  @Roles(...HUMANS)
  @Put("alarmas/config")
  async guardarConfig(@Req() req: FastifyRequest, @Body() body: { cambios?: Record<string, unknown>; por?: string }) {
    const por = this.autorizarCentro(req, body.por);
    try {
      return await this.alarmas.guardarConfig(body.cambios ?? {}, por);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /** Correo de prueba (evento simulado con datos reales). Solo si el envio esta activo. */
  @Version("1")
  @Roles(...HUMANS)
  @Post("alarmas/prueba")
  async prueba(@Req() req: FastifyRequest, @Body() body: { dispositivo?: string; por?: string }) {
    this.autorizarCentro(req, body.por);
    try {
      return await this.alarmas.enviarCorreoPrueba(body.dispositivo);
    } catch (e) {
      throw new BadRequestException(`No se pudo enviar el correo de prueba: ${(e as Error).message}`);
    }
  }

  /** Admin de la sede (usuario) o la clave del Centro de mando (SEDE_CENTRO_KEY). Devuelve quien hizo el cambio. */
  private autorizarCentro(req: FastifyRequest, por?: string) {
    const user = (req as FastifyRequest & { user?: { role?: string; username?: string; authType?: string } }).user;
    if (user?.authType === "user" && user.role === Role.admin) return user.username ?? "admin de la sede";
    const raw = req.headers["x-api-key"];
    const centro = process.env.SEDE_CENTRO_KEY;
    if (centro && typeof raw === "string" && raw.length === centro.length && timingSafeEqual(Buffer.from(raw), Buffer.from(centro))) {
      return `Centro de mando${por ? ` (${String(por).slice(0, 60)})` : ""}`;
    }
    throw new ForbiddenException("Solo un administrador o el Centro de mando pueden cambiar la configuración de alarmas");
  }

  /** Vista previa del correo con los datos reales de un medidor (evento simulado, no se envia). */
  @Version("1")
  @Roles(...HUMANS)
  @Get("alarmas/vista-previa")
  @Header("Content-Type", "text/html; charset=utf-8")
  vistaPrevia(@Query("dispositivo") dispositivo?: string, @Query("evento") evento?: string) {
    return this.alarmas.vistaPrevia(dispositivo, evento);
  }
}
