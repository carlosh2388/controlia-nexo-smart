import { useState } from "react";
import type { RedSede } from "../../api/red";

/**
 * Arquitectura de Gravix como diagrama unifilar animado (solo administradores).
 * Barras = buses de datos; derivaciones con su interruptor; el movimiento muestra hacia donde viajan los
 * datos: lecturas (verde), consultas del central (celeste), replica de InfluxDB (violeta), alarmas y
 * correos (ambar) y el camino actual de Telemetria 1 por AS-P y api-SIASA (gris azulado).
 * Los estados de la sede Gravix (responde, version, latencia, equipos) vienen en vivo del central.
 */

type Flujo = "lectura" | "consulta" | "replica" | "alarma" | "legado";
const FLUJO: Record<Flujo, { color: string; nombre: string; seg: number }> = {
  lectura: { color: "#22c55e", nombre: "Lecturas de energía", seg: 1.1 },
  consulta: { color: "#38bdf8", nombre: "Consultas del Centro de mando (cada 15 s)", seg: 1.4 },
  replica: { color: "#a78bfa", nombre: "Réplica InfluxDB sede → central", seg: 1.8 },
  alarma: { color: "#f59e0b", nombre: "Alarmas y correos", seg: 1.6 },
  legado: { color: "#64748b", nombre: "Telemetría 1: EBO AS-P → api-SIASA", seg: 2.2 },
};

interface Nodo {
  x: number;
  y: number;
  w: number;
  h: number;
  t: string;
  s: string;
  tipo: "web" | "api" | "bd" | "agente" | "equipo" | "servicio" | "legado";
  info: string[];
}

const TIPO_COLOR: Record<Nodo["tipo"], string> = {
  web: "#38bdf8",
  api: "#3b82f6",
  bd: "#a78bfa",
  agente: "#22c55e",
  equipo: "#f59e0b",
  servicio: "#94a3b8",
  legado: "#64748b",
};

