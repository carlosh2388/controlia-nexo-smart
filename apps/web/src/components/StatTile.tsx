export type StatTone = "sky" | "emerald" | "slate" | "amber" | "violet" | "teal";

export function StatTile({ label, value, tone }: { label: string; value: number; tone: StatTone }) {
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
