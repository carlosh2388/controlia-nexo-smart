import { type ReactNode, useState } from "react";
import type { SensorReadings } from "../api/devices";
import { BatteryIcon, ChartIcon, DustIcon, GaugeIcon, PersonIcon, SignalIcon, ThermometerIcon, WaterDropIcon, WindIcon } from "./icons";
import DeviceTrendModal from "./DeviceTrendModal";

function batteryTone(battery?: number) {
  if (battery === undefined) return "text-slate-500";
  if (battery <= 20) return "text-red-400";
  if (battery <= 50) return "text-amber-300";
  return "text-emerald-300";
}

/** CO2 en ppm: <=800 aire fresco, <=1200 moderado, resto cargado (guias tipicas de calidad de aire interior). */
function co2Tone(co2?: number) {
  if (co2 === undefined) return "text-slate-500";
  if (co2 <= 800) return "text-emerald-300";
  if (co2 <= 1200) return "text-amber-300";
  return "text-red-400";
}

function formatNumber(value: number | undefined, digits: number) {
  return value === undefined ? "--" : value.toFixed(digits);
}

/** Se considera sensor de calidad de aire (LEO-S592 via LoRaWAN) si trae CO2 o particulas en el payload. */
function isAirQuality(readings: SensorReadings | null) {
  return readings?.co2 !== undefined || readings?.pm2_5 !== undefined;
}

