import type { Device } from "../api/devices";

/**
 * Modelo de vista de la pestaña Sedes: convierte los Device que reporta el Agente_Go de una sede
 * (protocol modbus/lorawan, metadata.model + metadata.attributes) en el tipo de tarjeta que le
 * corresponde. Tambien genera los datos de demostracion que se muestran mientras el agente de la
 * sede todavia no reporto nada (mismos equipos que el mockup aprobado).
 */

export type SedeKind = "gen" | "ion" | "pm" | "door" | "env" | "wise" | "air" | "lora" | "gateway" | "radio";

export interface MetricDef {
  key: string;
  label: string;
  unit: string;
  dec: number;
  limit?: number;
  limitLabel?: string;
  /** Limite inferior (ej. refrigerador 2 °C); se dibuja como segunda linea punteada. */
  limitMin?: number;
  /** Metrica de eventos (aperturas de puerta): se grafica como barras por intervalo. */
  bar?: boolean;
}

export type Readings = Record<string, number | string | boolean | undefined>;

export interface SedeDevice {
  id: string;
  kind: SedeKind;
  name: string;
  model: string;
  area: string;
  attrs: Record<string, unknown>;
  readings: Readings;
  online: boolean;
  updatedAt: string | null;
  /** true = dato de demostracion, no viene de un equipo real. */
  demo: boolean;
}

export const ACCENT: Record<SedeKind, string> = {
  gen: "#F2A33A",
  ion: "#5B9BFF",
  pm: "#34C3B0",
  door: "#F2A33A",
  env: "#4FC3F7",
  wise: "#A99BFF",
  air: "#7BD88F",
  lora: "#9AA5B1",
  gateway: "#A99BFF",
  radio: "#8FB8FF",
};

