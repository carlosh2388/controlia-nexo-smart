/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import type { Transporter } from "nodemailer";
import * as nodemailer from "nodemailer";
import { PrismaService } from "../prisma/prisma.service";
import { tipoDe, type DeviceMeta } from "../red/telemetria";
import { EDITABLES, GUIA, SEVERIDAD_TEXTO, leerConfig, validarCambios, type ConfigAlarmas } from "./alarmas.config";
import * as plantilla from "./plantilla-correo";

/**
 * Motor de alarmas y correos del Gravix de sede. Es el mismo de api-SIASA
 * (monitoreo/eventos_modbus.js): mismos eventos, severidades, tiempos, agrupacion, recordatorios,
 * resumen diario y correo HTML. Diferencias por como lee Gravix:
 *  - Los datos llegan del Agente Go (lectura directa de cada medidor), no del EBO. "Datos congelados"
 *    es: Gravix no recibe sincronizaciones del agente.
 *  - No existen lectura atascada, reconexiones frecuentes ni reinicio por vigilante: eso era de la
 *    conexion Modbus de api-SIASA con el AS-P; aqui la hace el agente.
 *  - Con ALERTAS_CORREO_ACTIVO=false (modo paralelo, mientras api-SIASA envia los correos) cada correo
 *    se arma igual pero NO se envia: queda en alarma_correos como "preparado" para compararlo.
 * Solo se carga en el Gravix de sede (GRAVIX_MODO=sede).
 */

interface Ev {
  codigo: string;
  evento: string;
  severidad: string;
  dispositivo: string | null;
  inventario: string | null;
  inicio: number;
  fin?: number;
  detalle: Record<string, any>;
  notificado: boolean;
  notificadoEn?: number | null;
  ultimoAviso: number | null;
  restaurado?: boolean;
}

interface Medidor {
  nombre: string;
  inventario: string | null;
  area: string | null;
  firma: string;
  cambioEn: number;
  offlineDesde: number | null;
  ceroDesde: number | null;
  online?: boolean;
  ultimaVez?: number;
  info?: Record<string, unknown>;
  metricas?: Record<string, number>;
  generador?: "apagado" | "en_marcha" | null;
  generadorCandidatoDesde?: number | null;
  generadorDesde?: number | null;
  sinTransferencia?: boolean;
  ionSinMediciones?: boolean;
  transferenciaFallaDesde?: number | null;
  transferenciaRecuperacionDesde?: number | null;
  reglasIon?: Record<string, { falla?: number | null; recuperacion?: number | null }>;
  agente?: string;
}

interface DispositivoLeido {
  id: string;
  nombre: string;
  inventario: string | null;
  area: string | null;
  online: boolean;
  metrics: Record<string, number>;
  info: Record<string, unknown>;
  agente: string;
}

interface ItemCorreo {
  tipo: string;
  asunto: string;
  texto: string;
  html?: string;
  ev?: Ev;
  eventos?: Ev[];
  intentos: number;
}

const MIN_PARA_AGRUPAR = 3;

