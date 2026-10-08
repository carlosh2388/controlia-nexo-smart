import type { DeviceKindMeta } from "../utils/deviceKind";
import { ChevronIcon } from "./icons";

export default function SectionHeader({
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
