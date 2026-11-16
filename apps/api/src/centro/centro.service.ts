import { ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readFileSync } from "fs";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService, type Access } from "../access/access.service";

/**
 * Centro de mando dentro de Nodivo. NO reemplaza ni modifica el monitoreo central (10.30.10.27) ni
 * las sedes api-SIASA: solo LEE.
 *  - Vista general: GET <CENTRAL_URL>/api/vista (el mismo colector que ya consulta las 10 sedes),
 *    con la clave del panel (CENTRAL_CLAVE, solo en el .env del servidor).
 *  - Historial: cada minuto guarda kW, V y A de cada medidor en la hypertable centro_lecturas, para
 *    tener tendencias de las sedes que todavia se leen por el EBO.
 *  - Alarmas y correos de un equipo: GET <sede>/api/ebo/modbus-auto/eventos (las sedes guardan cuando
 *    se envio el correo de apertura y el de cierre). Las API keys de las sedes estan en el archivo
 *    CENTRAL_SEDES_FILE (copia del config/sedes.json del monitoreo central, permiso 600).
 */

interface SedeCfg { id: string; nombre: string; ip: string; puerto: number; key: string }
type Vista = {
  generado: string;
  totales: Record<string, number>;
  sedes: Array<{ id: string; nombre: string; sin_respuesta: boolean; medidores: Record<string, number>; abiertos: unknown[];
    dispositivos: Array<{ id: string; nombre: string; inventario: string | null; estado: string; lectura: { kw: number | null; v_prom: number | null; a_prom: number | null } | null }> } & Record<string, unknown>>;
  actividad: Array<{ sede_id: string } & Record<string, unknown>>;
} & Record<string, unknown>;