@Injectable()
export class AlarmasService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Alarmas");
  /** Configuracion efectiva: .env de la sede + lo guardado desde el Centro de mando (alarma_config). */
  cfg: ConfigAlarmas = leerConfig();
  private override: Record<string, string> = {};
  private overrideInfo: { actualizado: Date | null; por: string | null } = { actualizado: null, por: null };
  private readonly inicioProceso = Date.now();
  private timers: NodeJS.Timeout[] = [];
  private arrancado = false;

  // ---- estado en memoria (igual que st y abiertos de api-SIASA) ----
  private ultimaOk: number | null = null;
  private readonly medidores = new Map<string, Medidor>();
  private readonly abiertos = new Map<string, Ev>();
  private readonly restaurados = new Map<string, Record<string, Ev>>();
  private restauracionLista = false;
  private readonly pendientesMedidores: { apertura: Ev[]; cierre: Ev[] } = { apertura: [], cierre: [] };
  private readonly colaCorreo: ItemCorreo[] = [];
  private readonly enviadosUltimaHora: number[] = [];
  private transporte: Transporter | null = null;
  private correoMotivoInactivo: string | null = null;
  private ultimoResumenDia: string | null = null;
  private dbCola: Promise<unknown> = Promise.resolve();
  private evaluando = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      const fila = await this.prisma.alarmaConfig.findUnique({ where: { id: "unica" } });
      if (fila) {
        this.override = (fila.datos as Record<string, string>) ?? {};
        this.overrideInfo = { actualizado: fila.actualizado, por: fila.actualizadoPor };
        this.cfg = leerConfig({ ...process.env, ...this.override });
      }
    } catch (e) {
      this.log.warn(`No se pudo leer alarma_config: ${(e as Error).message}`);
    }
    await this.programar();
  }

  /** Arranca o detiene el motor segun ALARMAS_ACTIVAS (se llama al iniciar y al cambiar la configuracion). */
  private async programar() {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    if (!this.cfg.activas) {
      this.log.warn("Motor de alarmas apagado (ALARMAS_ACTIVAS=false)");
      return;
    }
    if (!this.arrancado) {
      this.arrancado = true;
      try {
        await this.restaurarAbiertos();
      } catch (e) {
        this.log.warn(`No se pudieron recuperar los eventos abiertos: ${(e as Error).message}`);
      }
      this.registrarPuntual("API_REINICIADA", "info", { mensaje: "Gravix arrancó." });
    }
    this.timers.push(setInterval(() => void this.tick(), 5000));
    this.timers.push(setInterval(() => this.agruparAdvertencias(), this.cfg.agruparAdvertenciasMs));
    this.timers.push(setInterval(() => void this.procesarCorreos(), 15000));
    this.timers.push(setInterval(() => this.quizasResumenDiario(), 60000));
    this.prepararTransporte();
    this.log.log(
      `Motor de alarmas iniciado (${this.cfg.sede}): correo ${this.transporte ? "activo" : `desactivado: ${this.correoMotivoInactivo}`}; ` +
        `umbrales min: congelado ${this.cfg.congeladoMs / 60000}, fuera de linea ${this.cfg.fueraDeLineaMs / 60000}, en cero ${this.cfg.enCeroMs / 60000}, sin cambio ${this.cfg.sinCambioMs / 60000}`,
    );
  }

  onModuleDestroy() {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
  }

  // ------------------------------------------------------
  //  Utilidades
  // ------------------------------------------------------
  private iso(ms: number | null | undefined) {
    return ms ? new Date(ms).toISOString() : null;
  }

  horaLocal = (ms: number | null | undefined) => {
    if (!ms) return "-";
    try {
      return new Date(ms).toLocaleString("es-GT", { timeZone: this.cfg.zona, hour12: false });
    } catch {
      return new Date(ms).toISOString();
    }
  };

  duracionTexto = (ms: number | null | undefined) => {
    if (ms == null) return "-";
    const s = Math.round(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d} d ${h} h ${m} min`;
    if (h > 0) return `${h} h ${m} min`;
    if (m > 0) return `${m} min`;
    return `${s} s`;
  };

  private nuevoCodigo(ms: number) {
    const d = new Date(ms);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    const fecha = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
    return `${this.cfg.prefijo}-${fecha}-${randomBytes(2).toString("hex")}`;
  }

  private logEvento(obj: Record<string, unknown>) {
    this.log.warn(`[GRAVIX-EVENTO] ${JSON.stringify({ t: new Date().toISOString(), sede: this.cfg.sede, ...obj })}`);
  }

  private enDb(fn: () => Promise<unknown>) {
    this.dbCola = this.dbCola.then(fn).catch((e) => this.log.warn(`No se guardo en alarma_eventos: ${(e as Error).message}`));
  }

  // ------------------------------------------------------
  //  Base de datos (tabla alarma_eventos, mismas columnas que api_eventos)
  // ------------------------------------------------------
  /** Eventos que dejo abiertos el proceso anterior: los de medidores ya notificados se recuperan tal cual. */
  private async restaurarAbiertos() {
    const filas = await this.prisma.alarmaEvento.findMany({ where: { fin: null, inicio: { lt: new Date(this.inicioProceso) } } });
    const aCerrar: string[] = [];
    for (const row of filas) {
      if (!/^(MEDIDOR_|GENERADOR_)/.test(row.evento) || !row.dispositivo || !row.notificadoEn) {
        aCerrar.push(row.codigo);
        continue;
      }
      const k = `${row.evento}|${row.dispositivo}`;
      if (this.abiertos.has(k)) {
        aCerrar.push(row.codigo);
        continue;
      }
      const notificadoEn = row.notificadoEn.getTime();
      const ev: Ev = {
        codigo: row.codigo, evento: row.evento, severidad: row.severidad, dispositivo: row.dispositivo, inventario: row.inventario,
        inicio: row.inicio.getTime(), detalle: (row.detalle as Record<string, any>) ?? {}, notificado: true, notificadoEn, ultimoAviso: notificadoEn, restaurado: true,
      };
      this.abiertos.set(k, ev);
      if (!this.restaurados.has(row.dispositivo)) this.restaurados.set(row.dispositivo, {});
      this.restaurados.get(row.dispositivo)![row.evento] = ev;
    }
    // Eventos abiertos sin correo enviado (modo paralelo): se recuperan igual, para no duplicarlos.
    for (const row of filas) {
      if (row.notificadoEn || !/^(MEDIDOR_|GENERADOR_)/.test(row.evento) || !row.dispositivo) continue;
      const i = aCerrar.indexOf(row.codigo);
      if (i < 0) continue;
      const k = `${row.evento}|${row.dispositivo}`;
      if (this.abiertos.has(k)) continue;
      aCerrar.splice(i, 1);
      const ev: Ev = {
        codigo: row.codigo, evento: row.evento, severidad: row.severidad, dispositivo: row.dispositivo, inventario: row.inventario,
        inicio: row.inicio.getTime(), detalle: (row.detalle as Record<string, any>) ?? {}, notificado: row.severidad === "critico", notificadoEn: null, ultimoAviso: Date.now(), restaurado: true,
      };
      this.abiertos.set(k, ev);
      if (!this.restaurados.has(row.dispositivo)) this.restaurados.set(row.dispositivo, {});
      this.restaurados.get(row.dispositivo)![row.evento] = ev;
    }
    if (aCerrar.length) {
      const fin = new Date();
      for (const codigo of aCerrar) {
        const r = filas.find((f) => f.codigo === codigo)!;
        await this.prisma.alarmaEvento.update({
          where: { codigo },
          data: {
            fin,
            duracionS: Math.max(0, Math.round((fin.getTime() - r.inicio.getTime()) / 1000)),
            detalle: { ...((r.detalle as object) ?? {}), cerrado_por: "reinicio de Gravix" } as Prisma.InputJsonValue,
          },
        });
      }
    }
    this.restauracionLista = true;
    if (filas.length) this.logEvento({ evento: "EVENTOS_RESTAURADOS", restaurados: filas.length - aCerrar.length, cerrados: aCerrar.length });
  }

  private guardarApertura(ev: Ev) {
    this.enDb(() =>
      this.prisma.alarmaEvento.upsert({
        where: { codigo: ev.codigo },
        update: {},
        create: {
          codigo: ev.codigo, sede: this.cfg.sede, evento: ev.evento, severidad: ev.severidad, dispositivo: ev.dispositivo, inventario: ev.inventario,
          inicio: new Date(ev.inicio), detalle: (ev.detalle ?? {}) as Prisma.InputJsonValue,
        },
      }),
    );
  }

  private guardarCierre(ev: Ev) {
    this.enDb(() =>
      this.prisma.alarmaEvento.updateMany({
        where: { codigo: ev.codigo },
        data: { fin: new Date(ev.fin!), duracionS: Math.round((ev.fin! - ev.inicio) / 1000), detalle: (ev.detalle ?? {}) as Prisma.InputJsonValue },
      }),
    );
  }

  private guardarNotificacion(ev: Ev, campo: "apertura" | "cierre") {
    this.enDb(() =>
      this.prisma.alarmaEvento.updateMany({
        where: { codigo: ev.codigo },
        data: { ...(campo === "cierre" ? { cierreNotificadoEn: new Date() } : { notificadoEn: new Date() }), intentosCorreo: { increment: 1 } },
      }),
    );
  }

  private async limpiarAntiguos() {
    try {
      const limite = new Date(Date.now() - this.cfg.retencionMeses * 30 * 86_400_000);
      const r = await this.prisma.alarmaEvento.deleteMany({ where: { fin: { not: null }, inicio: { lt: limite } } });
      await this.prisma.alarmaCorreo.deleteMany({ where: { creadoEn: { lt: limite } } });
      if (r.count > 0) this.log.log(`limpieza: ${r.count} eventos de más de ${this.cfg.retencionMeses} meses eliminados`);
    } catch (e) {
      this.log.warn(`error en limpieza de eventos: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------
  //  Correo
  // ------------------------------------------------------
  private prepararTransporte() {
    if (this.transporte) return this.transporte;
    const c = this.cfg.correo;
    if (!c.activo) {
      this.correoMotivoInactivo = "ALERTAS_CORREO_ACTIVO no está en true (modo paralelo: los correos los envía api-SIASA)";
      return null;
    }
    if (!c.host || !c.para) {
      this.correoMotivoInactivo = "faltan SMTP_HOST o ALERTAS_CORREO_PARA";
      return null;
    }
    this.transporte = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
    this.correoMotivoInactivo = null;
    return this.transporte;
  }

  private textoEvento(ev: Ev, tipo: string) {
    const guia = GUIA[ev.evento] || ({} as any);
    const l: string[] = [];
    l.push(`Sede:            ${this.cfg.sede}`);
    if (ev.dispositivo) l.push(`Dispositivo:     ${ev.dispositivo}${ev.inventario ? ` (inventario ${ev.inventario})` : ""}`);
    if (ev.detalle?.area) l.push(`Ubicación:       ${ev.detalle.area}`);
    l.push(`Evento:          ${ev.evento} - ${guia.titulo || ""}`);
    l.push(`Severidad:       ${SEVERIDAD_TEXTO[ev.severidad] || ev.severidad}`);
    l.push(`Desde:           ${this.horaLocal(ev.inicio)} (${this.cfg.zona})`);
    if (tipo === "cierre") {
      l.push(`Hasta:           ${this.horaLocal(ev.fin)}`);
      l.push(`Duración:        ${this.duracionTexto(ev.fin! - ev.inicio)}`);
    } else {
      l.push(`Lleva:           ${this.duracionTexto(Date.now() - ev.inicio)}`);
    }
    if (ev.detalle?.mensaje) l.push(`Detalle:         ${ev.detalle.mensaje}`);
    if (tipo !== "cierre") {
      const causa = ev.detalle?.causa || guia.causa;
      if (causa) l.push("", `Causa probable:  ${causa}`);
      if (guia.accion?.length) {
        l.push("", "Qué hacer:");
        guia.accion.forEach((a: string, i: number) => l.push(`  ${i + 1}. ${a}`));
      }
    } else {
      l.push("", "El evento se cerró: los datos volvieron a la normalidad.");
    }
    l.push("", `Estado de la lectura: ${this.estadoGeneral().estado} (última lectura buena: ${this.horaLocal(this.ultimaOk)})`);
    if (this.cfg.urlEstado) l.push(`Estado en vivo:  ${this.cfg.urlEstado}`);
    l.push(`Id. de evento:   ${ev.codigo}`);
    return l.join("\n");
  }

  private asuntoEvento(ev: Ev, tipo: string) {
    const guia = GUIA[ev.evento] || ({} as any);
    const pref = tipo === "cierre" ? "[RESUELTO]" : tipo === "recordatorio" ? `[RECORDATORIO ${SEVERIDAD_TEXTO[ev.severidad]}]` : `[${SEVERIDAD_TEXTO[ev.severidad]}]`;
    const tituloEv = (tipo === "cierre" && guia.tituloCierre) || guia.titulo || ev.evento;
    return `${pref} SIASA ${this.cfg.sede}${ev.dispositivo ? ` - ${ev.inventario ? `${ev.inventario} ` : ""}${ev.dispositivo}` : ""} - ${tituloEv}`;
  }

  private urlsCorreo() {
    return { monitoreo: this.cfg.urlMonitoreo || null, estado: this.cfg.urlEstado || null };
  }

  /** Ficha del medidor tal como esta en este momento (caracteristicas y ultima lectura). */
  private datosDispositivo(nombreOInventario: string | null) {
    if (!nombreOInventario) return null;
    const buscado = String(nombreOInventario).toLowerCase();
    for (const [id, m] of this.medidores) {
      if ([id, m.nombre, m.inventario].some((x) => x && String(x).toLowerCase() === buscado)) {
        return { id, nombre: m.nombre, online: m.online, generador: m.generador || null, info: m.info || {}, metricas: m.metricas || {}, fuente: `Agente Go ${m.agente ?? ""} (lectura directa)`.trim(), momento: this.horaLocal(m.ultimaVez) };
      }
    }
    return null;
  }

  private datosLectura() {
    return {
      ebo: `Agente Go${this.cfg.agentes.length ? ` ${this.cfg.agentes.join(", ")}` : ""}`,
      ultimaOk: this.horaLocal(this.ultimaOk),
      ultimoError: null,
      fallas: null,
      medidores: this.medidores.size ? `${this.medidores.size} (todos los de la sede)` : null,
    };
  }

  private htmlEvento(ev: Ev, tipo: string, { prueba = false, dispositivo = undefined as any } = {}) {
    return plantilla.correoEvento({
      tipo, ev, guia: GUIA[ev.evento] || {}, sede: this.cfg.sede, horaLocal: this.horaLocal, duracionTexto: this.duracionTexto,
      estadoTexto: this.estadoGeneral().estado, dispositivo: dispositivo !== undefined ? dispositivo : this.datosDispositivo(ev.dispositivo),
      lectura: this.datosLectura(), urls: this.urlsCorreo(), prueba,
    });
  }

  private encolarCorreo(item: Omit<ItemCorreo, "intentos">) {
    if (!item.html) {
      try {
        if (item.ev && ["apertura", "cierre", "recordatorio"].includes(item.tipo)) item.html = this.htmlEvento(item.ev, item.tipo);
        else if (item.eventos && /^grupo/.test(item.tipo)) {
          item.html = plantilla.correoGrupo({
            tipo: item.tipo === "grupo-cierre" ? "cierre" : "apertura",
            severidad: item.tipo === "grupo-advertencia" ? "advertencia" : "critico",
            eventos: item.eventos, sede: this.cfg.sede, horaLocal: this.horaLocal, duracionTexto: this.duracionTexto,
            estadoTexto: this.estadoGeneral().estado, urls: this.urlsCorreo(), acciones: (GUIA[item.eventos[0]?.evento] || ({} as any)).accion,
          });
        }
      } catch (e) {
        this.log.warn(`no se pudo armar el HTML del correo: ${(e as Error).message}`);
      }
    }
    // Conservar los valores leidos en el instante de la alerta, incluso en correos agrupados.
    for (const ev of item.ev ? [item.ev] : item.eventos || []) {
      const datos = item.tipo.includes("cierre") ? ev.detalle?.api_recuperacion : ev.detalle?.api_publicada;
      if (!datos) continue;
      const json = JSON.stringify(datos, null, 2);
      const seguro = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const nombre = String(ev.dispositivo).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const bloque = `<div><b>Metricas leidas: ${nombre}</b><pre>${seguro}</pre></div>`;
      item.html = /<\/body>/i.test(item.html || "") ? item.html!.replace(/<\/body>/i, bloque + "</body>") : (item.html || "") + bloque;
      item.texto = (item.texto || "") + `\nMetricas leidas (${ev.dispositivo}):\n${json}`;
    }
    this.colaCorreo.push({ intentos: 0, ...item });
  }

  private codigosDe(item: ItemCorreo) {
    return (item.ev ? [item.ev] : item.eventos ?? []).map((e) => e.codigo);
  }

  private async procesarCorreos() {
    if (this.colaCorreo.length === 0) return;
    const t = this.prepararTransporte();
    if (!t) {
      // Modo paralelo: el correo se arma igual y queda guardado como preparado, sin enviarse.
      const lote = this.colaCorreo.splice(0);
      for (const item of lote) {
        await this.prisma.alarmaCorreo
          .create({ data: { tipo: item.tipo, asunto: item.asunto, codigos: this.codigosDe(item), para: this.cfg.correo.para || null, enviado: false, motivo: this.correoMotivoInactivo, texto: item.texto, html: item.html ?? null } })
          .catch((e) => this.log.warn(`No se guardo el correo preparado: ${(e as Error).message}`));
        this.logEvento({ evento: "CORREO_PREPARADO_SIN_ENVIAR", tipo: item.tipo, asunto: item.asunto });
      }
      return;
    }
    const ahora = Date.now();
    while (this.enviadosUltimaHora.length && ahora - this.enviadosUltimaHora[0] > 3600000) this.enviadosUltimaHora.shift();
    while (this.colaCorreo.length > 0) {
      if (this.enviadosUltimaHora.length >= this.cfg.maxCorreosPorHora) {
        this.logEvento({ evento: "LIMITE_CORREOS", pendientes: this.colaCorreo.length });
        return;
      }
      const item = this.colaCorreo[0];
      try {
        await t.sendMail({ from: this.cfg.correo.de, to: this.cfg.correo.para, cc: this.cfg.correo.cc || undefined, subject: item.asunto, text: item.texto, html: item.html || undefined });
        this.colaCorreo.shift();
        this.enviadosUltimaHora.push(Date.now());
        if (item.ev && item.tipo === "apertura") this.guardarNotificacion(item.ev, "apertura");
        if (item.ev && item.tipo === "cierre") this.guardarNotificacion(item.ev, "cierre");
        (item.eventos || []).forEach((ev) => this.guardarNotificacion(ev, item.tipo === "grupo-cierre" ? "cierre" : "apertura"));
        await this.prisma.alarmaCorreo
          .create({ data: { tipo: item.tipo, asunto: item.asunto, codigos: this.codigosDe(item), para: this.cfg.correo.para, enviado: true, texto: item.texto, html: item.html ?? null } })
          .catch(() => undefined);
        this.logEvento({ evento: "CORREO_ENVIADO", tipo: item.tipo, asunto: item.asunto });
      } catch (e) {
        item.intentos += 1;
        this.logEvento({ evento: "CORREO_FALLIDO", tipo: item.tipo, intentos: item.intentos, error: (e as Error).message });
        if (item.intentos >= 50) this.colaCorreo.shift();
        return;
      }
    }
  }

  // ------------------------------------------------------
  //  Apertura y cierre de eventos
  // ------------------------------------------------------
  private abrir(evento: string, severidad: string, o: { dispositivo?: string | null; inventario?: string | null; detalle?: Record<string, any>; inicio?: number; clave?: string | null; diferir?: boolean; notificar?: boolean } = {}) {
    const { dispositivo = null, inventario = null, detalle = {}, inicio = Date.now(), clave = null, diferir = false, notificar = false } = o;
    const k = clave || `${evento}|${dispositivo || ""}`;
    if (this.abiertos.has(k)) return this.abiertos.get(k)!;
    const ev: Ev = { codigo: this.nuevoCodigo(inicio), evento, severidad, dispositivo, inventario, inicio, detalle, notificado: false, ultimoAviso: null };
    this.abiertos.set(k, ev);
    this.logEvento({ evento, accion: "abierto", severidad, codigo: ev.codigo, dispositivo, inventario, inicio: this.iso(inicio), ...detalle });
    this.guardarApertura(ev);
    if (severidad === "critico" || notificar) {
      if (diferir) this.pendientesMedidores.apertura.push(ev);
      else this.encolarCorreo({ ev, tipo: "apertura", asunto: this.asuntoEvento(ev, "apertura"), texto: this.textoEvento(ev, "apertura") });
      ev.notificado = true;
      ev.notificadoEn = Date.now();
      ev.ultimoAviso = Date.now();
    }
    return ev;
  }

  private cerrar(evento: string, dispositivo: string | null = null, detalleExtra: Record<string, unknown> = {}, { diferir = false, silencioso = false } = {}) {
    const k = `${evento}|${dispositivo || ""}`;
    const ev = this.abiertos.get(k);
    if (!ev) return null;
    this.abiertos.delete(k);
    ev.fin = Date.now();
    ev.detalle = { ...ev.detalle, ...detalleExtra };
    this.logEvento({ evento, accion: "cerrado", codigo: ev.codigo, dispositivo, duracion_s: Math.round((ev.fin - ev.inicio) / 1000), ...detalleExtra });
    this.guardarCierre(ev);
    if (ev.notificado && !silencioso) {
      if (diferir) this.pendientesMedidores.cierre.push(ev);
      else this.encolarCorreo({ ev, tipo: "cierre", asunto: this.asuntoEvento(ev, "cierre"), texto: this.textoEvento(ev, "cierre") });
    }
    return ev;
  }

  /** Si varios medidores fallan a la vez se manda un solo correo. */
  private enviarPendientesMedidores() {
    (["apertura", "cierre"] as const).forEach((tipo) => {
      const lista = this.pendientesMedidores[tipo].splice(0);
      if (lista.length === 0) return;
      if (lista.length < MIN_PARA_AGRUPAR) {
        lista.forEach((ev) => this.encolarCorreo({ ev, tipo, asunto: this.asuntoEvento(ev, tipo), texto: this.textoEvento(ev, tipo) }));
        return;
      }
      const guia = GUIA[lista[0].evento] || ({} as any);
      const l = [
        tipo === "cierre"
          ? `${lista.length} medidores volvieron a la normalidad en ${this.cfg.sede}.`
          : `${lista.length} medidores presentan eventos al mismo tiempo en ${this.cfg.sede}. Cuando fallan varios a la vez, lo más probable es una falla común: la red de la sede, un gateway RS-485 o el Agente Go.`,
        "",
      ];
      lista.forEach((ev) => l.push(`  - ${ev.inventario ? `${ev.inventario} ` : ""}${ev.dispositivo}: ${ev.evento} desde ${this.horaLocal(ev.inicio)}${tipo === "cierre" ? `, duró ${this.duracionTexto(ev.fin! - ev.inicio)}` : ""} (${ev.codigo})`));
      if (tipo !== "cierre" && guia.accion?.length) {
        l.push("", "Qué hacer:");
        l.push("  1. Revisar la red de la sede y los gateways RS-485 de los medidores.");
        guia.accion.forEach((a: string, i: number) => l.push(`  ${i + 2}. ${a}`));
      }
      l.push("", `Estado de la lectura: ${this.estadoGeneral().estado} (última lectura buena: ${this.horaLocal(this.ultimaOk)})`);
      if (this.cfg.urlEstado) l.push(`Estado en vivo:  ${this.cfg.urlEstado}`);
      const asunto = tipo === "cierre"
        ? `[RESUELTO] SIASA ${this.cfg.sede} - ${lista.length} medidores normalizados`
        : `[CRÍTICO] SIASA ${this.cfg.sede} - ${lista.length} medidores con eventos (posible falla común)`;
      this.encolarCorreo({ tipo: `grupo-${tipo}`, asunto, texto: l.join("\n"), eventos: lista });
    });
  }

  /** Evento sin duracion (reinicios): se abre y se cierra en el mismo momento. */
  private registrarPuntual(evento: string, severidad: string, detalle: Record<string, unknown> = {}) {
    const ev = this.abrir(evento, severidad, { detalle, clave: `${evento}|${Date.now()}|${Math.random()}` });
    for (const [k, v] of this.abiertos) if (v === ev) this.abiertos.delete(k);
    ev.fin = ev.inicio;
    this.guardarCierre(ev);
    return ev;
  }

  // ------------------------------------------------------
  //  Lectura de los medidores (de la base de Gravix) y evaluacion
  // ------------------------------------------------------
  /** Medidores ION7400 y PM2130 (como api-SIASA: ion_7400_* y pm_2130_*), con id estilo Telemetria 1. */
  private async leerMedidores(): Promise<DispositivoLeido[]> {
    const devices = await this.prisma.device.findMany({ where: { protocol: "modbus" }, include: { state: true }, orderBy: { name: "asc" } });
    const cuenta: Record<string, number> = {};
    const out: DispositivoLeido[] = [];
    for (const d of devices) {
      const meta = (d.metadata as DeviceMeta | null) ?? {};
      const agente = meta.agent?.buildingKey ?? "";
      if (this.cfg.agentes.length && !this.cfg.agentes.includes(agente.toLowerCase())) continue;
      const { tipo, modelo } = tipoDe(meta);
      if (tipo !== "ion" && tipo !== "pm") continue;
      const a = meta.attributes ?? {};
      cuenta[tipo] = (cuenta[tipo] ?? 0) + 1;
      const id = String(a.device_id ?? `${tipo === "ion" ? "ion_7400" : "pm_2130"}_${cuenta[tipo]}`);
      const r = (d.state?.readings as Record<string, unknown> | null) ?? {};
      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(r)) if (typeof v === "number" && Number.isFinite(v) && !k.startsWith("harm_")) metrics[k] = v;
      out.push({
        id,
        nombre: d.name,
        inventario: (a.code_inventory ?? a.code ?? null) as string | null,
        area: (a.area ?? null) as string | null,
        online: d.state?.state === "online",
        metrics,
        agente,
        info: {
          type: tipo, model: tipo === "ion" ? "7400" : tipo === "pm" ? "2130" : modelo, area: a.area, building: a.building, floor: a.floor, room: a.room,
          group: a.group, fase_energy: a.fase_energy ?? a.phase, capacity: a.capacity ?? a.capacityKva, code_inventory: a.code_inventory ?? a.code,
        },
      });
    }
    return out;
  }

  /** Ultima sincronizacion de los agentes vigilados (equivale a la "ultima lectura buena" de api-SIASA). */
  private async ultimaSincronizacion() {
    const filas = await this.prisma.eventLog.findMany({ where: { type: "agent.sync" }, orderBy: { createdAt: "desc" }, take: 30, select: { createdAt: true, payload: true } });
    const f = filas.find((x) => !this.cfg.agentes.length || this.cfg.agentes.includes(String((x.payload as Record<string, unknown> | null)?.buildingKey ?? "").toLowerCase()));
    return f?.createdAt.getTime() ?? null;
  }

  private async tick() {
    if (this.evaluando) return;
    this.evaluando = true;
    try {
      const sync = await this.ultimaSincronizacion();
      if (sync && sync !== this.ultimaOk) {
        // Llego una sincronizacion nueva del agente: es la "lectura buena" (lecturaOk de api-SIASA).
        this.ultimaOk = sync;
        if (this.abiertos.has("DATOS_CONGELADOS|")) this.cerrar("DATOS_CONGELADOS", null, { recuperado_en: this.iso(sync) });
        this.evaluarMedidores(await this.leerMedidores(), Date.now());
      }
      this.evaluarPeriodico();
    } catch (e) {
      this.log.warn(`Error evaluando alarmas: ${(e as Error).message}`);
    } finally {
      this.evaluando = false;
    }
  }

  private firmaMetricas(metrics: Record<string, number>) {
    const partes: string[] = [];
    Object.keys(metrics || {}).sort().forEach((k) => {
      if (/transfer|status|count/i.test(k)) return;
      partes.push(`${k}=${Number(metrics[k])}`);
    });
    return partes.join("|");
  }

  private voltajesEnCero(metrics: Record<string, number>) {
    const volt = Object.keys(metrics || {}).filter((k) => /volt/i.test(k) && !/unbalance|thd|desbal/i.test(k));
    if (volt.length === 0) return false;
    return volt.every((k) => Number.isFinite(metrics[k]) && Math.abs(metrics[k]) < 1);
  }

  /** Senal S1 (comercial) / S2 (generador) del ION: true, false o null si no viene. */
  private senal(metrics: Record<string, number>, ...keys: string[]) {
    for (const k of keys) {
      const v = metrics[k];
      if (v === 0) return false;
      if (v === 1) return true;
    }
    return null;
  }

  /** Mediciones (sin las senales y conteos de transferencia) todas en cero. */
  private medicionesEnCero(metrics: Record<string, number>) {
    const vals = Object.entries(metrics).filter(([k]) => !/transfer|status|count|transition/i.test(k)).map(([, v]) => v);
    return vals.length > 0 && vals.every((v) => v === 0);
  }

  private evaluarTransferencia(d: DispositivoLeido, m: Medidor, online: boolean, ahora: number, base: { dispositivo: string; inventario: string | null; detalle: Record<string, any> }) {
    if (!/^ion_7400/.test(d.id)) return;
    const s1 = this.senal(d.metrics, "s1_commercial_energy_status", "s1_transfer_normal");
    const s2 = this.senal(d.metrics, "s2_generator_energy_status", "s2_transfer_generator");
    const enCeroTodo = this.medicionesEnCero(d.metrics);
    const conValores = !enCeroTodo && Object.keys(d.metrics).length > 0;
    m.ionSinMediciones = false;
    if (this.cfg.reglasVigilantes) {
      const valido = online && s1 !== null && s2 !== null && Object.keys(d.metrics).length > 0;
      m.ionSinMediciones = valido && this.cfg.ionSinVigilantes.includes(d.id.toLowerCase()) && s1 === true && s2 === false && enCeroTodo;
      this.evaluarReglaIon("MEDIDOR_VIGILANTES_DESCONECTADOS", valido && !s1 && !s2 && conValores, valido && s1 !== s2 && !m.ionSinMediciones, m, ahora, base, d.metrics, s1, s2,
        "S1 y S2 estan en cero: sus vigilantes estan desconectados. Se necesita verificar el equipo. El ION sigue entregando sus mediciones.");
      this.evaluarReglaIon("MEDIDOR_ION_DESCONECTADO", m.ionSinMediciones, valido && !!s1 && !s2 && conValores, m, ahora, base, d.metrics, s1, s2,
        "ION desconectado: S1 (comercial) esta en 1, S2 en 0 y todas sus metricas estan en cero. Los vigilantes de este ION no estan conectados fisicamente. Se sugiere revisar el dispositivo ION.");
      if (valido && !s1 && !s2 && conValores) this.cerrar("MEDIDOR_SIN_TRANSFERENCIA", m.nombre, { reclasificado: "MEDIDOR_VIGILANTES_DESCONECTADOS" }, { silencioso: true });
    }
    m.sinTransferencia = s1 === false && s2 === false && enCeroTodo;
    const abierto = this.abiertos.get(`MEDIDOR_SIN_TRANSFERENCIA|${m.nombre}`);
    if (!online || s1 === null || s2 === null) {
      m.transferenciaFallaDesde = null;
      m.transferenciaRecuperacionDesde = null;
      return;
    }
    if (m.sinTransferencia) {
      m.transferenciaRecuperacionDesde = null;
      if (m.transferenciaFallaDesde == null) m.transferenciaFallaDesde = abierto?.inicio ?? ahora;
      if (ahora - m.transferenciaFallaDesde >= this.cfg.transferenciaConfirmacionMs) {
        this.abrir("MEDIDOR_SIN_TRANSFERENCIA", "critico", {
          ...base, diferir: true, inicio: m.transferenciaFallaDesde,
          detalle: { ...base.detalle, s1: false, s2: false, metricas_en_cero: true, mensaje: "S1 (comercial) y S2 (generador) en false y todas las mediciones en cero: no hay fuente activa." },
        });
      }
    } else {
      m.transferenciaFallaDesde = null;
      if (s1 !== s2 && abierto) {
        if (m.transferenciaRecuperacionDesde == null) m.transferenciaRecuperacionDesde = ahora;
        if (ahora - m.transferenciaRecuperacionDesde >= this.cfg.transferenciaConfirmacionMs) {
          this.cerrar("MEDIDOR_SIN_TRANSFERENCIA", m.nombre, { s1_recuperacion: s1, s2_recuperacion: s2, mensaje_cierre: "Transferencia restablecida: una fuente activa y lecturas disponibles." }, { diferir: true });
          m.transferenciaRecuperacionDesde = null;
        }
      } else m.transferenciaRecuperacionDesde = null;
    }
  }

  private evaluarReglaIon(evento: string, falla: boolean, recuperado: boolean, m: Medidor, ahora: number, base: { dispositivo: string; inventario: string | null; detalle: Record<string, any> }, metricas: Record<string, number>, s1: boolean | null, s2: boolean | null, mensaje: string) {
    const tiempos = m.reglasIon || (m.reglasIon = {});
    const t = tiempos[evento] || (tiempos[evento] = {});
    const abierto = this.abiertos.get(`${evento}|${m.nombre}`);
    if (falla) {
      t.recuperacion = null;
      if (t.falla == null) t.falla = abierto?.inicio ?? ahora;
      if (ahora - t.falla >= this.cfg.transferenciaConfirmacionMs) {
        this.abrir(evento, "critico", { ...base, diferir: true, inicio: t.falla, detalle: { ...base.detalle, s1, s2, mensaje, api_publicada: { ...metricas } } });
      }
    } else {
      t.falla = null;
      if (recuperado && abierto) {
        if (t.recuperacion == null) t.recuperacion = ahora;
        if (ahora - t.recuperacion >= this.cfg.transferenciaConfirmacionMs) {
          this.cerrar(evento, m.nombre, { s1_recuperacion: s1, s2_recuperacion: s2, api_recuperacion: { ...metricas } }, { diferir: true });
          t.recuperacion = null;
        }
      } else t.recuperacion = null;
    }
  }

  private esMedidorGenerador(id: string, nombre: string, inventario: string | null) {
    if (this.cfg.medidoresGenerador.length === 0) return false;
    return [id, nombre, inventario].some((x) => x && this.cfg.medidoresGenerador.includes(String(x).toLowerCase()));
  }

  private evaluarMedidores(devices: DispositivoLeido[], ahora: number) {
    if (!this.restauracionLista) {
      if (ahora - this.inicioProceso > this.cfg.esperaRestauracionMs) this.restauracionLista = true;
      else return;
    }
    for (const d of devices) {
      const { id, nombre, inventario } = d;
      let online = d.online;
      const firma = this.firmaMetricas(d.metrics);
      let m = this.medidores.get(id);
      if (!m) {
        m = { nombre, inventario, area: d.area, firma, cambioEn: ahora, offlineDesde: null, ceroDesde: null };
        // Evento abierto antes del reinicio: se continua desde su inicio (sin nuevo correo de apertura).
        const previo = this.restaurados.get(nombre) || {};
        const desde = previo.MEDIDOR_FUERA_DE_LINEA?.inicio ?? previo.MEDIDOR_SIN_CAMBIO?.inicio;
        if (desde != null) m.cambioEn = desde;
        if (previo.MEDIDOR_FUERA_DE_LINEA) m.offlineDesde = previo.MEDIDOR_FUERA_DE_LINEA.inicio;
        if (previo.MEDIDOR_EN_CERO) m.ceroDesde = previo.MEDIDOR_EN_CERO.inicio;
        this.restaurados.delete(nombre);
        this.medidores.set(id, m);
      }
      if (firma && firma !== m.firma) {
        m.firma = firma;
        m.cambioEn = ahora;
      }

      // Valores repetidos: el medidor responde pero no entrega datos nuevos -> fuera de linea.
      const congelado = online && this.cfg.offlinePorCongeladoMs > 0 && Boolean(firma) && !this.voltajesEnCero(d.metrics) && ahora - m.cambioEn >= this.cfg.offlinePorCongeladoMs;
      if (congelado) online = false;

      m.nombre = nombre;
      m.inventario = inventario;
      m.area = d.area || m.area;
      m.online = online;
      m.ultimaVez = ahora;
      m.info = d.info;
      m.metricas = d.metrics;
      m.agente = d.agente;
      const base = { dispositivo: nombre, inventario, detalle: { area: m.area } as Record<string, any> };

      this.evaluarTransferencia(d, m, online, ahora, base);
      m.online = online && !m.sinTransferencia && !m.ionSinMediciones;

      // Fuera de linea
      if (!online) {
        if (!m.offlineDesde) m.offlineDesde = congelado ? m.cambioEn : ahora;
        if (ahora - m.offlineDesde >= this.cfg.fueraDeLineaMs) {
          const mensaje = congelado
            ? `El medidor no entrega datos nuevos desde hace ${this.duracionTexto(ahora - m.offlineDesde)}: repite el último valor.`
            : `El Agente Go no obtiene lecturas del medidor desde hace ${this.duracionTexto(ahora - m.offlineDesde)}.`;
          this.abrir("MEDIDOR_FUERA_DE_LINEA", "critico", { ...base, diferir: true, inicio: m.offlineDesde, detalle: { ...base.detalle, mensaje } });
        }
        continue; // sin datos validos: no se evalua lo demas
      }
      if (m.offlineDesde) {
        m.offlineDesde = null;
        this.cerrar("MEDIDOR_FUERA_DE_LINEA", nombre, {}, { diferir: true });
      }

      const enCero = this.voltajesEnCero(d.metrics);

      // Sin cambio
      if (firma && (m.cambioEn === ahora || enCero)) {
        this.cerrar("MEDIDOR_SIN_CAMBIO", nombre, {}, { diferir: true, silencioso: enCero });
      } else if (firma && ahora - m.cambioEn >= this.cfg.sinCambioMs) {
        this.abrir("MEDIDOR_SIN_CAMBIO", "critico", { ...base, diferir: true, inicio: m.cambioEn, detalle: { ...base.detalle, mensaje: `Todas las métricas idénticas desde hace ${this.duracionTexto(ahora - m.cambioEn)}.` } });
      }

      // Medidor de generador: con 0 V esta en espera; con voltaje, el generador esta en marcha.
      if (this.esMedidorGenerador(id, nombre, inventario)) {
        if (this.cerrar("MEDIDOR_EN_CERO", nombre, { reclasificado: "medidor de generador: 0 V con el generador apagado" }, { silencioso: true })) m.ceroDesde = null;
        const estadoLeido = enCero ? "apagado" : "en_marcha";
        if (!m.generador) m.generador = estadoLeido;
        if (estadoLeido === m.generador) {
          m.generadorCandidatoDesde = null;
        } else {
          if (!m.generadorCandidatoDesde) m.generadorCandidatoDesde = ahora;
          if (ahora - m.generadorCandidatoDesde >= this.cfg.generadorConfirmacionMs) {
            m.generador = estadoLeido;
            m.generadorCandidatoDesde = null;
          }
        }
        if (m.generador === "en_marcha") {
          this.abrir("GENERADOR_EN_MARCHA", "info", {
            ...base, notificar: this.cfg.generadorCorreo, inicio: m.generadorDesde || ahora,
            detalle: { ...base.detalle, mensaje: `El generador está en marcha: ${inventario ? `${inventario} ` : ""}${nombre} registra voltaje. Este medidor solo mide con el generador encendido.` },
          });
          if (!m.generadorDesde) m.generadorDesde = ahora;
        } else {
          m.generadorDesde = null;
          this.cerrar("GENERADOR_EN_MARCHA", nombre, { mensaje_cierre: "El generador se apagó: el medidor volvió a 0 V (en espera)." });
        }
        continue;
      }

      // Voltaje en cero
      if (m.ionSinMediciones) {
        this.cerrar("MEDIDOR_EN_CERO", nombre, { reclasificado: "MEDIDOR_ION_DESCONECTADO" }, { silencioso: true });
        m.ceroDesde = null;
      } else if (enCero) {
        if (!m.ceroDesde) m.ceroDesde = ahora;
        if (ahora - m.ceroDesde >= this.cfg.enCeroMs) {
          this.abrir("MEDIDOR_EN_CERO", "critico", { ...base, diferir: true, inicio: m.ceroDesde, detalle: { ...base.detalle, mensaje: "Voltajes de todas las fases en 0 V." } });
        }
      } else if (m.ceroDesde) {
        m.ceroDesde = null;
        this.cerrar("MEDIDOR_EN_CERO", nombre, {}, { diferir: true });
      }
    }
    this.enviarPendientesMedidores();
  }

  estadoGeneral(ahora = Date.now()) {
    const antig = this.ultimaOk ? ahora - this.ultimaOk : ahora - this.inicioProceso;
    let estado = "ok";
    let motivo: string | null = null;
    if (!this.ultimaOk && ahora - this.inicioProceso < this.cfg.degradadoMs) estado = "iniciando";
    else if (!this.ultimaOk && !this.medidores.size) {
      // Sede sin equipos todavia (el agente no sincroniza porque no tiene nada que leer).
      estado = "sin_medidores";
      motivo = "el Agente Go todavía no tiene medidores que leer";
    } else if (antig >= this.cfg.congeladoMs) {
      estado = "congelado";
      motivo = `sin lectura buena desde hace ${this.duracionTexto(antig)}`;
    } else if (antig >= this.cfg.degradadoMs) {
      estado = "degradado";
      motivo = `sin lectura buena desde hace ${this.duracionTexto(antig)}`;
    }
    if (estado === "ok" && [...this.abiertos.values()].some((e) => e.evento === "MEDIDOR_SIN_CAMBIO")) {
      estado = "sin_cambio";
      motivo = "uno o más medidores con valores idénticos";
    }
    return { estado, motivo, antiguedadMs: antig };
  }

  private evaluarPeriodico() {
    const ahora = Date.now();
    const g = this.estadoGeneral(ahora);
    // Datos congelados: el agente dejo de sincronizar (solo si alguna vez sincronizo o hay medidores vigilados).
    if (g.estado === "congelado" && (this.ultimaOk || this.medidores.size)) {
      this.abrir("DATOS_CONGELADOS", "critico", {
        inicio: this.ultimaOk || this.inicioProceso,
        detalle: { mensaje: `Gravix no recibe lecturas del Agente Go desde ${this.horaLocal(this.ultimaOk || this.inicioProceso)}.` },
      });
    }
    // Recordatorios de criticos abiertos
    for (const ev of this.abiertos.values()) {
      if (this.cfg.recordatorioMs > 0 && ev.severidad === "critico" && ev.notificado && ev.ultimoAviso && ahora - ev.ultimoAviso >= this.cfg.recordatorioMs) {
        ev.ultimoAviso = ahora;
        this.encolarCorreo({ ev, tipo: "recordatorio", asunto: this.asuntoEvento(ev, "recordatorio"), texto: this.textoEvento(ev, "recordatorio") });
      }
    }
  }

  private agruparAdvertencias() {
    const pendientes = [...this.abiertos.values()].filter((e) => e.severidad === "advertencia" && !e.notificado);
    if (pendientes.length === 0) return;
    pendientes.forEach((e) => {
      e.notificado = true;
      e.notificadoEn = Date.now();
      e.ultimoAviso = Date.now();
    });
    this.encolarCorreo({
      tipo: "grupo-advertencia",
      asunto: `[ADVERTENCIA] SIASA ${this.cfg.sede} - ${pendientes.length} advertencia(s)`,
      texto: pendientes.map((e) => this.textoEvento(e, "apertura")).join("\n\n------------------------------\n\n"),
      eventos: pendientes,
      html: pendientes.length === 1 ? this.htmlEvento(pendientes[0], "apertura") : undefined,
    });
  }

  private minutosLocales(ms: number) {
    try {
      const partes = new Intl.DateTimeFormat("en-GB", { timeZone: this.cfg.zona, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
      const [h, m] = partes.split(":").map(Number);
      return h * 60 + m;
    } catch {
      const d = new Date(ms);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    }
  }

  armarResumen(ahora = Date.now()) {
    const dia = new Date(ahora).toLocaleDateString("en-CA", { timeZone: this.cfg.zona });
    const g = this.estadoGeneral(ahora);
    const l = [
      `Resumen diario de la lectura - ${this.cfg.sede}`,
      `Fecha: ${this.horaLocal(ahora)}`,
      "",
      `Estado actual: ${g.estado}${g.motivo ? ` (${g.motivo})` : ""}`,
      `Última lectura buena: ${this.horaLocal(this.ultimaOk)}`,
      `Eventos abiertos: ${this.abiertos.size}`,
    ];
    for (const e of this.abiertos.values()) l.push(`  - ${e.evento}${e.dispositivo ? ` ${e.dispositivo}` : ""} desde ${this.horaLocal(e.inicio)} (${e.codigo})`);
    l.push("", "Medidores:");
    for (const m of this.medidores.values()) {
      const estadoTxt = !m.online ? "fuera de línea"
        : m.generador === "apagado" ? "en espera (mide solo con el generador encendido; generador apagado)"
        : m.generador === "en_marcha" ? "en línea (generador en marcha)"
        : "en línea";
      l.push(`  - ${m.nombre}${m.inventario ? ` (${m.inventario})` : ""}: ${estadoTxt}, último cambio ${this.horaLocal(m.cambioEn)}`);
    }
    l.push("", "Si el centro de monitoreo no recibe este resumen a la hora habitual, Gravix o el servidor de la sede está caído.");
    return {
      asunto: `[RESUMEN] SIASA ${this.cfg.sede} - ${g.estado.toUpperCase()}`,
      texto: l.join("\n"),
      html: plantilla.correoResumen({
        sede: this.cfg.sede, fecha: dia, estado: g.estado, motivo: g.motivo, ultimaOk: this.horaLocal(this.ultimaOk),
        abiertos: [...this.abiertos.values()], medidores: [...this.medidores.values()], urls: this.urlsCorreo(), horaLocal: this.horaLocal,
      }),
    };
  }

  private quizasResumenDiario() {
    const [hh, mm] = this.cfg.resumenDiarioHora.split(":").map(Number);
    const objetivo = (hh || 0) * 60 + (mm || 0);
    const ahora = Date.now();
    const dia = new Date(ahora).toLocaleDateString("en-CA", { timeZone: this.cfg.zona });
    const min = this.minutosLocales(ahora);
    if (min < objetivo || min > objetivo + 10 || this.ultimoResumenDia === dia) return;
    this.ultimoResumenDia = dia;
    if (this.cfg.resumenDiarioCorreo) this.encolarCorreo({ tipo: "resumen", ...this.armarResumen(ahora) });
    void this.limpiarAntiguos();
  }

  // ------------------------------------------------------
  //  Consultas (las usa la API /sede/...)
  // ------------------------------------------------------
  /** Estado de cada medidor segun el motor, por nombre (ok, fuera_de_linea, en_cero, ...). */
  estadoPorNombre() {
    const porDispositivo = new Map<string, Ev>();
    for (const e of this.abiertos.values()) if (e.dispositivo) porDispositivo.set(e.dispositivo, e);
    const out = new Map<string, { estado: string; evento: string | null; ultimoCambio: string | null }>();
    for (const m of this.medidores.values()) {
      const ev = porDispositivo.get(m.nombre);
      let estado = m.online ? "ok" : "fuera_de_linea";
      if (m.online && m.generador === "apagado") estado = "en_espera_generador_apagado";
      if (m.online && m.generador === "en_marcha") estado = "generador_en_marcha";
      if (ev?.evento === "MEDIDOR_SIN_CAMBIO") estado = "sin_cambio";
      if (ev?.evento === "MEDIDOR_EN_CERO") estado = "en_cero";
      if (this.abiertos.has(`MEDIDOR_SIN_TRANSFERENCIA|${m.nombre}`)) estado = "sin_transferencia";
      if (this.abiertos.has(`MEDIDOR_VIGILANTES_DESCONECTADOS|${m.nombre}`)) estado = "vigilantes_desconectados";
      if (this.abiertos.has(`MEDIDOR_ION_DESCONECTADO|${m.nombre}`)) estado = "fuera_de_linea";
      out.set(m.nombre, { estado, evento: ev?.codigo ?? null, ultimoCambio: this.iso(m.cambioEn) });
    }
    return out;
  }

  /** Eventos abiertos con el formato de /api/vista del monitoreo central (titulo incluido). */
  abiertosVista() {
    return [...this.abiertos.values()].map((e) => ({
      codigo: e.codigo, evento: e.evento, titulo: GUIA[e.evento]?.titulo ?? e.evento, severidad: e.severidad, dispositivo: e.dispositivo, inventario: e.inventario, desde: this.iso(e.inicio),
    }));
  }

  /** Igual que obtenerEstado() de api-SIASA (GET /api/ebo/modbus-auto/estado). */
  obtenerEstado() {
    const g = this.estadoGeneral();
    const est = this.estadoPorNombre();
    return {
      sede: this.cfg.sede,
      motor: this.cfg.activas ? "activo" : "apagado",
      estado: g.estado,
      motivo: g.motivo,
      ultima_lectura_ok: this.iso(this.ultimaOk),
      antiguedad_s: Math.round(g.antiguedadMs / 1000),
      eventos_abiertos: this.abiertosVista(),
      dispositivos: [...this.medidores.entries()].map(([id, m]) => ({
        id, nombre: m.nombre, inventario: m.inventario, area: m.area, estado: est.get(m.nombre)?.estado ?? "ok",
        ...(m.generador ? { medidor_de_generador: true } : {}), ultimo_cambio: this.iso(m.cambioEn), evento: est.get(m.nombre)?.evento ?? null,
      })),
      correo: this.prepararTransporte() ? "activo" : `desactivado: ${this.correoMotivoInactivo}`,
      correo_activo: !!this.transporte,
      pendientes_correo: this.colaCorreo.length,
      proceso_iniciado: this.iso(this.inicioProceso),
    };
  }

  /** Igual que consultarEventos() de api-SIASA (GET /api/ebo/modbus-auto/eventos), mismas columnas. */
  async consultarEventos({ desde, hasta, dispositivo, abiertos, limite }: { desde?: string; hasta?: string; dispositivo?: string; abiertos?: string | boolean; limite?: number }) {
    const where: Prisma.AlarmaEventoWhereInput = {};
    if (desde || hasta) where.inicio = { ...(desde ? { gte: new Date(desde) } : {}), ...(hasta ? { lte: new Date(hasta) } : {}) };
    if (dispositivo) where.OR = [{ dispositivo }, { inventario: dispositivo }];
    if (String(abiertos) === "true") where.fin = null;
    const filas = await this.prisma.alarmaEvento.findMany({ where, orderBy: { inicio: "desc" }, take: Math.min(Math.max(Number(limite) || 200, 1), 2000) });
    return {
      origen: "gravix",
      total: filas.length,
      eventos: filas.map((r) => ({
        codigo: r.codigo, sede: r.sede, evento: r.evento, titulo: GUIA[r.evento]?.titulo ?? r.evento, severidad: r.severidad, dispositivo: r.dispositivo, inventario: r.inventario,
        inicio: r.inicio.toISOString(), fin: r.fin?.toISOString() ?? null, duracion_s: r.duracionS, detalle: r.detalle, notificado_en: r.notificadoEn?.toISOString() ?? null,
        cierre_notificado_en: r.cierreNotificadoEn?.toISOString() ?? null,
      })),
    };
  }

  /** Correos que preparo Gravix (enviados o, en modo paralelo, solo preparados). */
  async correos(dias = 7, limite = 200) {
    const filas = await this.prisma.alarmaCorreo.findMany({
      where: { creadoEn: { gte: new Date(Date.now() - dias * 86_400_000) } },
      orderBy: { creadoEn: "desc" },
      take: Math.min(Math.max(limite, 1), 1000),
      select: { id: true, tipo: true, asunto: true, codigos: true, enviado: true, motivo: true, creadoEn: true },
    });
    return { modo: this.transporte ? "envia" : "paralelo (no envía)", correos: filas };
  }

  async correoHtml(id: string) {
    const c = await this.prisma.alarmaCorreo.findUnique({ where: { id }, select: { html: true, texto: true } });
    return c?.html ?? (c?.texto ? `<pre>${c.texto.replace(/</g, "&lt;")}</pre>` : null);
  }

  // ------------------------------------------------------
  //  Configuracion desde el Centro de mando (modulo "Alarmas y correos")
  // ------------------------------------------------------
  /** Valores efectivos de las variables editables y de donde salen (centro o .env). La clave SMTP no se devuelve. */
  configuracion() {
    const efectivo = { ...process.env, ...this.override } as Record<string, string | undefined>;
    const valores: Record<string, string> = {};
    const desde: Record<string, "centro" | "env"> = {};
    for (const k of Object.keys(EDITABLES)) {
      if (k === "SMTP_CLAVE") continue;
      valores[k] = efectivo[k] ?? "";
      desde[k] = k in this.override ? "centro" : "env";
    }
    return {
      valores,
      desde,
      claveSmtpGuardada: Boolean(efectivo.SMTP_CLAVE),
      sede: this.cfg.sede,
      actualizado: this.overrideInfo.actualizado?.toISOString() ?? null,
      actualizadoPor: this.overrideInfo.por,
      correo: this.prepararTransporte() ? "activo" : `desactivado: ${this.correoMotivoInactivo}`,
    };
  }

  /** Guarda cambios hechos desde el Centro de mando y los aplica al momento (sin reiniciar Gravix). */
  async guardarConfig(entrada: Record<string, unknown>, por: string) {
    const cambios = validarCambios(entrada);
    if ("SMTP_CLAVE" in cambios && cambios.SMTP_CLAVE === "") delete cambios.SMTP_CLAVE; // vacio = conservar la guardada
    const nuevo = { ...this.override, ...cambios };
    const fila = await this.prisma.alarmaConfig.upsert({
      where: { id: "unica" },
      update: { datos: nuevo, actualizadoPor: por },
      create: { id: "unica", datos: nuevo, actualizadoPor: por },
    });
    const antes = { correo: this.cfg.correo.activo, activas: this.cfg.activas };
    this.override = nuevo;
    this.overrideInfo = { actualizado: fila.actualizado, por };
    this.cfg = leerConfig({ ...process.env, ...nuevo });
    this.transporte = null;
    this.prepararTransporte();
    await this.programar();
    this.logEvento({
      evento: "CONFIGURACION_CAMBIADA", por, cambios: Object.keys(cambios),
      correo: `${antes.correo} -> ${this.cfg.correo.activo}`, motor: `${antes.activas} -> ${this.cfg.activas}`,
    });
    return this.configuracion();
  }

  /** Correo de prueba con los datos reales de un medidor (evento simulado). Solo si el envio esta activo. */
  async enviarCorreoPrueba(dispositivo?: string) {
    const t = this.prepararTransporte();
    if (!t) return { enviado: false, motivo: this.correoMotivoInactivo };
    const html = this.vistaPrevia(dispositivo);
    const asunto = `[PRUEBA] SIASA ${this.cfg.sede} - correo de prueba de Gravix`;
    const info = await t.sendMail({ from: this.cfg.correo.de, to: this.cfg.correo.para, cc: this.cfg.correo.cc || undefined, subject: asunto, text: "Correo de prueba de Gravix (evento simulado, datos reales del dispositivo).", html });
    await this.prisma.alarmaCorreo.create({ data: { tipo: "prueba", asunto, para: this.cfg.correo.para, enviado: true, html } }).catch(() => undefined);
    this.logEvento({ evento: "CORREO_PRUEBA", asunto, para: this.cfg.correo.para });
    return { enviado: true, para: this.cfg.correo.para, cc: this.cfg.correo.cc || null, asunto, id_mensaje: (info as { messageId?: string })?.messageId ?? null };
  }

  /** Vista previa del correo con los datos reales de un medidor (evento simulado). */
  vistaPrevia(dispositivo?: string, evento?: string) {
    const tipoEvento = evento && GUIA[evento] && /^MEDIDOR_/.test(evento) ? evento : "MEDIDOR_FUERA_DE_LINEA";
    const disp = this.datosDispositivo(dispositivo ?? null) || this.datosDispositivo([...this.medidores.keys()][0] ?? null);
    const ahora = Date.now();
    const ev: Ev = {
      codigo: `${this.nuevoCodigo(ahora)}-PRUEBA`, evento: tipoEvento, severidad: "critico", dispositivo: disp?.nombre ?? null,
      inventario: (disp?.info?.code_inventory as string) ?? null, inicio: ahora - 15 * 60000, notificadoEn: ahora, notificado: true, ultimoAviso: ahora,
      detalle: { area: disp?.info?.area ?? null, mensaje: "Evento simulado para revisar el formato del correo." },
    };
    return this.htmlEvento(ev, "apertura", { prueba: true, dispositivo: disp });
  }
}
