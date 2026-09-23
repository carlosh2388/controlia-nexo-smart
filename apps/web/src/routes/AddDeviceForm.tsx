import { FormEvent, useState } from "react";
import {
  useCreateDevice,
  useUpdateDevice,
  type CreateDevicePayload,
  type Device,
  type DeviceProtocol,
  type HttpMethod,
} from "../api/devices";
import { useAllAreas } from "../api/areas";
import { extractErrorMessage } from "../api/errors";
import ThinkingIndicator from "../components/ThinkingIndicator";

const inputClass =
  "w-full rounded-md bg-slate-800 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500";
const labelClass = "mb-1 block text-xs text-slate-400";

function jsonOrEmpty(value: unknown): string {
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

/** Crea un dispositivo nuevo, o edita uno existente si se pasa `device` (precarga sus valores, incluida la config HTTP guardada). */
export default function AddDeviceForm({ device, onDone }: { device?: Device; onDone: () => void }) {
  const isEditing = Boolean(device);
  const createDevice = useCreateDevice();
  const updateDevice = useUpdateDevice();
  const { data: allAreas } = useAllAreas();
  const httpConfig = device?.metadata?.http;
  const ewelinkConfig = device?.metadata?.ewelink;

  const [protocol, setProtocol] = useState<DeviceProtocol>(device?.protocol ?? "mqtt");
  const [name, setName] = useState(device?.name ?? "");
  const [areaId, setAreaId] = useState(device?.areaId ?? "");
  const [error, setError] = useState<string | null>(null);

  const [payloadOn, setPayloadOn] = useState(device?.payloadOn ?? "ON");
  const [payloadOff, setPayloadOff] = useState(device?.payloadOff ?? "OFF");

  // mqtt
  const [commandTopic, setCommandTopic] = useState(device?.commandTopic ?? "");
  const [stateTopic, setStateTopic] = useState(device?.stateTopic ?? "");

  // http
  const [httpBaseUrl, setHttpBaseUrl] = useState(device?.httpBaseUrl ?? "");
  const [onMethod, setOnMethod] = useState<HttpMethod>(httpConfig?.on.method ?? "GET");
  const [onPath, setOnPath] = useState(httpConfig?.on.path ?? "");
  const [offMethod, setOffMethod] = useState<HttpMethod>(httpConfig?.off.method ?? "GET");
  const [offPath, setOffPath] = useState(httpConfig?.off.path ?? "");
  const [stateMethod, setStateMethod] = useState<HttpMethod>(httpConfig?.state?.method ?? "GET");
  const [statePath, setStatePath] = useState(httpConfig?.state?.path ?? "");
  const [pollIntervalMs, setPollIntervalMs] = useState(String(httpConfig?.pollIntervalMs ?? 5000));
  const [stateJsonPath, setStateJsonPath] = useState(httpConfig?.stateJsonPath ?? "");
  const [headersJson, setHeadersJson] = useState(jsonOrEmpty(httpConfig?.on.headers));
  const [onBodyJson, setOnBodyJson] = useState(jsonOrEmpty(httpConfig?.on.body));
  const [offBodyJson, setOffBodyJson] = useState(jsonOrEmpty(httpConfig?.off.body));

  // ewelink (LAN directo, sin nube ni Home Assistant)
  const [ewDeviceId, setEwDeviceId] = useState(ewelinkConfig?.deviceId ?? "");
  const [ewDeviceKey, setEwDeviceKey] = useState(ewelinkConfig?.devicekey ?? "");
  const [ewHost, setEwHost] = useState(ewelinkConfig?.host ?? "");
  const [ewPort, setEwPort] = useState(String(ewelinkConfig?.port ?? 8081));
  const [ewChannel, setEwChannel] = useState(
    ewelinkConfig?.channel !== undefined ? String(ewelinkConfig.channel) : "",
  );

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const payload: CreateDevicePayload = {
      name,
      protocol,
      payloadOn: payloadOn || undefined,
      payloadOff: payloadOff || undefined,
      areaId: isEditing ? areaId : areaId || undefined,
    };

    if (protocol === "mqtt") {
      payload.commandTopic = commandTopic || undefined;
      payload.stateTopic = stateTopic || undefined;
    } else if (protocol === "ewelink") {
      if (!ewDeviceId || !ewDeviceKey || !ewHost) {
        setError("deviceId, devicekey y host son obligatorios para eWeLink LAN.");
        return;
      }
      payload.ewelinkConfig = {
        deviceId: ewDeviceId,
        devicekey: ewDeviceKey,
        host: ewHost,
        port: ewPort ? Number(ewPort) : undefined,
        channel: ewChannel.trim() !== "" ? Number(ewChannel) : undefined,
      };
    } else {
      if (!httpBaseUrl || !onPath || !offPath) {
        setError("URL base, ruta de encendido y ruta de apagado son obligatorias para HTTP.");
        return;
      }

      let headers: Record<string, string> | undefined;
      let onBody: unknown;
      let offBody: unknown;
      try {
        headers = headersJson.trim() ? JSON.parse(headersJson) : undefined;
        onBody = onBodyJson.trim() ? JSON.parse(onBodyJson) : undefined;
        offBody = offBodyJson.trim() ? JSON.parse(offBodyJson) : undefined;
      } catch {
        setError('Encabezados o cuerpo con JSON invalido. Ejemplo: {"Authorization": "Bearer ..."}');
        return;
      }

      payload.httpBaseUrl = httpBaseUrl;
      payload.httpConfig = {
        on: { method: onMethod, path: onPath, headers, body: onBody },
        off: { method: offMethod, path: offPath, headers, body: offBody },
        ...(statePath
          ? {
              state: { method: stateMethod, path: statePath, headers },
              pollIntervalMs: Number(pollIntervalMs) || 5000,
              stateJsonPath: stateJsonPath || undefined,
            }
          : {}),
      };
    }

    try {
      if (isEditing && device) {
        await updateDevice.mutateAsync({ id: device.id, payload });
      } else {
        await createDevice.mutateAsync(payload);
      }
      onDone();
    } catch (err) {
      setError(
        extractErrorMessage(err, `No se pudo ${isEditing ? "actualizar" : "crear"} el dispositivo. Revisa los datos e intenta de nuevo.`),
      );
    }
  }

  const isPending = createDevice.isPending || updateDevice.isPending;

  return (
    <form onSubmit={handleSubmit} className="mb-6 rounded-xl bg-slate-900 p-5 shadow">
      <h2 className="mb-4 font-medium">{isEditing ? `Editar dispositivo: ${device!.name}` : "Agregar dispositivo"}</h2>

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass}>Nombre</label>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className={labelClass}>Protocolo</label>
          <select
            className={inputClass}
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as DeviceProtocol)}
          >
            <option value="mqtt">MQTT</option>
            <option value="http">HTTP (Tasmota, Shelly, ESPHome, REST, Home Assistant...)</option>
            <option value="ewelink">eWeLink LAN directo (Sonoff, sin nube ni Home Assistant)</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Area (Vista de edificio)</label>
          <select className={inputClass} value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">Sin asignar</option>
            {Object.entries(
              (allAreas ?? []).reduce<Record<string, typeof allAreas>>((groups, area) => {
                const key = area.tenant.level;
                (groups[key] ??= []).push(area);
                return groups;
              }, {}),
            ).map(([level, areasInLevel]) => (
              <optgroup key={level} label={level}>
                {areasInLevel!.map((area) => (
                  <option key={area.id} value={area.id}>
                    {area.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      {protocol === "mqtt" ? (
        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Topic de comando</label>
            <input
              className={inputClass}
              placeholder="home/lampara/set"
              value={commandTopic}
              onChange={(e) => setCommandTopic(e.target.value)}
            />
          </div>
          <div>
            <label className={labelClass}>Topic de estado</label>
            <input
              className={inputClass}
              placeholder="home/lampara/state"
              value={stateTopic}
              onChange={(e) => setStateTopic(e.target.value)}
            />
          </div>
          <div>
            <label className={labelClass}>Payload "encendido"</label>
            <input className={inputClass} value={payloadOn} onChange={(e) => setPayloadOn(e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Payload "apagado"</label>
            <input className={inputClass} value={payloadOff} onChange={(e) => setPayloadOff(e.target.value)} />
          </div>
        </div>
      ) : protocol === "ewelink" ? (
        <div className="mb-4 space-y-4">
          <p className="text-xs text-slate-500">
            Control 100% local por red, sin pasar por la nube de eWeLink ni por Home Assistant. La devicekey se
            obtiene una sola vez de tu cuenta eWeLink (ej. desde el almacenamiento de una integracion existente).
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Device ID</label>
              <input
                className={inputClass}
                placeholder="10021512ef"
                value={ewDeviceId}
                onChange={(e) => setEwDeviceId(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass}>Device Key (clave AES local)</label>
              <input
                className={inputClass}
                type="password"
                value={ewDeviceKey}
                onChange={(e) => setEwDeviceKey(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass}>Host / IP en tu red local</label>
              <input
                className={inputClass}
                placeholder="10.3.0.45"
                value={ewHost}
                onChange={(e) => setEwHost(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass}>Puerto</label>
              <input className={inputClass} type="number" value={ewPort} onChange={(e) => setEwPort(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Canal (solo switches multi-canal, ej. 0, 1, 2)</label>
              <input
                className={inputClass}
                placeholder="dejar vacio si es un solo canal"
                value={ewChannel}
                onChange={(e) => setEwChannel(e.target.value)}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="mb-4 space-y-4">
          <div>
            <label className={labelClass}>URL base</label>
            <input
              className={inputClass}
              placeholder="http://10.0.0.50"
              value={httpBaseUrl}
              onChange={(e) => setHttpBaseUrl(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex gap-2">
              <select className={inputClass} value={onMethod} onChange={(e) => setOnMethod(e.target.value as HttpMethod)}>
                <option>GET</option>
                <option>POST</option>
                <option>PUT</option>
              </select>
              <input
                className={inputClass}
                placeholder="/cm?cmnd=Power%20On o /api/services/switch/turn_on"
                value={onPath}
                onChange={(e) => setOnPath(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <select className={inputClass} value={offMethod} onChange={(e) => setOffMethod(e.target.value as HttpMethod)}>
                <option>GET</option>
                <option>POST</option>
                <option>PUT</option>
              </select>
              <input
                className={inputClass}
                placeholder="/cm?cmnd=Power%20Off o /api/services/switch/turn_off"
                value={offPath}
                onChange={(e) => setOffPath(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass}>Cuerpo JSON al encender (opcional, ej. {"{"}"entity_id": "switch.xxx"{"}"})</label>
              <input className={inputClass} value={onBodyJson} onChange={(e) => setOnBodyJson(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Cuerpo JSON al apagar (opcional)</label>
              <input className={inputClass} value={offBodyJson} onChange={(e) => setOffBodyJson(e.target.value)} />
            </div>
          </div>

          <div>
            <label className={labelClass}>
              Encabezados HTTP compartidos (JSON, opcional) - ej. para un token: {"{"}"Authorization": "Bearer ..."{"}"}
            </label>
            <input
              className={inputClass}
              placeholder='{"Authorization": "Bearer ..."}'
              value={headersJson}
              onChange={(e) => setHeadersJson(e.target.value)}
            />
          </div>

          <p className="text-xs text-slate-500">Lectura de estado (opcional, para reflejar cambios en tiempo real):</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex gap-2">
              <select
                className={inputClass}
                value={stateMethod}
                onChange={(e) => setStateMethod(e.target.value as HttpMethod)}
              >
                <option>GET</option>
                <option>POST</option>
                <option>PUT</option>
              </select>
              <input
                className={inputClass}
                placeholder="/cm?cmnd=Power"
                value={statePath}
                onChange={(e) => setStatePath(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass}>Cada cuanto leer (ms)</label>
              <input
                className={inputClass}
                type="number"
                value={pollIntervalMs}
                onChange={(e) => setPollIntervalMs(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass}>Campo JSON con el estado (ej. "POWER")</label>
              <input className={inputClass} value={stateJsonPath} onChange={(e) => setStateJsonPath(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Payload "encendido" / "apagado"</label>
              <div className="flex gap-2">
                <input className={inputClass} value={payloadOn} onChange={(e) => setPayloadOn(e.target.value)} />
                <input className={inputClass} value={payloadOff} onChange={(e) => setPayloadOff(e.target.value)} />
              </div>
            </div>
          </div>
        </div>
      )}

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="flex items-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
        >
          {isPending && <ThinkingIndicator size={16} />}
          {isPending ? "Guardando..." : isEditing ? "Guardar cambios" : "Guardar dispositivo"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md bg-slate-800 px-4 py-2 text-sm hover:bg-slate-700"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
