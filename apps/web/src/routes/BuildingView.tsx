import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import {
  useAreas,
  useTenants,
  useCreateTenant,
  useCreateArea,
  useUploadAreaImage,
  resolveAreaImageSrc,
  type Area,
  GENERAL_IMAGE_WIDTH,
  GENERAL_IMAGE_HEIGHT,
} from "../api/areas";
import { useSendDeviceCommand } from "../api/devices";
import { extractErrorMessage } from "../api/errors";
import ToggleSwitch from "../components/ToggleSwitch";
import { SensorReadingPanel } from "../components/SensorReadingCard";
import ClimateControlPanel from "../components/ClimateControlPanel";
import { BuildingIcon, ClimateIcon, PlusIcon } from "../components/icons";

/** Foto real si existe; si el area se creo sin imagen (nivel nuevo aun sin render), un marcador generico. */
function AreaImage({ imageFile, name, className }: { imageFile: string; name: string; className?: string }) {
  if (!imageFile) {
    return (
      <div className={`flex items-center justify-center bg-slate-800/60 ${className ?? ""}`}>
        <BuildingIcon className="h-10 w-10 text-slate-600" />
      </div>
    );
  }
  return <img src={resolveAreaImageSrc(imageFile)} alt={name} className={className} />;
}

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

function isClimateDevice(device: Area["devices"][number]) {
  const normalized = device.name.replace(/[_-]+/g, " ");
  return device.kind === "climate" || /\b(a\/?c|ac|hvac)\b|aire|clima|climat/i.test(normalized);
}

