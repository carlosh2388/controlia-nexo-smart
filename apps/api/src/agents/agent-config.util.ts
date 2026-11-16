import { BadRequestException } from "@nestjs/common";

/**
 * Configuracion remota de un Agente_Go: las mismas secciones de protocolo que su config.yaml
 * (ver apps/Agente_Go/config.example.yaml) mas "discovery", que solo usa la web para recordar en
 * que rangos de IP buscar equipos. El agente valida y aplica; aca se valida lo suficiente para que
 * un error de tipeo en el formulario no llegue hasta la sede.
 */
export type AgentProtocolsConfig = Record<string, unknown>;

/** Valor que reemplaza a un secreto al mandarlo a la web. Si vuelve igual en un PUT, se conserva el guardado. */
export const SECRET_MASK = "********";

const SECTIONS = ["mqtt", "lorawan", "bacnet", "modbus", "modbusServers", "loraGateway", "discovery"] as const;
const KEY_SECRETS = ["nwkSKey", "appSKey", "appKey"] as const;

type Obj = Record<string, any>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
// La config es JSON puro (viene de una columna Json), asi que esta copia es exacta.
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function fail(path: string, msg: string): never {
  throw new BadRequestException(`config.${path}: ${msg}`);
}

function checkPort(path: string, v: unknown) {
  if (v === undefined || v === null) return;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 65535) fail(path, "puerto invalido (1-65535)");
}

function checkPositiveInt(path: string, v: unknown) {
  if (v === undefined || v === null) return;
  if (!Number.isInteger(v) || (v as number) < 0) fail(path, "debe ser un entero positivo");
}

function checkHost(path: string, v: unknown, required: boolean) {
  if (v === undefined || v === null || v === "") {
    if (required) fail(path, "es obligatorio");
    return;
  }
  if (typeof v !== "string" || !/^[A-Za-z0-9.\-_:]+$/.test(v) || v.length > 253) fail(path, "host invalido");
}

function checkBrokerUrl(path: string, v: unknown, enabled: boolean) {
  if (v === undefined || v === null || v === "") {
    if (enabled) fail(path, "es obligatorio");
    return;
  }
  if (typeof v !== "string" || !/^(tcp|ssl|ws|wss|mqtt|mqtts):\/\/[A-Za-z0-9.\-_]+(:\d{1,5})?\/?$/.test(v)) {
    fail(path, 'URL de broker invalida (ej. "tcp://192.168.70.25:1883")');
  }
}