@Injectable()
export class CentroService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("CentroService");
  private vista: Vista | null = null;
  private vistaAt = 0;
  private error: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly url: string;
  private readonly clave: string;
  private readonly sedesFile: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.url = (config.get<string>("CENTRAL_URL") || "").replace(/\/$/, "");
    this.clave = config.get<string>("CENTRAL_CLAVE") || "";
    this.sedesFile = config.get<string>("CENTRAL_SEDES_FILE") || "";
  }

  onModuleInit() {
    if (!this.url || !this.clave) {
      this.log.warn("Centro de mando sin configurar (CENTRAL_URL / CENTRAL_CLAVE): la pestaña mostrara el aviso");
      return;
    }
    void this.refrescar();
    this.timers.push(setInterval(() => void this.refrescar(), 15_000));
    this.timers.push(setInterval(() => void this.guardar(), 60_000));
  }

  onModuleDestroy() {
    this.timers.forEach((t) => clearInterval(t));
  }

  private async refrescar() {
    try {
      const r = await fetch(`${this.url}/api/vista`, { headers: { "x-clave": this.clave }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.vista = (await r.json()) as Vista;
      this.vistaAt = Date.now();
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** Una foto por minuto de cada medidor (solo sedes que respondieron). */
  private async guardar() {
    const v = this.vista;
    if (!v || Date.now() - this.vistaAt > 60_000) return;
    const time = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const data = v.sedes
      .filter((s) => !s.sin_respuesta)
      .flatMap((s) =>
        s.dispositivos.map((d) => ({ time, sede: s.id, medidor: d.id, kw: d.lectura?.kw ?? null, vProm: d.lectura?.v_prom ?? null, aProm: d.lectura?.a_prom ?? null, estado: d.estado })),
      );
    if (!data.length) return;
    try {
      await this.prisma.centroLectura.createMany({ data, skipDuplicates: true });
    } catch (e) {
      this.log.warn(`No se guardo la foto del centro de mando: ${(e as Error).message}`);
    }
  }

  /** Vista del monitoreo central, solo con las sedes que el usuario puede ver. */
  vistaPara(access: Access) {
    if (!this.url || !this.clave) throw new ServiceUnavailableException("El centro de mando no esta configurado en el servidor (CENTRAL_URL / CENTRAL_CLAVE)");
    if (!this.vista) throw new ServiceUnavailableException(`Sin datos del monitoreo central todavia${this.error ? `: ${this.error}` : ""}`);
    const sedes = this.vista.sedes.filter((s) => AccessService.seesSite(access, s.id));
    const disp = sedes.flatMap((s) => s.dispositivos);
    const totales = {
      ...this.vista.totales,
      sedes: sedes.length,
      sedes_responden: sedes.filter((s) => !s.sin_respuesta).length,
      medidores: disp.length,
      medidores_ok: disp.filter((d) => d.estado === "ok" || d.estado === "generador_en_marcha" || d.estado === "en_espera_generador_apagado").length,
      medidores_fuera: disp.filter((d) => d.estado === "fuera_de_linea").length,
    };
    return {
      ...this.vista,
      totales,
      sedes,
      actividad: this.vista.actividad.filter((a) => AccessService.seesSite(access, a.sede_id)),
      recibido: new Date(this.vistaAt).toISOString(),
      atrasado: Date.now() - this.vistaAt > 45_000,
      error: this.error,
    };
  }

  private sedeCfg(id: string): SedeCfg {
    if (!this.sedesFile) throw new ServiceUnavailableException("Falta CENTRAL_SEDES_FILE en el servidor");
    const lista = JSON.parse(readFileSync(this.sedesFile, "utf8")) as SedeCfg[];
    const s = lista.find((x) => x.id === id);
    if (!s) throw new NotFoundException(`Sede ${id} no configurada`);
    return s;
  }

  private ver(access: Access, sede: string) {
    if (!AccessService.seesSite(access, sede)) throw new ForbiddenException("No tiene acceso a esta sede");
  }

  /** Alarmas de un equipo con la hora de sus correos (apertura y cierre), desde la base de la sede. */
  async eventos(access: Access, sede: string, dispositivo: string, dias: number) {
    this.ver(access, sede);
    const s = this.sedeCfg(sede);
    const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
    const q = `dispositivo=${encodeURIComponent(dispositivo)}&desde=${encodeURIComponent(desde)}&limite=500`;
    try {
      const r = await fetch(`http://${s.ip}:${s.puerto}/api/ebo/modbus-auto/eventos?${q}`, { headers: { "x-api-key": s.key }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { eventos?: unknown[]; origen?: string };
      return { sede, dispositivo, dias, origen: body.origen ?? null, eventos: body.eventos ?? [] };
    } catch (e) {
      throw new ServiceUnavailableException(`La sede ${s.nombre} no respondio: ${(e as Error).message}`);
    }
  }

  private bucketFor(minutes: number) {
    return Math.max(60, Math.round((minutes * 60) / 240));
  }

  /** Tendencia de un medidor desde centro_lecturas (promedio por intervalo). */
  async historial(access: Access, sede: string, medidor: string, minutes: number, bucketSeconds?: number) {
    this.ver(access, sede);
    const bucket = bucketSeconds ?? this.bucketFor(minutes);
    const rows = await this.prisma.$queryRaw<{ t: Date; kw: number | null; v: number | null; a: number | null; n: number; fuera: number }[]>`
      SELECT time_bucket(make_interval(secs => ${bucket}::int), "time") AS t,
             avg(kw)::float AS kw, avg("vProm")::float AS v, avg("aProm")::float AS a,
             count(*)::int AS n, count(*) FILTER (WHERE estado = 'fuera_de_linea')::int AS fuera
      FROM centro_lecturas
      WHERE sede = ${sede} AND medidor = ${medidor} AND "time" > now() - make_interval(mins => ${minutes}::int)
      GROUP BY t ORDER BY t`;
    const [first] = await this.prisma.$queryRaw<{ first: Date | null }[]>`
      SELECT min("time") AS first FROM centro_lecturas WHERE sede = ${sede} AND medidor = ${medidor}`;
    return {
      sede, medidor, minutes, bucketSeconds: bucket, desde: first?.first?.toISOString() ?? null,
      points: rows.map((r) => ({ t: r.t.toISOString(), kw: r.kw, v: r.v, a: r.a, fuera: r.fuera > 0 })),
    };
  }
}
