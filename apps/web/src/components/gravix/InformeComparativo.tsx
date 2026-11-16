/**
 * Informe del comparativo de la Fase B (lectura directa vs AS-P) en IGSS Escuintla, cerrado el 12/11/2026.
 * Son los resultados fijos del analisis (consulta de solo lectura sobre `readings`, ver docs/piloto-gravix.md
 * seccion 9 "Resultado del comparativo"); no se recalculan. El resumen en vivo es la vista "Resumen directo vs AS-P".
 */

import type { ReactNode } from "react";

type Estado ="ok" | "warn" | "bad" | "info";

const COLOR: Record<Estado, string> = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)", info: "var(--accent)" };
const TXT: Record<Estado, string> = { ok: "Coincide", warn: "Revisar", bad: "Falla", info: "Pendiente" };

function Chip({ e, t }: { e: Estado; t?: string }) {
  return (
    <span className="inf-chip" style={{ color: COLOR[e], borderColor: COLOR[e] }}>
      {t ?? TXT[e]}
    </span>
  );
}

const COINCIDEN: [string, string, string, Estado][] = [
  ["Voltaje (fase-neutro y fase-fase)", "99.6 – 100 % dentro de ±1 %", "≤ 0.02 %", "ok"],
  ["Frecuencia", "100 % dentro de ±0.05 Hz", "0.00 Hz", "ok"],
  ["THD de voltaje", "99 – 100 % dentro de ±0.5 puntos", "< 1 %", "ok"],
  ["Demandas pico y estado/conteos del ATS", "100 % iguales", "0", "ok"],
  ["Potencia y corriente de los ION7400 (promedio de 15 min)", "97 – 100 % dentro de ±3 % (ANALIZADOR-4 fase B: 88 – 90 %)", "≤ 0.2 %", "ok"],
  ["Demanda total de los PM2130", "95 – 100 % dentro de ±3 %", "≤ 0.02 %", "ok"],
  ["Corriente de los PM2130 (promedio de 15 min)", "61 – 99 % dentro de ±3 %", "≤ 0.4 % (PM2130-6: −1.5 %)", "warn"],
];

// equipo, minutos pareados, voltaje, frecuencia, potencia/corriente, huecos directo (min en 3 dias), observacion, estado
const EQUIPOS: [string, number, string, string, string, number, string, Estado][] = [
  ["ANALIZADOR-1", 4492, "99.7 %", "100 %", "99.7 %", 2, "AS-P: THD corriente A en 0 y flicker 5 veces más bajo", "ok"],
  ["ANALIZADOR-2", 3033, "100 %", "100 %", "100 %", 1, "AS-P: corriente A en 0 (directo 388 A), THD corriente A en 0, flicker bajo", "ok"],
  ["ANALIZADOR-3", 4271, "99.6 %", "100 %", "96.8 – 97.9 %", 11, "Directo: estado del ATS sin sentido (no tiene esas entradas). AS-P 1 min atrasado", "warn"],
  ["ANALIZADOR-4", 4274, "99.6 %", "100 %", "88.1 – 98.9 %", 5, "Directo: estado del ATS sin sentido. Sin fase C. THD corriente B: AS-P 3.6, directo 14.6", "warn"],
  ["ANALIZADOR-5", 4277, "100 %", "100 %", "98.2 – 98.9 %", 4, "THD corriente B/C: AS-P 2.2, directo 21.4 (confirmar en el medidor)", "warn"],
  ["ANALIZADOR-6", 4277, "100 %", "100 %", "99.6 – 100 %", 4, "AS-P: THD corriente A en 0", "ok"],
  ["Generador Planta Hospital", 3033, "—", "—", "—", 1, "No arrancó en la prueba: kW, Hz, RPM y carga sin verificar. AS-P: factor de potencia 16", "info"],
  ["PM2130-1", 4488, "100 %", "100 %", "86.6 – 95.7 %", 10, "Demanda 100 %. Directo: factor de potencia > 1", "warn"],
  ["PM2130-2", 4273, "100 %", "100 %", "79.3 – 97.5 %", 10, "Demanda 95.4 %. AS-P dejó la corriente fija hasta 16 min", "warn"],
  ["PM2130-3", 4275, "100 %", "100 %", "73.7 – 87.0 %", 8, "Demanda 98.9 %. Carga chica que cambia rápido", "warn"],
  ["PM2130-4", 4274, "100 %", "100 %", "95.8 – 98.6 %", 9, "Demanda 100 %", "ok"],
  ["PM2130-5", 4274, "100 %", "100 %", "93.0 – 99.6 %", 9, "Demanda 100 %", "ok"],
  ["PM2130-6", 4274, "100 %", "100 %", "79.6 – 94.4 %", 9, "Demanda 100 %. Corriente 1.5 % más baja directo", "warn"],
  ["PM2130-7", 4273, "100 %", "100 %", "61.1 – 82.1 %", 10, "Demanda 100 %. Carga chica que cambia rápido", "warn"],
];

