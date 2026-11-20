import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaService } from "../prisma/prisma.service";

/** Lo que el centro sabe de una sede Gravix en este momento. */
export interface EstadoGravix {
  ok: boolean;
  error: string | null;
  ultimoContacto: string | null;
  version: string | null;
  latenciaMs: number | null;
  equipos: number | null;
  influx: unknown;
  /** Puerto de la web local de la sede (segun su /sede/salud). */
  webPuerto: number | null;
  /** Alarmas abiertas del motor de Gravix (forma de /api/vista) y estado del motor y su correo. */
  abiertos: unknown[];
  alarmas: unknown;
}

const VACIO = { ultimoContacto: null, version: null, equipos: null, influx: null, webPuerto: null, abiertos: [] as unknown[], alarmas: null };

interface SedeGravix {
  id: string;
  url: string;
  key: string;
  agentes: string[];
}

interface VistaSede {
  version?: string;
  abiertos?: unknown[];
  dispositivos?: { id: string; estado: string; lectura?: { kw: number | null; v_prom: number | null; a_prom: number | null } }[];
}

export interface Reenvio {
  status: number;
  contentType: string | null;
  disposition: string | null;
  body: Buffer;
}

/**
 * Sedes con su propio Gravix (red_sedes.origen = "gravix"), vistas desde el servidor central.
 *  - Guarda la clave de consulta de cada sede cifrada (AES-256-GCM). La llave sale de GRAVIX_KEYS_SECRET
 *    o, si no existe, de JWT_ACCESS_SECRET.
 *  - Cada 15 s pide GET /sede/vista a cada sede (y /sede/salud cada minuto): estado, version, y que
 *    equipos tiene (para saber a quien pasarle las consultas de un equipo).
 *  - Cada minuto guarda kW, V y A de sus equipos en centro_lecturas, igual que con Telemetria 1.
 *  - reenviar(): pasa una consulta GET de solo lectura a la sede (historial, huecos, Excel, alarmas...).
 */