const NODOS: Record<string, Nodo> = {
  webc: { x: 50, y: 58, w: 210, h: 58, t: "Web Nodivo", s: "React · nginx · :5173 / :5443", tipo: "web", info: ["Centro de mando, mapa, alertas, Gravix por voz.", "Habla con la API central por REST (/api/v1, JWT) y recibe cambios por WebSocket /ws."] },
  apic: { x: 320, y: 58, w: 230, h: 58, t: "API central", s: "NestJS · :3010 · modo central", tipo: "api", info: ["Colector: consulta cada Gravix de sede cada 15 s (/sede/vista, /devices, /agents; salud cada 1 min).", "Pasa las consultas de pantalla a la sede (solo GET); las escrituras se hacen en la web de la sede.", "Clave de cada sede cifrada con AES-256-GCM."] },
  pgc: { x: 610, y: 58, w: 230, h: 58, t: "PostgreSQL + TimescaleDB", s: "central · red, sedes, usuarios", tipo: "bd", info: ["Red y sedes (URL, clave cifrada, fuente de alarmas), usuarios y permisos, foto por minuto, TEC 3.", "Pendiente: respaldo nocturno de la configuración de cada sede."] },
  influxc: { x: 900, y: 58, w: 250, h: 58, t: "InfluxDB central", s: ":8286 · réplica de todas las sedes", tipo: "bd", info: ["Un bucket por sede (1 año) con lecturas, alarmas y correos.", "Bucket «resumen» cada 15 min de toda la red (5 años).", "Si se corta el enlace, la sede guarda en cola (hasta 5 GB) y reenvía al volver."] },

  webs: { x: 50, y: 330, w: 150, h: 56, t: "Web local", s: "nginx · :5273", tipo: "web", info: ["La misma web en modo sede: Equipos, Piloto Gravix y Usuarios.", "nginx pasa /api y /ws a la API de la sede: funciona aunque se caiga el enlace al central."] },
  apis: { x: 220, y: 330, w: 160, h: 56, t: "API Gravix", s: "NestJS · :3110", tipo: "api", info: ["Recibe las lecturas de los Agentes Go (x-api-key).", "Motor de alarmas y correos con las reglas de api-SIASA (en paralelo: prepara sin enviar).", "API /sede para el central: salud, vista, telemetría, eventos, alarmas."] },
  tsdb: { x: 400, y: 330, w: 150, h: 56, t: "TimescaleDB", s: "principal · 60 días", tipo: "bd", info: ["Lecturas (readings, comprimidas a los 7 días), fichas, configuración de agentes, usuarios, alarmas y correos.", "Retención del detalle: 60 días (SEDE_RETENCION_DIAS)."] },
  influxs: { x: 570, y: 330, w: 150, h: 56, t: "InfluxDB sede", s: ":8186 · 60 días", tipo: "bd", info: ["Bucket telemetry: lecturas de energía, alarmas y correos (60 días).", "Buckets monitoreo y monitoreo_horas: consumo de la VM (Telegraf).", "Replica todo al InfluxDB central."] },

  ag1: { x: 120, y: 448, w: 150, h: 50, t: "Agente Go", s: "lector principal", tipo: "agente", info: ["Lee los equipos por Modbus TCP y envía a la API Gravix.", "Configuración remota desde la API; guarda hasta 3 días en disco si la API no responde."] },
  ag2: { x: 300, y: 448, w: 150, h: 50, t: "Agente Go 2", s: "segunda red", tipo: "agente", info: ["Segundo lector para la otra red de la sede (perfil agente2 del docker compose)."] },
  tlg: { x: 480, y: 448, w: 120, h: 50, t: "Telegraf", s: "consumo de la VM", tipo: "servicio", info: ["Mide CPU, memoria y disco de cada contenedor y de las bases; escribe en InfluxDB sede (monitoreo)."] },
  rds: { x: 620, y: 448, w: 100, h: 50, t: "Redis · MQTT", s: "cola y broker", tipo: "servicio", info: ["Redis: cola de comandos (BullMQ).", "Mosquitto: broker MQTT local (otros protocolos se trabajan después)."] },

  ion1: { x: 60, y: 572, w: 120, h: 44, t: "ION7400", s: "analizador", tipo: "equipo", info: ["Analizador de calidad de energía (Modbus TCP).", "Pendiente Fase C: recuperar huecos desde su memoria (data recorder)."] },
  ion2: { x: 195, y: 572, w: 120, h: 44, t: "ION7400", s: "analizador", tipo: "equipo", info: ["Analizador de calidad de energía (Modbus TCP)."] },
  pm1: { x: 330, y: 572, w: 120, h: 44, t: "PM2130", s: "medidor", tipo: "equipo", info: ["Medidor de energía (Modbus TCP).", "Pendiente Fase C: estimar la energía perdida con la diferencia del contador."] },
  pm2: { x: 465, y: 572, w: 120, h: 44, t: "PM2130", s: "medidor", tipo: "equipo", info: ["Medidor de energía (Modbus TCP)."] },
  gen: { x: 600, y: 572, w: 120, h: 44, t: "Generador", s: "controlador", tipo: "equipo", info: ["Controlador del generador: marcha, kW y transferencia."] },

  siasa: { x: 860, y: 330, w: 260, h: 56, t: "api-SIASA", s: "una por sede · envía los correos hoy", tipo: "legado", info: ["Camino actual de Telemetría 1. Sigue enviando los correos de alarma.", "El Centro de mando la consulta para las sedes que todavía no tienen Gravix."] },
  asp: { x: 860, y: 448, w: 260, h: 50, t: "EBO AS-P", s: "Schneider · uno por sede", tipo: "legado", info: ["Controlador de Schneider que Gravix reemplaza en cada sede nueva."] },
  eqt1: { x: 860, y: 572, w: 260, h: 44, t: "Equipos de energía", s: "ION7400 · PM2130 · generadores", tipo: "legado", info: ["Los mismos tipos de equipo, leídos por el AS-P."] },
};

/** Puntos de conexion de un nodo (centro arriba / abajo / lados). */
const arriba = (k: string) => ({ x: NODOS[k].x + NODOS[k].w / 2, y: NODOS[k].y });
const abajo = (k: string) => ({ x: NODOS[k].x + NODOS[k].w / 2, y: NODOS[k].y + NODOS[k].h });

/** Barras (buses) del unifilar. */
const BARRAS = [
  { id: "central", x1: 60, x2: 1140, y: 170, nombre: "BARRA CENTRAL · Centro de mando" },
  { id: "sede", x1: 60, x2: 720, y: 300, nombre: "BARRA DE SEDE · API y bases" },
  { id: "datos", x1: 110, x2: 720, y: 425, nombre: "BARRA DE DATOS · agentes" },
  { id: "modbus", x1: 60, x2: 720, y: 545, nombre: "RED MODBUS TCP · equipos de energía" },
];

