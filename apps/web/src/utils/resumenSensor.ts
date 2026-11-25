import { co2Limit, coldChainChannels, fmt, isDoorOpen, num, str, wiseGroup, type SedeDevice } from "./sedes";

/** Lo que el plano 3D muestra de un sensor LoRaWAN. */
export interface ResumenSensor {
  nivel: "ok" | "alerta" | "fuera";
  tipo: string;
  /** Valor corto para la lista. */
  valor: string;
  /** Valores para el recuadro al pasar el cursor. */
  lineas: string[];
  estado: string;
  /** Hora del ultimo dato que mando el sensor. */
  ultimo: string | null;
}

/** Minutos sin dato para darlo por fuera de linea: una puerta solo habla al abrirse o cada hora aprox. */
const MAX_MIN = { puerta: 180, otro: 60 };

const limite = (v: unknown) => {
  const n = Number(str(v));
  return str(v).trim() !== "" && Number.isFinite(n) ? n : null;
};

export function resumenSensor(d: SedeDevice, ahora = Date.now()): ResumenSensor {
  const r = d.readings;
  const lineas: string[] = [];
  const alertas: string[] = [];
  let tipo = "Sensor";
  let valor = "";
  const ver = (k: string, nombre: string, unidad: string, dec: number) => {
    const v = num(r, k);
    if (v != null) lineas.push(`${nombre}: ${fmt(v, dec)} ${unidad}`);
    return v;
  };

  if (d.kind === "door") {
    tipo = "Puerta";
    const abierta = isDoorOpen(r);
    valor = abierta ? "abierta" : "cerrada";
    lineas.push(`Puerta ${valor}`);
    const b = ver("battery", "Batería", "%", 0);
    if (b != null && b <= 20) alertas.push("batería baja");
  } else if (d.kind === "wise") {
    const g = wiseGroup(d);
    tipo = g === "pump" ? "Bombeo de agua" : g === "heating" ? "Calderas y calentadores" : "Cadena de frío";
    const canales = coldChainChannels(d);
    for (const c of canales) {
      if (c.fault) {
        lineas.push(`${c.name}: sonda con falla`);
        alertas.push("sonda con falla");
        continue;
      }
      lineas.push(`${c.name}: ${fmt(c.value, 1)} ${c.unit}`);
      if (c.value != null && ((c.max != null && c.value > c.max) || (c.min != null && c.value < c.min))) alertas.push("fuera de rango");
    }
    const buenos = canales.filter((c) => !c.fault && c.value != null);
    valor = buenos.length ? `${fmt(buenos[0].value, 1)} ${buenos[0].unit.trim()}${canales.length > 1 ? ` +${canales.length - 1}` : ""}` : canales.length ? "sonda con falla" : "";
  } else {
    const co2 = num(r, "co2");
    tipo = d.kind === "air" ? "Calidad de aire" : d.kind === "env" ? "Temperatura y humedad" : "Sensor";
    if (co2 != null) {
      ver("co2", "CO₂", "ppm", 0);
      if (co2 > co2Limit(d)) alertas.push("CO₂ alto");
    }
    const t = ver("temperature", "Temperatura", "°C", 1);
    const h = ver("humidity", "Humedad", "%HR", 0);
    ver("pm2_5", "PM2.5", "µg/m³", 0);
    if (d.kind === "env") {
      const max = limite(d.attrs.tag_threshold_max);
      const min = limite(d.attrs.tag_threshold_min);
      if (t != null && ((max != null && t > max) || (min != null && t < min))) alertas.push("temperatura fuera de rango");
      const hMax = limite(d.attrs.tag_threshold_max_humidity);
      const hMin = limite(d.attrs.tag_threshold_min_humidity);
      if (h != null && ((hMax != null && h > hMax) || (hMin != null && h < hMin))) alertas.push("humedad fuera de rango");
      if (r.low_battery === true) alertas.push("batería baja");
    }
    valor = co2 != null ? `${fmt(co2, 0)} ppm` : t != null ? `${fmt(t, 1)} °C` : "";
  }

  const ultimo = str(d.attrs.lastUplinkAt) || d.updatedAt;
  const hace = ultimo ? (ahora - Date.parse(ultimo)) / 60_000 : Infinity;
  const callado = !(hace <= (d.kind === "door" ? MAX_MIN.puerta : MAX_MIN.otro));
  const nivel = !d.online || callado ? "fuera" : alertas.length ? "alerta" : "ok";
  const estado = !d.online ? "fuera de línea" : callado ? "sin comunicación" : alertas.length ? [...new Set(alertas)].join(", ") : "en línea";
  return { nivel, tipo, valor, lineas, estado, ultimo: ultimo || null };
}
