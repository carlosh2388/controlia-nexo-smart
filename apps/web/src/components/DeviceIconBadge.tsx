import type { DeviceKindMeta } from "../utils/deviceKind";

export default function DeviceIconBadge({
  kind,
  isOn,
  size = "md",
}: {
  kind: DeviceKindMeta;
  isOn: boolean;
  size?: "md" | "sm";
}) {
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