/** Cables: trazo en el sentido del flujo de datos. */
/** Columna del enlace WAN sede -> central (entre el titulo de la sede y su estado en vivo). */
const WAN_X = 480;
interface Cable { d: string; f: Flujo; corte?: { x: number; y: number }; wan?: boolean }
function cables(sedeOk: boolean): Cable[] {
  const out: Cable[] = [];
  const baja = (k: string, y: number, f: Flujo, haciaNodo: boolean) => {
    const p = abajo(k);
    out.push({ d: haciaNodo ? `M${p.x} ${y}V${p.y}` : `M${p.x} ${p.y}V${y}`, f, corte: { x: p.x, y: (p.y + y) / 2 } });
  };
  const sube = (k: string, y: number, f: Flujo, haciaNodo: boolean) => {
    const p = arriba(k);
    out.push({ d: haciaNodo ? `M${p.x} ${y}V${p.y}` : `M${p.x} ${p.y}V${y}`, f, corte: { x: p.x, y: (p.y + y) / 2 } });
  };
  // equipos -> red Modbus -> agentes -> barra de datos -> API Gravix
  for (const k of ["ion1", "ion2", "pm1", "pm2", "gen"]) sube(k, 545, "lectura", false);
  baja("ag1", 545, "lectura", false);
  baja("ag2", 545, "lectura", false);
  out.push({ d: `M${arriba("ag1").x} ${arriba("ag1").y}V425`, f: "lectura", corte: { x: arriba("ag1").x, y: 436 } });
  out.push({ d: `M${arriba("ag2").x} ${arriba("ag2").y}V425`, f: "lectura", corte: { x: arriba("ag2").x, y: 436 } });
  out.push({ d: `M${arriba("tlg").x} ${arriba("tlg").y}V425`, f: "lectura", corte: { x: arriba("tlg").x, y: 436 } });
  out.push({ d: `M${arriba("rds").x} 425V${arriba("rds").y}`, f: "alarma", corte: { x: arriba("rds").x, y: 436 } });
  out.push({ d: `M${abajo("apis").x} 425V${abajo("apis").y}`, f: "lectura" });
  // API Gravix -> barra de sede -> bases y web local
  out.push({ d: `M${arriba("apis").x} ${arriba("apis").y}V300`, f: "lectura", corte: { x: arriba("apis").x, y: 315 } });
  out.push({ d: `M${arriba("tsdb").x} 300V${arriba("tsdb").y}`, f: "lectura", corte: { x: arriba("tsdb").x, y: 315 } });
  out.push({ d: `M${arriba("influxs").x} 300V${arriba("influxs").y}`, f: "lectura", corte: { x: arriba("influxs").x, y: 315 } });
  out.push({ d: `M${arriba("webs").x} 300V${arriba("webs").y}`, f: "consulta", corte: { x: arriba("webs").x, y: 315 } });
  // alarmas y correos de la sede (motor dentro de la API) hacia TimescaleDB e InfluxDB
  out.push({ d: `M${NODOS.apis.x + NODOS.apis.w} ${NODOS.apis.y + 40}H${NODOS.tsdb.x}`, f: "alarma" });
  // enlace WAN: la sede responde al central (sube)
  out.push({ d: `M${WAN_X} 300V170`, f: sedeOk ? "consulta" : "legado", corte: { x: WAN_X, y: 232 }, wan: true });
  // replica InfluxDB sede -> InfluxDB central (por el pasillo entre zonas, sin cruzar bloques)
  out.push({ d: `M${NODOS.influxs.x + NODOS.influxs.w} ${NODOS.influxs.y + 28}H778V232H870V102H${NODOS.influxc.x}`, f: "replica" });
  // central: nodos sobre la barra central
  for (const k of ["webc", "apic", "pgc", "influxc"]) out.push({ d: `M${abajo(k).x} 170V${abajo(k).y}`, f: k === "webc" ? "consulta" : "lectura", corte: { x: abajo(k).x, y: 143 } });
  // Telemetria 1 (camino actual)
  out.push({ d: `M${arriba("eqt1").x} ${arriba("eqt1").y}V${abajo("asp").y}`, f: "legado" });
  out.push({ d: `M${arriba("asp").x} ${arriba("asp").y}V${abajo("siasa").y}`, f: "legado" });
  out.push({ d: `M${arriba("siasa").x} ${arriba("siasa").y}V170`, f: "legado", corte: { x: arriba("siasa").x, y: 250 } });
  return out;
}

