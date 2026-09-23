import { FormEvent, useState } from "react";
import { useDiscoverBacnet, useImportBacnet, type DiscoveredBacnetUnit } from "../api/devices";
import { extractErrorMessage } from "../api/errors";
import ThinkingIndicator from "../components/ThinkingIndicator";

const inputClass = "w-full rounded-md bg-slate-800 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500";
const labelClass = "mb-1 block text-xs text-slate-400";

/** Descubre e importa unidades de aire acondicionado desde un gateway BACnet/IP (ej. "AC Smart 5" VRF). */
export default function ImportBacnet({ onDone }: { onDone: () => void }) {
  const discover = useDiscoverBacnet();
  const importUnits = useImportBacnet();

  const [host, setHost] = useState("10.3.0.11");
  const [units, setUnits] = useState<DiscoveredBacnetUnit[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; failed: number } | null>(null);

  async function handleDiscover(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    try {
      const found = await discover.mutateAsync({ host });
      setUnits(found);
      setNames(Object.fromEntries(found.map((u) => [u.unitKey, u.name])));
      setSelected(new Set());
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  function toggle(unitKey: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(unitKey)) next.delete(unitKey);
      else next.add(unitKey);
      return next;
    });
  }

  async function handleImport() {
    if (!units) return;
    setError(null);
    const toImport = [...selected].map((unitKey) => ({
      unitKey,
      name: names[unitKey]?.trim() || `AC ${unitKey.toUpperCase()}`,
    }));

    try {
      const res = await importUnits.mutateAsync({ host, units: toImport });
      setResult({ created: res.created.length, failed: res.failed.length });
      if (res.failed.length === 0) setTimeout(onDone, 1200);
    } catch (err) {
      setError(extractErrorMessage(err, "Fallo la importacion. Intenta de nuevo."));
    }
  }

  return (
    <div className="mb-6 rounded-xl bg-slate-900 p-5 shadow">
      <h2 className="mb-1 font-medium">Importar aires acondicionados por BACnet</h2>
      <p className="mb-4 text-xs text-slate-500">
        Se conecta al gateway BACnet/IP (ej. AC Smart 5) a traves del puente local (bacnet-bridge) y lista las
        unidades controlables. Solo lectura hasta que confirmes la importacion.
      </p>

      <form onSubmit={handleDiscover} className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass}>IP del gateway BACnet</label>
          <input className={inputClass} placeholder="10.3.0.11" value={host} onChange={(e) => setHost(e.target.value)} />
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={discover.isPending}
            className="flex items-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
          >
            {discover.isPending && <ThinkingIndicator size={16} />}
            {discover.isPending ? "Descubriendo... (puede tardar ~1 min)" : "Descubrir unidades"}
          </button>
        </div>
      </form>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {result && (
        <p className="mb-3 text-sm text-emerald-400">
          Importadas {result.created} unidad(es){result.failed > 0 ? `, ${result.failed} fallaron` : ""}.
        </p>
      )}

      {units && (
        <>
          <p className="mb-3 text-xs text-slate-400">
            {units.length} unidad(es) encontradas. Los valores de temperatura son la lectura en vivo ahora mismo:
            usalos para identificar cual sala es cual antes de nombrarlas.
          </p>

          <div className="mb-4 max-h-96 overflow-y-auto rounded-md border border-slate-800">
            {units.map((unit) => (
              <div
                key={unit.unitKey}
                className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-3 py-2.5 text-sm last:border-b-0 hover:bg-slate-800/50"
              >
                <input type="checkbox" checked={selected.has(unit.unitKey)} onChange={() => toggle(unit.unitKey)} />
                <span className="w-14 shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-center text-[10px] font-medium uppercase text-slate-400">
                  {unit.unitKey}
                </span>
                <input
                  className={`${inputClass} max-w-[220px]`}
                  value={names[unit.unitKey] ?? ""}
                  onChange={(e) => setNames((prev) => ({ ...prev, [unit.unitKey]: e.target.value }))}
                />
                <span className="ml-auto flex items-center gap-3 text-xs text-slate-400">
                  <span className={unit.sample.on ? "text-emerald-400" : "text-slate-500"}>
                    {unit.sample.on === null ? "?" : unit.sample.on ? "Encendido" : "Apagado"}
                  </span>
                  <span>
                    {unit.sample.roomTemp ?? "--"}&deg;C actual &middot; {unit.sample.setRoomTemp ?? "--"}&deg;C consigna
                  </span>
                </span>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={handleImport}
            disabled={selected.size === 0 || importUnits.isPending}
            className="flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {importUnits.isPending && <ThinkingIndicator size={16} />}
            {importUnits.isPending ? "Importando..." : `Importar seleccionadas (${selected.size})`}
          </button>
        </>
      )}

      <div className="mt-4">
        <button type="button" onClick={onDone} className="rounded-md bg-slate-800 px-4 py-2 text-sm hover:bg-slate-700">
          Cerrar
        </button>
      </div>
    </div>
  );
}
