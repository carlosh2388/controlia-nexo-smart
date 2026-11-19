/* eslint-disable @typescript-eslint/no-explicit-any */
// ======================================================
//  PLANTILLA HTML DE LOS CORREOS DE ALERTA
//  Copia de api-SIASA/monitoreo/plantilla_correo.js (misma presentacion que reciben hoy los
//  responsables de cada sede). Cambios: el pie dice que el correo lo envia Gravix y la tarjeta de la
//  lectura habla del Agente Go en vez del EBO.
//  Tablas y estilos en linea para que se vea bien en Outlook / Microsoft 365.
// ======================================================

const COLORES: Record<string, { fuerte: string; suave: string; texto: string; nombre: string; icono: string }> = {
  critico: { fuerte: "#C62828", suave: "#FDECEA", texto: "#7F1D1D", nombre: "CRÍTICO", icono: "&#9888;" },
  advertencia: { fuerte: "#B45309", suave: "#FEF3C7", texto: "#78350F", nombre: "ADVERTENCIA", icono: "&#9888;" },
  info: { fuerte: "#1D4ED8", suave: "#E0EAFF", texto: "#1E3A8A", nombre: "INFORMATIVO", icono: "&#8505;" },
  resuelto: { fuerte: "#15803D", suave: "#DCFCE7", texto: "#14532D", nombre: "RESUELTO", icono: "&#10004;" },
  prueba: { fuerte: "#6D28D9", suave: "#EDE9FE", texto: "#4C1D95", nombre: "PRUEBA", icono: "&#9881;" },
};

const NEUTRO = {
  fondo: "#EEF2F6",
  tarjeta: "#FFFFFF",
  borde: "#E2E8F0",
  texto: "#0F172A",
  secundario: "#475569",
  tenue: "#94A3B8",
  marca: "#0B2E59",
};

const FUENTE = "font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