export default function ArquitecturaGravix({ sedesGravix, sedesTelemetria1 }: { sedesGravix: RedSede[]; sedesTelemetria1: number }) {
  const [sel, setSel] = useState<string>("apis");
  const [sedeSel, setSedeSel] = useState<string | null>(sedesGravix[0]?.id ?? null);
  const [verFlujo, setVerFlujo] = useState<Set<Flujo>>(new Set(Object.keys(FLUJO) as Flujo[]));
  const sede = sedesGravix.find((s) => s.id === sedeSel) ?? sedesGravix[0] ?? null;
  const est = sede?.estado ?? null;
  const sedeOk = !!est?.ok;
  const nodo = NODOS[sel];
  const lista = cables(sedeOk);

  return (
    <section aria-label="Arquitectura de Gravix" className="panel flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <span className="eyebrow">Arquitectura de Gravix · diagrama unifilar</span>
          <span className="text-[12.5px] text-slate-400">Cómo va conectada la solución: equipos, Agente Go, Gravix de sede, Centro de mando y bases de datos. Clic en un bloque para ver su detalle.</span>
        </div>
        {sedesGravix.length > 1 && (
          <div role="group" aria-label="Sede Gravix" className="ml-auto flex flex-wrap gap-1.5">
            {sedesGravix.map((s) => (
              <button key={s.id} type="button" aria-pressed={s.id === sede?.id} onClick={() => setSedeSel(s.id)} className={`min-h-[32px] rounded-full border px-3 text-[12px] font-semibold ${s.id === sede?.id ? "border-sky-500 bg-sky-500/15 text-sky-100" : "border-slate-700 text-slate-300"}`}>
                {s.nombre}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="overflow-x-auto rounded-xl border border-[#1a2742] bg-[#070d19]">
          <svg viewBox="0 0 1200 650" className="block min-w-[880px]" width="100%" role="img" aria-label={`Diagrama unifilar de Gravix${sede ? ` para ${sede.nombre}` : ""}`}>
            <defs>
              <pattern id="uniRej" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#111b2e" strokeWidth="1" /></pattern>
              <filter id="uniBrillo" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            </defs>
            <rect width="1200" height="650" fill="url(#uniRej)" />

            {/* zonas */}
            <rect x="20" y="22" width="1160" height="190" rx="14" fill="#0b1426" stroke="#1e3a5f" strokeDasharray="6 6" />
            <text x="36" y="44" fill="#7cc4ff" fontSize="12" fontWeight="800" letterSpacing="2">CENTRO DE MANDO · CENTRAL</text>
            <rect x="30" y="250" width="730" height="385" rx="14" fill="#0a1322" stroke={sedeOk ? "#1f6b3d" : "#7f1d1d"} strokeDasharray="6 6" />
            <text x="46" y="272" fill={sedeOk ? "#86efac" : "#fca5a5"} fontSize="12" fontWeight="800" letterSpacing="2">
              GRAVIX DE SEDE · {(sede?.nombre ?? "sin sede Gravix").toUpperCase()} · VM LINUX + DOCKER
            </text>
            <rect x="800" y="250" width="380" height="385" rx="14" fill="#0b111d" stroke="#334155" strokeDasharray="6 6" />
            <text x="816" y="272" fill="#94a3b8" fontSize="12" fontWeight="800" letterSpacing="2">TELEMETRÍA 1 · {sedesTelemetria1} SEDES (ACTUAL)</text>
            <text x={WAN_X + 12} y="236" fill={sedeOk ? "#7cc4ff" : "#fca5a5"} fontSize="10.5" className="mono">{sedeOk ? "WAN · consulta cada 15 s" : "WAN · enlace cortado"}</text>
            <text x="784" y="226" fill="#c4b5fd" fontSize="10.5" className="mono">réplica</text>

            {/* barras */}
            {BARRAS.map((b) => (
              <g key={b.id}>
                <line x1={b.x1} x2={b.x2} y1={b.y} y2={b.y} stroke={b.id === "modbus" ? "#b45309" : "#2563eb"} strokeWidth="7" strokeLinecap="round" opacity=".55" />
                <line x1={b.x1} x2={b.x2} y1={b.y} y2={b.y} stroke={b.id === "modbus" ? "#fbbf24" : "#7dd3fc"} strokeWidth="2" strokeLinecap="round" className="uni-barra" />
                <text x={b.x2 - 4} y={b.y - 8} fill="#64748b" fontSize="9.5" textAnchor="end" letterSpacing="1">{b.nombre}</text>
              </g>
            ))}

            {/* cables con flujo */}
            {lista.map((c, i) => {
              const fl = FLUJO[c.f];
              const visible = verFlujo.has(c.f);
              return (
                <g key={i} opacity={visible ? 1 : 0.15}>
                  <path d={c.d} fill="none" stroke={fl.color} strokeOpacity=".22" strokeWidth="5" strokeLinecap="round" />
                  <path d={c.d} fill="none" stroke={fl.color} strokeWidth="2" strokeLinecap="round" className="uni-flujo" style={{ animationDuration: `${fl.seg}s` }} filter="url(#uniBrillo)" />
                  {c.corte && (
                    <rect x={c.corte.x - 6} y={c.corte.y - 6} width="12" height="12" rx="2" fill="#0b1220" stroke={c.wan && !sedeOk ? "#ef4444" : fl.color} strokeWidth="1.6" />
                  )}
                </g>
              );
            })}

            {/* bloques */}
            {Object.entries(NODOS).map(([k, n]) => {
              const col = TIPO_COLOR[n.tipo];
              const activo = sel === k;
              const enSede = n.y >= 300 && n.x < 760;
              const apagado = enSede && !sedeOk;
              return (
                <g
                  key={k}
                  role="button"
                  tabIndex={0}
                  aria-label={`${n.t}: ${n.s}`}
                  aria-pressed={activo}
                  onClick={() => setSel(k)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSel(k); } }}
                  className="uni-nodo"
                  style={{ cursor: "pointer" }}
                >
                  <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="10" fill={activo ? "#10213d" : "#0d1628"} stroke={activo ? "#e2e8f0" : col} strokeWidth={activo ? 2 : 1.3} opacity={apagado ? 0.55 : 1} />
                  <rect x={n.x} y={n.y + 8} width="4" height={n.h - 16} rx="2" fill={col} />
                  <text x={n.x + 14} y={n.y + (n.h > 50 ? 24 : 20)} fill="#f1f5f9" fontSize="13" fontWeight="700">{n.t}</text>
                  <text x={n.x + 14} y={n.y + (n.h > 50 ? 42 : 36)} fill="#94a3b8" fontSize="10.5" className="mono">{n.s}</text>
                </g>
              );
            })}

            {/* estado en vivo de la sede Gravix */}
            {sede && (
              <g>
                <circle cx="742" cy="268" r="6" fill={sedeOk ? "#22c55e" : "#ef4444"} className="uni-latido" />
                <text x="732" y="272" fill={sedeOk ? "#86efac" : "#fca5a5"} fontSize="10.5" textAnchor="end" className="mono">
                  {sedeOk ? `responde${est?.latenciaMs != null ? ` · ${est.latenciaMs} ms` : ""}${est?.equipos != null ? ` · ${est.equipos} equipos` : ""}${est?.version ? ` · v${est.version}` : ""}` : "sin respuesta"}
                </text>
              </g>
            )}
          </svg>
        </div>

        <aside className="flex flex-col gap-3">
          <div className="rounded-xl border border-slate-800 bg-[#0d1628] p-4">
            <span className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-sm" style={{ background: TIPO_COLOR[nodo.tipo] }} />
              <b className="text-[15px] text-slate-100">{nodo.t}</b>
            </span>
            <span className="mono mt-1 block text-[11.5px] text-slate-400">{nodo.s}</span>
            <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-4 text-[13px] leading-relaxed text-slate-300">
              {nodo.info.map((l) => <li key={l}>{l}</li>)}
            </ul>
            {sede && (sel === "apis" || sel === "influxs" || sel === "tsdb") && est && (
              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-800 pt-3 text-[12px]">
                <span className="text-slate-400">Motor de alarmas</span><span className="text-slate-200">{est.alarmas?.motor ?? "—"}</span>
                <span className="text-slate-400">Correos</span><span className="text-slate-200">{est.alarmas ? (est.alarmas.correoActivo ? "envía" : "en paralelo (no envía)") : "—"}</span>
                <span className="text-slate-400">Alarmas abiertas</span><span className="text-slate-200">{est.alarmas?.abiertos ?? "—"}</span>
              </div>
            )}
          </div>
          <div className="rounded-xl border border-slate-800 bg-[#0d1628] p-4">
            <span className="eyebrow">Flujos de datos</span>
            <div className="mt-2 flex flex-col gap-1.5">
              {(Object.keys(FLUJO) as Flujo[]).map((f) => {
                const on = verFlujo.has(f);
                return (
                  <label key={f} className="flex min-h-[30px] cursor-pointer items-center gap-2 text-[12.5px] text-slate-200">
                    <input type="checkbox" checked={on} onChange={() => setVerFlujo((p) => { const n = new Set(p); if (n.has(f)) n.delete(f); else n.add(f); return n; })} />
                    <span className="h-[3px] w-6 rounded" style={{ background: FLUJO[f].color }} />
                    {FLUJO[f].nombre}
                  </label>
                );
              })}
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-slate-400">Los cuadros pequeños sobre cada línea son las derivaciones (interruptores) de la barra; en rojo, el enlace está cortado.</p>
          </div>
        </aside>
      </div>
    </section>
  );
}
