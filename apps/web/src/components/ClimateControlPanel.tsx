import { useMemo, useState } from "react";
import type { Device } from "../api/devices";
import { useSetClimate, type ClimateCommand } from "../api/devices";
import { extractErrorMessage } from "../api/errors";
import { ClimateIcon, FanIcon } from "./icons";
import ThinkingIndicator from "./ThinkingIndicator";

const MODE_LABELS: Record<string, string> = { COOL: "FRIO", HEAT: "CALOR", FAN: "VENT", DRY: "DESHU", AUTO: "AUTO" };
const FAN_LABELS: Record<string, string> = { LOW: "BAJA", MIDDLE: "MEDIA", MED: "MEDIA", HIGH: "ALTA", AUTO: "AUTO" };

function segButtonClass(active: boolean) {
  return `rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    active ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
  }`;
}

export default function ClimateControlPanel({ device, onClose }: { device: Device; onClose: () => void }) {
  const setClimate = useSetClimate();
  const bacnet = device.metadata?.bacnet;
  const readings = device.state?.readings;

  const initial = useMemo(
    () => ({
      on: device.state?.state === "on",
      mode: readings?.mode as string | undefined,
      fanSpeed: readings?.fanSpeed as string | undefined,
      temperature: readings?.setRoomTemp as number | undefined,
      swing: readings?.swing as boolean | undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [device.id],
  );

  const [on, setOn] = useState(initial.on);
  const [mode, setMode] = useState(initial.mode);
  const [fanSpeed, setFanSpeed] = useState(initial.fanSpeed);
  const [temperature, setTemperature] = useState(initial.temperature);
  const [swing, setSwing] = useState(initial.swing);
  const [error, setError] = useState<string | null>(null);

  const rangeLow = (readings?.tempRangeLow as number | undefined) ?? 16;
  const rangeHigh = (readings?.tempRangeHigh as number | undefined) ?? 30;
  const roomTemp = readings?.roomTemp as number | undefined;

  const dirty: ClimateCommand = {};
  if (on !== initial.on) dirty.on = on;
  if (mode !== undefined && mode !== initial.mode) dirty.mode = mode;
  if (fanSpeed !== undefined && fanSpeed !== initial.fanSpeed) dirty.fanSpeed = fanSpeed;
  if (temperature !== undefined && temperature !== initial.temperature) dirty.temperature = temperature;
  if (swing !== undefined && swing !== initial.swing) dirty.swing = swing;
  const hasChanges = Object.keys(dirty).length > 0;

  function step(delta: number) {
    setTemperature((prev) => {
      const base = prev ?? roomTemp ?? rangeLow;
      const next = Math.round((base + delta) * 2) / 2;
      return Math.min(rangeHigh, Math.max(rangeLow, next));
    });
  }

  async function handleApply() {
    setError(null);
    try {
      await setClimate.mutateAsync({ deviceId: device.id, command: dirty });
    } catch (err) {
      setError(extractErrorMessage(err, "No se pudo aplicar el cambio."));
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-sm flex-col overflow-y-auto border-l border-slate-800 bg-slate-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-400/15 text-sky-300">
              <ClimateIcon className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold text-slate-100">{device.name}</h2>
              <p className="text-xs text-slate-500">
                {roomTemp !== undefined ? `${roomTemp}°C ambiente` : "Sin lectura"}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200">
            ✕
          </button>
        </div>

        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">Funcionamiento</p>
        <div className="mb-5 grid grid-cols-2 gap-2">
          <button onClick={() => setOn(true)} className={segButtonClass(on)}>
            ON
          </button>
          <button onClick={() => setOn(false)} className={segButtonClass(!on)}>
            OFF
          </button>
        </div>

        {bacnet?.modeStates && bacnet.modeStates.length > 0 && (
          <>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">Modo</p>
            <div className="mb-5 grid grid-cols-3 gap-2">
              {bacnet.modeStates.map((m) => (
                <button key={m} onClick={() => setMode(m)} className={segButtonClass(mode === m)}>
                  {MODE_LABELS[m] ?? m}
                </button>
              ))}
            </div>
          </>
        )}

        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">Fijar temperatura</p>
        <div className="mb-1.5 flex items-center justify-between rounded-xl bg-slate-800/60 px-4 py-3">
          <span className="text-3xl font-semibold tabular-nums text-slate-100">
            {(temperature ?? roomTemp ?? rangeLow).toFixed(1)}°C
          </span>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => step(0.5)}
              className="flex h-7 w-9 items-center justify-center rounded-md bg-slate-700 text-slate-200 hover:bg-slate-600"
            >
              ▲
            </button>
            <button
              onClick={() => step(-0.5)}
              className="flex h-7 w-9 items-center justify-center rounded-md bg-slate-700 text-slate-200 hover:bg-slate-600"
            >
              ▼
            </button>
          </div>
        </div>
        <p className="mb-5 text-xs text-slate-500">
          Rango permitido: {rangeLow.toFixed(1)}~{rangeHigh.toFixed(1)}°C
        </p>

        {bacnet?.fanStates && bacnet.fanStates.length > 0 && (
          <>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
              <FanIcon className="h-3.5 w-3.5" />
              Velocidad ventilador
            </p>
            <div className="mb-5 grid grid-cols-4 gap-2">
              {bacnet.fanStates.map((f) => (
                <button key={f} onClick={() => setFanSpeed(f)} className={segButtonClass(fanSpeed === f)}>
                  {FAN_LABELS[f] ?? f}
                </button>
              ))}
            </div>
          </>
        )}

        {bacnet?.points.swingCommand && (
          <>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">Swing</p>
            <div className="mb-5 grid grid-cols-2 gap-2">
              <button onClick={() => setSwing(true)} className={segButtonClass(!!swing)}>
                Fijar
              </button>
              <button onClick={() => setSwing(false)} className={segButtonClass(!swing)}>
                Limpiar
              </button>
            </div>
          </>
        )}

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <button
          onClick={handleApply}
          disabled={!hasChanges || setClimate.isPending}
          className="mt-auto flex items-center justify-center gap-2 rounded-lg bg-sky-600 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {setClimate.isPending && <ThinkingIndicator size={16} />}
          {setClimate.isPending ? "Aplicando..." : "Aplicar"}
        </button>
      </div>
    </div>
  );
}