const ASP_MAL: [string, string, string, string][] = [
  ["Los 6 ION7400", "THD de corriente fase A", "0 %", "7.3 – 22.8 %"],
  ["ANALIZADOR-2", "Corriente fase A (con 47.8 kW en esa fase)", "0 A", "388 A"],
  ["ANALIZADOR-1, 2 y 3", "Flicker Pst", "0.06 – 0.13", "0.40 – 0.50"],
  ["Generador Planta Hospital", "Factor de potencia", "16", "1.0"],
  ["Generador Planta Hospital", "Voltaje de batería", "27 V (redondeado)", "27.4 V"],
  ["Generador Planta Hospital", "Valores basura guardados el 10/11 07:56", "65535 Hz, 4,252 millones RPM, −32769 kW", "Marca \"sin comunicación\""],
];

const FRESCURA: [string, string, string][] = [
  ["Retraso", "Hasta 1 minuto tarde (en ANALIZADOR-3 la diferencia baja de 15.4 % a 2.8 % al correr el directo 1 min)", "Al momento"],
  ["Voltaje igual a la lectura anterior (ANALIZADOR-1 y 2)", "23 – 29 % de las lecturas, hasta 2 min sin cambiar", "0.2 %"],
  ["Valor más largo sin cambiar", "16 min (corriente del PM2130-2)", "2 min"],
  ["Datos de cada PM2130", "11 valores", "35 – 40 valores (potencia por fase, factor de potencia, THD, kWh, kVArh, kVAh)"],
  ["Disponibilidad en 3 días", "Casi sin huecos, pero con datos congelados o en 0", "99.8 – 100 % (huecos de 1 – 5 min)"],
];

const CORREGIR: [string, string, string][] = [
  ["ANALIZADOR-3 y 4 reportan estado y conteos del ATS sin sentido (−37.9 y −22,307)", "Quitar los registros 411 – 414 del perfil de esos dos medidores", "Pendiente"],
  ["Factor de potencia de los PM2130 mayor a 1 (1.05 – 1.42)", "Confirmar en la pantalla del medidor la codificación de Schneider (−2 a 2) y convertirla", "Pendiente"],
  ["Generador: kW, kVA, Hz, RPM, carga, aceite y combustible sin verificar", "Comparar en la próxima prueba semanal del generador", "Pendiente"],
  ["El agente de prueba no arranca solo si se reinicia el servidor y no tiene configuración remota", "Agregarlo al arranque y activar la configuración remota", "Pendiente"],
];

const CONFIRMAR: [string, string, string, string][] = [
  ["ANALIZADOR-5", "THD de corriente fases B y C", "2.2 %", "21.4 %"],
  ["ANALIZADOR-4", "THD de corriente fase B", "3.6 %", "14.6 %"],
  ["ANALIZADOR-1, 2, 3 y 6", "THD de corriente fases B y C", "5.2 – 6.6 %", "5.8 – 8.4 %"],
  ["PM2130-1 a 6", "Factor de potencia", "No lo manda", "1.05 – 1.42 (imposible)"],
];