function polygonAttr(points: [number, number][]) {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

function AreaDeviceRow({ area, onOpenClimate }: { area: Area; onOpenClimate: (deviceId: string) => void }) {
  const sendCommand = useSendDeviceCommand();

  function handleToggle(deviceId: string, next: boolean) {
    sendCommand.mutate({ deviceId, action: next ? "on" : "off" });
  }

  if (area.devices.length === 0) {
    return <p className="text-sm text-slate-500">Aun sin dispositivos conectados a esta area.</p>;
  }

  const climates = area.devices.filter(isClimateDevice);
  const switches = area.devices.filter((d) => d.kind !== "sensor" && !isClimateDevice(d));
  const sensors = area.devices.filter((d) => d.kind === "sensor");
  // El maestro no incluye los switches de privacidad (vidrio/tinte): son un control aparte, no iluminacion.
  const lightSwitches = switches.filter((d) => !isPrivacyDevice(d.name));
  const onCount = lightSwitches.filter((d) => d.state?.state === "on").length;
  const allOn = lightSwitches.length > 0 && onCount === lightSwitches.length;

  function handleToggleAll(next: boolean) {
    for (const device of lightSwitches) {
      if ((device.state?.state === "on") !== next) {
        sendCommand.mutate({ deviceId: device.id, action: next ? "on" : "off" });
      }
    }
  }

  return (
    <div className="space-y-3">
      {climates.length > 0 && (
        <div className="space-y-2">
          {climates.map((device) => {
            const isOn = device.state?.state === "on";
            const roomTemp = device.state?.readings?.roomTemp as number | undefined;
            const setRoomTemp = device.state?.readings?.setRoomTemp as number | undefined;
            return (
              <button
                key={device.id}
                onClick={() => {
                  if (device.kind === "climate") {
                    onOpenClimate(device.id);
                  } else {
                    handleToggle(device.id, !isOn);
                  }
                }}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-left hover:bg-sky-500/10"
              >
                <span className="flex min-w-0 items-center gap-2 text-sm text-slate-200">
                  <ClimateIcon className={`h-4 w-4 shrink-0 ${isOn ? "text-sky-300" : "text-slate-500"}`} />
                  <span className="truncate">{device.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${isOn ? "bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400)]" : "bg-slate-700"}`}
                  />
                  {device.kind === "climate" ? (
                    <>
                      {roomTemp !== undefined ? `${roomTemp}°C` : "--"}
                      {setRoomTemp !== undefined && <span className="text-slate-600">&rarr; {setRoomTemp}°C</span>}
                    </>
                  ) : (
                    <span>{isOn ? "encendido" : "apagado"}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {lightSwitches.length > 1 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2">
          <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-sky-200">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-sky-400 shadow-[0_0_6px_theme(colors.sky.400)]" />
            Todas las luces ({onCount}/{lightSwitches.length} encendidas)
          </span>
          <ToggleSwitch checked={allOn} onChange={handleToggleAll} />
        </div>
      )}
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
          <SensorReadingPanel
            readings={device.state?.readings ?? null}
            updatedAt={device.state?.updatedAt}
            deviceId={device.id}
            deviceName={device.name}
          />
        </div>
      ))}
    </div>
  );
}

function NewTenantForm({ onCreated, onCancel }: { onCreated: (tenantId: string) => void; onCancel: () => void }) {
  const createTenant = useCreateTenant();
  const createArea = useCreateArea();
  const uploadImage = useUploadAreaImage();
  const [building, setBuilding] = useState("TEC 3");
  const [level, setLevel] = useState("");
  const [areaName, setAreaName] = useState("");
  const [imageFile, setImageFile] = useState("");
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isPending = createTenant.isPending || createArea.isPending || uploadImage.isPending;

  async function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    const previewUrl = URL.createObjectURL(file);
    setImagePreview(previewUrl);
    try {
      const uploaded = await uploadImage.mutateAsync(file);
      setImageFile(uploaded);
    } catch (err) {
      setImagePreview(null);
      setError(extractErrorMessage(err, "No se pudo subir la imagen. Usa JPG, PNG o WEBP (max 8MB)."));
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const tenant = await createTenant.mutateAsync({ name: `${building} - ${level}`, building, level });
      if (areaName.trim()) {
        await createArea.mutateAsync({ tenantId: tenant.id, name: areaName, imageFile: imageFile || undefined });
      }
      onCreated(tenant.id);
    } catch (err) {
      setError(extractErrorMessage(err, "No se pudo crear el nivel. Intenta de nuevo."));
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mb-4 rounded-xl border border-sky-500/30 bg-slate-900/80 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-100">Nuevo nivel</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-slate-400">Edificio</label>
          <input
            className="w-full rounded-md bg-slate-800 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500"
            value={building}
            onChange={(e) => setBuilding(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-400">Nivel</label>
          <input
            className="w-full rounded-md bg-slate-800 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500"
            placeholder="Nivel 4"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-400">Primera area (opcional)</label>
          <input
            className="w-full rounded-md bg-slate-800 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500"
            placeholder="NOC"
            value={areaName}
            onChange={(e) => setAreaName(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-400">Foto del area (opcional, JPG/PNG/WEBP)</label>
          <div className="flex items-center gap-3">
            {imagePreview && (
              <img src={imagePreview} alt="" className="h-10 w-10 shrink-0 rounded-md border border-slate-700 object-cover" />
            )}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleImageChange}
              className="block w-full text-xs text-slate-400 file:mr-3 file:rounded-md file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-sm file:text-slate-200 hover:file:bg-slate-700"
            />
          </div>
          {uploadImage.isPending && <p className="mt-1 text-xs text-sky-400">Subiendo...</p>}
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
        >
          {isPending ? "Creando..." : "Crear nivel"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md bg-slate-800 px-4 py-2 text-sm hover:bg-slate-700">
          Cancelar
        </button>
      </div>
    </form>
  );
}

export default function BuildingView() {
  const { data: tenants } = useTenants();
  const [tenantId, setTenantId] = useState<string | undefined>(undefined);
  const { data, isLoading, isError } = useAreas(tenantId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewTenant, setShowNewTenant] = useState(false);
  const [climateDeviceId, setClimateDeviceId] = useState<string | null>(null);

  const areas = data?.areas ?? [];
  const selected = useMemo(
    () => areas.find((a) => a.id === selectedId) ?? areas[0] ?? null,
    [areas, selectedId],
  );
  const hotspotAreas = areas.filter((a) => a.points && a.points.length >= 3);
  const climateDevice = areas.flatMap((a) => a.devices).find((d) => d.id === climateDeviceId) ?? null;

  // Al cambiar de nivel/tenant, la seleccion previa ya no aplica: vuelve a la primera area del nuevo tenant.
  useEffect(() => {
    setSelectedId(null);
  }, [tenantId]);

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

      {tenants && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {tenants.length > 1 &&
            tenants.map((t) => {
              const isActive = t.id === (tenantId ?? tenants[0]?.id);
              return (
                <button
                  key={t.id}
                  onClick={() => setTenantId(t.id)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/40"
                      : "bg-slate-900/70 text-slate-400 hover:bg-slate-800/70"
                  }`}
                >
                  {t.level}
                </button>
              );
            })}
          <button
            onClick={() => setShowNewTenant((v) => !v)}
            className="flex items-center gap-1 rounded-lg bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-400 hover:bg-slate-800/70"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Nuevo nivel
          </button>
        </div>
      )}

      {showNewTenant && (
        <NewTenantForm
          onCreated={(newTenantId) => {
            setTenantId(newTenantId);
            setShowNewTenant(false);
          }}
          onCancel={() => setShowNewTenant(false)}
        />
      )}

      {hotspotAreas.length === 0 ? (
        <div className={`grid grid-cols-1 gap-4 ${areas.length > 1 ? "lg:grid-cols-2" : ""}`}>
          {areas.map((area) => (
            <div
              key={area.id}
              className={`overflow-hidden rounded-2xl border transition-colors ${
                selected?.id === area.id
                  ? "border-sky-500/50 bg-sky-500/5"
                  : "border-slate-800 bg-slate-900/70"
              }`}
            >
              <button
                onClick={() => setSelectedId(area.id)}
                className="flex w-full items-center justify-center overflow-hidden bg-white"
                style={{ height: "min(48vh, 480px)" }}
              >
                <AreaImage imageFile={area.imageFile} name={area.name} className="h-full w-full object-contain" />
              </button>
              <div className="p-4">
                <h3 className="mb-3 text-base font-semibold text-slate-100">{area.name}</h3>
                <AreaDeviceRow area={area} onOpenClimate={setClimateDeviceId} />
              </div>
            </div>
          ))}
        </div>
      ) : (
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
                const switches = area.devices.filter((d) => d.kind !== "sensor" && !isClimateDevice(d));
                const lightsOn = switches.some((d) => !isPrivacyDevice(d.name) && d.state?.state === "on");
                const hasLights = switches.some((d) => !isPrivacyDevice(d.name));
                const privacyOn = switches.some((d) => isPrivacyDevice(d.name) && d.state?.state === "on");
                const climates = area.devices.filter(isClimateDevice);

                const borderColor = !hasLights ? "#38bdf8" : lightsOn ? "#fcd34d" : "#475569";
                const fillColor = !hasLights ? "rgba(56,189,248,.08)" : lightsOn ? "rgba(253,224,71,.14)" : "rgba(2,6,23,.55)";
                const pts = polygonAttr(area.points!);
                const glowFilter = isSelected ? "url(#areaGlowSky)" : lightsOn ? "url(#areaGlowAmber)" : undefined;

                const xs = area.points!.map((p) => p[0]);
                const ys = area.points!.map((p) => p[1]);
                const labelX = Math.min(...xs);
                const labelY = Math.min(...ys) - 26;
                // Centro real del poligono (promedio de vertices): ahi va el simbolo de A/C, dentro del
                // contorno del area, a diferencia de la etiqueta de nombre que flota arriba.
                const centerX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
                const centerY = ys.reduce((sum, y) => sum + y, 0) / ys.length;

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
                    {climates.length > 0 &&
                      (() => {
                        // Una burbuja por cada A/C real del area (no un solo icono agregado), para que se vea
                        // cual esta encendido y cual apagado, no solo que "hay clima aca".
                        const size = 26;
                        const gap = 6;
                        const rowWidth = climates.length * size + (climates.length - 1) * gap;
                        const startX = centerX - rowWidth / 2;
                        return climates.map((device, i) => {
                          const isOn = device.state?.state === "on";
                          const bx = startX + i * (size + gap);
                          return (
                            <foreignObject
                              key={device.id}
                              x={bx}
                              y={centerY - size / 2}
                              width={size}
                              height={size}
                              style={{ pointerEvents: "none", overflow: "visible" }}
                            >
                              <div className="relative flex h-[26px] w-[26px] items-center justify-center">
                                {isOn && <span className="absolute inset-0 animate-ping rounded-full bg-sky-400/25" />}
                                <div
                                  className={`relative flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors ${
                                    isOn ? "border-sky-400 bg-slate-950/90" : "border-slate-600 bg-slate-950/85"
                                  }`}
                                  style={isOn ? { boxShadow: "0 0 10px rgba(56,189,248,.65)" } : undefined}
                                >
                                  <ClimateIcon className={`h-3.5 w-3.5 ${isOn ? "text-sky-300" : "text-slate-500"}`} />
                                </div>
                              </div>
                            </foreignObject>
                          );
                        });
                      })()}
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm border-2" style={{ borderColor: "#fcd34d", background: "rgba(253,224,71,.18)" }} />
              Luces encendidas
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm border-2 border-slate-600 bg-slate-950/70" />
              Luces apagadas
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm border-2" style={{ borderColor: "#38bdf8", background: "rgba(56,189,248,.1)" }} />
              Area sin luces (solo sensores)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm border border-slate-400 bg-slate-200/70" />
              Privacidad activa
            </span>
            <span className="flex items-center gap-1.5">
              <ClimateIcon className="h-3.5 w-3.5 text-sky-300" />
              Aire acondicionado (BACnet)
            </span>
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
                <AreaImage imageFile={selected.imageFile} name={selected.name} className="h-full w-full object-contain" />
              </div>
              <h3 className="mb-3 text-lg font-semibold text-slate-100">{selected.name}</h3>
              <AreaDeviceRow area={selected} onOpenClimate={setClimateDeviceId} />
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
                <AreaImage
                  imageFile={area.imageFile}
                  name=""
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
      )}

      {climateDevice && <ClimateControlPanel device={climateDevice} onClose={() => setClimateDeviceId(null)} />}
    </div>
  );
}