/** Version compacta para filas dentro de un grupo (reemplaza el ToggleSwitch cuando el dispositivo es un sensor). */
export function SensorReadingInline({ readings }: { readings: SensorReadings | null }) {
  if (isAirQuality(readings)) {
    return (
      <div className="flex items-center gap-3 text-xs text-slate-300">
        <span className={`flex items-center gap-1 ${co2Tone(readings?.co2)}`}>
          <WindIcon className="h-3.5 w-3.5" />
          {formatNumber(readings?.co2, 0)} ppm
        </span>
        <span className="flex items-center gap-1">
          <ThermometerIcon className="h-3.5 w-3.5 text-orange-300" />
          {formatNumber(readings?.temperature, 1)}&deg;C
        </span>
        <span className="flex items-center gap-1">
          <WaterDropIcon className="h-3.5 w-3.5 text-cyan-300" />
          {formatNumber(readings?.humidity, 0)}%
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 text-xs text-slate-300">
      <span className="flex items-center gap-1">
        <ThermometerIcon className="h-3.5 w-3.5 text-orange-300" />
        {formatNumber(readings?.temperature, 1)}&deg;C
      </span>
      <span className="flex items-center gap-1">
        <WaterDropIcon className="h-3.5 w-3.5 text-cyan-300" />
        {formatNumber(readings?.humidity, 0)}%
      </span>
      <span className={`flex items-center gap-1 ${batteryTone(readings?.battery)}`}>
        <BatteryIcon className="h-3.5 w-3.5" />
        {formatNumber(readings?.battery, 0)}%
      </span>
    </div>
  );
}

function MetricTile({
  icon,
  label,
  value,
  unit,
  tone = "text-slate-100",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg bg-slate-800/40 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-slate-500">
        {icon}
        {label}
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${tone}`}>
        {value}
        {unit && <span className="text-sm text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

/** Panel completo para un sensor de calidad de aire (LEO-S592): CO2, TVOC, particulas, temp/humedad, + estado ambiental. */
function AirQualityPanel({ readings, updatedAt }: { readings: SensorReadings | null; updatedAt?: string | null }) {
  const occupied = readings?.pirStatus === "Occupied";
  return (
    <div className="border-t border-slate-800/70 pt-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MetricTile
          icon={<WindIcon className="h-3.5 w-3.5" />}
          label="CO2"
          value={formatNumber(readings?.co2, 0)}
          unit=" ppm"
          tone={co2Tone(readings?.co2)}
        />
        <MetricTile
          icon={<ThermometerIcon className="h-3.5 w-3.5 text-orange-300" />}
          label="Temperatura"
          value={formatNumber(readings?.temperature, 1)}
          unit="°C"
        />
        <MetricTile
          icon={<WaterDropIcon className="h-3.5 w-3.5 text-cyan-300" />}
          label="Humedad"
          value={formatNumber(readings?.humidity, 0)}
          unit="%"
        />
        <MetricTile
          icon={<DustIcon className="h-3.5 w-3.5 text-violet-300" />}
          label="PM2.5"
          value={formatNumber(readings?.pm2_5, 0)}
          unit=" µg/m³"
        />
        <MetricTile
          icon={<DustIcon className="h-3.5 w-3.5 text-violet-300" />}
          label="PM10"
          value={formatNumber(readings?.pm10, 0)}
          unit=" µg/m³"
        />
        <MetricTile
          icon={<WindIcon className="h-3.5 w-3.5 text-teal-300" />}
          label="TVOC"
          value={formatNumber(readings?.tvoc, 2)}
          unit=" mg/m³"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <GaugeIcon className="h-3.5 w-3.5" />
          {formatNumber(readings?.barometricPressure, 1)} hPa
        </span>
        {readings?.lightLevel && <span>Luz: {readings.lightLevel}</span>}
        {readings?.pirStatus && (
          <span className={`flex items-center gap-1.5 ${occupied ? "text-amber-300" : "text-slate-500"}`}>
            <PersonIcon className="h-3.5 w-3.5" />
            {occupied ? "Ocupado" : "Libre"}
          </span>
        )}
        <span>{updatedAt ? new Date(updatedAt).toLocaleTimeString() : "sin datos"}</span>
      </div>
    </div>
  );
}

function TrendsButton({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 py-2 text-sm font-medium text-sky-300 transition-colors hover:border-sky-500/50 hover:bg-sky-500/20 hover:text-sky-200"
      >
        <ChartIcon className="h-4 w-4" />
        Ver tendencias
      </button>
      {open && <DeviceTrendModal deviceId={deviceId} deviceName={deviceName} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Panel completo para la tarjeta de un sensor individual: lecturas grandes + diagnostico. */
export function SensorReadingPanel({
  readings,
  updatedAt,
  deviceId,
  deviceName,
}: {
  readings: SensorReadings | null;
  updatedAt?: string | null;
  deviceId?: string;
  deviceName?: string;
}) {
  if (isAirQuality(readings)) {
    return (
      <>
        <AirQualityPanel readings={readings} updatedAt={updatedAt} />
        {deviceId && deviceName && <TrendsButton deviceId={deviceId} deviceName={deviceName} />}
      </>
    );
  }

  return (
    <div className="border-t border-slate-800/70 pt-3">
      <div className="grid grid-cols-2 gap-3">
        <MetricTile
          icon={<ThermometerIcon className="h-3.5 w-3.5 text-orange-300" />}
          label="Temperatura"
          value={formatNumber(readings?.temperature, 1)}
          unit="°C"
        />
        <MetricTile
          icon={<WaterDropIcon className="h-3.5 w-3.5 text-cyan-300" />}
          label="Humedad"
          value={formatNumber(readings?.humidity, 0)}
          unit="%"
        />
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
        <span className={`flex items-center gap-1.5 ${batteryTone(readings?.battery)}`}>
          <BatteryIcon className="h-3.5 w-3.5" />
          Bateria {formatNumber(readings?.battery, 0)}%
        </span>
        <span className="flex items-center gap-1.5">
          <SignalIcon className="h-3.5 w-3.5" />
          Señal {readings?.linkquality ?? "--"}
        </span>
        <span>{updatedAt ? new Date(updatedAt).toLocaleTimeString() : "sin datos"}</span>
      </div>
      {deviceId && deviceName && <TrendsButton deviceId={deviceId} deviceName={deviceName} />}
    </div>
  );
}