export function num(r: Readings, key: string): number | null {
  const v = r[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function fmt(v: number | null | undefined, dec = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(dec);
}

export function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** magnet_status llega como "open"/"close", 1/0 o true/false segun el decoder de ChirpStack. */
export function isDoorOpen(r: Readings): boolean {
  const v = r.magnet_status ?? r.magnetStatus ?? r.door_status ?? r.doorStatus;
  if (typeof v === "string") return /^(open|abierta|1|true)$/i.test(v.trim());
  return v === 1 || v === true;
}

export function aiKeys(r: Readings): string[] {
  return Object.keys(r)
    .filter((k) => /^ai\d(_value)?$/i.test(k))
    .sort();
}

function classify(device: Device): SedeKind | null {
  const model = (device.metadata?.model ?? "").toLowerCase();
  const name = device.name.toLowerCase();
  const r = (device.state?.readings ?? {}) as Readings;

  if (device.protocol === "modbus") {
    if (model === "generator") return "gen";
    if (model.includes("ion7400")) return "ion";
    if (model.includes("pm2130")) return "pm";
    return null;
  }
  if (device.protocol !== "lorawan") return null;

  // Receptor directo de gateways (Agente Go, sin ChirpStack).
  const category = String(device.metadata?.attributes?.category ?? "");
  if (category === "gateway" || model === "lorawan-gateway") return "gateway";
  if (category === "lora_radio") return "radio";

  // ChirpStack trae tags por dispositivo (el Agente_Go los reenvia como attributes.tag_*).
  const sensorType = String(device.metadata?.attributes?.tag_sensor_type ?? "").toLowerCase();
  const hay = `${model} ${name}`;
  if (sensorType === "door" || /s595/.test(hay) || "magnet_status" in r) return "door";
  if (/wise|s617|s614/.test(hay) || aiKeys(r).length > 0) return "wise";
  if (/eva/.test(hay)) return "env";
  if (/s592|aq/.test(hay) || "co2" in r) return "air";
  if ("temperature" in r) return "env";
  return "lora";
}

export function toSedeDevices(devices: Device[], buildingKey: string): SedeDevice[] {
  const out: SedeDevice[] = [];
  for (const d of devices) {
    if (d.metadata?.agent?.buildingKey !== buildingKey) continue;
    const kind = classify(d);
    if (!kind) continue;
    const attrs = d.metadata?.attributes ?? {};
    out.push({
      id: d.id,
      kind,
      name: d.name,
      model: d.metadata?.model ?? "",
      // Modbus: area del config del agente. LoRaWAN: tag "area" de ChirpStack.
      area: str(attrs.area ?? attrs.tag_area),
      attrs,
      readings: (d.state?.readings ?? {}) as Readings,
      online: d.state?.state !== "offline",
      updatedAt: d.state?.updatedAt ?? null,
      demo: false,
    });
  }
  const order = (x: SedeDevice) => x.name;
  return out.sort((a, b) => order(a).localeCompare(order(b), "es", { numeric: true }));
}

// ---------- metricas graficables por tipo ----------

export function metricsFor(d: SedeDevice): MetricDef[] {
  switch (d.kind) {
    case "gen":
      return [
        { key: "gen_kw_total_metering", label: "Potencia", unit: "kW", dec: 1 },
        { key: "engine_load_metering", label: "Carga del motor", unit: "%", dec: 0, limit: 80, limitLabel: "Límite 80 %" },
        { key: "fuel_level_metering", label: "Combustible", unit: "%", dec: 1, limit: 25, limitLabel: "Mínimo 25 %" },
        { key: "coolant_temp_metering", label: "Refrigerante", unit: "°C", dec: 1, limit: 95, limitLabel: "Alarma 95 °C" },
        { key: "battery_voltage_metering", label: "Batería", unit: "V", dec: 2, limit: 24, limitLabel: "Mínimo 24 V" },
      ];
    case "ion":
      return [
        { key: "active_power_total", label: "Potencia activa", unit: "kW", dec: 1 },
        { key: "__load", label: "Carga", unit: "%", dec: 0, limit: 80, limitLabel: "Límite 80 %" },
        { key: "power_factor_total", label: "Factor de potencia", unit: "pf", dec: 2, limit: 0.9, limitLabel: "Mínimo 0.90" },
        { key: "thd_voltage_v1_high", label: "THD voltaje", unit: "%", dec: 2, limit: 5, limitLabel: "Límite 5 %" },
        { key: "frequency", label: "Frecuencia", unit: "Hz", dec: 2 },
      ];
    case "pm":
      return [
        { key: "demand_total", label: "Demanda", unit: "kW", dec: 2 },
        { key: "voltage_a_n", label: "Voltaje A-N", unit: "V", dec: 1, limit: 126, limitLabel: "Máximo +5 % (126 V)" },
        { key: "current_a", label: "Corriente A", unit: "A", dec: 1 },
      ];
    case "door":
      return [
        { key: "__opens", label: "Aperturas", unit: "aperturas", dec: 0, bar: true },
        { key: "battery", label: "Batería", unit: "%", dec: 0, limit: 20, limitLabel: "Batería baja 20 %" },
      ];
    case "env":
      return [
        { key: "temperature", label: "Temperatura", unit: "°C", dec: 1, limit: 26, limitLabel: "Máximo 26 °C" },
        { key: "humidity", label: "Humedad", unit: "%HR", dec: 0, limit: 60, limitLabel: "Máximo 60 %HR" },
      ];
    case "wise": {
      const cold = coldChainChannels(d);
      if (cold.length) {
        return cold.map((c) => ({
          key: c.key,
          label: c.name,
          unit: "°C",
          dec: 1,
          limit: c.max ?? undefined,
          limitMin: c.min ?? undefined,
          limitLabel: c.min != null && c.max != null ? `Rango ${c.min} a ${c.max} °C` : undefined,
        }));
      }
      const keys = aiKeys(d.readings);
      return (keys.length ? keys : ["ai0_value", "ai1_value", "ai2_value", "ai3_value"]).map((k) => ({
        key: k,
        label: k.replace(/_value$/i, "").toUpperCase(),
        unit: "mA",
        dec: 2,
        limit: 20,
        limitLabel: "Fondo de escala 20 mA",
      }));
    }
    case "air": {
      const co2Max = co2Limit(d);
      return [
        { key: "co2", label: "CO₂", unit: "ppm", dec: 0, limit: co2Max, limitLabel: `Máximo ${co2Max} ppm` },
        { key: "temperature", label: "Temperatura", unit: "°C", dec: 1, limit: 26, limitLabel: "Máximo 26 °C" },
        { key: "humidity", label: "Humedad", unit: "%HR", dec: 0 },
        { key: "pm2_5", label: "PM2.5", unit: "µg/m³", dec: 0 },
      ];
    }
    case "gateway":
      return [
        { key: "frames_received", label: "Tramas recibidas", unit: "", dec: 0 },
        { key: "devices_heard", label: "Dispositivos escuchados", unit: "", dec: 0 },
        { key: "rxok", label: "Recibidas OK (gateway)", unit: "", dec: 0 },
      ];
    case "radio":
      return [
        { key: "rssi", label: "RSSI", unit: "dBm", dec: 0, limitMin: -120 },
        { key: "snr", label: "SNR", unit: "dB", dec: 1 },
        { key: "fcnt", label: "Contador de tramas", unit: "", dec: 0 },
      ];
    default:
      return Object.keys(d.readings)
        .filter((k) => num(d.readings, k) != null)
        .slice(0, 6)
        .map((k) => ({ key: k, label: k, unit: "", dec: 1 }));
  }
}

export interface ColdChainChannel {
  key: string; // ej. "ai0_temperature"
  channel: string; // "AI0"
  name: string; // "Refrigerador Unidades No Liberadas"
  code: string;
  category: string; // "Refrigerador" | "Ultra congelador"
  min: number | null;
  max: number | null;
  value: number | null;
}

/**
 * Canales de cadena de frio de un WISE: el Agente_Go convierte cada entrada 4-20 mA a °C con los
 * tags de ChirpStack (aiN_multiplier/offset) y reenvia nombre, codigo y rango permitido por canal.
 */
export function coldChainChannels(d: SedeDevice): ColdChainChannel[] {
  const out: ColdChainChannel[] = [];
  for (let k = 0; k < 8; k++) {
    const key = `ai${k}_temperature`;
    if (!(key in d.readings)) continue;
    const t = (s: string) => str(d.attrs[`tag_ai${k}_${s}`]);
    const min = t("threshold_min") === "" ? null : Number(t("threshold_min"));
    const max = t("threshold_max") === "" ? null : Number(t("threshold_max"));
    out.push({
      key,
      channel: `AI${k}`,
      name: t("operative_area") || `Canal AI${k}`,
      code: t("code"),
      category: t("category"),
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
      value: num(d.readings, key),
    });
  }
  return out;
}

/** Limite de CO₂: el tag threshold_max del sensor en ChirpStack (cuando unit = ppm) o 1000 ppm. */
export function co2Limit(d: SedeDevice): number {
  const unit = str(d.attrs.tag_unit).toLowerCase();
  const max = Number(str(d.attrs.tag_threshold_max));
  return unit === "ppm" && Number.isFinite(max) && max > 0 ? max : 1000;
}

/** Valor de una metrica para un punto de lecturas; resuelve las metricas derivadas (__load). */
export function metricValue(d: SedeDevice, key: string, r: Readings): number | null {
  if (key === "__load") {
    const cap = Number(d.attrs.capacityKva);
    const kva = num(r, "apparent_power_total");
    return cap > 0 && kva != null ? (kva / cap) * 100 : null;
  }
  if (key === "power_factor_total") {
    const v = num(r, key);
    return v == null ? null : Math.abs(v);
  }
  return num(r, key);
}

// ---------- datos de demostracion (mismos equipos que el mockup) ----------

function noise(n: number) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function demoDevices(tick: number, outage: boolean): SedeDevice[] {
  const j = (base: number, i: number, amp = 0.015) => base * (1 + amp * Math.sin(tick * 0.9 + i * 1.7));
  const now = new Date().toISOString();
  const mk = (id: string, kind: SedeKind, name: string, model: string, area: string, attrs: Record<string, unknown>, readings: Readings): SedeDevice => ({
    id, kind, name, model, area, attrs: { area, ...attrs }, readings, online: true, updatedAt: now, demo: true,
  });
  const out: SedeDevice[] = [];

  const ions = [
    { n: 1, area: "Cuarto eléctrico", code: "HES107", cap: 300, k: 1, mono: false, src: true },
    { n: 2, area: "Cuarto eléctrico", code: "HES108", cap: 200, k: 0.55, mono: false, src: false },
    { n: 3, area: "Consulta Externa", code: "HES105", cap: 225, k: 0.6, mono: false, src: false },
    { n: 4, area: "Consulta Externa", code: "HES106", cap: 22, k: 0.05, mono: true, src: false },
    { n: 5, area: "Módulos", code: "HES109", cap: 750, k: 1.9, mono: false, src: true },
    { n: 6, area: "Módulos", code: "HES110", cap: 750, k: 1.4, mono: false, src: false },
  ];
  const ionKw: number[] = [];
  ions.forEach((d, i) => {
    const kw = [52.4, 50.03, d.mono ? 0 : 47.58].map((b, p) => j(b * d.k, i * 3 + p));
    const kva = [53.62, 52.43, d.mono ? 0 : 49].map((b, p) => j(b * d.k, i * 3 + p));
    const amps = [430.09, 417.21, d.mono ? 0 : 391.1].map((b, p) => j(b * d.k, i * 3 + p));
    const total = kw[0] + kw[1] + kw[2];
    ionKw.push(total);
    const onGen = outage && d.src;
    const r: Readings = {
      active_power_a: kw[0], active_power_b: kw[1], active_power_c: kw[2], active_power_total: total,
      apparent_power_total: kva[0] + kva[1] + kva[2],
      current_a: amps[0], current_b: amps[1], current_c: amps[2],
      voltage_a_n: j(121.4, i, 0.003), voltage_b_n: j(121.9, i + 1, 0.003), voltage_c_n: d.mono ? 0 : j(121.2, i + 2, 0.003),
      power_factor_total: -j(0.97, i, 0.004),
      frequency: onGen ? j(60, i, 0.0015) : j(59.95, i, 0.0008),
      thd_voltage_v1_high: j(5.86 - i * 0.3, i, 0.05),
    };
    if (d.src) {
      r.s1_commercial_energy_status = onGen ? 0 : 1;
      r.s2_generator_energy_status = onGen ? 1 : 0;
    }
    out.push(mk(`demo-ion-${d.n}`, "ion", `ANALIZADOR-${d.n}`, "ION7400", d.area,
      { code: d.code, capacityKva: d.cap, phase: d.mono ? "Monofásica" : "Trifásica", registers: "EBO AS-P", category: "power_meter" }, r));
  });

  const gens = [
    { id: "ph", name: "Generador Planta Hospital", area: "Cuarto eléctrico", feeds: "ANALIZADOR-1", fuel: 86, ion: 0, load: 48 },
    { id: "mod", name: "Generador Módulos", area: "Módulos", feeds: "ANALIZADOR-5", fuel: 74, ion: 4, load: 57 },
  ];
  gens.forEach((d, i) => {
    const run = outage;
    out.unshift(mk(`demo-gen-${d.id}`, "gen", d.name, "generator", d.area, { feeds: d.feeds, category: "generator" }, {
      engine_speed_metering: run ? j(1800, i, 0.003) : 0,
      engine_load_metering: run ? j(d.load, i, 0.03) : 0,
      gen_kw_total_metering: run ? ionKw[d.ion] : 0,
      gen_frequency_metering: run ? j(60, i, 0.0015) : 0,
      coolant_temp_metering: run ? j(82, i, 0.01) : j(41, i, 0.01),
      oil_pressure_metering: run ? j(52, i, 0.02) : 0,
      battery_voltage_metering: run ? j(28.1, i, 0.003) : j(27.2, i, 0.002),
      fuel_level_metering: d.fuel - (run ? (tick % 40) * 0.05 : 0),
      power_factor_metering: run ? 0.92 : 0,
    }));
  });

  const pms = [
    { n: 1, area: "Emergencia", code: "HES111", k: 1.4 },
    { n: 2, area: "Quirófanos", code: "HES116", k: 2.1 },
    { n: 3, area: "Quirófanos", code: "HES117", k: 1.8 },
    { n: 4, area: "Laboratorio", code: "HES114", k: 1.2 },
    { n: 5, area: "Banco de Sangre", code: "HES112", k: 0.9 },
    { n: 6, area: "Intensivos", code: "HES113", k: 1.6 },
    { n: 7, area: "Intensivos Neonatología", code: "HES115", k: 1, mono: true },
  ];
  pms.forEach((d, i) => {
    const r: Readings = {
      voltage_a_n: j(d.mono ? 121.96 : 121.9, i, 0.003),
      voltage_b_n: j(d.mono ? 122.45 : 122.4, i + 1, 0.003),
      voltage_c_n: d.mono ? 0 : j(121.6, i + 2, 0.003),
      current_a: j(14.92 * (d.mono ? 1 : d.k), i * 2, 0.04),
      current_b: j(14.59 * (d.mono ? 1 : d.k), i * 2 + 1, 0.04),
      current_c: d.mono ? 0 : j(14.2 * d.k, i * 2 + 2, 0.04),
      frequency: j(59.97, i, 0.0008),
      demand_total: j(d.mono ? 3.82 : 3.82 * d.k * 1.5, i, 0.04),
    };
    out.push(mk(`demo-pm-${d.n}`, "pm", `PM2130-${d.n}`, "PM2130", d.area,
      { code: d.code, phase: d.mono ? "Monofásica" : "Trifásica", category: "circuit_meter" }, r));
  });

  const eui = (n: number) => "24e124" + Math.floor(noise(n) * 0xffffffff).toString(16).padStart(8, "0") + String(10 + (n % 89));
  const doorAreas = ["Farmacia", "Bodega", "Cuarto eléctrico", "Quirófanos", "Emergencia", "Laboratorio", "Banco de Sangre", "Intensivos", "Data center", "Archivo"];
  for (let i = 0; i < 30; i++) {
    const open = noise(i * 3.1 + Math.floor(tick / 3) * 0.37) > 0.86;
    const battery = Math.round(35 + noise(i + 5) * 65) - (i === 7 ? 22 : 0) - (i === 19 ? 18 : 0);
    const area = doorAreas[i % doorAreas.length];
    out.push(mk(`demo-door-${i}`, "door", `Puerta ${String(i + 1).padStart(2, "0")} · ${area}`, "LEO-S595", area,
      lora(eui(i + 100), tick, i), { magnet_status: open ? "open" : "close", battery, tamper_status: "normal" }));
  }
  [
    { name: "Farmacia", area: "Cadena de frío", t: 21.4, h: 48 },
    { name: "Banco de Sangre", area: "Sala de equipos", t: 22.1, h: 52 },
    { name: "Quirófano 1", area: "Quirófanos", t: 20.3, h: 55 },
    { name: "Data center", area: "Cuarto de servidores", t: 25.6, h: 41 },
  ].forEach((d, i) => {
    out.push(mk(`demo-env-${i}`, "env", d.name, "EVA-2310", d.area, lora(eui(i + 200), tick, i + 40), {
      temperature: j(d.t, i + 40, 0.025), humidity: j(d.h, i + 50, 0.03), battery: Math.round(60 + noise(i) * 40),
    }));
  });
  [
    { name: "Tanque de agua", area: "Cuarto de máquinas", model: "WISE-S617" },
    { name: "Presión oxígeno", area: "Gases médicos", model: "WISE-S617" },
    { name: "Cisterna", area: "Exterior", model: "WISE-S614T" },
    { name: "Bombas", area: "Cuarto de máquinas", model: "WISE-S614T" },
  ].forEach((d, i) => {
    const r: Readings = {};
    [0, 1, 2, 3].forEach((k) => { r[`ai${k}_value`] = j(4 + noise(i * 4 + k) * 15, i * 4 + k + 60, 0.03); });
    out.push(mk(`demo-wise-${i}`, "wise", d.name, d.model, d.area, lora(eui(i + 300), tick, i + 60), r));
  });
  [
    { name: "Calidad de aire · Consulta Externa", area: "Consulta Externa", co2: 620 },
    { name: "Calidad de aire · Emergencia", area: "Emergencia", co2: 840 },
  ].forEach((d, i) => {
    out.push(mk(`demo-air-${i}`, "air", d.name, "LEO-S592", d.area, lora(eui(i + 400), tick, i + 80), {
      co2: j(d.co2, i + 80, 0.05), temperature: j(23.4 + i, i + 81, 0.02), humidity: j(54, i + 82, 0.03), pm2_5: j(12, i + 83, 0.1), tvoc: j(0.18, i + 84, 0.1),
    }));
  });

  return out;
}

function lora(devEui: string, tick: number, i: number): Record<string, unknown> {
  const t = new Date(Date.now() - Math.floor(noise(tick + i) * 60000));
  return {
    devEui,
    fCnt: 1000 + Math.floor(noise(i + 3) * 9000) + tick,
    rssi: -70 - Math.floor(noise(i + 7) * 45),
    snr: Math.round((2 + noise(i + 9) * 8) * 10) / 10,
    lastUplinkAt: t.toISOString(),
  };
}

/** Eventos de demostracion (mismos tipos que genera el Agente_Go) para revisar la pestaña Eventos sin agente. */
export function demoEvents(): {
  id: string;
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  value: number | null;
  data: Record<string, unknown> | null;
  occurredAt: string;
  deviceId: string | null;
  deviceName: string | null;
  externalId: string | null;
}[] {
  const now = Date.now();
  const at = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();
  const rows: [number, string, "info" | "warning" | "critical", string, string | null, string | null][] = [
    [4, "door.opened", "info", "Puerta 04 · Quirófanos: puerta ABIERTA", "demo-door-3", "Puerta 04 · Quirófanos"],
    [9, "air.co2_high", "warning", "Calidad de aire · Emergencia: CO₂ alto (1040 ppm > 1000 ppm)", "demo-air-1", "Calidad de aire · Emergencia"],
    [26, "door.closed", "info", "Puerta 09 · Data center: puerta cerrada (estuvo abierta 3 min)", "demo-door-8", "Puerta 09 · Data center"],
    [48, "energy.source_commercial", "info", "ANALIZADOR-1 (Cuarto eléctrico): regresó a energía COMERCIAL", "demo-ion-1", "ANALIZADOR-1"],
    [49, "generator.stopped", "info", "Generador Planta Hospital: generador se detuvo tras 22 min en marcha", "demo-gen-ph", "Generador Planta Hospital"],
    [71, "generator.started", "warning", "Generador Planta Hospital: generador ARRANCÓ (1800 RPM)", "demo-gen-ph", "Generador Planta Hospital"],
    [71, "energy.source_generator", "critical", "ANALIZADOR-1 (Cuarto eléctrico): el ATS transfirió la carga a GENERADOR", "demo-ion-1", "ANALIZADOR-1"],
    [71, "energy.generator_transfer_counted", "warning", "ANALIZADOR-1 (Cuarto eléctrico): el vigilante registró 1 transferencia(s) a generador (total 29)", "demo-ion-1", "ANALIZADOR-1"],
    [130, "power.thd_high", "warning", "ANALIZADOR-2 (Cuarto eléctrico): THD de voltaje alto (8.40 % > 8 %)", "demo-ion-2", "ANALIZADOR-2"],
    [185, "sensor.battery_low", "warning", "Puerta 08 · Intensivos: batería baja (15 %)", "demo-door-7", "Puerta 08 · Intensivos"],
    [240, "device.online", "info", "Tanque de agua (Cuarto de máquinas): volvió a comunicar (estuvo 75 min sin datos)", "demo-wise-0", "Tanque de agua"],
    [315, "device.offline", "warning", "Tanque de agua (Cuarto de máquinas): sin uplinks hace 61 min", "demo-wise-0", "Tanque de agua"],
    [1500, "lorawan.site_restored", "info", "Los sensores LoRaWAN volvieron a reportar", null, null],
    [1520, "lorawan.site_silent", "critical", "Ningún sensor LoRaWAN reporta hace 16 min: revisar ChirpStack, el gateway o el broker MQTT", null, null],
  ];
  return rows.map(([m, type, severity, message, deviceId, deviceName], i) => ({
    id: `demo-ev-${i}`, type, severity, message, value: null, data: null, occurredAt: at(m), deviceId, deviceName, externalId: null,
  }));
}

/** Serie sintetica para las tendencias de un equipo de demostracion. */
export function demoSeries(d: SedeDevice, m: MetricDef, n: number, stepMin: number, outage: boolean, tick: number): { t: Date; v: number }[] {
  const now = Date.now();
  const cur = m.key === "__opens" ? 0 : metricValue(d, m.key, d.readings) ?? 0;
  const seed = d.id.length * 31 + d.id.charCodeAt(d.id.length - 1) * 7 + m.key.length * 13;
  const out: { t: Date; v: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(now - (n - 1 - i) * stepMin * 60000);
    const hod = t.getHours() + t.getMinutes() / 60;
    const daily = Math.sin(((hod - 9) / 24) * 2 * Math.PI);
    const nz = noise(seed + i + (stepMin <= 1 ? tick : 0)) - 0.5;
    let v: number;
    if (m.bar) {
      const busy = Math.max(0.15, 0.6 + 0.6 * daily);
      v = Math.round(noise(seed + i * 1.7) * (stepMin >= 1440 ? 60 : stepMin >= 60 ? 8 : 2) * busy);
    } else if (d.kind === "gen" && ["gen_kw_total_metering", "engine_load_metering"].includes(m.key)) {
      const testRun = stepMin >= 120 && (i === 40 || i === 41);
      const recent = outage && i >= n - Math.max(3, Math.round(n * 0.08));
      const base = m.key === "engine_load_metering" ? 50 : 150;
      v = recent ? cur : testRun ? base * 0.6 * (1 + 0.05 * nz) : 0;
    } else if (m.key === "fuel_level_metering") {
      v = cur + (n - 1 - i) * (stepMin >= 120 ? 0.05 : 0.002);
    } else {
      const amp = m.key.includes("frequency") ? 0.002 : m.key.includes("voltage") ? 0.01 : m.key.includes("power_factor") ? 0.01 : 0.2;
      v = cur * (1 + amp * daily + amp * 0.4 * 2 * nz);
    }
    out.push({ t, v });
  }
  if (!m.bar && out.length) out[out.length - 1].v = cur;
  return out;
}