@Injectable()
export class GravixService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("GravixService");
  private readonly llave: Buffer;
  private sedes: SedeGravix[] = [];
  private readonly estados = new Map<string, EstadoGravix>();
  private readonly vistas = new Map<string, VistaSede>();
  /** deviceId (de la base de la sede) → id de la sede. */
  private readonly equipos = new Map<string, string>();
  /** Lista completa de equipos (GET /devices) y estado de sus agentes, por sede: la usa la pestaña Sedes. */
  private readonly dispositivos = new Map<string, Record<string, unknown>[]>();
  private readonly estadoAgentes = new Map<string, Record<string, unknown>[]>();
  /** Sedes que tambien trae el monitoreo central (Telemetria 1): su foto por minuto ya la guarda CentroService. */
  private readonly sedesCentrales: Set<string>;
  private timers: NodeJS.Timeout[] = [];
  private vuelta = 0;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const secreto = config.get<string>("GRAVIX_KEYS_SECRET") || config.get<string>("JWT_ACCESS_SECRET") || "change-me-access";
    this.llave = createHash("sha256").update(`gravix-sede:${secreto}`).digest();
    let ids: string[] = [];
    try {
      const archivo = config.get<string>("CENTRAL_SEDES_FILE");
      if (archivo) ids = (JSON.parse(readFileSync(archivo, "utf8")) as { id: string }[]).map((s) => s.id);
    } catch {
      /* sin archivo de sedes: ninguna sede central */
    }
    this.sedesCentrales = new Set(ids);
  }

  /** Equipos de las sedes Gravix que respondieron, y los buildingKey que cubren (para la lista GET /devices). */
  dispositivosDeSedes() {
    const keys = new Set<string>();
    const lista: Record<string, unknown>[] = [];
    for (const s of this.sedes) {
      const d = this.dispositivos.get(s.id);
      if (!d) continue;
      s.agentes.forEach((k) => keys.add(k));
      lista.push(...d);
    }
    return { keys, lista };
  }

  /** Estado de los agentes de las sedes Gravix (GET /devices/agent-status). */
  estadoAgentesDeSedes() {
    const keys = new Set<string>();
    const lista: Record<string, unknown>[] = [];
    for (const s of this.sedes) {
      const d = this.estadoAgentes.get(s.id);
      if (!d) continue;
      s.agentes.forEach((k) => keys.add(k));
      lista.push(...d);
    }
    return { keys, lista };
  }

  onModuleInit() {
    void this.refrescar();
    this.timers.push(setInterval(() => void this.refrescar(), 15_000));
    this.timers.push(setInterval(() => void this.guardarFoto(), 60_000));
  }

  onModuleDestroy() {
    this.timers.forEach((t) => clearInterval(t));
  }

  cifrar(texto: string) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.llave, iv);
    const enc = Buffer.concat([c.update(texto, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
  }

  descifrar(b64: string) {
    const raw = Buffer.from(b64, "base64");
    const d = createDecipheriv("aes-256-gcm", this.llave, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  }

  /** Ultimos 4 caracteres de la clave guardada (para mostrar en la web). */
  finalDeClave(apiKeyEnc: string | null) {
    if (!apiKeyEnc) return null;
    try {
      return this.descifrar(apiKeyEnc).slice(-4);
    } catch {
      return "????";
    }
  }

  estadoDe(id: string): EstadoGravix | null {
    return this.estados.get(id) ?? null;
  }

  sedeDeEquipo(deviceId: string) {
    return this.equipos.get(deviceId) ?? null;
  }

  sedeDeAgente(buildingKey: string) {
    return this.sedes.find((s) => s.agentes.includes(buildingKey))?.id ?? null;
  }

  urlDe(id: string) {
    return this.sedes.find((s) => s.id === id)?.url ?? null;
  }

  /** Prueba una sede antes de guardarla: devuelve su /sede/salud o un error claro. */
  async probar(url: string, key: string) {
    const base = url.replace(/\/$/, "");
    let r: Response;
    try {
      r = await fetch(`${base}/api/v1/sede/salud`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(8000) });
    } catch (e) {
      throw new BadRequestException(`No se pudo conectar con ${base}: ${(e as Error).message}`);
    }
    if (r.status === 401) throw new BadRequestException("La sede respondió, pero rechazó la clave (401). Use CENTRO_API_KEY de su .env");
    if (r.status === 403) throw new BadRequestException("Esa clave no es de consulta (403). Use CENTRO_API_KEY, no la del agente");
    if (r.status === 404) throw new BadRequestException("En esa dirección no hay un Gravix de sede (404)");
    if (!r.ok) throw new BadRequestException(`La sede respondió HTTP ${r.status}`);
    type Salud = { modo?: string; sede: { codigo: string; nombre: string }; version: string; agentes: { buildingKey: string }[] };
    let salud: Salud;
    try {
      salud = (await r.json()) as Salud;
    } catch {
      salud = {} as Salud;
    }
    if (salud.modo !== "sede" || !Array.isArray(salud.agentes)) {
      throw new BadRequestException(`En ${base} responde otra cosa, no la API de un Gravix de sede. Use el puerto de la API (normalmente 3010), no el de la web`);
    }
    return salud;
  }

  /**
   * Escritura a la sede con la clave del centro (solo las rutas que la sede acepta de el:
   * PUT /sede/alarmas/config y POST /sede/alarmas/prueba). Devuelve el JSON o lanza el error de la sede.
   */
  async escribir(sedeId: string, metodo: "PUT" | "POST", ruta: string, body: unknown) {
    const s = this.sedes.find((x) => x.id === sedeId);
    if (!s) throw new BadRequestException("La sede no tiene un Gravix registrado");
    let r: Response;
    try {
      r = await fetch(`${s.url}${ruta}`, {
        method: metodo,
        headers: { "x-api-key": s.key, "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new BadRequestException(`La sede ${sedeId} no responde: ${(e as Error).message}`);
    }
    const texto = await r.text();
    let json: unknown = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = texto;
    }
    if (!r.ok) {
      // El filtro de errores de la API envuelve el mensaje: { message: { message: "..." } }.
      let m: unknown = (json as { message?: unknown } | null)?.message;
      if (m && typeof m === "object") m = (m as { message?: unknown }).message;
      if (Array.isArray(m)) m = m.join("; ");
      throw new BadRequestException(typeof m === "string" ? m : `La sede respondió HTTP ${r.status}`);
    }
    return json;
  }

  /** Pasa una consulta GET a la sede tal cual (ruta con /api/v1/... y su query). */
  async reenviar(sedeId: string, ruta: string): Promise<Reenvio> {
    const s = this.sedes.find((x) => x.id === sedeId);
    if (!s) return { status: 404, contentType: "application/json", disposition: null, body: Buffer.from(JSON.stringify({ message: "Sede Gravix no registrada" })) };
    try {
      const r = await fetch(`${s.url}${ruta}`, { headers: { "x-api-key": s.key }, signal: AbortSignal.timeout(20_000) });
      return {
        status: r.status,
        contentType: r.headers.get("content-type"),
        disposition: r.headers.get("content-disposition"),
        body: Buffer.from(await r.arrayBuffer()),
      };
    } catch (e) {
      const msg = `La sede ${sedeId} no responde: ${(e as Error).message}`;
      return { status: 502, contentType: "application/json", disposition: null, body: Buffer.from(JSON.stringify({ statusCode: 502, message: msg })) };
    }
  }

  private async cargarSedes() {
    const filas = await this.prisma.redSede.findMany({ where: { origen: "gravix" } });
    const lista: SedeGravix[] = [];
    for (const f of filas) {
      if (!f.url || !f.apiKeyEnc) continue;
      try {
        lista.push({ id: f.id, url: f.url.replace(/\/$/, ""), key: this.descifrar(f.apiKeyEnc), agentes: f.agentes });
      } catch {
        this.estados.set(f.id, { ...VACIO, ok: false, error: "No se pudo descifrar la clave guardada: vuelva a escribirla", latenciaMs: null });
      }
    }
    this.sedes = lista;
  }

  /** Recarga ya la lista (despues de guardar o borrar una sede). */
  async recargar() {
    await this.refrescar();
  }

  private async refrescar() {
    try {
      await this.cargarSedes();
    } catch (e) {
      this.log.warn(`No se pudo leer red_sedes: ${(e as Error).message}`);
      return;
    }
    const conSalud = this.vuelta++ % 4 === 0;
    await Promise.all(this.sedes.map((s) => this.consultar(s, conSalud)));
  }

  private async consultar(s: SedeGravix, conSalud: boolean) {
    const previo = this.estados.get(s.id);
    const t0 = Date.now();
    try {
      const r = await fetch(`${s.url}/api/v1/sede/vista`, { headers: { "x-api-key": s.key }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const vista = (await r.json()) as VistaSede;
      this.vistas.set(s.id, vista);
      for (const d of vista.dispositivos ?? []) this.equipos.set(d.id, s.id);
      // Todos los equipos de la sede (energia y sensores) y el estado de sus agentes.
      const h = { headers: { "x-api-key": s.key }, signal: AbortSignal.timeout(8000) };
      const [rd, ra] = await Promise.all([fetch(`${s.url}/api/v1/devices`, h).catch(() => null), fetch(`${s.url}/api/v1/devices/agent-status`, h).catch(() => null)]);
      if (rd?.ok) {
        const lista = (await rd.json()) as Record<string, unknown>[];
        this.dispositivos.set(s.id, lista);
        for (const d of lista) if (typeof d.id === "string") this.equipos.set(d.id, s.id);
      }
      if (ra?.ok) this.estadoAgentes.set(s.id, (await ra.json()) as Record<string, unknown>[]);
      let influx = previo?.influx ?? null;
      let webPuerto = previo?.webPuerto ?? null;
      let alarmas = previo?.alarmas ?? null;
      if (conSalud) {
        const rs = await fetch(`${s.url}/api/v1/sede/salud`, { headers: { "x-api-key": s.key }, signal: AbortSignal.timeout(8000) }).catch(() => null);
        if (rs?.ok) {
          const salud = (await rs.json()) as { agentes?: { buildingKey: string }[]; bases?: { influx?: unknown }; web?: { puerto?: number | null }; alarmas?: unknown };
          influx = salud.bases?.influx ?? null;
          webPuerto = salud.web?.puerto ?? null;
          alarmas = salud.alarmas ?? null;
          const agentes = [...new Set((salud.agentes ?? []).map((a) => a.buildingKey))].sort();
          if (agentes.length && agentes.join(",") !== [...s.agentes].sort().join(",")) {
            await this.prisma.redSede.update({ where: { id: s.id }, data: { agentes } });
            s.agentes = agentes;
          }
        }
      }
      this.estados.set(s.id, {
        ok: true,
        error: null,
        ultimoContacto: new Date().toISOString(),
        version: vista.version ?? null,
        latenciaMs: Date.now() - t0,
        equipos: vista.dispositivos?.length ?? 0,
        influx,
        webPuerto,
        abiertos: vista.abiertos ?? [],
        alarmas,
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (previo?.error !== msg) this.log.warn(`Sede Gravix ${s.id} (${s.url}) no responde: ${msg}`);
      this.estados.set(s.id, { ...(previo ?? VACIO), ok: false, error: msg, latenciaMs: null });
    }
  }

  /** Foto de un minuto de cada equipo de las sedes Gravix que respondieron. */
  private async guardarFoto() {
    const time = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const data = this.sedes.flatMap((s) => {
      if (this.sedesCentrales.has(s.id)) return []; // ya la guarda CentroService desde el monitoreo central
      const e = this.estados.get(s.id);
      if (!e?.ok || !e.ultimoContacto || Date.now() - new Date(e.ultimoContacto).getTime() > 60_000) return [];
      return (this.vistas.get(s.id)?.dispositivos ?? []).map((d) => ({
        time,
        sede: s.id,
        medidor: d.id,
        kw: d.lectura?.kw ?? null,
        vProm: d.lectura?.v_prom ?? null,
        aProm: d.lectura?.a_prom ?? null,
        estado: d.estado,
      }));
    });
    if (!data.length) return;
    try {
      await this.prisma.centroLectura.createMany({ data, skipDuplicates: true });
    } catch (e) {
      this.log.warn(`No se guardo la foto de las sedes Gravix: ${(e as Error).message}`);
    }
  }
}