const CONCLUSION: [string, string, Estado][] = [
  ["Exactitud en lo básico (voltaje, frecuencia, potencia, demanda)", "Igual al AS-P", "ok"],
  ["Disponibilidad", "99.8 – 100 %", "ok"],
  ["Calidad del dato", "Mejor que el AS-P: más fresca y sin valores basura", "ok"],
  ["Datos extra", "Unas 3 veces más en los PM2130", "ok"],
  ["Listo para producción", "Falta corregir 4 puntos y confirmar el THD de corriente", "warn"],
];

function Tabla({ titulo, head, children, nota }: { titulo: string; head: string[]; children: ReactNode; nota?: string }) {
  return (
    <div className="card2" style={{ overflowX: "auto" }}>
      <div className="h">
        <b>{titulo}</b>
      </div>
      <table className="cmp-table inf-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {nota && (
        <p className="muted" style={{ fontSize: ".76rem", margin: 0 }}>
          {nota}
        </p>
      )}
    </div>
  );
}

export function InformeComparativo() {
  return (
    <section className="pane inf" aria-label="Informe del comparativo directo vs AS-P" style={{ padding: 16, display: "grid", gap: 14 }}>
      <style>{`
        .gx .inf-table td.tx, .gx .inf-table th.tx { text-align: left; font-family: inherit; white-space: normal; min-width: 180px; }
        .gx .inf-table tbody tr { cursor: default; }
        .gx .inf-chip { display: inline-block; border: 1px solid; border-radius: 999px; padding: 1px 8px; font: 600 .7rem/1.5 inherit; white-space: nowrap; }
        .gx .inf-verdict { border: 1px solid var(--ok); border-radius: 12px; padding: 12px 14px; background: var(--panel-2); }
        .gx .inf-verdict b { color: var(--ok); }
      `}</style>

      <div className="inf-verdict">
        <b>Veredicto: la lectura directa (Gravix) es viable.</b> Da los mismos valores que el AS-P en voltaje, frecuencia, potencia y demanda. Además llega
        antes, no se queda congelada y tiene más datos. Antes de pasarla a producción hay que corregir 4 puntos (tabla 5).
        <div className="muted" style={{ fontSize: ".78rem", marginTop: 6 }}>
          Periodo: 09/11/2026 13:08 – 12/11/2026 16:00 (hora de Guatemala). 14 equipos por los dos caminos, unos 2.3 millones de valores. Solo se cuentan los
          minutos con dato de los dos caminos. Tolerancias: voltaje ±1 %, corriente y potencia ±3 %, frecuencia ±0.05 Hz, factor de potencia ±0.02, THD ±0.5
          puntos, flicker ±0.1.
        </div>
      </div>

      <div className="gstats">
        <div className="gstat">
          <span className="v">14</span>
          <span className="t">equipos comparados</span>
        </div>
        <div className="gstat">
          <span className="v" style={{ color: "var(--ok)" }}>99.8 – 100 %</span>
          <span className="t">disponibilidad de la lectura directa</span>
        </div>
        <div className="gstat">
          <span className="v" style={{ color: "var(--ok)" }}>≤ 0.02 %</span>
          <span className="t">diferencia promedio en voltaje</span>
        </div>
        <div className="gstat">
          <span className="v" style={{ color: "var(--warn)" }}>4</span>
          <span className="t">puntos por corregir</span>
        </div>
      </div>

      <Tabla titulo="1. Dónde coinciden" head={["Métrica", "Coincidencia", "Diferencia promedio", "Estado"]}>
        {COINCIDEN.map(([m, c, d, e]) => (
          <tr key={m}>
            <th scope="row" className="tx">{m}</th>
            <td className="tx">{c}</td>
            <td>{d}</td>
            <td><Chip e={e} /></td>
          </tr>
        ))}
      </Tabla>

      <Tabla
        titulo="2. Resultado por equipo (promedio de 15 min, % dentro de tolerancia)"
        head={["Equipo", "Minutos comparados", "Voltaje", "Frecuencia", "Potencia / corriente", "Huecos directo (min)", "Observación", "Estado"]}
        nota="Huecos directo: minutos sin respuesta del medidor en los 3 días, sin contar la prueba de corte del 09/11. ANALIZADOR-2 y el generador se leen directo desde el 10/11 13:27. La corriente de los PM2130 coincide menos porque son cargas chicas (4 a 33 A) que cambian de un segundo a otro; en promedio los dos caminos dan lo mismo."
      >
        {EQUIPOS.map(([n, min, v, f, p, h, o, e]) => (
          <tr key={n}>
            <th scope="row">{n}</th>
            <td>{min.toLocaleString("es-GT")}</td>
            <td>{v}</td>
            <td>{f}</td>
            <td>{p}</td>
            <td>{h}</td>
            <td className="tx">{o}</td>
            <td><Chip e={e} t={e === "info" ? "Sin verificar" : undefined} /></td>
          </tr>
        ))}
      </Tabla>

      <Tabla titulo="3. Datos que el AS-P entrega mal (la lectura directa los corrige)" head={["Equipo", "Dato", "Por el AS-P", "Directo"]}>
        {ASP_MAL.map(([eq, d, a, di]) => (
          <tr key={eq + d}>
            <th scope="row" className="tx">{eq}</th>
            <td className="tx">{d}</td>
            <td style={{ color: "var(--bad)" }}>{a}</td>
            <td style={{ color: "var(--ok)" }} className="tx">{di}</td>
          </tr>
        ))}
      </Tabla>

      <Tabla titulo="4. Frescura y cantidad de datos" head={["Aspecto", "Por el AS-P", "Directo"]}>
        {FRESCURA.map(([a, asp, d]) => (
          <tr key={a}>
            <th scope="row" className="tx">{a}</th>
            <td className="tx">{asp}</td>
            <td className="tx" style={{ color: "var(--ok)" }}>{d}</td>
          </tr>
        ))}
      </Tabla>

      <Tabla titulo="5. Por corregir antes de pasarlo a producción" head={["#", "Problema", "Qué hacer", "Estado"]}>
        {CORREGIR.map(([p, q, s], i) => (
          <tr key={p}>
            <th scope="row">{i + 1}</th>
            <td className="tx">{p}</td>
            <td className="tx">{q}</td>
            <td><Chip e="info" t={s} /></td>
          </tr>
        ))}
      </Tabla>

      <Tabla
        titulo="6. Por confirmar en la pantalla del medidor"
        head={["Equipo", "Dato", "Por el AS-P", "Directo"]}
        nota="Con los datos no se puede saber cuál de los dos es el correcto: hay que verlo en la pantalla del medidor. La recuperación de huecos desde la memoria del ION7400 (Fase C) sigue pendiente."
      >
        {CONFIRMAR.map(([eq, d, a, di]) => (
          <tr key={eq + d}>
            <th scope="row" className="tx">{eq}</th>
            <td className="tx">{d}</td>
            <td>{a}</td>
            <td>{di}</td>
          </tr>
        ))}
      </Tabla>

      <Tabla titulo="7. Conclusión" head={["Aspecto", "Resultado", "Estado"]}>
        {CONCLUSION.map(([a, r, e]) => (
          <tr key={a}>
            <th scope="row" className="tx">{a}</th>
            <td className="tx">{r}</td>
            <td><Chip e={e} t={e === "ok" ? "Cumple" : "Falta"} /></td>
          </tr>
        ))}
      </Tabla>

      <p className="muted" style={{ fontSize: ".76rem", margin: 0 }}>
        Informe fijo con corte al 12/11/2026 16:00. No se tocaron los equipos, el AS-P ni el servidor de producción de Escuintla: solo se consultó el historial
        guardado en este servidor. Para ver los números en vivo, use "Resumen directo vs AS-P".
      </p>
    </section>
  );
}
