import type { BacnetConfig, BrokerConfig, DiscoveryConfig, LoraGatewayConfig, ModbusDeviceConfig, ModbusServerConfig } from "../../api/agents";
import { MODBUS_PROFILES, isValidUnitIds, joinBrokerUrl, newModbusServer, splitBrokerUrl, splitListen } from "../../utils/agentConfig";
import { Field, IpField, NumberField, ProtocolCard, SecretField, TargetsInput, TextField, inputClass } from "./fields";

const smallButton = "rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-sky-500 hover:text-sky-300 disabled:opacity-40";
const removeButton = "rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-40";

// ---------- Modbus TCP ----------

export function ModbusCard({
  servers,
  onChange,
  discovery,
  onDiscoveryChange,
  readOnly,
}: {
  servers: ModbusServerConfig[];
  onChange: (next: ModbusServerConfig[]) => void;
  discovery: DiscoveryConfig["modbus"];
  onDiscoveryChange: (next: NonNullable<DiscoveryConfig["modbus"]>) => void;
  readOnly: boolean;
}) {
  const enabled = servers.some((s) => s.enabled);
  const update = (i: number, patch: Partial<ModbusServerConfig>) => onChange(servers.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const targets = discovery?.targets ?? [];
  const unitIds = discovery?.unitIds ?? "1-10";

  return (
    <ProtocolCard
      title="Modbus TCP"
      description="Medidores de energía, EBO, generadores y ATS. Solo lectura (funciones 03/04)."
      badge="TCP"
      tone="amber"
      mode="consulta"
      enabled={enabled}
      disabled={readOnly || servers.length === 0}
      onToggle={(v) => onChange(servers.map((s) => ({ ...s, enabled: v })))}
    >
      {servers.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-700 px-3 py-2 text-xs text-slate-400">
          Sin servidores Modbus. Agrega uno a mano o búscalos con <b className="text-slate-200">Buscar dispositivos en la red</b>.
        </p>
      )}

      {servers.map((s, i) => (
        <div key={i} className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextField label="Nombre" value={s.name ?? ""} onChange={(v) => update(i, { name: v })} placeholder="EBO-ASP-ESCUINTLA" disabled={readOnly} />
            </div>
            <button type="button" className={removeButton} disabled={readOnly} onClick={() => onChange(servers.filter((_, j) => j !== i))}>
              Quitar servidor
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="sm:col-span-2">
              <IpField label="IP del servidor" value={s.host} onChange={(v) => update(i, { host: v })} placeholder="10.0.6.26" disabled={readOnly} />
            </div>
            <NumberField label="Puerto TCP" value={s.port ?? 502} defaultValue={502} min={1} max={65535} onChange={(v) => update(i, { port: v })} disabled={readOnly} hint="Puerto estándar" />
            <NumberField label="Unit ID" value={s.unitId ?? 1} min={0} max={255} onChange={(v) => update(i, { unitId: v })} disabled={readOnly} />
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <NumberField
              label="Leer cada (s)"
              value={s.pollIntervalSeconds ?? 15}
              min={1}
              max={3600}
              onChange={(v) => update(i, { pollIntervalSeconds: v })}
              disabled={readOnly}
            />
          </div>
          <ModbusDevices devices={s.devices ?? []} onChange={(devices) => update(i, { devices })} readOnly={readOnly} />
        </div>
      ))}

      <button type="button" className={smallButton} disabled={readOnly} onClick={() => onChange([...servers, newModbusServer("")])}>
        + Agregar servidor Modbus
      </button>

      <div className="grid gap-3 border-t border-slate-800 pt-4 sm:grid-cols-[1fr_140px]">
        <TargetsInput
          label="Dónde buscar equipos Modbus"
          tone="amber"
          targets={targets}
          disabled={readOnly}
          onChange={(t) => onDiscoveryChange({ targets: t, unitIds })}
        />
        <TextField
          label="Unit IDs a probar"
          value={unitIds}
          placeholder="1-10"
          disabled={readOnly}
          onChange={(v) => onDiscoveryChange({ targets, unitIds: v })}
          validate={(v) => (isValidUnitIds(v) ? undefined : "Ej. 1-10 o 1,2,5")}
        />
      </div>
    </ProtocolCard>
  );
}

