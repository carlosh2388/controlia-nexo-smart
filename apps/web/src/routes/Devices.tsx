import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDeleteDevice, useDevices, useSendDeviceCommand, useSetDeviceHidden, type Device } from "../api/devices";
import { useDeviceSocket } from "../ws/useDeviceSocket";
import { useAuthStore } from "../store/auth.store";
import { APP_NAME, BUILDING_CONTEXT } from "../config/brand";
import { inferDeviceKind, type DeviceKindId, type DeviceKindMeta } from "../utils/deviceKind";
import AddDeviceForm from "./AddDeviceForm";
import ImportHomeAssistant from "./ImportHomeAssistant";
import ImportMqtt from "./ImportMqtt";
import ImportBacnet from "./ImportBacnet";
import BuildingView from "./BuildingView";
import ClimateControlPanel from "../components/ClimateControlPanel";
import Automations from "./Automations";
import ToggleSwitch from "../components/ToggleSwitch";
import { SensorReadingInline, SensorReadingPanel } from "../components/SensorReadingCard";
import LiveClock from "../components/LiveClock";
import {
  BuildingIcon,
  ChevronIcon,
  ChipLogo,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  ImportIcon,
  LogoutIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "../components/icons";
import { ToastContainer, useToasts } from "../components/Toast";
import GlobalActivityIndicator from "../components/GlobalActivityIndicator";

function ActionButton({
  onClick,
  title,
  tone,
  children,
}: {
  onClick: () => void;
  title: string;
  tone: "blue" | "red" | "slate";
  children: React.ReactNode;
}) {
  const toneClass = {
    blue: "bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 hover:text-sky-300",
    red: "bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300",
    slate: "bg-slate-700/40 text-slate-300 hover:bg-slate-700/70 hover:text-slate-100",
  }[tone];

  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${toneClass}`}
    >
      {children}
    </button>
  );
}

function DeviceIconBadge({ kind, isOn, size = "md" }: { kind: DeviceKindMeta; isOn: boolean; size?: "md" | "sm" }) {
  const Icon = kind.Icon;
  const box = size === "md" ? "h-11 w-11 rounded-xl" : "h-8 w-8 rounded-lg";
  const iconSize = size === "md" ? "h-5 w-5" : "h-4 w-4";
  return (
    <div
      className={`flex shrink-0 items-center justify-center transition-all ${box} ${
        isOn ? `${kind.accent.bgOn} ${kind.accent.text} shadow-lg ${kind.accent.glow}` : "bg-slate-800 text-slate-500"
      }`}
    >
      <Icon className={iconSize} />
    </div>
  );
}

function StatusDot({ isOn }: { isOn: boolean }) {
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${
        isOn ? "bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400)]" : "bg-slate-700"
      }`}
    />
  );
}

type StatTone = "sky" | "emerald" | "slate" | "amber" | "violet" | "teal";

