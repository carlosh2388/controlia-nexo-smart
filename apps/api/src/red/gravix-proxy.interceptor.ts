import { CallHandler, ConflictException, ExecutionContext, HttpException, Injectable, NestInterceptor } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Observable, map, of } from "rxjs";
import { GravixService } from "./gravix.service";

const EQUIPO = /^\/api\/v1\/(?:pilot\/devices|devices)\/([^/?]+)(\/[^?]*)?/;
const AGENTE = /^\/api\/v1\/(?:pilot\/([^/?]+)\/(?:devices|cumplimiento)|sites\/([^/?]+)\/events|agents\/([^/?]+)(?:\/[^?]*)?)(?:\?|$)/;
const LISTA = /^\/api\/v1\/devices(?:\?|$)/;
const LISTA_AGENTES = /^\/api\/v1\/agents(?:\?|$)/;
const ESTADO_AGENTES = /^\/api\/v1\/devices\/agent-status(?:\?|$)/;

type Dev = { metadata?: { agent?: { buildingKey?: string } } | null; protocol?: string };
const llaveDe = (d: Dev) => d?.metadata?.agent?.buildingKey ?? "";

/**
 * Pasa a la sede las consultas de equipos y agentes que viven en un Gravix de sede, para que las
 * pantallas del central (Centro de mando, ventana del equipo, historial, huecos, Excel, normas,
 * alarmas y la pestaña Sedes) funcionen igual que con los equipos de este servidor.
 *  - GET de un equipo o agente de la sede: se pide a la sede tal cual.
 *  - GET /devices y /devices/agent-status: la respuesta local, cambiando los equipos y agentes de las
 *    sedes Gravix por los que informa cada sede (los locales de esos agentes son copias viejas).
 *  - Cambios (PUT/POST/PATCH/DELETE) a un equipo de una sede Gravix: 409, se hacen en su web local.
 * Corre despues de AuthGuard/RolesGuard. Solo se carga en el servidor central (RedModule).
 */
@Injectable()
export class GravixProxyInterceptor implements NestInterceptor {
  constructor(private readonly gravix: GravixService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== "http") return next.handle();
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const url = req.url;
    if (!url.startsWith("/api/v1/pilot/") && !url.startsWith("/api/v1/sites/") && !url.startsWith("/api/v1/devices") && !url.startsWith("/api/v1/agents")) return next.handle();

    // Listas mezcladas con lo que informan las sedes
    if (req.method === "GET" && LISTA_AGENTES.test(url)) {
      const { keys, lista } = this.gravix.agentesDeSedes();
      if (!keys.size) return next.handle();
      return next.handle().pipe(map((local) => [...(Array.isArray(local) ? local : []).filter((a: { buildingKey?: string }) => !keys.has(a?.buildingKey ?? "")), ...lista]));
    }
    if (req.method === "GET" && ESTADO_AGENTES.test(url)) {
      const { keys, lista } = this.gravix.estadoAgentesDeSedes();
      if (!keys.size) return next.handle();
      return next.handle().pipe(map((local) => [...(Array.isArray(local) ? local : []).filter((a: { buildingKey?: string }) => !keys.has(a?.buildingKey ?? "")), ...lista]));
    }
    if (req.method === "GET" && LISTA.test(url)) {
      const { keys, lista } = this.gravix.dispositivosDeSedes();
      if (!keys.size) return next.handle();
      const protocolo = (req.query as { protocol?: string } | undefined)?.protocol;
      const remotos = protocolo ? lista.filter((d) => (d as Dev).protocol === protocolo) : lista;
      return next.handle().pipe(map((local) => [...(Array.isArray(local) ? local : []).filter((d: Dev) => !keys.has(llaveDe(d))), ...remotos]));
    }

    const eq = EQUIPO.exec(url);
    const ag = eq ? null : AGENTE.exec(url);
    const sede = eq ? this.gravix.sedeDeEquipo(eq[1]) : ag ? this.gravix.sedeDeAgente(ag[1] ?? ag[2] ?? ag[3]) : null;
    if (!sede) return next.handle();

    if (req.method !== "GET") {
      const api = this.gravix.urlDe(sede);
      const puerto = this.gravix.estadoDe(sede)?.webPuerto ?? 5173;
      const web = api ? `${api.replace(/:\d+$/, "")}:${puerto}` : null;
      const que = ag?.[3] ? "Este agente" : "Este equipo";
      throw new ConflictException(`${que} está en el Gravix de la sede ${sede}: los cambios (configuración, búsqueda de equipos, umbrales) se hacen en su web local${web ? ` (${web})` : ""}`);
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