function ModbusDevices({ devices, onChange, readOnly }: { devices: ModbusDeviceConfig[]; onChange: (d: ModbusDeviceConfig[]) => void; readOnly: boolean }) {
  const update = (i: number, patch: Partial<ModbusDeviceConfig>) => onChange(devices.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <details className="group rounded-lg border border-slate-800" open={devices.length <= 4}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs text-slate-300">
        <span>
          <b className="text-slate-100">{devices.length}</b> equipo(s) que lee el agente en este servidor
        </span>
        <span className="text-slate-500 group-open:rotate-180">▾</span>
      </summary>
      <div className="space-y-2 border-t border-slate-800 p-3">
        {devices.length === 0 && (
          <p className="text-xs text-amber-300">
            Sin equipos: el agente se conecta pero no lee nada. Agrega cada equipo con su perfil y su registro inicial
            (ver docs/procedimientos/sede-igss.md para ubicar los bloques).
          </p>
        )}
        {devices.map((d, i) => (
          <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_170px_110px_auto]">
            <TextField label="Nombre (no cambiarlo después)" value={d.name} onChange={(v) => update(i, { name: v })} placeholder="ANALIZADOR-1" disabled={readOnly} />
            <Field label="Perfil">
              {(id) => (
                <select id={id} className={inputClass} value={d.profile} disabled={readOnly} onChange={(e) => update(i, { profile: e.target.value })}>
                  {!MODBUS_PROFILES.some((p) => p.value === d.profile) && <option value={d.profile}>{d.profile || "Elegí un perfil..."}</option>}
                  {MODBUS_PROFILES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <NumberField label="Registro inicial" value={d.start} min={1} max={65536} onChange={(v) => update(i, { start: v })} disabled={readOnly} />
            <button type="button" className={removeButton} disabled={readOnly} onClick={() => onChange(devices.filter((_, j) => j !== i))}>
              Quitar
            </button>
          </div>
        ))}
        <button
          type="button"
          className={smallButton}
          disabled={readOnly}
          onClick={() => onChange([...devices, { name: "", profile: "ion7400", start: 1 }])}
        >
          + Agregar equipo
        </button>
      </div>
    </details>
  );
}

// ---------- BACnet/IP ----------

export function BacnetCard({
  config,
  onChange,
  discovery,
  onDiscoveryChange,
  readOnly,
}: {
  config: BacnetConfig | null | undefined;
  onChange: (next: BacnetConfig) => void;
  discovery: DiscoveryConfig["bacnet"];
  onDiscoveryChange: (next: NonNullable<DiscoveryConfig["bacnet"]>) => void;
  readOnly: boolean;
}) {
  const c: BacnetConfig = config ?? { enabled: false, bridgeUrl: "http://localhost:3099", pollIntervalSeconds: 20, devices: [] };
  const set = (patch: Partial<BacnetConfig>) => onChange({ ...c, ...patch });
  const devices = c.devices ?? [];
  const updateDevice = (i: number, patch: Partial<BacnetConfig["devices"][number]>) =>
    set({ devices: devices.map((d, j) => (j === i ? { ...d, ...patch } : d)) });

  return (
    <ProtocolCard
      title="BACnet/IP"
      description="Aires VRF, climatización y controladores BMS, a través del bridge BACnet."
      badge="UDP"
      tone="orange"
      mode="consulta"
      enabled={c.enabled}
      disabled={readOnly}
      onToggle={(v) => set({ enabled: v })}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <TextField
          label="URL del bridge BACnet"
          value={c.bridgeUrl}
          placeholder="http://localhost:3099"
          onChange={(v) => set({ bridgeUrl: v })}
          disabled={readOnly}
          hint="Puerto UDP 47808: lo abre el bridge, que debe correr en una máquina que alcance los equipos."
          validate={(v) => (/^https?:\/\/[^\s]+$/.test(v) ? undefined : "Ej. http://localhost:3099")}
        />
        <SecretField label="Token del bridge" value={c.bridgeToken ?? ""} onChange={(v) => set({ bridgeToken: v })} disabled={readOnly} />
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <NumberField label="Leer cada (s)" value={c.pollIntervalSeconds ?? 15} min={1} max={3600} onChange={(v) => set({ pollIntervalSeconds: v })} disabled={readOnly} />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-slate-400">Gateways BACnet que lee el agente</p>
        {devices.length === 0 && <p className="text-xs text-slate-500">Ninguno todavía.</p>}
        {devices.map((d, i) => (
          <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <TextField label="Nombre" value={d.name} onChange={(v) => updateDevice(i, { name: v })} placeholder="AC Smart 5" disabled={readOnly} />
            <IpField label="IP" value={d.host} onChange={(v) => updateDevice(i, { host: v })} placeholder="10.3.0.11" disabled={readOnly} />
            <button type="button" className={removeButton} disabled={readOnly} onClick={() => set({ devices: devices.filter((_, j) => j !== i) })}>
              Quitar
            </button>
          </div>
        ))}
        <button type="button" className={smallButton} disabled={readOnly} onClick={() => set({ devices: [...devices, { name: "", host: "" }] })}>
          + Agregar gateway BACnet
        </button>
      </div>

      <div className="border-t border-slate-800 pt-4">
        <TargetsInput
          label="Dónde buscar equipos BACnet (Who-Is)"
          tone="orange"
          targets={discovery?.targets ?? []}
          disabled={readOnly}
          onChange={(t) => onDiscoveryChange({ targets: t })}
        />
      </div>
    </ProtocolCard>
  );
}

// ---------- LoRaWAN directo (gateways Semtech UDP) ----------

export function LoraGatewayCard({
  config,
  onChange,
  readOnly,
}: {
  config: LoraGatewayConfig | null | undefined;
  onChange: (next: LoraGatewayConfig) => void;
  readOnly: boolean;
}) {
  const c: LoraGatewayConfig = config ?? { enabled: false, listen: ":1700", gatewayTimeoutSeconds: 90 };
  const { ip, port } = splitListen(c.listen);
  const set = (patch: Partial<LoraGatewayConfig>) => onChange({ ...c, ...patch });
  const keys = c.keys?.length ?? 0;

  return (
    <ProtocolCard
      title="LoRaWAN · gateway directo"
      description="Los gateways LoRa envían las tramas de los sensores a este puerto (sin ChirpStack)."
      badge="UDP"
      tone="violet"
      mode="escucha"
      enabled={c.enabled}
      disabled={readOnly}
      onToggle={(v) => set({ enabled: v })}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField label="Puerto UDP" value={port} defaultValue={1700} min={1} max={65535} onChange={(v) => set({ listen: `${ip}:${v}` })} disabled={readOnly} hint="Puerto estándar" />
        <TextField
          label="Escuchar en la IP"
          value={ip}
          placeholder="Todas las interfaces"
          onChange={(v) => set({ listen: `${v}:${port}` })}
          disabled={readOnly}
          validate={(v) => (/^(\d{1,3}\.){3}\d{1,3}$/.test(v) ? undefined : "IP de esta máquina, o vacío para todas")}
        />
        <NumberField
          label="Gateway caído tras (s)"
          value={c.gatewayTimeoutSeconds ?? 90}
          min={10}
          max={3600}
          onChange={(v) => set({ gatewayTimeoutSeconds: v })}
          disabled={readOnly}
        />
      </div>
      <p className="text-xs text-slate-500">
        En cada gateway, configura como <i>Network Server</i> la IP del servidor del agente y este puerto. Los gateways aparecen solos al
        enviar su primera trama. {keys > 0 ? `${keys} sensor(es) con llaves cargadas (se administran con chirpstack-keys, no se muestran aquí).` : ""}
      </p>
    </ProtocolCard>
  );
}

// ---------- Brokers MQTT (ChirpStack y Zigbee2MQTT) ----------

export function BrokerCard({
  kind,
  config,
  onChange,
  onTest,
  testing,
  readOnly,
}: {
  kind: "lorawan" | "mqtt";
  config: BrokerConfig | null | undefined;
  onChange: (next: BrokerConfig) => void;
  onTest: (host: string, port: number) => void;
  testing: boolean;
  readOnly: boolean;
}) {
  const isMqtt = kind === "mqtt";
  const c: BrokerConfig = config ?? { enabled: false, brokerUrl: "", username: "", password: "", ...(isMqtt ? { baseTopic: "zigbee2mqtt" } : {}) };
  const { scheme, host, port } = splitBrokerUrl(c.brokerUrl);
  const set = (patch: Partial<BrokerConfig>) => onChange({ ...c, ...patch });

  return (
    <ProtocolCard
      title={isMqtt ? "MQTT · Zigbee2MQTT" : "LoRaWAN · ChirpStack"}
      description={
        isMqtt ? "Sensores y switches Zigbee a través del broker MQTT." : "Sensores LoRaWAN que ChirpStack publica en su broker MQTT."
      }
      badge="TCP"
      tone={isMqtt ? "emerald" : "teal"}
      mode="consulta"
      enabled={c.enabled}
      disabled={readOnly}
      onToggle={(v) => set({ enabled: v })}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_130px]">
        <TextField
          label="IP o nombre del broker"
          value={host}
          placeholder={isMqtt ? "192.168.70.25" : "10.0.6.35"}
          onChange={(v) => set({ brokerUrl: joinBrokerUrl(scheme, v.trim(), port) })}
          disabled={readOnly}
          validate={(v) => (/^[A-Za-z0-9.\-_]+$/.test(v) ? undefined : "Escribe solo la IP o el nombre, sin tcp://")}
        />
        <NumberField label="Puerto TCP" value={port} defaultValue={1883} min={1} max={65535} onChange={(v) => set({ brokerUrl: joinBrokerUrl(scheme, host, v) })} disabled={readOnly} hint="Puerto estándar" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Usuario" value={c.username ?? ""} onChange={(v) => set({ username: v })} disabled={readOnly} />
        <SecretField label="Contraseña" value={c.password ?? ""} onChange={(v) => set({ password: v })} disabled={readOnly} />
      </div>
      {isMqtt && (
        <TextField label="Tópico base" value={c.baseTopic ?? "zigbee2mqtt"} onChange={(v) => set({ baseTopic: v })} disabled={readOnly} />
      )}
      <button type="button" className={smallButton} disabled={!host || testing} onClick={() => onTest(host, port)}>
        {testing ? "Probando..." : "Probar conexión desde el agente"}
      </button>
    </ProtocolCard>
  );
}