/** Lanza BadRequest con la ruta del campo si algo no tiene la forma que espera el agente. */
export function validateAgentConfig(config: unknown): AgentProtocolsConfig {
  if (!isObj(config)) throw new BadRequestException("config debe ser un objeto");
  for (const key of Object.keys(config)) {
    if (!(SECTIONS as readonly string[]).includes(key)) fail(key, "seccion desconocida");
  }

  for (const name of ["mqtt", "lorawan"] as const) {
    const s = config[name];
    if (s === undefined || s === null) continue;
    if (!isObj(s)) fail(name, "debe ser un objeto");
    checkBrokerUrl(`${name}.brokerUrl`, s.brokerUrl, !!s.enabled);
  }

  const bacnet = config.bacnet;
  if (bacnet !== undefined && bacnet !== null) {
    if (!isObj(bacnet)) fail("bacnet", "debe ser un objeto");
    if (bacnet.enabled && !bacnet.bridgeUrl) fail("bacnet.bridgeUrl", "es obligatorio");
    checkPositiveInt("bacnet.pollIntervalSeconds", bacnet.pollIntervalSeconds);
    if (bacnet.devices !== undefined && !Array.isArray(bacnet.devices)) fail("bacnet.devices", "debe ser una lista");
    (bacnet.devices ?? []).forEach((d: unknown, i: number) => {
      if (!isObj(d)) fail(`bacnet.devices[${i}]`, "debe ser un objeto");
      checkHost(`bacnet.devices[${i}].host`, d.host, true);
    });
  }

  const servers: unknown[] = [];
  if (config.modbus !== undefined && config.modbus !== null) servers.push(config.modbus);
  if (config.modbusServers !== undefined) {
    if (!Array.isArray(config.modbusServers)) fail("modbusServers", "debe ser una lista");
    servers.push(...config.modbusServers);
  }
  servers.forEach((m, i) => {
    const path = `modbusServers[${i}]`;
    if (!isObj(m)) fail(path, "debe ser un objeto");
    checkHost(`${path}.host`, m.host, !!m.enabled);
    checkPort(`${path}.port`, m.port);
    if (m.unitId !== undefined && (!Number.isInteger(m.unitId) || m.unitId < 0 || m.unitId > 255)) {
      fail(`${path}.unitId`, "unit ID invalido (0-255)");
    }
    checkPositiveInt(`${path}.pollIntervalSeconds`, m.pollIntervalSeconds);
    if (m.devices !== undefined && !Array.isArray(m.devices)) fail(`${path}.devices`, "debe ser una lista");
    (m.devices ?? []).forEach((d: unknown, j: number) => {
      if (!isObj(d) || typeof d.name !== "string" || !d.name.trim()) fail(`${path}.devices[${j}].name`, "es obligatorio");
      if (typeof d.profile !== "string" || !d.profile) fail(`${path}.devices[${j}].profile`, "es obligatorio");
      if (!Number.isInteger(d.start) || d.start < 1) fail(`${path}.devices[${j}].start`, "registro inicial invalido");
    });
  });

  const gw = config.loraGateway;
  if (gw !== undefined && gw !== null) {
    if (!isObj(gw)) fail("loraGateway", "debe ser un objeto");
    if (gw.listen !== undefined && (typeof gw.listen !== "string" || !/^((\d{1,3}\.){3}\d{1,3})?:\d{1,5}$/.test(gw.listen))) {
      fail("loraGateway.listen", 'debe tener la forma ":1700" o "0.0.0.0:1700"');
    }
    if (gw.keys !== undefined && !Array.isArray(gw.keys)) fail("loraGateway.keys", "debe ser una lista");
  }

  return config;
}

/** Copia de la config sin secretos, para mandarla a la web. */
export function maskSecrets(config: AgentProtocolsConfig): AgentProtocolsConfig {
  const out: Obj = clone(config);
  for (const name of ["mqtt", "lorawan"]) {
    if (isObj(out[name]) && out[name].password) out[name].password = SECRET_MASK;
  }
  if (isObj(out.bacnet) && out.bacnet.bridgeToken) out.bacnet.bridgeToken = SECRET_MASK;
  if (isObj(out.loraGateway) && Array.isArray(out.loraGateway.keys)) {
    for (const k of out.loraGateway.keys) {
      if (!isObj(k)) continue;
      for (const field of KEY_SECRETS) if (k[field]) k[field] = SECRET_MASK;
    }
  }
  return out;
}

/** Los secretos que la web devuelve enmascarados se reemplazan por el valor guardado. */
export function restoreSecrets(next: AgentProtocolsConfig, previous: AgentProtocolsConfig | null): AgentProtocolsConfig {
  const out: Obj = clone(next);
  const prev: Obj = previous ?? {};
  for (const name of ["mqtt", "lorawan"]) {
    if (isObj(out[name]) && out[name].password === SECRET_MASK) out[name].password = prev[name]?.password ?? "";
  }
  if (isObj(out.bacnet) && out.bacnet.bridgeToken === SECRET_MASK) out.bacnet.bridgeToken = prev.bacnet?.bridgeToken ?? "";
  if (isObj(out.loraGateway) && Array.isArray(out.loraGateway.keys)) {
    const prevKeys: Obj[] = Array.isArray(prev.loraGateway?.keys) ? prev.loraGateway.keys : [];
    out.loraGateway.keys.forEach((k: unknown, i: number) => {
      if (!isObj(k)) return;
      const old = prevKeys.find((p) => isObj(p) && p.devEui && p.devEui === k.devEui) ?? prevKeys[i] ?? {};
      for (const field of KEY_SECRETS) if (k[field] === SECRET_MASK) k[field] = old[field] ?? "";
    });
  }
  return out;
}
