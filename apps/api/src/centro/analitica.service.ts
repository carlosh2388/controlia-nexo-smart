import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { Access } from "../access/access.service";
import { CentroService } from "./centro.service";

/**
 * Analitica predictiva del Centro de mando, calculada aqui mismo (sin servicios externos ni licencias).
 * Fuente: centro_lecturas (una foto por minuto de kW, voltaje, corriente y estado de cada medidor).
 *  - Desconexiones: episodios fuera de linea / voltaje en cero; tasa de fallas reciente vs. del periodo
 *    y probabilidad de otra caida en 7 dias (modelo de Poisson: p = 1 - e^(-tasa x 7 dias)).
 *  - Voltaje: desviacion contra el nominal deducido (120/127/208/220/230/240/277/480 V), tendencia
 *    diaria (regresion lineal) y dias estimados para salir de +-5 %; dias con caidas de tension (<90 %).
 *  - Carga: demanda maxima diaria, crecimiento semana contra semana y pico proyectado a 7 dias.
 *  - Comunicacion: huecos sin datos de la sede (mas de 5 min) y lecturas congeladas.
 * Es una estimacion estadistica con pocos dias de historia: orienta el mantenimiento, no lo reemplaza.
 */

type Nivel = "alto" | "medio" | "bajo";
export interface Hallazgo {
  id: string;
  tipo: "desconexion" | "voltaje" | "carga" | "comunicacion" | "lectura" | "generador";
  nivel: Nivel;
  /** 0-100, para ordenar. */
  puntaje: number;
  /** Probabilidad estimada (0-1) de que ocurra en los proximos 7 dias, cuando aplica. */
  probabilidad: number | null;
  sedeId: string;
  sedeNombre: string;
  equipo: string | null;
  inventario: string | null;
  titulo: string;
  detalle: string;
  recomendacion: string;
  /** Valores por dia para la mini grafica (null = sin dato). */
  serie: { etiqueta: string; dias: string[]; valores: (number | null)[]; unidad: string } | null;
}

interface FilaEpisodios {
  sede: string;
  medidor: string;
  muestras: number;
  desde: Date;
  hasta: Date;
  caidas: number;
  caidas_3d: number;
  min_caido: number;
  ultima_caida: Date | null;
  arranques_gen: number;
  min_gen: number;
  min_congelado: number;
  huecos: number;
  huecos_3d: number;
  min_hueco: number;
  caidas_24h: number;
  min_caido_24h: number;
  huecos_24h: number;
}
interface Fila24h {
  sede: string;
  medidor: string;
  kw24: number | null;
  kwprev: number | null;
  v24: number | null;
  vmin24: number | null;
}

/** Lo que paso en las ultimas 24 horas en una sede y lo peor que se proyecta. */
export interface Sede24h {
  sedeId: string;
  sedeNombre: string;
  nivel: "critico" | "advertencia" | "estable";
  caidas: number;
  minSinDatos: number;
  cortesComunicacion: number;
  caidasTension: string[];
  criticas: number;
  advertencias: number;
  /** Cambio del consumo promedio contra las 24 h anteriores (%), si hay datos. */
  cambioConsumo: number | null;
  riesgo: { titulo: string; nivel: Nivel; probabilidad: number | null } | null;
}
interface FilaDia {
  sede: string;
  medidor: string;
  dia: Date;
  v: number | null;
  vmin: number | null;
  kw: number | null;
  kwmax: number | null;
  min_caido: number;
}

const DIAS = 14;
const CACHE_MS = 10 * 60_000;
const NOMINALES = [120, 127, 208, 220, 230, 240, 277, 480];
const CAIDO = ["fuera_de_linea", "en_cero"];

const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (p: number) => `${Math.round(p * 100)} %`;
const nivelDe = (p: number): Nivel => (p >= 0.6 ? "alto" : p >= 0.3 ? "medio" : "bajo");
const PESO: Record<Nivel, number> = { alto: 70, medio: 40, bajo: 10 };

/** Regresion lineal simple (x = indice del dia). */
function regresion(ys: number[]) {
  const n = ys.length;
  if (n < 2) return { pendiente: 0, r2: 0 };
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  ys.forEach((y, i) => {
    sxy += (i - mx) * (y - my);
    sxx += (i - mx) ** 2;
    syy += (y - my) ** 2;
  });
  const pendiente = sxx ? sxy / sxx : 0;
  return { pendiente, r2: syy ? (sxy * sxy) / (sxx * syy) : 0 };
}

