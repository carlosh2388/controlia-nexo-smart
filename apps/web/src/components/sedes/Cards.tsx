import type { ReactNode } from "react";
import { AirArt, DoorArt, EvaArt, GeneratorArt, IonArt, PmArt, RingGauge, TrendIcon, WiseArt } from "./Art";
import { aiKeys, co2Limit, coldChainChannels, fmt, isDoorOpen, num, str, type ColdChainChannel, type SedeDevice } from "../../utils/sedes";

/**
 * Tarjetas de la pestaña Sedes, una por tipo de equipo (diseño final aprobado: ilustracion
 * realista + anillo de estado que se pone naranja fuera de rango). Todas reciben un SedeDevice
 * (ver utils/sedes.ts) y abren las tendencias con onTrend.
 */

const WARN = "#FF8A5C";

interface CardProps {
  d: SedeDevice;
  compact: boolean;
  onTrend: (d: SedeDevice) => void;
}

function CardShell({ compact, offline, children }: { compact: boolean; offline?: boolean; children: ReactNode }) {
  return (
    <article
      className={`flex min-w-0 flex-col rounded-[14px] border bg-[#121A23] ${compact ? "gap-2 px-3 py-2.5" : "gap-3 p-4"} ${
        offline ? "border-[#5A3A2A] opacity-75" : "border-[#243243]"
      }`}
    >
      {children}
    </article>
  );
}