function StatTile({ label, value, tone }: { label: string; value: number; tone: StatTone }) {
  const toneClass = {
    sky: "text-sky-300",
    emerald: "text-emerald-300",
    slate: "text-slate-200",
    amber: "text-amber-300",
    violet: "text-violet-300",
    teal: "text-teal-300",
  }[tone];
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3">
      <div className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

/** Etiqueta legible + color por protocolo; orden fijo para que la fila de tarjetas no salte al cambiar los datos. */
const PROTOCOL_META: Record<string, { label: string; tone: StatTone }> = {
  http: { label: "HTTP / Home Assistant", tone: "sky" },
  mqtt: { label: "MQTT", tone: "emerald" },
  bacnet: { label: "BACnet (aires)", tone: "amber" },
  lorawan: { label: "LoRaWAN", tone: "violet" },
  ewelink: { label: "eWeLink LAN", tone: "teal" },
};
const PROTOCOL_ORDER = ["http", "mqtt", "bacnet", "lorawan", "ewelink"];

/** Orden fijo de las secciones del panel: primero lo mas numeroso/operativo, sensores y categorias raras al final. */
const SECTION_ORDER: DeviceKindId[] = ["light", "climate", "sensor", "plug", "water", "lock", "camera", "fan"];

function SectionHeader({
  kind,
  count,
  collapsed,
  onToggle,
}: {
  kind: DeviceKindMeta;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const Icon = kind.Icon;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="group mb-3 mt-8 flex w-full items-center gap-3 text-left first:mt-0"
    >
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${kind.accent.bgOn} ${kind.accent.text}`}>
        <Icon className="h-4 w-4" />
      </div>
      <h2 className="text-base font-semibold text-slate-100">{kind.label}</h2>
      <span className="text-xs text-slate-500">{count} dispositivo(s)</span>
      <div className="h-px flex-1 bg-slate-800" />
      <ChevronIcon
        className={`h-4 w-4 shrink-0 text-slate-500 transition-transform group-hover:text-slate-300 ${collapsed ? "-rotate-90" : ""}`}
      />
    </button>
  );
}

function DeviceRow({
  device,
  onToggle,
  onEdit,
  onDelete,
  onHide,
}: {
  device: Device;
  onToggle: (device: Device, next: boolean) => void;
  onEdit: (device: Device) => void;
  onDelete: (device: Device) => void;
  onHide: (device: Device) => void;
}) {
  const isSensor = device.kind === "sensor";
  const isOn = device.state?.state === "on";
  const kind = inferDeviceKind(device.name, device.kind);
  return (
    <div className="group flex items-center justify-between gap-3 border-b border-slate-800/70 py-2.5 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <DeviceIconBadge kind={kind} isOn={isOn} size="sm" />
        <span className="truncate text-sm text-slate-200">{device.name}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isSensor ? (
          <SensorReadingInline readings={device.state?.readings ?? null} />
        ) : (
          <ToggleSwitch checked={isOn} onChange={(next) => onToggle(device, next)} />
        )}
        <div className="flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
          <ActionButton onClick={() => onEdit(device)} title="Editar" tone="blue">
            <EditIcon className="h-5 w-5" />
          </ActionButton>
          <ActionButton onClick={() => onHide(device)} title="Ocultar del panel" tone="slate">
            <EyeOffIcon className="h-5 w-5" />
          </ActionButton>
          <ActionButton onClick={() => onDelete(device)} title="Eliminar" tone="red">
            <TrashIcon className="h-5 w-5" />
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

function GroupCard({
  id,
  title,
  kind,
  members,
  onToggle,
  onEdit,
  onDelete,
  onHide,
}: {
  id: string;
  title: string;
  kind: DeviceKindMeta;
  members: Device[];
  onToggle: (device: Device, next: boolean) => void;
  onEdit: (device: Device) => void;
  onDelete: (device: Device) => void;
  onHide: (device: Device) => void;
}) {
  const groupOn = members.some((m) => m.state?.state === "on");
  return (
    <div
      key={id}
      className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-sm transition-colors hover:border-slate-700"
    >
      <div className="mb-3 flex items-center gap-3">
        <DeviceIconBadge kind={kind} isOn={groupOn} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-medium text-slate-100">{title}</h2>
          <p className={`text-xs font-medium uppercase tracking-wide ${kind.accent.text}`}>
            {kind.label} &middot; {members.length} canales
          </p>
        </div>
        <span className="shrink-0 text-xs text-slate-500">{members[0].protocol.toUpperCase()}</span>
      </div>
      <div>
        {members.map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            onToggle={onToggle}
            onEdit={onEdit}
            onDelete={onDelete}
            onHide={onHide}
          />
        ))}
      </div>
    </div>
  );
}

function DeviceCard({
  device,
  kind,
  onToggle,
  onEdit,
  onDelete,
  onHide,
  onOpenClimate,
}: {
  device: Device;
  kind: DeviceKindMeta;
  onToggle: (device: Device, next: boolean) => void;
  onEdit: (device: Device) => void;
  onDelete: (device: Device) => void;
  onHide: (device: Device) => void;
  onOpenClimate: (device: Device) => void;
}) {
  const isSensor = device.kind === "sensor";
  const isClimate = device.kind === "climate";
  const isOn = device.state?.state === "on";
  const roomTemp = device.state?.readings?.roomTemp as number | undefined;
  const setRoomTemp = device.state?.readings?.setRoomTemp as number | undefined;
  return (
    <div className="group relative rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-sm transition-all hover:border-slate-700 hover:shadow-lg">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <DeviceIconBadge kind={kind} isOn={!isSensor && isOn} />
          <div className="min-w-0">
            <h2 className="truncate font-medium text-slate-100">{device.name}</h2>
            <p className={`text-xs font-medium uppercase tracking-wide ${kind.accent.text}`}>{kind.label}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isSensor && !isClimate && <ToggleSwitch checked={isOn} onChange={(next) => onToggle(device, next)} />}
          {isClimate && (
            <button
              onClick={() => onOpenClimate(device)}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
            >
              Controlar
            </button>
          )}
          <span className="hidden items-center gap-1 group-hover:flex">
            <ActionButton onClick={() => onEdit(device)} title="Editar" tone="blue">
              <EditIcon className="h-4 w-4" />
            </ActionButton>
            <ActionButton onClick={() => onHide(device)} title="Ocultar del panel" tone="slate">
              <EyeOffIcon className="h-4 w-4" />
            </ActionButton>
            <ActionButton onClick={() => onDelete(device)} title="Eliminar" tone="red">
              <TrashIcon className="h-4 w-4" />
            </ActionButton>
          </span>
        </div>
      </div>

      {isSensor ? (
        <SensorReadingPanel
          readings={device.state?.readings ?? null}
          updatedAt={device.state?.updatedAt}
          deviceId={device.id}
          deviceName={device.name}
        />
      ) : isClimate ? (
        <button
          onClick={() => onOpenClimate(device)}
          className="flex w-full items-center justify-between border-t border-slate-800/70 pt-3 text-left text-xs text-slate-500 hover:text-slate-300"
        >
          <span className="flex items-center gap-1.5">
            <StatusDot isOn={isOn} />
            {isOn ? "Encendido" : "Apagado"}
            {device.state?.readings?.mode ? ` · ${device.state.readings.mode}` : ""}
          </span>
          <span className="text-sm font-semibold text-slate-200">
            {roomTemp !== undefined ? `${roomTemp}°C` : "--"}
            {setRoomTemp !== undefined && <span className="ml-1 text-slate-500">→ {setRoomTemp}°C</span>}
          </span>
        </button>
      ) : (
        <div className="flex items-center justify-between border-t border-slate-800/70 pt-3 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <StatusDot isOn={isOn} />
            {isOn ? "Encendido" : "Apagado"}
          </span>
          <span>
            {device.protocol.toUpperCase()} &middot;{" "}
            {device.state?.updatedAt ? new Date(device.state.updatedAt).toLocaleTimeString() : "sin datos"}
          </span>
        </div>
      )}
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="mb-4 h-4 w-1/3 rounded bg-slate-800" />
      <div className="mb-2.5 h-4 rounded bg-slate-800/70" />
      <div className="h-4 w-2/3 rounded bg-slate-800/70" />
    </div>
  );
}

export default function Devices() {
  const navigate = useNavigate();
  const { data: devices, isLoading, isError } = useDevices();
  const sendCommand = useSendDeviceCommand();
  const deleteDevice = useDeleteDevice();
  const setHidden = useSetDeviceHidden();
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showImportMqtt, setShowImportMqtt] = useState(false);
  const [showImportBacnet, setShowImportBacnet] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [climateDeviceId, setClimateDeviceId] = useState<string | null>(null);
  const climateDevice = devices?.find((d) => d.id === climateDeviceId) ?? null;
  const [search, setSearch] = useState("");
  const [showHiddenPanel, setShowHiddenPanel] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<DeviceKindId>>(new Set());
  const [view, setView] = useState<"classic" | "building" | "automations">("classic");
  const { toasts, push } = useToasts();

  useDeviceSocket();

  const { groups, singles, hidden, stats, protocols, sections } = useMemo(() => {
    const query = search.trim().toLowerCase();
    const groupsMap = new Map<string, Device[]>();
    const singles: Device[] = [];
    const hidden: Device[] = [];
    const protocolCounts = new Map<string, number>();
    let on = 0;
    let off = 0;
    let sensors = 0;

    for (const device of devices ?? []) {
      if (device.metadata?.hidden) {
        hidden.push(device);
        continue;
      }
      if (device.kind === "sensor") sensors += 1;
      else if (device.state?.state === "on") on += 1;
      else if (device.state?.state === "off") off += 1;
      protocolCounts.set(device.protocol, (protocolCounts.get(device.protocol) ?? 0) + 1);

      if (query && !device.name.toLowerCase().includes(query)) continue;

      const key = device.metadata?.group?.key;
      if (key) {
        if (!groupsMap.has(key)) groupsMap.set(key, []);
        groupsMap.get(key)!.push(device);
      } else {
        singles.push(device);
      }
    }

    // Orden alfabetico (por el titulo visible de cada tarjeta) en vez del orden de llegada de la API,
    // que es lo que hacia que el panel se viera "todo general" sin ningun criterio.
    const groupTitle = (members: Device[]) => (members[0].metadata?.group?.label || members[0].name).toLowerCase();
    const groups = [...groupsMap.entries()].sort((a, b) => groupTitle(a[1]).localeCompare(groupTitle(b[1]), "es"));
    singles.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "es"));

    const protocols = PROTOCOL_ORDER.filter((key) => protocolCounts.get(key)).map((key) => ({
      key,
      count: protocolCounts.get(key)!,
      ...PROTOCOL_META[key],
    }));

    // Divide el panel en secciones por tipo (Iluminacion, Climatizacion, Sensores, ...) en vez de una
    // sola grilla plana: cada tarjeta de grupo o suelta se clasifica con la misma inferDeviceKind que ya
    // decide su icono/color, y dentro de cada seccion queda ordenada alfabeticamente.
    type SectionItem =
      | { type: "group"; key: string; title: string; kind: DeviceKindMeta; members: Device[] }
      | { type: "single"; device: Device; kind: DeviceKindMeta };

    const bySection = new Map<DeviceKindId, SectionItem[]>();
    const pushItem = (kindId: DeviceKindId, item: SectionItem) => {
      if (!bySection.has(kindId)) bySection.set(kindId, []);
      bySection.get(kindId)!.push(item);
    };

    for (const [key, members] of groups) {
      const title = members[0].metadata?.group?.label || members[0].name;
      const kind = inferDeviceKind(title, members[0].kind);
      pushItem(kind.id, { type: "group", key, title, kind, members });
    }
    for (const device of singles) {
      const kind = inferDeviceKind(device.name, device.kind);
      pushItem(kind.id, { type: "single", device, kind });
    }

    const itemTitle = (item: SectionItem) => (item.type === "group" ? item.title : item.device.name).toLowerCase();
    const itemDeviceCount = (item: SectionItem) => (item.type === "group" ? item.members.length : 1);

    const sections = SECTION_ORDER.filter((id) => bySection.has(id)).map((id) => {
      const items = bySection.get(id)!.sort((a, b) => itemTitle(a).localeCompare(itemTitle(b), "es"));
      return {
        kind: items[0].kind,
        items,
        deviceCount: items.reduce((sum, item) => sum + itemDeviceCount(item), 0),
      };
    });

    return { groups, singles, hidden, stats: { total: on + off + sensors, on, off, sensors }, protocols, sections };
  }, [devices, search]);

  function handleLogout() {
    clear();
    navigate("/login");
  }

  function handleDelete(device: Device) {
    if (confirm(`Eliminar el dispositivo "${device.name}"? Esta accion no se puede deshacer.`)) {
      deleteDevice.mutate(device.id);
    }
  }

  function handleToggle(device: Device, next: boolean) {
    sendCommand.mutate(
      { deviceId: device.id, action: next ? "on" : "off" },
      { onError: () => push(`No se pudo enviar el comando a "${device.name}"`, "error") },
    );
  }

  function handleEdit(device: Device) {
    setShowForm(false);
    setShowImport(false);
    setShowImportMqtt(false);
    setShowImportBacnet(false);
    setEditingDevice(device);
  }

  function handleOpenClimate(device: Device) {
    setClimateDeviceId(device.id);
  }

  function handleHide(device: Device) {
    setHidden.mutate(
      { id: device.id, hidden: true },
      { onSuccess: () => push(`"${device.name}" se oculto del panel`, "success") },
    );
  }

  function handleUnhide(device: Device) {
    setHidden.mutate({ id: device.id, hidden: false });
  }

  function toggleSection(kindId: DeviceKindId) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(kindId)) next.delete(kindId);
      else next.add(kindId);
      return next;
    });
  }

  const formOpen = showForm || editingDevice !== null;
  const totalVisible = groups.length + singles.length;
  const isEmpty = !isLoading && !isError && totalVisible === 0 && hidden.length === 0;
  const noResults = !isLoading && !isError && totalVisible === 0 && hidden.length > 0 && !showHiddenPanel;

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-400 to-blue-600 text-white">
              <ChipLogo className="h-5 w-5" />
            </div>
            <div className="min-w-0 leading-tight">
              <span className="block truncate font-semibold text-slate-100">{APP_NAME}</span>
              <span className="block text-[10px] uppercase tracking-wide text-slate-500">by SIASA</span>
            </div>
          </div>

          <div className="hidden items-center gap-2 rounded-full border border-slate-800 bg-slate-900/70 px-3 py-1.5 text-sm text-slate-300 md:flex">
            <BuildingIcon className="h-4 w-4 text-sky-400" />
            <span className="font-medium text-slate-100">{BUILDING_CONTEXT.building}</span>
            <span className="text-slate-600">&middot;</span>
            <span>{BUILDING_CONTEXT.level}</span>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <div className="hidden sm:block">
              <LiveClock />
            </div>
            <span className="hidden text-sm text-slate-400 lg:inline">
              {user?.username} &middot; <span className="text-slate-500">{user?.role}</span>
            </span>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            >
              <LogoutIcon className="h-3.5 w-3.5" />
              Salir
            </button>
            <GlobalActivityIndicator />
          </div>
        </div>
      </header>

      <main className={`mx-auto p-6 transition-[max-width] duration-300 ${view === "building" ? "max-w-[1920px]" : "max-w-6xl"}`}>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-sky-400">
              <BuildingIcon className="h-3.5 w-3.5" />
              Edificio {BUILDING_CONTEXT.building}
              {view === "building" ? " · Vista de edificio" : ` · ${BUILDING_CONTEXT.level}`}
            </p>
            <h1 className="text-xl font-semibold text-slate-50">Panel de dispositivos</h1>
            {view === "classic" && (
              <p className="text-sm text-slate-500">
                {totalVisible} visible(s){hidden.length > 0 ? ` · ${hidden.length} oculto(s)` : ""}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
              <button
                onClick={() => setView("classic")}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  view === "classic" ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Vista Operativa
              </button>
              <button
                onClick={() => setView("building")}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  view === "building" ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Vista de Edificio
              </button>
              <button
                onClick={() => setView("automations")}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  view === "automations" ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Gestión Inteligente
              </button>
            </div>
          </div>
        </div>

        {view === "automations" && <Automations />}

        {view === "classic" && (
        <>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setShowImport(false);
                setShowImportMqtt(false);
                setShowImportBacnet(false);
                setEditingDevice(null);
                setShowForm((v) => !v);
              }}
              className="flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Agregar
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setShowImportMqtt(false);
                setShowImportBacnet(false);
                setEditingDevice(null);
                setShowImport((v) => !v);
              }}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
            >
              <ImportIcon className="h-3.5 w-3.5" />
              Con Home Assistant
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setShowImport(false);
                setShowImportBacnet(false);
                setEditingDevice(null);
                setShowImportMqtt((v) => !v);
              }}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
            >
              <ImportIcon className="h-3.5 w-3.5" />
              Sin Home Assistant (MQTT directo)
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setShowImport(false);
                setShowImportMqtt(false);
                setEditingDevice(null);
                setShowImportBacnet((v) => !v);
              }}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
            >
              <ImportIcon className="h-3.5 w-3.5" />
              Aires acondicionados (BACnet)
            </button>
          </div>
        </div>

        {!isLoading && !isError && stats.total > 0 && (
          <div className={`mb-3 grid gap-3 ${stats.sensors > 0 ? "grid-cols-4 sm:max-w-lg" : "grid-cols-3 sm:max-w-md"}`}>
            <StatTile label="Dispositivos" value={stats.total} tone="slate" />
            <StatTile label="Encendidos" value={stats.on} tone="emerald" />
            <StatTile label="Apagados" value={stats.off} tone="sky" />
            {stats.sensors > 0 && <StatTile label="Sensores" value={stats.sensors} tone="sky" />}
          </div>
        )}

        {!isLoading && !isError && protocols.length > 0 && (
          <div className="mb-6">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-600">Por protocolo</p>
            <div className="grid grid-cols-2 gap-3 sm:max-w-lg sm:grid-cols-3 md:grid-cols-5">
              {protocols.map((p) => (
                <StatTile key={p.key} label={p.label} value={p.count} tone={p.tone} />
              ))}
            </div>
          </div>
        )}

        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div className="relative max-w-xs flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar dispositivo..."
              className="w-full rounded-lg border border-slate-800 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-200 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
            />
          </div>
          {hidden.length > 0 && (
            <button
              onClick={() => setShowHiddenPanel((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
            >
              <EyeOffIcon className="h-4 w-4" />
              {showHiddenPanel ? "Ocultar panel de ocultos" : `Ver ocultos (${hidden.length})`}
            </button>
          )}
        </div>

        {showHiddenPanel && hidden.length > 0 && (
          <div className="mb-6 rounded-xl border border-dashed border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
              Ocultos del panel principal
            </p>
            {hidden.map((device) => (
              <div key={device.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <span className="text-slate-400">{device.name}</span>
                <ActionButton onClick={() => handleUnhide(device)} title="Mostrar de nuevo" tone="blue">
                  <EyeIcon className="h-5 w-5" />
                </ActionButton>
              </div>
            ))}
          </div>
        )}

        {showImport && <ImportHomeAssistant onDone={() => setShowImport(false)} />}
        {showImportMqtt && <ImportMqtt onDone={() => setShowImportMqtt(false)} />}
        {showImportBacnet && <ImportBacnet onDone={() => setShowImportBacnet(false)} />}

        {formOpen && (
          <AddDeviceForm
            key={editingDevice?.id ?? "new"}
            device={editingDevice ?? undefined}
            onDone={() => {
              setShowForm(false);
              setEditingDevice(null);
            }}
          />
        )}

        {isError && (
          <p className="mb-4 rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-400">
            No se pudieron cargar los dispositivos.
          </p>
        )}

        {isEmpty && (
          <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-slate-500">
            Aun no tienes dispositivos. Agrega uno manualmente o importa desde Home Assistant.
          </div>
        )}

        {noResults && (
          <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-slate-500">
            Sin resultados para &quot;{search}&quot;.
          </div>
        )}

        {isLoading && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </div>
        )}

        {sections.map((section) => {
          const isCollapsed = collapsedSections.has(section.kind.id);
          return (
            <div key={section.kind.id}>
              <SectionHeader
                kind={section.kind}
                count={section.deviceCount}
                collapsed={isCollapsed}
                onToggle={() => toggleSection(section.kind.id)}
              />
              {!isCollapsed && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {section.items.map((item) =>
                    item.type === "group" ? (
                      <GroupCard
                        key={item.key}
                        id={item.key}
                        title={item.title}
                        kind={item.kind}
                        members={item.members}
                        onToggle={handleToggle}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        onHide={handleHide}
                      />
                    ) : (
                      <DeviceCard
                        key={item.device.id}
                        device={item.device}
                        kind={item.kind}
                        onToggle={handleToggle}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        onHide={handleHide}
                        onOpenClimate={handleOpenClimate}
                      />
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
        </>
        )}

        {view === "building" && <BuildingView />}
      </main>

      {climateDevice && <ClimateControlPanel device={climateDevice} onClose={() => setClimateDeviceId(null)} />}

      <ToastContainer toasts={toasts} />
    </div>
  );
}