const hace = (d: Date) => {
  const h = (Date.now() - d.getTime()) / 3_600_000;
  if (h < 1) return "hace menos de una hora";
  if (h < 48) return `hace ${Math.round(h)} horas`;
  return `hace ${Math.round(h / 24)} días`;
};

@Injectable()
export class AnaliticaService {
  private readonly log = new Logger("AnaliticaService");
  private cache: { at: number; episodios: FilaEpisodios[]; dias: FilaDia[]; ultimas: Fila24h[] } | null = null;
  private pendiente: Promise<NonNullable<AnaliticaService["cache"]>> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly centro: CentroService,
  ) {}

  private async datos() {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    this.pendiente ??= (async () => {
      try {
        const [episodios, dias, ultimas] = await Promise.all([
          this.prisma.$queryRaw<FilaEpisodios[]>`
            WITH x AS (
              SELECT sede, medidor, "time", estado,
                     lag(estado) OVER w AS prev, lag("time") OVER w AS prev_t
              FROM centro_lecturas
              WHERE "time" > now() - make_interval(days => ${DIAS}::int)
              WINDOW w AS (PARTITION BY sede, medidor ORDER BY "time"))
            SELECT sede, medidor,
              count(*)::int AS muestras, min("time") AS desde, max("time") AS hasta,
              count(*) FILTER (WHERE estado = ANY(${CAIDO}) AND NOT (coalesce(prev, 'ok') = ANY(${CAIDO})))::int AS caidas,
              count(*) FILTER (WHERE estado = ANY(${CAIDO}) AND NOT (coalesce(prev, 'ok') = ANY(${CAIDO})) AND "time" > now() - interval '3 days')::int AS caidas_3d,
              count(*) FILTER (WHERE estado = ANY(${CAIDO}))::int AS min_caido,
              max("time") FILTER (WHERE estado = ANY(${CAIDO})) AS ultima_caida,
              count(*) FILTER (WHERE estado = 'generador_en_marcha' AND coalesce(prev, '') <> 'generador_en_marcha')::int AS arranques_gen,
              count(*) FILTER (WHERE estado = 'generador_en_marcha')::int AS min_gen,
              count(*) FILTER (WHERE estado = 'sin_cambio')::int AS min_congelado,
              count(*) FILTER (WHERE "time" - prev_t > interval '5 minutes')::int AS huecos,
              count(*) FILTER (WHERE "time" - prev_t > interval '5 minutes' AND "time" > now() - interval '3 days')::int AS huecos_3d,
              coalesce(sum(extract(epoch FROM ("time" - prev_t)) / 60) FILTER (WHERE "time" - prev_t > interval '5 minutes'), 0)::float AS min_hueco,
              count(*) FILTER (WHERE estado = ANY(${CAIDO}) AND NOT (coalesce(prev, 'ok') = ANY(${CAIDO})) AND "time" > now() - interval '24 hours')::int AS caidas_24h,
              count(*) FILTER (WHERE estado = ANY(${CAIDO}) AND "time" > now() - interval '24 hours')::int AS min_caido_24h,
              count(*) FILTER (WHERE "time" - prev_t > interval '5 minutes' AND "time" > now() - interval '24 hours')::int AS huecos_24h
            FROM x GROUP BY sede, medidor`,
          this.prisma.$queryRaw<FilaDia[]>`
            SELECT sede, medidor, time_bucket('1 day', "time", 'America/Guatemala') AS dia,
              avg("vProm") FILTER (WHERE "vProm" > 1 AND NOT (estado = ANY(${CAIDO})))::float AS v,
              min("vProm") FILTER (WHERE "vProm" > 1 AND NOT (estado = ANY(${CAIDO})))::float AS vmin,
              avg(kw) FILTER (WHERE NOT (estado = ANY(${CAIDO})))::float AS kw,
              max(kw) FILTER (WHERE NOT (estado = ANY(${CAIDO})))::float AS kwmax,
              count(*) FILTER (WHERE estado = ANY(${CAIDO}))::int AS min_caido
            FROM centro_lecturas
            WHERE "time" > now() - make_interval(days => ${DIAS}::int)
            GROUP BY 1, 2, 3 ORDER BY 3`,
          this.prisma.$queryRaw<Fila24h[]>`
            SELECT sede, medidor,
              avg(kw) FILTER (WHERE "time" > now() - interval '24 hours' AND NOT (estado = ANY(${CAIDO})))::float AS kw24,
              avg(kw) FILTER (WHERE "time" <= now() - interval '24 hours' AND NOT (estado = ANY(${CAIDO})))::float AS kwprev,
              avg("vProm") FILTER (WHERE "time" > now() - interval '24 hours' AND "vProm" > 1)::float AS v24,
              min("vProm") FILTER (WHERE "time" > now() - interval '24 hours' AND "vProm" > 1)::float AS vmin24
            FROM centro_lecturas
            WHERE "time" > now() - interval '48 hours'
            GROUP BY 1, 2`,
        ]);
        this.cache = { at: Date.now(), episodios, dias, ultimas };
        return this.cache;
      } finally {
        this.pendiente = null;
      }
    })();
    return this.pendiente;
  }

  /** Hallazgos y pronosticos de las sedes que el usuario puede ver. */
  async para(access: Access) {
    const vista = this.centro.vistaPara(access);
    const { episodios, dias, ultimas, at } = await this.datos();
    const sedes = new Map(vista.sedes.map((s) => [s.id, s]));
    const equipo = (sede: string, medidor: string) => sedes.get(sede)?.dispositivos.find((d) => d.id === medidor) ?? null;
    const diasDe = new Map<string, FilaDia[]>();
    for (const d of dias) {
      const k = `${d.sede}|${d.medidor}`;
      if (!diasDe.has(k)) diasDe.set(k, []);
      diasDe.get(k)!.push(d);
    }
    const etiqueta = (d: Date) => d.toLocaleDateString("es-GT", { timeZone: "America/Guatemala", day: "2-digit", month: "2-digit" });

    const hallazgos: Hallazgo[] = [];
    const porSedeHuecos = new Map<string, FilaEpisodios>();

    for (const e of episodios) {
      const sede = sedes.get(e.sede);
      const eq = equipo(e.sede, e.medidor);
      if (!sede || !eq) continue; // sede sin permiso o medidor que ya no existe
      const base = { sedeId: sede.id, sedeNombre: sede.nombre, equipo: eq.nombre, inventario: eq.inventario };
      const serieDias = diasDe.get(`${e.sede}|${e.medidor}`) ?? [];
      const diasObs = Math.max(1, (new Date(e.hasta).getTime() - new Date(e.desde).getTime()) / 86_400_000);
      const id = `${e.sede}|${e.medidor}`;

      // Huecos de comunicacion: se evaluan por sede (todos sus medidores caen juntos).
      const prev = porSedeHuecos.get(e.sede);
      if (!prev || e.huecos > prev.huecos) porSedeHuecos.set(e.sede, e);

      /* ---- desconexiones ---- */
      const caidoAhora = CAIDO.includes(eq.estado);
      if (e.caidas > 0 || caidoAhora) {
        // Tasa de fallas del periodo; si en los ultimos 3 dias fallo mas seguido, se sube hasta 1.5 veces.
        const tasa14 = e.caidas / diasObs;
        const tasa3 = e.caidas_3d / Math.min(3, diasObs);
        const subiendo = e.caidas_3d > 0 && tasa3 > tasa14 * 1.5;
        const tasa = tasa14 * (e.caidas_3d > 0 ? Math.min(1.5, Math.max(1, tasa3 / (tasa14 || 1))) : 0.7);
        const p = caidoAhora ? 1 : 1 - Math.exp(-tasa * 7);
        const mtbfH = e.caidas > 1 ? (diasObs * 24) / e.caidas : null;
        // Cortes muy breves (menos de 15 min en total): avisan, pero no son una falla grave.
        const breves = e.min_caido < 15;
        let nivel: Nivel = caidoAhora ? "alto" : nivelDe(p);
        if (!caidoAhora && breves && nivel === "alto") nivel = "medio";
        hallazgos.push({
          id: `${id}|desconexion`,
          tipo: "desconexion",
          nivel,
          puntaje: Math.min(100, PESO[nivel] + p * 30),
          probabilidad: caidoAhora ? null : p,
          ...base,
          titulo: caidoAhora ? `${eq.nombre} está fuera de línea ahora` : `${eq.nombre} puede volver a desconectarse`,
          detalle:
            `${e.caidas} ${e.caidas === 1 ? (breves ? "corte breve" : "caída") : breves ? "cortes breves" : "caídas"} en ${Math.round(diasObs)} días (${Math.round(e.min_caido)} min sin datos en total${e.ultima_caida ? `; la última ${hace(new Date(e.ultima_caida))}` : ""}).` +
            (mtbfH ? ` Tiempo medio entre fallas: ${mtbfH >= 48 ? `${r1(mtbfH / 24)} días` : `${Math.round(mtbfH)} horas`}.` : "") +
            (caidoAhora ? "" : ` Probabilidad de otra caída en los próximos 7 días: ${pct(p)}${subiendo ? ", y van en aumento" : ""}.`),
          recomendacion: "Revisar la comunicación del equipo (cable RS-485 / Ethernet, gateway) y la alimentación del medidor; si cae en voltaje cero, revisar los fusibles de medición.",
          serie: serieDias.length ? { etiqueta: "Minutos sin datos por día", dias: serieDias.map((d) => etiqueta(d.dia)), valores: serieDias.map((d) => d.min_caido), unidad: "min" } : null,
        });
      }

      /* ---- voltaje ---- */
      const vDias = serieDias.filter((d) => d.v != null);
      if (vDias.length >= 3) {
        const vs = vDias.map((d) => d.v as number);
        const mediana = [...vs].sort((a, b) => a - b)[Math.floor(vs.length / 2)];
        const nominal = NOMINALES.reduce((a, b) => (Math.abs(b - mediana) < Math.abs(a - mediana) ? b : a));
        if (Math.abs(mediana - nominal) / nominal < 0.15) {
          const ultimo = vs[vs.length - 1];
          const desv = ((ultimo - nominal) / nominal) * 100;
          const { pendiente, r2 } = regresion(vs);
          const limite = nominal * (pendiente >= 0 ? 1.05 : 0.95);
          const diasLimite = Math.abs(pendiente) > 0.05 && r2 > 0.5 ? (limite - ultimo) / pendiente : null;
          const caidasV = vDias.filter((d) => d.vmin != null && (d.vmin as number) < nominal * 0.9).length;
          let nivel: Nivel | null = null;
          let titulo = "";
          if (Math.abs(desv) >= 5) {
            nivel = "alto";
            titulo = `Voltaje fuera de rango en ${eq.nombre}`;
          } else if (diasLimite != null && diasLimite > 0 && diasLimite <= 14) {
            nivel = diasLimite <= 7 ? "alto" : "medio";
            titulo = `El voltaje de ${eq.nombre} va hacia el límite`;
          } else if (caidasV >= 2) {
            nivel = "medio";
            titulo = `Caídas de tensión repetidas en ${eq.nombre}`;
          } else if (Math.abs(desv) >= 3) {
            nivel = "bajo";
            titulo = `Voltaje de ${eq.nombre} alejado del nominal`;
          }
          if (nivel) {
            hallazgos.push({
              id: `${id}|voltaje`,
              tipo: "voltaje",
              nivel,
              puntaje: PESO[nivel] + Math.min(20, Math.abs(desv) * 2),
              probabilidad: null,
              ...base,
              titulo,
              detalle:
                `Promedio de hoy ${r1(ultimo)} V contra ${nominal} V nominal (${desv >= 0 ? "+" : ""}${r1(desv)} %).` +
                (Math.abs(pendiente) > 0.05 ? ` Tendencia: ${pendiente > 0 ? "sube" : "baja"} ${r1(Math.abs(pendiente))} V por día.` : " Sin tendencia marcada.") +
                (diasLimite != null && diasLimite > 0 && diasLimite <= 30 ? ` A este ritmo saldría de ±5 % en unos ${Math.round(diasLimite)} días.` : "") +
                (caidasV ? ` ${caidasV} ${caidasV === 1 ? "día tuvo" : "días tuvieron"} caídas por debajo del 90 %.` : ""),
              recomendacion: "Verificar el tap del transformador y las conexiones de la acometida; si las caídas coinciden con arranques de cargas grandes, revisar su secuencia de arranque.",
              serie: { etiqueta: "Voltaje promedio por día", dias: vDias.map((d) => etiqueta(d.dia)), valores: vs.map(r1), unidad: "V" },
            });
          }
        }
      }

      /* ---- carga ---- */
      const kDias = serieDias.filter((d) => d.kwmax != null && (d.kwmax as number) > 1);
      if (kDias.length >= 6) {
        const ks = kDias.map((d) => d.kwmax as number);
        const mitad = Math.floor(ks.length / 2);
        const antes = ks.slice(0, mitad);
        const ahora = ks.slice(mitad);
        const prom = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
        const crec = ((prom(ahora) - prom(antes)) / prom(antes)) * 100;
        const { pendiente } = regresion(ks);
        const proyectado = ks[ks.length - 1] + pendiente * 7;
        if (crec >= 10) {
          // Con pocos dias de historia el aumento no pasa de "medio".
          const nivel: Nivel = crec >= 25 && kDias.length >= 8 ? "alto" : crec >= 15 ? "medio" : "bajo";
          hallazgos.push({
            id: `${id}|carga`,
            tipo: "carga",
            nivel,
            puntaje: PESO[nivel] + Math.min(20, crec / 2),
            probabilidad: null,
            ...base,
            titulo: `La demanda de ${eq.nombre} va en aumento`,
            detalle: `La demanda máxima diaria subió ${Math.round(crec)} % (de ${Math.round(prom(antes))} a ${Math.round(prom(ahora))} kW en promedio). Si sigue así, en 7 días el pico rondaría ${Math.round(Math.max(proyectado, ks[ks.length - 1]))} kW.`,
            recomendacion: "Confirmar si hay cargas nuevas en el circuito y comparar el pico proyectado con la capacidad del transformador y del interruptor principal.",
            serie: { etiqueta: "Demanda máxima por día", dias: kDias.map((d) => etiqueta(d.dia)), valores: ks.map((k) => Math.round(k)), unidad: "kW" },
          });
        }
      }

      /* ---- lectura congelada ---- */
      if (e.min_congelado >= 30) {
        const nivel: Nivel = e.min_congelado >= 240 ? "medio" : "bajo";
        hallazgos.push({
          id: `${id}|lectura`,
          tipo: "lectura",
          nivel,
          puntaje: PESO[nivel],
          probabilidad: null,
          ...base,
          titulo: `${eq.nombre} entregó valores congelados`,
          detalle: `Durante ${Math.round(e.min_congelado)} minutos sus valores no cambiaron: el equipo responde pero podría estar atascado.`,
          recomendacion: "Revisar el registro del medidor en el EBO y, si se repite, reiniciar su comunicación.",
          serie: null,
        });
      }

      /* ---- generador ---- */
      if (e.arranques_gen >= 2) {
        hallazgos.push({
          id: `${id}|generador`,
          tipo: "generador",
          nivel: e.arranques_gen >= 5 ? "medio" : "bajo",
          puntaje: e.arranques_gen >= 5 ? 40 : 15,
          probabilidad: null,
          ...base,
          titulo: `${sede.nombre} pasó ${e.arranques_gen} veces a generador`,
          detalle: `En ${Math.round(diasObs)} días el generador estuvo en marcha ${Math.round(e.min_gen / 60)} horas en total.`,
          recomendacion: "Revisar con la distribuidora la calidad del suministro y el nivel de combustible del generador.",
          serie: null,
        });
      }
    }

    /* ---- comunicacion con la sede ---- */
    for (const [sedeId, e] of porSedeHuecos) {
      if (e.huecos < 2) continue;
      const sede = sedes.get(sedeId)!;
      const diasObs = Math.max(1, (new Date(e.hasta).getTime() - new Date(e.desde).getTime()) / 86_400_000);
      const tasa = e.huecos_3d > 0 ? 0.6 * (e.huecos_3d / Math.min(3, diasObs)) + 0.4 * (e.huecos / diasObs) : 0.7 * (e.huecos / diasObs);
      const p = 1 - Math.exp(-tasa * 7);
      const nivel = nivelDe(p);
      hallazgos.push({
        id: `${sedeId}|comunicacion`,
        tipo: "comunicacion",
        nivel,
        puntaje: PESO[nivel] * 0.8 + p * 20,
        probabilidad: p,
        sedeId,
        sedeNombre: sede.nombre,
        equipo: null,
        inventario: null,
        titulo: `${sede.nombre} puede volver a quedar sin comunicación`,
        detalle: `La sede dejó de reportar ${e.huecos} veces en ${Math.round(diasObs)} días (${Math.round(e.min_hueco)} min en total). Probabilidad de otro corte de comunicación en 7 días: ${pct(p)}.`,
        recomendacion: "Revisar el enlace de red de la sede (ZeroTier/VPN, router) y el servidor de la api-SIASA.",
        serie: null,
      });
    }

    hallazgos.sort((a, b) => b.puntaje - a.puntaje);

    /* ---- ultimas 24 horas por sede ---- */
    const sedes24h: Sede24h[] = [...sedes.values()].map((s) => {
      const eps = episodios.filter((e) => e.sede === s.id && equipo(e.sede, e.medidor));
      const ult = ultimas.filter((u) => u.sede === s.id && equipo(u.sede, u.medidor));
      // Consumo: analizadores ION7400 (o todos si la sede no tiene ION).
      const ion = ult.filter((u) => /ion/i.test(u.medidor) || /ion/i.test(equipo(u.sede, u.medidor)?.nombre ?? ""));
      const base = ion.length ? ion : ult;
      const kw24 = base.reduce((a, u) => a + (u.kw24 ?? 0), 0);
      const kwPrev = base.reduce((a, u) => a + (u.kwprev ?? 0), 0);
      const cambio = kwPrev > 1 && kw24 > 0 ? ((kw24 - kwPrev) / kwPrev) * 100 : null;
      const tension = ult
        .filter((u) => u.v24 != null && u.vmin24 != null)
        .filter((u) => {
          const nom = NOMINALES.reduce((a, b) => (Math.abs(b - (u.v24 as number)) < Math.abs(a - (u.v24 as number)) ? b : a));
          return (u.vmin24 as number) < nom * 0.9;
        })
        .map((u) => equipo(u.sede, u.medidor)!.nombre);
      const abiertos = (s.abiertos ?? []) as Array<{ severidad?: string; evento?: string; titulo?: string }>;
      // Igual que la web: los vigilantes desconectados (instrumentacion) cuentan como advertencia.
      const criticas = abiertos.filter((a) => a.severidad === "critico" && !/VIGILANTE/i.test(`${a.evento ?? ""} ${a.titulo ?? ""}`)).length;
      const peor = hallazgos.find((h) => h.sedeId === s.id) ?? null;
      const caidas = eps.reduce((a, e) => a + e.caidas_24h, 0);
      const cortes = Math.max(0, ...eps.map((e) => e.huecos_24h));
      // "critico" solo por lo que paso en estas 24 h; un riesgo a futuro deja la sede en "advertencia".
      const nivel: Sede24h["nivel"] =
        s.sin_respuesta || criticas || caidas ? "critico" : abiertos.length || cortes || tension.length || peor?.nivel === "alto" || peor?.nivel === "medio" ? "advertencia" : "estable";
      return {
        sedeId: s.id,
        sedeNombre: s.nombre,
        nivel,
        caidas,
        minSinDatos: eps.reduce((a, e) => a + e.min_caido_24h, 0),
        cortesComunicacion: cortes,
        caidasTension: tension,
        criticas,
        advertencias: abiertos.length - criticas,
        cambioConsumo: cambio == null ? null : r1(cambio),
        riesgo: peor ? { titulo: peor.titulo, nivel: peor.nivel, probabilidad: peor.probabilidad } : null,
      };
    });
    const ordenNivel = { critico: 0, advertencia: 1, estable: 2 };
    sedes24h.sort((a, b) => ordenNivel[a.nivel] - ordenNivel[b.nivel]);

    const historia = episodios.length ? new Date(Math.min(...episodios.map((e) => new Date(e.desde).getTime()))) : null;
    return {
      generado: new Date(at).toISOString(),
      diasAnalizados: historia ? Math.max(1, Math.round((Date.now() - historia.getTime()) / 86_400_000)) : 0,
      equiposAnalizados: episodios.filter((e) => equipo(e.sede, e.medidor)).length,
      resumen: {
        alto: hallazgos.filter((h) => h.nivel === "alto").length,
        medio: hallazgos.filter((h) => h.nivel === "medio").length,
        bajo: hallazgos.filter((h) => h.nivel === "bajo").length,
      },
      hallazgos,
      sedes24h,
    };
  }
}