function esc(v: unknown) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function valor(m: any): number | null {
  if (m == null) return null;
  const v = typeof m === "object" && "value" in m ? m.value : m;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function unidad(m: any, porDefecto = "") {
  return (m && typeof m === "object" && m.unit) || porDefecto;
}

function fmt(n: number | null | undefined, dec = 1) {
  if (n == null) return "—";
  return Number(n).toLocaleString("es-GT", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

// ------------------------------------------------------
//  Bloques
// ------------------------------------------------------
function pastilla(texto: string, fondo: string, color: string) {
  return `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${fondo};color:${color};font-size:11px;font-weight:700;letter-spacing:.08em;${FUENTE}">${texto}</span>`;
}

function encabezado({ paleta, titulo, resumen, sede, codigo, etiquetaSuperior }: any) {
  return `
  <tr><td style="background:${NEUTRO.marca};padding:14px 28px;${FUENTE}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="color:#C7D7EE;font-size:12px;letter-spacing:.12em;font-weight:600;${FUENTE}">SIASA &middot; MONITOREO DE ENERG&Iacute;A</td>
      <td align="right" style="color:#C7D7EE;font-size:12px;${FUENTE}">${esc(sede)}</td>
    </tr></table>
  </td></tr>
  <tr><td style="background:${paleta.suave};border-left:6px solid ${paleta.fuerte};padding:24px 28px 22px 22px;${FUENTE}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="56" valign="top">
        <div style="width:44px;height:44px;line-height:44px;border-radius:50%;background:${paleta.fuerte};color:#fff;font-size:22px;text-align:center;">${paleta.icono}</div>
      </td>
      <td valign="top" style="${FUENTE}">
        <div style="margin-bottom:6px;">${pastilla(etiquetaSuperior || paleta.nombre, paleta.fuerte, "#FFFFFF")}</div>
        <div style="font-size:22px;line-height:28px;font-weight:700;color:${paleta.texto};">${esc(titulo)}</div>
        <div style="font-size:14px;line-height:21px;color:${NEUTRO.secundario};margin-top:6px;">${resumen}</div>
      </td>
    </tr></table>
    <div style="font-size:11px;color:${NEUTRO.tenue};margin-top:12px;${FUENTE}">Id. de evento: <b style="color:${NEUTRO.secundario};">${esc(codigo)}</b></div>
  </td></tr>`;
}

// Linea de tiempo: Detectado -> Notificado -> Resuelto
function lineaDeTiempo({ inicio, notificado, fin, duracion, paleta, horaLocal }: any) {
  const paso = (activo: boolean, titulo: string, hora: string, color: string) => `
    <td align="center" width="33%" style="${FUENTE}">
      <div style="width:22px;height:22px;line-height:22px;border-radius:50%;margin:0 auto;background:${activo ? color : "#FFFFFF"};border:2px solid ${activo ? color : NEUTRO.borde};color:#fff;font-size:12px;">${activo ? "&#10003;" : ""}</div>
      <div style="font-size:12px;font-weight:700;color:${activo ? NEUTRO.texto : NEUTRO.tenue};margin-top:6px;">${titulo}</div>
      <div style="font-size:11px;color:${NEUTRO.tenue};">${hora}</div>
    </td>`;
  const verde = COLORES.resuelto.fuerte;
  return `
  <tr><td style="padding:22px 28px 6px 28px;${FUENTE}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${paso(true, "Detectado", horaLocal(inicio), paleta.fuerte)}
        ${paso(Boolean(notificado), "Notificado", notificado ? horaLocal(notificado) : "—", paleta.fuerte)}
        ${paso(Boolean(fin), "Resuelto", fin ? horaLocal(fin) : "pendiente", verde)}
      </tr>
    </table>
    <div style="text-align:center;margin-top:12px;">
      ${pastilla(`&#9201; ${fin ? "DUR&Oacute;" : "LLEVA"} ${esc(duracion).toUpperCase()}`, NEUTRO.fondo, NEUTRO.secundario)}
    </div>
  </td></tr>`;
}

function titulo(texto: string) {
  return `<div style="font-size:12px;font-weight:700;letter-spacing:.1em;color:${NEUTRO.tenue};margin:0 0 10px 0;${FUENTE}">${texto}</div>`;
}

function tarjetaDispositivo(disp: any) {
  if (!disp) return "";
  const info = disp.info || {};
  const online = disp.online !== false;
  const modelo = [info.type ? String(info.type).toUpperCase() : "", info.model || ""].filter(Boolean).join(" ");
  const filas = ([
    ["Inventario", info.code_inventory],
    ["Equipo", disp.nombre],
    ["Modelo", modelo || null],
    ["&Aacute;rea", info.area],
    ["Edificio", info.building],
    ["Piso", info.floor],
    ["Sala", info.room],
    ["Grupo", info.group],
    ["Sistema", info.fase_energy],
    ["Capacidad", info.capacity != null ? `${fmt(info.capacity, 0)} kVA` : null],
    ["Fuente de datos", disp.fuente],
    ["Id. interno", disp.id],
  ] as [string, unknown][]).filter(([, v]) => v != null && v !== "");

  const mitad = Math.ceil(filas.length / 2);
  const columna = (lista: [string, unknown][]) => lista.map(([k, v]) => `
      <tr>
        <td style="padding:5px 0;font-size:12px;color:${NEUTRO.tenue};width:42%;${FUENTE}">${k}</td>
        <td style="padding:5px 0;font-size:13px;color:${NEUTRO.texto};font-weight:600;${FUENTE}">${esc(v)}</td>
      </tr>`).join("");

  return `
  <tr><td style="padding:18px 28px 6px 28px;">
    ${titulo("DISPOSITIVO AFECTADO")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${NEUTRO.borde};border-radius:10px;">
      <tr><td style="padding:16px 18px;border-bottom:1px solid ${NEUTRO.borde};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="62" valign="middle">
            <div style="width:50px;height:50px;line-height:50px;border-radius:10px;background:${NEUTRO.marca};color:#fff;text-align:center;font-weight:800;font-size:13px;${FUENTE}">${esc((info.type || "EQ").toString().toUpperCase().slice(0, 3))}</div>
          </td>
          <td valign="middle" style="${FUENTE}">
            <div style="font-size:19px;font-weight:800;color:${NEUTRO.texto};">${esc(info.code_inventory || disp.nombre)}</div>
            <div style="font-size:13px;color:${NEUTRO.secundario};">${esc(disp.nombre)}${info.area ? ` &middot; ${esc(info.area)}` : ""}</div>
          </td>
          <td align="right" valign="middle">
            ${!online ? pastilla("&#9679; FUERA DE L&Iacute;NEA", "#FDECEA", "#991B1B")
              : disp.generador === "apagado" ? pastilla("&#9679; EN ESPERA &middot; GENERADOR APAGADO", "#EEF2F6", "#475569")
              : disp.generador === "en_marcha" ? pastilla("&#9679; GENERADOR EN MARCHA", "#E0EAFF", "#1E3A8A")
              : pastilla("&#9679; EN L&Iacute;NEA", "#DCFCE7", "#166534")}
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:10px 18px 12px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="top" width="50%" style="padding-right:12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${columna(filas.slice(0, mitad))}</table></td>
          <td valign="top" width="50%" style="padding-left:12px;border-left:1px solid ${NEUTRO.borde};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${columna(filas.slice(mitad))}</table></td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>`;
}

// Barras por fase: muestra a simple vista si una fase esta caida o desbalanceada
function barrasFases(fases: { f: string; v: number | null }[], unidadTxt: string, maxRef?: number) {
  const maximo = Math.max(maxRef || 0, ...fases.map((f) => f.v || 0), 1);
  return fases.map((f) => {
    const pct = f.v == null ? 0 : Math.max(2, Math.round((f.v / maximo) * 100));
    const color = f.v == null ? NEUTRO.borde : f.v === 0 ? COLORES.critico.fuerte : "#2563EB";
    return `
      <tr>
        <td width="18" style="font-size:11px;color:${NEUTRO.tenue};font-weight:700;${FUENTE}">${f.f}</td>
        <td style="padding:3px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${NEUTRO.fondo};border-radius:4px;"><tr>
            <td width="${pct}%" style="background:${color};height:8px;border-radius:4px;font-size:0;line-height:0;">&nbsp;</td><td style="font-size:0;line-height:0;">&nbsp;</td>
          </tr></table>
        </td>
        <td width="70" align="right" style="font-size:12px;color:${f.v === 0 ? COLORES.critico.fuerte : NEUTRO.texto};font-weight:600;${FUENTE}">${fmt(f.v, 1)} ${unidadTxt}</td>
      </tr>`;
  }).join("");
}

function tarjetaMetricas(disp: any, momento: string) {
  const m = disp?.metricas;
  if (!m || Object.keys(m).length === 0) return "";
  const g = (k: string) => valor(m[k]);
  const prom = (ks: string[]) => {
    const xs = ks.map(g).filter((x): x is number => x != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const thd = ["thd_voltage_v1_high", "thd_voltage_v2_high", "thd_voltage_v3_high"].map(g).filter((x): x is number => x != null);
  // Fuera de linea: las metricas se muestran en rojo para no confundirlas con una lectura real.
  const fuera = disp.online === false;
  const colorValor = fuera ? COLORES.critico.fuerte : NEUTRO.texto;

  const destacadas = ([
    ["Potencia activa", g("active_power_total"), unidad(m.active_power_total, "kW"), 1],
    ["Potencia aparente", g("apparent_power_total"), unidad(m.apparent_power_total, "kVA"), 1],
    ["Demanda", g("demand_total"), unidad(m.demand_total, "kW"), 1],
    ["Factor de potencia", g("power_factor_total"), "", 2],
    ["Frecuencia", g("frequency"), unidad(m.frequency, "Hz"), 2],
    ["THD voltaje m&aacute;x.", thd.length ? Math.max(...thd) : null, "%", 1],
  ] as [string, number | null, string, number][]).filter(([, v]) => v != null);

  const celdas = destacadas.map(([k, v, u, d]) => `
      <td width="33%" valign="top" style="padding:6px;">
        <div style="border:1px solid ${NEUTRO.borde};border-radius:10px;padding:12px 12px 10px 12px;${FUENTE}">
          <div style="font-size:11px;color:${NEUTRO.tenue};font-weight:600;">${k}</div>
          <div style="font-size:20px;font-weight:800;color:${colorValor};margin-top:4px;">${fmt(v, d)}<span style="font-size:12px;color:${NEUTRO.secundario};font-weight:600;"> ${esc(u)}</span></div>
        </div>
      </td>`);
  const filasCeldas: string[] = [];
  for (let i = 0; i < celdas.length; i += 3) {
    const fila = celdas.slice(i, i + 3);
    while (fila.length < 3) fila.push('<td width="33%"></td>');
    filasCeldas.push(`<tr>${fila.join("")}</tr>`);
  }

  const vLN = [["A", "voltage_a_n"], ["B", "voltage_b_n"], ["C", "voltage_c_n"]].map(([f, k]) => ({ f, v: g(k) }));
  const corr = [["A", "current_a"], ["B", "current_b"], ["C", "current_c"]].map(([f, k]) => ({ f, v: g(k) }));
  const hayV = vLN.some((x) => x.v != null);
  const hayI = corr.some((x) => x.v != null);

  return `
  <tr><td style="padding:18px 22px 6px 22px;">
    <div style="padding:0 6px;">${titulo(`LECTURA DEL MEDIDOR &middot; ${esc(momento)}`)}</div>
    ${fuera ? `<div style="margin:0 6px 8px 6px;background:${COLORES.critico.suave};color:${COLORES.critico.texto};border-radius:8px;padding:10px 12px;font-size:13px;line-height:19px;${FUENTE}"><b>Medidor sin comunicaci&oacute;n:</b> las m&eacute;tricas mostradas son las &uacute;ltimas que entreg&oacute;.</div>` : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${filasCeldas.join("")}</table>
    ${hayV || hayI ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;"><tr>
      ${hayV ? `<td valign="top" width="50%" style="padding:6px;">
        <div style="border:1px solid ${NEUTRO.borde};border-radius:10px;padding:12px;${FUENTE}">
          <div style="font-size:11px;color:${NEUTRO.tenue};font-weight:600;margin-bottom:6px;">Voltaje fase-neutro &middot; prom. ${fmt(prom(["voltage_a_n", "voltage_b_n", "voltage_c_n"]), 1)} V</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${barrasFases(vLN, "V", 132)}</table>
        </div></td>` : ""}
      ${hayI ? `<td valign="top" width="50%" style="padding:6px;">
        <div style="border:1px solid ${NEUTRO.borde};border-radius:10px;padding:12px;${FUENTE}">
          <div style="font-size:11px;color:${NEUTRO.tenue};font-weight:600;margin-bottom:6px;">Corriente por fase &middot; prom. ${fmt(prom(["current_a", "current_b", "current_c"]), 1)} A</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${barrasFases(corr, "A")}</table>
        </div></td>` : ""}
    </tr></table>` : ""}
    <div style="font-size:11px;color:${NEUTRO.tenue};padding:4px 6px 0 6px;${FUENTE}">Las barras en rojo indican una fase en 0.</div>
  </td></tr>`;
}

function tarjetaLectura(lectura: any) {
  if (!lectura) return "";
  const filas = ([
    ["Origen", lectura.ebo],
    ["&Uacute;ltima lectura buena", lectura.ultimaOk],
    ["&Uacute;ltimo error", lectura.ultimoError || "ninguno"],
    ["Fallas seguidas", lectura.fallas],
    ["Medidores que dejan de actualizarse", lectura.medidores],
  ] as [string, unknown][]).filter(([, v]) => v != null && v !== "");
  return `
  <tr><td style="padding:18px 28px 6px 28px;">
    ${titulo("LECTURA DEL AGENTE GO")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${NEUTRO.borde};border-radius:10px;">
      ${filas.map(([k, v], i) => `<tr>
        <td style="padding:10px 16px;font-size:12px;color:${NEUTRO.tenue};${i ? `border-top:1px solid ${NEUTRO.borde};` : ""}${FUENTE}">${k}</td>
        <td style="padding:10px 16px;font-size:13px;color:${NEUTRO.texto};font-weight:600;${i ? `border-top:1px solid ${NEUTRO.borde};` : ""}${FUENTE}">${esc(v)}</td>
      </tr>`).join("")}
    </table>
  </td></tr>`;
}

function causaYAcciones({ causa, acciones, paleta }: any) {
  const pasos = ((acciones || []) as string[]).map((a, i) => `
      <tr>
        <td width="34" valign="top" style="padding:6px 0;">
          <div style="width:24px;height:24px;line-height:24px;border-radius:50%;background:${NEUTRO.marca};color:#fff;font-size:12px;font-weight:700;text-align:center;${FUENTE}">${i + 1}</div>
        </td>
        <td valign="top" style="padding:8px 0 6px 0;font-size:14px;line-height:20px;color:${NEUTRO.texto};${FUENTE}">${esc(a)}</td>
      </tr>`).join("");
  return `
  ${causa ? `<tr><td style="padding:18px 28px 6px 28px;">
    ${titulo("CAUSA PROBABLE")}
    <div style="background:${paleta.suave};border-radius:10px;padding:14px 16px;font-size:14px;line-height:21px;color:${paleta.texto};${FUENTE}">${esc(causa)}</div>
  </td></tr>` : ""}
  ${pasos ? `<tr><td style="padding:18px 28px 6px 28px;">
    ${titulo("QU&Eacute; HACER")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${pasos}</table>
  </td></tr>` : ""}`;
}

function botones(urls: { monitoreo?: string | null; estado?: string | null }) {
  const b = (texto: string, href: string | null | undefined, primario: boolean) => href ? `
      <td style="padding:0 6px;">
        <a href="${esc(href)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:${primario ? NEUTRO.marca : "#FFFFFF"};color:${primario ? "#FFFFFF" : NEUTRO.marca};border:1px solid ${NEUTRO.marca};font-size:14px;font-weight:700;text-decoration:none;${FUENTE}">${texto}</a>
      </td>` : "";
  const html = b("Ver monitoreo en vivo", urls.monitoreo, true) + b("Estado (JSON)", urls.estado, false);
  if (!html.trim()) return "";
  return `<tr><td align="center" style="padding:24px 28px 8px 28px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${html}</tr></table></td></tr>`;
}

function pie({ sede, estadoTexto, nota }: any) {
  return `
  <tr><td style="padding:22px 28px 26px 28px;border-top:1px solid ${NEUTRO.borde};font-size:12px;line-height:18px;color:${NEUTRO.tenue};${FUENTE}">
    ${nota ? `<div style="margin-bottom:8px;color:${NEUTRO.secundario};">${nota}</div>` : ""}
    Estado actual de la lectura en ${esc(sede)}: <b style="color:${NEUTRO.secundario};">${esc(estadoTexto)}</b><br>
    Correo autom&aacute;tico de Gravix (monitoreo de eventos de la sede). No responder a esta direcci&oacute;n.
  </td></tr>`;
}

function documento(preencabezado: string, filas: string[]) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SIASA</title></head>
<body style="margin:0;padding:0;background:${NEUTRO.fondo};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preencabezado)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${NEUTRO.fondo};"><tr><td align="center" style="padding:24px 10px;">
  <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:${NEUTRO.tarjeta};border-radius:14px;overflow:hidden;border:1px solid ${NEUTRO.borde};">
    ${filas.join("\n")}
  </table>
</td></tr></table>
</body></html>`;
}

// ------------------------------------------------------
//  Correos completos
// ------------------------------------------------------
export function correoEvento(d: any) {
  // d: { tipo, ev, guia, sede, horaLocal, duracionTexto, estadoTexto, dispositivo, lectura, urls, prueba }
  const resuelto = d.tipo === "cierre";
  const paleta = d.prueba ? COLORES.prueba : resuelto ? COLORES.resuelto : COLORES[d.ev.severidad] || COLORES.info;
  const sujeto = d.dispositivo ? `${d.dispositivo.info?.code_inventory || ""} ${d.dispositivo.nombre}`.trim() : `la lectura de ${d.sede}`;
  const tituloEv = (resuelto && d.guia.tituloCierre) || d.guia.titulo || d.ev.evento;
  const resumen = resuelto
    ? d.ev.evento === "MEDIDOR_FUERA_DE_LINEA"
      ? `<b>${esc(sujeto)}</b> volvi&oacute; a comunicar y entrega datos nuevos.`
      : d.ev.evento === "GENERADOR_EN_MARCHA"
      ? `El generador se apag&oacute;: <b>${esc(sujeto)}</b> volvi&oacute; a 0 V y queda en espera (solo mide con el generador encendido).`
      : `El evento en <b>${esc(sujeto)}</b> se resolvi&oacute; y los datos volvieron a la normalidad.`
    : `${esc(d.ev.detalle?.mensaje || "")} ${d.dispositivo ? `Equipo: <b>${esc(sujeto)}</b>.` : ""}`;
  const etiqueta = d.prueba
    ? "CORREO DE PRUEBA"
    : resuelto ? "RESUELTO" : d.tipo === "recordatorio" ? `RECORDATORIO &middot; ${paleta.nombre}` : paleta.nombre;
  const filas = [
    encabezado({ paleta, titulo: tituloEv, resumen, sede: d.sede, codigo: d.ev.codigo, etiquetaSuperior: etiqueta }),
    lineaDeTiempo({
      inicio: d.ev.inicio,
      notificado: d.ev.notificadoEn || (resuelto ? null : Date.now()),
      fin: d.ev.fin,
      duracion: d.duracionTexto((d.ev.fin || Date.now()) - d.ev.inicio),
      paleta,
      horaLocal: d.horaLocal,
    }),
    tarjetaDispositivo(d.dispositivo),
    tarjetaMetricas(d.dispositivo, d.dispositivo?.momento || ""),
    d.dispositivo ? "" : tarjetaLectura(d.lectura),
    resuelto ? "" : causaYAcciones({ causa: d.ev.detalle?.causa || d.guia.causa, acciones: d.guia.accion, paleta }),
    botones(d.urls || {}),
    pie({
      sede: d.sede,
      estadoTexto: d.estadoTexto,
      nota: d.prueba ? "Este es un correo de prueba: el evento es simulado, pero los datos del dispositivo son reales y actuales." : null,
    }),
  ];
  return documento(`${paleta.nombre}: ${tituloEv} - ${sujeto}`, filas);
}

export function correoGrupo(d: any) {
  // d: { tipo: 'apertura'|'cierre', severidad, eventos, sede, horaLocal, duracionTexto, estadoTexto, urls, acciones }
  const resuelto = d.tipo === "cierre";
  const adv = d.severidad === "advertencia";
  const paleta = resuelto ? COLORES.resuelto : adv ? COLORES.advertencia : COLORES.critico;
  const lista = (d.eventos as any[]).map((ev) => `
      <tr>
        <td style="padding:10px 14px;border-top:1px solid ${NEUTRO.borde};${FUENTE}">
          <div style="font-size:14px;font-weight:700;color:${NEUTRO.texto};">${esc(ev.inventario || "")} ${esc(ev.dispositivo || "")}</div>
          <div style="font-size:12px;color:${NEUTRO.secundario};">${esc(ev.detalle?.area || "")}</div>
        </td>
        <td style="padding:10px 14px;border-top:1px solid ${NEUTRO.borde};font-size:12px;color:${NEUTRO.secundario};${FUENTE}">${esc(ev.evento)}</td>
        <td align="right" style="padding:10px 14px;border-top:1px solid ${NEUTRO.borde};font-size:12px;color:${NEUTRO.secundario};${FUENTE}">${resuelto ? `dur&oacute; ${esc(d.duracionTexto(ev.fin - ev.inicio))}` : `desde ${esc(d.horaLocal(ev.inicio))}`}</td>
      </tr>`).join("");
  const resumen = resuelto
    ? `${d.eventos.length} medidores volvieron a la normalidad.`
    : adv
    ? "Advertencias detectadas en la lectura de la sede. No requieren acci&oacute;n inmediata, pero conviene revisarlas si se repiten."
    : `${d.eventos.length} medidores presentan eventos al mismo tiempo. Cuando fallan varios a la vez, lo m&aacute;s probable es una falla com&uacute;n: la red de la sede, un gateway RS-485 o el Agente Go.`;
  const filas = [
    encabezado({ paleta, titulo: resuelto ? "Eventos normalizados" : adv ? `${d.eventos.length} advertencias` : "Varios medidores con eventos", resumen, sede: d.sede, codigo: d.eventos.map((e: any) => e.codigo).slice(0, 2).join(", ") + (d.eventos.length > 2 ? "…" : ""), etiquetaSuperior: paleta.nombre }),
    `<tr><td style="padding:18px 28px 6px 28px;">${titulo("MEDIDORES AFECTADOS")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${NEUTRO.borde};border-radius:10px;">${lista}</table></td></tr>`,
    resuelto ? "" : causaYAcciones({ causa: null, acciones: d.acciones, paleta }),
    botones(d.urls || {}),
    pie({ sede: d.sede, estadoTexto: d.estadoTexto }),
  ];
  return documento(`${paleta.nombre}: ${d.eventos.length} medidores`, filas);
}

export function correoResumen(d: any) {
  // d: { sede, fecha, estado, motivo, ultimaOk, abiertos, medidores, urls, horaLocal }
  const ok = d.estado === "ok";
  const paleta = ok ? COLORES.resuelto : COLORES.advertencia;
  const filasMed = (d.medidores as any[]).map((m) => `
      <tr>
        <td style="padding:8px 14px;border-top:1px solid ${NEUTRO.borde};font-size:13px;font-weight:700;color:${NEUTRO.texto};${FUENTE}">${esc(m.inventario || "")} ${esc(m.nombre)}</td>
        <td style="padding:8px 14px;border-top:1px solid ${NEUTRO.borde};font-size:12px;color:${NEUTRO.secundario};${FUENTE}">${esc(m.area || "")}</td>
        <td align="right" style="padding:8px 14px;border-top:1px solid ${NEUTRO.borde};">${!m.online ? pastilla("FUERA", "#FDECEA", "#991B1B")
          : m.generador === "apagado" ? pastilla("EN ESPERA", "#EEF2F6", "#475569")
          : m.generador === "en_marcha" ? pastilla("GENERADOR EN MARCHA", "#E0EAFF", "#1E3A8A")
          : pastilla("EN L&Iacute;NEA", "#DCFCE7", "#166534")}</td>
      </tr>`).join("");
  const filas = [
    encabezado({
      paleta,
      titulo: `Resumen diario: ${ok ? "todo en orden" : d.estado}`,
      resumen: `Estado de la lectura: <b>${esc(d.estado)}</b>${d.motivo ? ` (${esc(d.motivo)})` : ""}. &Uacute;ltima lectura buena: ${esc(d.ultimaOk)}. Eventos abiertos: <b>${d.abiertos.length}</b>.`,
      sede: d.sede,
      codigo: d.fecha,
      etiquetaSuperior: "RESUMEN DIARIO",
    }),
    d.abiertos.length ? `<tr><td style="padding:18px 28px 6px 28px;">${titulo("EVENTOS ABIERTOS")}
      ${(d.abiertos as any[]).map((e) => `<div style="font-size:13px;color:${NEUTRO.texto};padding:4px 0;${FUENTE}">&#9679; ${esc(e.evento)} ${esc(e.dispositivo || "")} &middot; desde ${esc(d.horaLocal(e.inicio))}</div>`).join("")}</td></tr>` : "",
    `<tr><td style="padding:18px 28px 6px 28px;">${titulo(`MEDIDORES (${d.medidores.length})`)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${NEUTRO.borde};border-radius:10px;">${filasMed}</table></td></tr>`,
    botones(d.urls || {}),
    pie({ sede: d.sede, estadoTexto: d.estado, nota: "Si el centro de monitoreo no recibe este resumen a la hora habitual, Gravix o el servidor de la sede est&aacute; ca&iacute;do." }),
  ];
  return documento(`Resumen diario ${d.sede}: ${d.estado}`, filas);
}