function TrendButton({ d, onTrend }: { d: SedeDevice; onTrend: (d: SedeDevice) => void }) {
  return (
    <button
      type="button"
      onClick={() => onTrend(d)}
      className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-[10px] border border-[#2C3D50] bg-[#0E151D] px-3 py-2 text-[13px] font-semibold text-[#CFE0F5] transition-colors hover:border-[#3A4E64] hover:bg-[#1B2735]"
    >
      <TrendIcon />
      Ver tendencias
    </button>
  );
}

function Tile({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="min-w-0 rounded-[10px] bg-[#0E151D] px-2.5 py-2">
      <div className="truncate text-[11px] text-[#93A4B5]">{label}</div>
      <div className="sd-num text-base font-semibold text-[#E6EDF3]">
        {value} <span className="text-[11px] font-normal text-[#93A4B5]">{unit}</span>
      </div>
    </div>
  );
}

function OfflineTag({ d }: { d: SedeDevice }) {
  if (d.online) return null;
  return <span className="rounded-full border border-[#7A4A12] bg-[#2A1A08] px-2.5 py-0.5 text-xs text-[#FFC979]">Sin comunicación</span>;
}

// ---------------- Generador ----------------

export function generatorRunning(d: SedeDevice) {
  return (num(d.readings, "engine_speed_metering") ?? 0) > 100;
}

export function GeneratorCard({ d, compact, onTrend }: CardProps) {
  const r = d.readings;
  const run = generatorRunning(d);
  const load = num(r, "engine_load_metering") ?? 0;
  const fuel = num(r, "fuel_level_metering");
  const rpm = num(r, "engine_speed_metering");
  const kw = num(r, "gen_kw_total_metering");
  const batt = num(r, "battery_voltage_metering");
  const feeds = str(d.attrs.feeds);
  const pill = (
    <span
      className={`self-start whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${
        run ? "bg-[#F2A33A] text-[#1A1206]" : "border border-[#2C3D50] bg-[#0E151D] text-[#B4C2D0]"
      }`}
    >
      {run ? "Operando" : compact ? "Espera" : "En espera · auto"}
    </span>
  );
  const ringLabel = `Carga ${fmt(load, 0)} %, combustible ${fmt(fuel, 0)} %`;

  return (
    <CardShell compact={compact} offline={!d.online}>
      {compact ? (
        <div className="flex items-center gap-2.5">
          <GeneratorArt running={run} lcd="" compact />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{d.name}</div>
            <div className="sd-num text-xs text-[#B4C2D0]">
              {run ? `${fmt(kw, 0)} kW · comb. ${fmt(fuel, 0)}%` : `Batería ${fmt(batt, 1)} V · comb. ${fmt(fuel, 0)}%`}
            </div>
          </div>
          {pill}
          <RingGauge size={44} pct={load} color="#F2A33A" label={fmt(load, 0)} stroke={10} ariaLabel={ringLabel} />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3.5">
            <GeneratorArt running={run} lcd={run ? `${fmt(rpm, 0)} RPM` : "LISTO"} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="text-[15px] font-semibold">{d.name}</div>
              <div className="text-xs text-[#93A4B5]">
                {d.area}
                {feeds ? ` · respalda ${feeds}` : ""}
              </div>
              {pill}
              <OfflineTag d={d} />
            </div>
            <RingGauge
              size={74}
              pct={load}
              color="#F2A33A"
              label={`${fmt(load, 0)}%`}
              sub="carga"
              inner={{ pct: fuel ?? 0, color: "#8C7BFF" }}
              ariaLabel={ringLabel}
              stroke={7}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Velocidad" value={fmt(rpm, 0)} unit="RPM" />
            <Tile label="Potencia" value={fmt(kw, 1)} unit="kW" />
            <Tile label="Frecuencia" value={fmt(num(r, "gen_frequency_metering"), 2)} unit="Hz" />
            <Tile label="Refrigerante" value={fmt(num(r, "coolant_temp_metering"), 0)} unit="°C" />
            <Tile label="Aceite" value={fmt(num(r, "oil_pressure_metering"), 0)} unit="psi" />
            <Tile label="Batería" value={fmt(batt, 1)} unit="V" />
            <Tile label="Factor pot." value={run ? fmt(num(r, "power_factor_metering"), 2) : "—"} unit="" />
            <Tile label="Combustible" value={fmt(fuel, 0)} unit="%" />
          </div>
          <div className="flex gap-4 text-xs text-[#93A4B5]">
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#F2A33A]" />
              Carga {fmt(load, 0)}%
            </span>
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#8C7BFF]" />
              Combustible {fmt(fuel, 0)}%
            </span>
          </div>
        </>
      )}
      <TrendButton d={d} onTrend={onTrend} />
    </CardShell>
  );
}

// ---------------- ION7400 ----------------

/** "Comercial" | "Generador" | null segun el estado S1/S2 que vigila el analizador. */
export function ionSource(d: SedeDevice): "Comercial" | "Generador" | null {
  const s1 = num(d.readings, "s1_commercial_energy_status");
  const s2 = num(d.readings, "s2_generator_energy_status");
  if (s1 == null && s2 == null) return null;
  if (s2 === 1) return "Generador";
  return "Comercial";
}

export function IonCard({ d, compact, onTrend }: CardProps) {
  const r = d.readings;
  const mono = str(d.attrs.phase) === "Monofásica";
  const kw = ["a", "b", "c"].map((p) => num(r, `active_power_${p}`) ?? 0);
  const total = num(r, "active_power_total") ?? kw[0] + kw[1] + kw[2];
  const cap = Number(d.attrs.capacityKva) || 0;
  const kva = num(r, "apparent_power_total");
  const load = cap > 0 && kva != null ? (kva / cap) * 100 : 0;
  const maxKw = Math.max(...kw, 1);
  const hz = num(r, "frequency");
  const pfRaw = num(r, "power_factor_total");
  const pf = pfRaw == null ? null : Math.abs(pfRaw);
  const thd = Math.max(num(r, "thd_voltage_v1_high") ?? 0, num(r, "thd_voltage_v2_high") ?? 0, num(r, "thd_voltage_v3_high") ?? 0);
  const source = ionSource(d);
  const ringColor = load > 80 ? WARN : "#5B9BFF";
  const ringLabel = cap ? `Carga ${fmt(load, 0)} % de ${cap} kVA` : "Capacidad no configurada";
  const phases = (mono ? ["A", "B"] : ["A", "B", "C"]).map((L, i) => ({ L, kw: kw[i], f: kw[i] / maxKw }));

  return (
    <CardShell compact={compact} offline={!d.online}>
      {compact ? (
        <div className="flex items-center gap-2.5">
          <IonArt compact lcdMain={total >= 100 ? fmt(total, 0) : fmt(total, 1)} lcdSub="" phases={[]} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold" title={d.name}>
              {d.name}
            </div>
            <div className="truncate text-xs text-[#93A4B5]">
              {d.area} · {fmt(total, 1)} kW
            </div>
          </div>
          <RingGauge size={44} pct={load} color={ringColor} label={fmt(load, 0)} stroke={10} ariaLabel={ringLabel} />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <IonArt
              lcdMain={total >= 100 ? fmt(total, 1) : fmt(total, 2)}
              lcdSub={`${fmt(hz, 2)}Hz  PF ${fmt(pf, 2)}`}
              phases={phases.map((p) => p.f)}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="font-semibold">{d.name}</div>
              <div className="text-xs text-[#93A4B5]">
                {d.area}
                {cap ? ` · ${cap} kVA` : ""}
              </div>
              {source && (
                <span
                  className={`self-start whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs ${
                    source === "Generador" ? "border-[#7A4A12] bg-[#2A1E0C] text-[#FFC979]" : "border-[#22406E] bg-[#13213A] text-[#A9C8FF]"
                  }`}
                >
                  {source}
                </span>
              )}
              <OfflineTag d={d} />
            </div>
            <RingGauge size={64} pct={load} color={ringColor} label={`${fmt(load, 0)}%`} sub="carga" ariaLabel={ringLabel} />
          </div>
          <div className="flex flex-col gap-1.5">
            {phases.map((p) => (
              <div key={p.L} className="grid grid-cols-[22px_minmax(0,1fr)_72px] items-center gap-2 text-xs">
                <span className="text-[#93A4B5]">{p.L}</span>
                <div className="h-1.5 overflow-hidden rounded bg-[#0E151D]">
                  <div className="h-1.5 rounded bg-[#5B9BFF] transition-[width] duration-700" style={{ width: `${(p.f * 100).toFixed(0)}%` }} />
                </div>
                <span className="sd-num text-right">{fmt(p.kw, 1)} kW</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-1.5 text-xs">
            <div className="rounded-lg bg-[#0E151D] px-2 py-1.5">
              <div className="text-[#93A4B5]">FP</div>
              <div className="sd-num">{fmt(pf, 2)}</div>
            </div>
            <div className="rounded-lg bg-[#0E151D] px-2 py-1.5">
              <div className="text-[#93A4B5]">Frecuencia</div>
              <div className="sd-num">{fmt(hz, 2)} Hz</div>
            </div>
            <div className="rounded-lg bg-[#0E151D] px-2 py-1.5">
              <div className="text-[#93A4B5]">THD V máx</div>
              <div className="sd-num" style={{ color: thd > 5 ? WARN : undefined }}>
                {fmt(thd, 1)}%
              </div>
            </div>
          </div>
        </>
      )}
      <TrendButton d={d} onTrend={onTrend} />
    </CardShell>
  );
}

// ---------------- PM2130 ----------------

export function PmCard({ d, compact, onTrend }: CardProps) {
  const r = d.readings;
  const mono = str(d.attrs.phase) === "Monofásica";
  const L = mono ? ["a", "b"] : ["a", "b", "c"];
  const v = L.map((p) => num(r, `voltage_${p}_n`));
  const a = L.map((p) => num(r, `current_${p}`));
  const valid = v.filter((x): x is number => x != null && x > 0);
  const avgV = valid.length ? valid.reduce((s, x) => s + x, 0) / valid.length : 0;
  const kw = num(r, "demand_total");
  const off = avgV > 0 && Math.abs(avgV - 120) / 120 > 0.05;
  const ringColor = off ? WARN : "#34C3B0";
  const ringLabel = `Voltaje promedio ${fmt(avgV, 1)} V`;
  const lines = mono
    ? [`V1 ${fmt(v[0], 1)}V`, `V2 ${fmt(v[1], 1)}V`, `P  ${fmt(kw, 2)}kW`]
    : [`V1 ${fmt(v[0], 1)}V`, `V2 ${fmt(v[1], 1)}V`, `V3 ${fmt(v[2], 1)}V`];

  return (
    <CardShell compact={compact} offline={!d.online}>
      {compact ? (
        <div className="flex items-center gap-2.5">
          <PmArt compact lines={[]} compactValue={fmt(kw, 1)} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{d.area || d.name}</div>
            <div className="sd-num text-xs text-[#93A4B5]">{fmt(kw, 2)} kW</div>
          </div>
          <RingGauge size={40} pct={(avgV / 130) * 100} color={ringColor} label={fmt(avgV, 0)} stroke={10} ariaLabel={ringLabel} />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <PmArt lines={lines} compactValue="" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{d.area || d.name}</div>
              <div className="text-xs text-[#93A4B5]">
                {d.name}
                {d.attrs.code ? ` · ${str(d.attrs.code)}` : ""}
              </div>
              <div className="sd-num pt-1 text-lg font-semibold">
                {fmt(kw, 2)} <span className="text-xs font-normal text-[#93A4B5]">kW</span>
              </div>
              <OfflineTag d={d} />
            </div>
            <RingGauge size={56} pct={(avgV / 130) * 100} color={ringColor} label={fmt(avgV, 0)} sub="V prom" ariaLabel={ringLabel} />
          </div>
          <div className="grid grid-cols-[22px_repeat(2,minmax(0,1fr))] gap-x-2 gap-y-1 text-xs">
            {L.map((p, i) => (
              <div key={p} className="contents">
                <span className="text-[#93A4B5]">{p.toUpperCase()}</span>
                <span className="sd-num">{fmt(v[i], 1)} V</span>
                <span className="sd-num">{fmt(a[i], 1)} A</span>
              </div>
            ))}
          </div>
        </>
      )}
      <TrendButton d={d} onTrend={onTrend} />
    </CardShell>
  );
}

// ---------------- LoRaWAN ----------------

export function DoorTile({ d, onTrend }: { d: SedeDevice; onTrend: (d: SedeDevice) => void }) {
  const open = isDoorOpen(d.readings);
  const status = !d.online ? "Sin comunicación" : open ? "Abierta" : "Cerrada";
  const battery = num(d.readings, "battery");
  return (
    <article
      className={`flex min-w-0 items-center gap-2.5 rounded-xl border bg-[#121A23] p-2.5 ${open ? "border-[#7A4A12]" : "border-[#243243]"}`}
    >
      <DoorArt open={open} label={status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold" title={d.name}>
          {d.area || d.name}
        </div>
        {d.area && <div className="sd-num truncate text-[10px] text-[#7D8FA1]">{d.name}</div>}
        <div className={`text-xs font-semibold ${open ? "text-[#FFC979]" : "text-[#8FE0B5]"}`}>{status}</div>
        <div className="sd-num text-[11px] text-[#93A4B5]" style={{ color: battery != null && battery < 20 ? WARN : undefined }}>
          Bat. {fmt(battery, 0)}%
        </div>
      </div>
      <button
        type="button"
        onClick={() => onTrend(d)}
        aria-label={`Ver tendencias de ${d.name}`}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-[#2C3D50] bg-[#0E151D] text-[#CFE0F5] hover:border-[#3A4E64] hover:bg-[#1B2735]"
      >
        <TrendIcon className="h-[18px] w-[18px]" />
      </button>
    </article>
  );
}

export function EnvCard({ d, onTrend }: { d: SedeDevice; onTrend: (d: SedeDevice) => void }) {
  const t = num(d.readings, "temperature");
  const h = num(d.readings, "humidity");
  const out = t != null && (t < 18 || t > 26);
  return (
    <CardShell compact={false} offline={!d.online}>
      <div className="flex items-center gap-3">
        <EvaArt lcd={`${fmt(t, 1)}°`} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{d.name}</div>
          <div className="text-xs text-[#93A4B5]">
            {d.model || "EVA"}
            {d.area ? ` · ${d.area}` : ""}
          </div>
          <div className="sd-num pt-0.5 text-[13px]">
            {fmt(t, 1)} °C · {fmt(h, 0)} %HR
          </div>
          <OfflineTag d={d} />
        </div>
        <RingGauge
          size={58}
          pct={t == null ? 0 : ((t - 10) / 30) * 100}
          color={out ? WARN : "#4FC3F7"}
          label={`${fmt(t, 1)}°`}
          ariaLabel={`Temperatura ${fmt(t, 1)} °C`}
          stroke={8}
        />
      </div>
      <TrendButton d={d} onTrend={onTrend} />
    </CardShell>
  );
}

export function WiseCard({ d, onTrend }: { d: SedeDevice; onTrend: (d: SedeDevice) => void }) {
  const cold = coldChainChannels(d);
  if (cold.length) return <ColdChainCard d={d} channels={cold} onTrend={onTrend} />;
  const keys = aiKeys(d.readings);
  const ais = keys.map((k) => ({ k, label: k.replace(/_value$/i, "").toUpperCase(), v: num(d.readings, k) }));
  return (
    <CardShell compact={false} offline={!d.online}>
      <div className="flex items-center gap-3">
        <WiseArt active={ais.map((a) => (a.v ?? 0) > 4.2)} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{d.name}</div>
          <div className="text-xs text-[#93A4B5]">
            {d.model || "WISE"}
            {d.area ? ` · ${d.area}` : ""}
          </div>
          <OfflineTag d={d} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {ais.map((a) => (
          <div key={a.k} className="grid grid-cols-[30px_minmax(0,1fr)_64px] items-center gap-2 text-xs">
            <span className="text-[#93A4B5]">{a.label}</span>
            <div className="h-1.5 overflow-hidden rounded bg-[#0E151D]">
              <div
                className="h-1.5 rounded bg-[#A99BFF] transition-[width] duration-700"
                style={{ width: `${Math.max(0, Math.min(100, (((a.v ?? 4) - 4) / 16) * 100)).toFixed(0)}%` }}
              />
            </div>
            <span className="sd-num text-right">{fmt(a.v, 2)} mA</span>
          </div>
        ))}
        {ais.length === 0 && <div className="text-xs text-[#93A4B5]">Sin entradas analógicas en el último uplink.</div>}
      </div>
      <TrendButton d={d} onTrend={onTrend} />
    </CardShell>
  );
}

/**
 * WISE de cadena de frio: un renglon por refrigerador/congelador (nombre del tag operative_area de
 * ChirpStack), temperatura en °C convertida por el Agente_Go y su rango permitido.
 */
function ColdChainCard({ d, channels, onTrend }: { d: SedeDevice; channels: ColdChainChannel[]; onTrend: (d: SedeDevice) => void }) {
  return (
    <CardShell compact={false} offline={!d.online}>
      <div className="flex items-center gap-3">
        <WiseArt active={channels.map((c) => c.value != null)} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{d.area || d.name}</div>
          <div className="truncate text-xs text-[#93A4B5]">
            Cadena de frío · {d.model || "WISE"} · {d.name}
          </div>
          <OfflineTag d={d} />
        </div>
      </div>
      <ul className="flex flex-col gap-1.5">
        {channels.map((c) => {
          const out = c.value != null && ((c.min != null && c.value < c.min) || (c.max != null && c.value > c.max));
          // Posicion del valor dentro de una escala de rango ±(ancho del rango) para la barrita.
          const span = c.min != null && c.max != null ? c.max - c.min : 10;
          const lo = (c.min ?? (c.value ?? 0) - 5) - span;
          const hi = (c.max ?? (c.value ?? 0) + 5) + span;
          const pos = c.value == null ? 0 : Math.max(0, Math.min(100, ((c.value - lo) / (hi - lo)) * 100));
          const bandL = c.min != null ? ((c.min - lo) / (hi - lo)) * 100 : 0;
          const bandW = c.min != null && c.max != null ? ((c.max - c.min) / (hi - lo)) * 100 : 100;
          return (
            <li key={c.key} className="rounded-[10px] bg-[#0E151D] px-2.5 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-xs text-[#B4C2D0]" title={`${c.name}${c.code ? ` · ${c.code}` : ""}`}>
                  {c.name}
                </span>
                <span className="sd-num shrink-0 text-base font-semibold" style={{ color: out ? WARN : "#E6EDF3" }}>
                  {fmt(c.value, 1)} °C
                </span>
              </div>
              <div className="relative mt-1.5 h-1.5 rounded bg-[#1B2633]" aria-hidden="true">
                <div className="absolute inset-y-0 rounded bg-[#1E3A2E]" style={{ left: `${bandL}%`, width: `${bandW}%` }} />
                <div
                  className="absolute -top-[3px] h-3 w-1.5 rounded-sm transition-[left] duration-700"
                  style={{ left: `calc(${pos}% - 3px)`, background: out ? WARN : "#4FC3F7" }}
                />
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-[#7D8FA1]">
                <span>
                  {c.category || c.channel}
                  {c.code ? ` · ${c.code}` : ""}
                </span>
                <span>{c.min != null && c.max != null ? `${c.min} a ${c.max} °C` : "sin rango"}</span>
              </div>
            </li>
          );
        })}
      </ul>
      <TrendButton d={d} onTrend={onTrend} />
    </CardShell>
  );
}

export function AirCard({ d, onTrend }: { d: SedeDevice; onTrend: (d: SedeDevice) => void }) {
  const co2 = num(d.readings, "co2");
  const bad = co2 != null && co2 > co2Limit(d);
  return (
    <CardShell compact={false} offline={!d.online}>
      <div className="flex items-center gap-3">
        <AirArt />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{d.name}</div>
          <div className="text-xs text-[#93A4B5]">
            {d.model || "LEO S592"}
            {d.area ? ` · ${d.area}` : ""}
          </div>
          <div className="sd-num pt-0.5 text-[13px]">
            {fmt(num(d.readings, "temperature"), 1)} °C · {fmt(num(d.readings, "humidity"), 0)} %HR · PM2.5 {fmt(num(d.readings, "pm2_5"), 0)}
          </div>
          <OfflineTag d={d} />
        </div>
        <RingGauge
          size={58}
          pct={co2 == null ? 0 : (co2 / 1500) * 100}
          color={bad ? WARN : "#7BD88F"}
          label={fmt(co2, 0)}
          sub="ppm CO₂"
          ariaLabel={`CO2 ${fmt(co2, 0)} ppm`}
        />
      </div>
      <TrendButton d={d} onTrend={onTrend} />
    </CardShell>
  );
}

export function LoraCard({ d, onTrend }: { d: SedeDevice; onTrend: (d: SedeDevice) => void }) {
  const entries = Object.entries(d.readings).filter(([, v]) => typeof v === "number" || typeof v === "string").slice(0, 6);
  return (
    <CardShell compact={false} offline={!d.online}>
      <div>
        <div className="font-semibold">{d.name}</div>
        <div className="text-xs text-[#93A4B5]">{d.model || "LoRaWAN"}</div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {entries.map(([k, v]) => (
          <Tile key={k} label={k} value={typeof v === "number" ? fmt(v, 2) : String(v)} unit="" />
        ))}
      </div>
      <TrendButton d={d} onTrend={onTrend} />
    </CardShell>
  );
}

// ---------------- LoRaWAN directo (gateway -> Agente Go, sin ChirpStack) ----------------

function agoShort(iso: string) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return `hace ${Math.round(s / 3600)} h`;
}

/** Gateway LoRa conectado directo al agente por Semtech UDP. */
export function GatewayCard({ d, onTrend }: { d: SedeDevice; onTrend: (d: SedeDevice) => void }) {
  const r = d.readings;
  const eui = str(d.attrs.gatewayEui).toUpperCase();
  return (
    <CardShell compact={false} offline={!d.online}>
      <div className="flex items-center gap-3">
        <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true" className="shrink-0">
          <rect x="10" y="22" width="36" height="26" rx="4" fill="#D5DAE0" stroke="#A8B0BA" />
          <rect x="15" y="27" width="26" height="6" rx="1.5" fill="#1F4E8C" />
          <rect x="14" y="8" width="3" height="16" rx="1.5" fill="#2B3038" />
          <rect x="39" y="8" width="3" height="16" rx="1.5" fill="#2B3038" />
          <circle className={d.online ? "sd-blink" : undefined} cx="18" cy="41" r="2" fill={d.online ? "#4CC38A" : "#7A2A22"} />
          <circle cx="25" cy="41" r="2" fill={d.online ? "#4FC3F7" : "#3A414B"} />
          {d.online && (
            <>
              <path className="sd-glow" d="M8 6a10 10 0 0 0 0 14" fill="none" stroke="#A99BFF" strokeWidth="1.5" />
              <path className="sd-glow" d="M48 6a10 10 0 0 1 0 14" fill="none" stroke="#A99BFF" strokeWidth="1.5" />
            </>
          )}
        </svg>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Gateway LoRa</div>
          <div className="sd-num truncate text-xs text-[#93A4B5]">EUI {eui}</div>
          <span
            className={`mt-1 inline-block rounded-full border px-2.5 py-0.5 text-xs ${
              d.online ? "border-[#1F3A2E] bg-[#0F1F18] text-[#8FE0B5]" : "border-[#7A2A22] bg-[#2A1210] text-[#FF8A7A]"
            }`}
          >
            {d.online ? "Conectado directo al agente" : "Desconectado"}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Tramas recibidas" value={fmt(num(r, "frames_received"), 0)} unit="" />
        <Tile label="Dispositivos" value={fmt(num(r, "devices_heard"), 0)} unit="" />
        <Tile label="Errores CRC" value={fmt(num(r, "crc_errors"), 0)} unit="" />
        <Tile label="RX OK (gateway)" value={fmt(num(r, "rxok"), 0)} unit="" />
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-[#93A4B5]">
        <span>
          IP <span className="sd-num text-[#E6EDF3]">{str(d.attrs.ip) || "—"}</span>
        </span>
        <span>Semtech UDP · {str(d.attrs.listen) || ":1700"}</span>
        <span>Último contacto {agoShort(str(d.attrs.lastSeenAt))}</span>
      </div>
      <TrendButton d={d} onTrend={onTrend} />
    </CardShell>
  );
}

/** Dispositivos escuchados por radio sin llaves: se ve que existen y su señal, no su contenido. */
export function RadioTable({ devices, onTrend }: { devices: SedeDevice[]; onTrend: (d: SedeDevice) => void }) {
  const rows = [...devices].sort((a, b) => str(b.attrs.lastUplinkAt).localeCompare(str(a.attrs.lastUplinkAt)));
  return (
    <div className="overflow-x-auto rounded-[14px] border border-[#243243] bg-[#121A23]">
      <table className="w-full min-w-[760px] text-left text-[13px]">
        <thead className="text-xs text-[#93A4B5]">
          <tr className="border-b border-[#1B2633]">
            <th className="px-3 py-2 font-medium">Dispositivo</th>
            <th className="px-3 py-2 font-medium">RSSI</th>
            <th className="px-3 py-2 font-medium">SNR</th>
            <th className="px-3 py-2 font-medium">Frecuencia</th>
            <th className="px-3 py-2 font-medium">FCnt</th>
            <th className="px-3 py-2 font-medium">Tramas / joins</th>
            <th className="px-3 py-2 font-medium">Último</th>
            <th className="px-3 py-2 font-medium" aria-label="Tendencias" />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const rssi = num(d.readings, "rssi");
            return (
              <tr key={d.id} className="border-b border-[#1B2633] last:border-b-0">
                <td className="px-3 py-2">
                  <div className="font-semibold">{d.name}</div>
                  <div className="sd-num text-[11px] text-[#7D8FA1]">
                    {d.attrs.devAddr ? `DevAddr ${str(d.attrs.devAddr).toUpperCase()}` : ""}
                    {d.attrs.devEui ? ` · DevEUI ${str(d.attrs.devEui).toUpperCase()}` : ""} · cifrado
                  </div>
                </td>
                <td className="sd-num px-3 py-2" style={{ color: rssi != null && rssi < -115 ? WARN : undefined }}>
                  {fmt(rssi, 0)} dBm
                </td>
                <td className="sd-num px-3 py-2">{fmt(num(d.readings, "snr"), 1)} dB</td>
                <td className="sd-num px-3 py-2">{fmt(num(d.readings, "frequency_mhz"), 1)} MHz</td>
                <td className="sd-num px-3 py-2">{fmt(num(d.readings, "fcnt"), 0)}</td>
                <td className="sd-num px-3 py-2">
                  {fmt(num(d.readings, "uplinks"), 0)} / {fmt(num(d.readings, "join_requests"), 0)}
                </td>
                <td className="px-3 py-2 text-xs text-[#93A4B5]">{agoShort(str(d.attrs.lastUplinkAt))}</td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => onTrend(d)}
                    aria-label={`Ver tendencias de ${d.name}`}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#2C3D50] bg-[#0E151D] text-[#CFE0F5] hover:bg-[#1B2735]"
                  >
                    <TrendIcon />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
