import { CallHandler, ConflictException, ExecutionContext, HttpException, Injectable, NestInterceptor } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Observable, of } from "rxjs";
import { GravixService } from "./gravix.service";

const EQUIPO = /^\/api\/v1\/pilot\/devices\/([^/?]+)(\/[^?]*)?/;
const AGENTE = /^\/api\/v1\/(?:pilot\/([^/?]+)\/(?:devices|cumplimiento)|sites\/([^/?]+)\/events)(?:\?|$)/;

/**
 * Pasa a la sede las consultas de equipos y agentes que viven en un Gravix de sede, para que las
 * pantallas del Centro de mando (ventana del equipo, historial, huecos, Excel, normas, alarmas)
 * funcionen igual que con los equipos de este servidor.
 *
 * Corre despues de AuthGuard/RolesGuard (el usuario ya esta autenticado y autorizado) y solo para
 * GET: los cambios a un equipo de una sede Gravix se hacen en la web local de esa sede.
 * Solo se carga en el servidor central (RedModule).
 */
@Injectable()
export class GravixProxyInterceptor implements NestInterceptor {
  constructor(private readonly gravix: GravixService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== "http") return next.handle();
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const url = req.url;
    if (!url.startsWith("/api/v1/pilot/") && !url.startsWith("/api/v1/sites/")) return next.handle();

    const eq = EQUIPO.exec(url);
    const ag = eq ? null : AGENTE.exec(url);
    const sede = eq ? this.gravix.sedeDeEquipo(eq[1]) : ag ? this.gravix.sedeDeAgente(ag[1] ?? ag[2]) : null;
    if (!sede) return next.handle();

    if (req.method !== "GET") {
      const web = this.gravix.urlDe(sede)?.replace(/:\d+$/, "");
      throw new ConflictException(`Este equipo está en el Gravix de la sede ${sede}: los cambios se hacen en su web local${web ? ` (${web})` : ""}`);
    }

    const r = await this.gravix.reenviar(sede, url);
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    // El Excel usa @Res(): la respuesta se envia aqui mismo.
    if (eq?.[2] === "/excel") {
      reply.status(r.status);
      if (r.contentType) reply.header("Content-Type", r.contentType);
      if (r.disposition) reply.header("Content-Disposition", r.disposition);
      reply.send(r.body);
      return of(undefined);
    }
    let cuerpo: unknown = r.body.toString("utf8");
    if (r.contentType?.includes("json")) {
      try {
        cuerpo = cuerpo === "" ? null : JSON.parse(cuerpo as string);
      } catch {
        /* se devuelve como texto */
      }
    }
    if (r.status >= 400) throw new HttpException(cuerpo as object, r.status);
    return of(cuerpo);
  }
}
