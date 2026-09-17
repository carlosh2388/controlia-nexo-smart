import { useMemo, useState } from "react";
import { useAreas, type Area, GENERAL_IMAGE_WIDTH, GENERAL_IMAGE_HEIGHT } from "../api/areas";
import { useSendDeviceCommand } from "../api/devices";
import ToggleSwitch from "../components/ToggleSwitch";
import { SensorReadingPanel } from "../components/SensorReadingCard";
import { BuildingIcon } from "../components/icons";

function ShieldIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 3l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6l7-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** Es "privacidad" (tinte/vidrio) si el nombre del switch lo sugiere; el resto se trata como iluminacion normal. */
function isPrivacyDevice(name: string) {
  return /privacidad/i.test(name);
}

function polygonAttr(points: [number, number][]) {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

function AreaDeviceRow({ area }: { area: Area }) {
  const sendCommand = useSendDeviceCommand();

  function handleToggle(deviceId: string, next: boolean) {
    sendCommand.mutate({ deviceId, action: next ? "on" : "off" });
  }

  if (area.devices.length === 0) {
    return <p className="text-sm text-slate-500">Aun sin dispositivos conectados a esta area.</p>;
  }

  const switches = area.devices.filter((d) => d.kind !== "sensor");
  const sensors = area.devices.filter((d) => d.kind === "sensor");

  return (
    <div className="space-y-3">
      {switches.length > 0 && (
        <div className="space-y-2">
          {switches.map((device) => {
            const isOn = device.state?.state === "on";
            const privacy = isPrivacyDevice(device.name);
            return (
              <div
                key={device.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2"
              >
                <span className="flex min-w-0 items-center gap-2 text-sm text-slate-200">
                  {privacy ? (
                    <ShieldIcon className={`h-4 w-4 shrink-0 ${isOn ? "text-sky-400" : "text-slate-500"}`} />
                  ) : (
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${isOn ? "bg-amber-300 shadow-[0_0_6px_theme(colors.amber.300)]" : "bg-slate-600"}`}
                    />
                  )}
                  <span className="truncate">{device.name}</span>
                </span>
                <ToggleSwitch checked={isOn} onChange={(next) => handleToggle(device.id, next)} />
              </div>
            );
          })}
        </div>
      )}
      {sensors.map((device) => (
        <div key={device.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <p className="mb-1 text-sm text-slate-200">{device.name}</p>
          <SensorReadingPanel readings={device.state?.readings ?? null} updatedAt={device.state?.updatedAt} />
        </div>
      ))}
    </div>
  );
}

export default function BuildingView() {
  const { data, isLoading, isError } = useAreas();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const areas = data?.areas ?? [];
  const selected = useMemo(
    () => areas.find((a) => a.id === selectedId) ?? areas[0] ?? null,
    [areas, selectedId],
  );
  const hotspotAreas = areas.filter((a) => a.points && a.points.length >= 3);

  if (isLoading) {
    return <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-slate-500">Cargando areas...</div>;
  }
  if (isError || !data) {
    return (
      <p className="rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-400">
        No se pudieron cargar las areas.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-sm text-slate-400">
        <BuildingIcon className="h-4 w-4 text-sky-400" />
        <span className="font-medium text-slate-200">{data.tenant.building}</span>
        <span className="text-slate-600">&middot;</span>
        <span>{data.tenant.level}</span>
        <span className="ml-auto text-xs text-slate-500">{areas.length} areas</span>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.6fr_1fr]">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
          <div className="relative w-full overflow-hidden rounded-xl bg-slate-950" style={{ height: "min(78vh, 900px)" }}>
            <svg
              viewBox={`0 0 ${GENERAL_IMAGE_WIDTH} ${GENERAL_IMAGE_HEIGHT}`}
              preserveAspectRatio="xMidYMid meet"
              className="absolute inset-0 h-full w-full"
            >
              <defs>
                <filter id="areaGlowAmber" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="5" result="b" />
                  <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
                <filter id="areaGlowSky" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="6" result="b" />
                  <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>

              <image href="/areas/isometrico-general-1.jpg" x={0} y={0} width={GENERAL_IMAGE_WIDTH} height={GENERAL_IMAGE_HEIGHT} />

              {hotspotAreas.map((area) => {
                const isSelected = selected?.id === area.id;
                const switches = area.devices.filter((d) => d.kind !== "sensor");
                const lightsOn = switches.some((d) => !isPrivacyDevice(d.name) && d.state?.state === "on");
                const hasLights = switches.some((d) => !isPrivacyDevice(d.name));
                const privacyOn = switches.some((d) => isPrivacyDevice(d.name) && d.state?.state === "on");

                const borderColor = !hasLights ? "#38bdf8" : lightsOn ? "#fcd34d" : "#475569";
                const fillColor = !hasLights ? "rgba(56,189,248,.08)" : lightsOn ? "rgba(253,224,71,.14)" : "rgba(2,6,23,.55)";
                const pts = polygonAttr(area.points!);
                const glowFilter = isSelected ? "url(#areaGlowSky)" : lightsOn ? "url(#areaGlowAmber)" : undefined;

                const xs = area.points!.map((p) => p[0]);
                const ys = area.points!.map((p) => p[1]);
                const labelX = Math.min(...xs);
                const labelY = Math.min(...ys) - 26;

                return (
                  <g key={area.id} onClick={() => setSelectedId(area.id)} style={{ cursor: "pointer" }}>
                    {/* Halo oscuro fijo: separa el contorno de la foto y de areas vecinas para que no se vean "pegadas". */}
                    <polygon points={pts} fill="none" stroke="rgba(2,6,23,.9)" strokeWidth={7} strokeLinejoin="round" />
                    <polygon
                      points={pts}
                      fill={fillColor}
                      stroke={borderColor}
                      strokeWidth={isSelected ? 4.5 : 3.5}
                      strokeLinejoin="round"
                      filter={glowFilter}
                      style={{ transition: "fill .3s ease, stroke .3s ease", pointerEvents: "all" }}
                    />
                    {privacyOn && (
                      <polygon points={pts} fill="rgba(226,232,240,.75)" style={{ pointerEvents: "none" }} />
                    )}
                    {isSelected && (
                      <polygon
                        points={pts}
                        fill="none"
                        stroke="#7dd3fc"
                        strokeWidth={2}
                        strokeDasharray="9 6"
                        strokeLinejoin="round"
                        className="animate-[dashMove_.8s_linear_infinite]"
                        style={{ pointerEvents: "none" }}
                      />
                    )}
                    <foreignObject x={labelX} y={Math.max(4, labelY)} width={180} height={22} style={{ pointerEvents: "none", overflow: "visible" }}>
                      <div className="inline-flex items-center gap-1.5 rounded bg-slate-950/80 px-1.5 py-0.5 text-[11px] font-semibold text-slate-100 shadow-sm">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${isSelected ? "animate-pulse" : ""}`}
                          style={{ background: borderColor, boxShadow: `0 0 5px ${borderColor}` }}
                        />
                        {area.name}
                      </div>
                    </foreignObject>
                  </g>
                );
              })}
            </svg>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Las areas marcadas ya tienen dispositivos reales conectados. El resto se activa aqui mismo en cuanto confirmemos su
            ubicacion en el plano.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          {selected && (
            <div key={selected.id} className="animate-[fadeIn_.3s_ease] rounded-2xl border border-sky-500/40 bg-slate-900/80 p-4">
              <div className="mb-3 flex items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-slate-950" style={{ height: "min(32vh, 340px)" }}>
                <img src={`/areas/${selected.imageFile}`} alt={selected.name} className="h-full w-full object-contain" />
              </div>
              <h3 className="mb-3 text-lg font-semibold text-slate-100">{selected.name}</h3>
              <AreaDeviceRow area={selected} />
            </div>
          )}

          <div className="max-h-[38vh] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900/70 p-2">
            {areas.map((area) => (
              <button
                key={area.id}
                onClick={() => setSelectedId(area.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-all ${
                  selected?.id === area.id ? "bg-sky-500/10 ring-1 ring-sky-500/40" : "hover:bg-slate-800/60"
                }`}
              >
                <img
                  src={`/areas/${area.imageFile}`}
                  alt=""
                  className="h-11 w-11 shrink-0 rounded-md border border-slate-800 object-cover transition-transform"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-200">{area.name}</span>
                  <span className="block text-xs text-slate-500">
                    {area.devices.length > 0 ? `${area.devices.length} dispositivo(s)` : "sin dispositivos"}
                  </span>
                </span>
                {selected?.id === area.id && <span className="shrink-0 text-xs font-semibold text-sky-400">viendo</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
