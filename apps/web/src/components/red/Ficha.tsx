/**
 * Ficha del dispositivo: los mismos campos (y nombres) que la respuesta v1 de Telemetría 1 (api-SIASA).
 * Se guarda en los atributos del equipo en la configuración del Agente Go, así que viaja con cada lectura
 * y la API la devuelve tal cual en GET /red/sedes/:id/telemetria. También se escriben los atributos que
 * ya usaban los equipos de Escuintla (code, phase, capacityKva) para no romper lo existente.
 */
export interface Ficha {
  device_id: string;
  area: string;
  building: string;
  floor: string;
  group: string;
  room: string;
  fase_energy: string;
  code_inventory: string;
  capacity: string;
}

export const FASES = ["Trifásica", "Bifásica", "Monofásica"] as const;
export const GRUPO_DEFECTO = "Disponibilidad y Calidad de Energía";

const s = (v: unknown) => (v == null ? "" : String(v));

export function fichaVacia(): Ficha {
  return { device_id: "", area: "", building: "", floor: "", group: GRUPO_DEFECTO, room: "", fase_energy: "Trifásica", code_inventory: "", capacity: "" };
}

/** Lee la ficha de los atributos de un equipo (con los nombres anteriores como respaldo). */
export function fichaDeAtributos(a: Record<string, unknown> | undefined | null): Ficha {
  const x = a ?? {};
  return {
    device_id: s(x.device_id),
    area: s(x.area),
    building: s(x.building),
    floor: s(x.floor),
    group: s(x.group) || GRUPO_DEFECTO,
    room: s(x.room),
    fase_energy: s(x.fase_energy ?? x.phase) || "Trifásica",
    code_inventory: s(x.code_inventory ?? x.code),
    capacity: s(x.capacity ?? x.capacityKva),
  };
}

/** Atributos a guardar: los de la ficha + los nombres que ya usaba la web (code, phase, capacityKva). */
export function atributosDeFicha(f: Ficha, prev: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev };
  (Object.keys(f) as (keyof Ficha)[]).forEach((k) => {
    const v = f[k].trim();
    if (v) out[k] = k === "capacity" && Number.isFinite(Number(v)) ? Number(v) : v;
    else delete out[k];
  });
  if (f.code_inventory.trim()) out.code = f.code_inventory.trim(); else delete out.code;
  if (f.fase_energy.trim()) out.phase = f.fase_energy.trim();
  if (f.capacity.trim() && Number.isFinite(Number(f.capacity))) out.capacityKva = Number(f.capacity); else delete out.capacityKva;
  return out;
}

/** device_id sugerido con la convención de Telemetría 1: pm_2130_1, ion_7400_2, generador_1... */
export function sugerirDeviceId(model: string, usados: string[]): string {
  const base = /7400|ION/i.test(model) ? "ion_7400" : /2130|PM/i.test(model) ? "pm_2130" : /gen/i.test(model) ? "generador" : "equipo";
  let n = 1;
  while (usados.includes(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** Fase sugerida por lo que vio el agente (fase C sin dato = monofásico). */
export function faseSugerida(evidencia: string | undefined): string {
  return /monof/i.test(evidencia ?? "") ? "Monofásica" : "Trifásica";
}

const campo = "min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none";

function Campo({ label, clave, children }: { label: string; clave: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-slate-400">
      <span className="flex items-baseline justify-between gap-2">{label}<span className="mono text-[10px] text-slate-600">{clave}</span></span>
      {children}
    </label>
  );
}

/** Campos de la ficha. `disabled` para quien solo puede ver. */
export function FichaCampos({ valor, onChange, disabled = false }: { valor: Ficha; onChange: (f: Ficha) => void; disabled?: boolean }) {
  const set = (k: keyof Ficha) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...valor, [k]: e.target.value });
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        <Campo label="Código del dispositivo" clave="device_id"><input className={`${campo} mono`} value={valor.device_id} onChange={set("device_id")} disabled={disabled} placeholder="pm_2130_1" /></Campo>
        <Campo label="Código de inventario" clave="code_inventory"><input className={`${campo} mono`} value={valor.code_inventory} onChange={set("code_inventory")} disabled={disabled} placeholder="HES111" /></Campo>
        <Campo label="Capacidad (kVA)" clave="capacity"><input className={campo} value={valor.capacity} onChange={set("capacity")} disabled={disabled} inputMode="decimal" placeholder="opcional" /></Campo>
      </div>
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(130px,1fr))]">
        <Campo label="Área" clave="area"><input className={campo} value={valor.area} onChange={set("area")} disabled={disabled} placeholder="Emergencia" /></Campo>
        <Campo label="Edificio" clave="building"><input className={campo} value={valor.building} onChange={set("building")} disabled={disabled} placeholder="Principal" /></Campo>
        <Campo label="Nivel" clave="floor"><input className={campo} value={valor.floor} onChange={set("floor")} disabled={disabled} placeholder="1" /></Campo>
        <Campo label="Ambiente" clave="room"><input className={campo} value={valor.room} onChange={set("room")} disabled={disabled} placeholder="Pasillo principal" /></Campo>
      </div>
      <Campo label="Grupo" clave="group"><input className={campo} value={valor.group} onChange={set("group")} disabled={disabled} /></Campo>
      <div className="flex flex-col gap-1 text-xs text-slate-400">
        <span className="flex items-baseline justify-between gap-2">Tipo de conexión<span className="mono text-[10px] text-slate-600">fase_energy</span></span>
        <div role="group" aria-label="Tipo de conexión" className="flex w-fit flex-wrap gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
          {FASES.map((f) => (
            <button key={f} type="button" disabled={disabled} aria-pressed={valor.fase_energy === f} onClick={() => onChange({ ...valor, fase_energy: f })} className={`min-h-[32px] rounded-md px-3 text-[13px] font-semibold ${valor.fase_energy === f ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"} disabled:opacity-50`}>{f}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Vista previa del equipo en el formato v1 de Telemetría 1. */
export function fichaJsonV1(nombre: string, model: string, f: Ficha) {
  const tipo = /7400|ION/i.test(model) ? "ion" : /2130|PM/i.test(model) ? "pm" : /gen/i.test(model) ? "generator" : "unknown";
  const o: Record<string, unknown> = {
    device_id: f.device_id || "(se asigna al guardar)",
    name: nombre,
    type: tipo,
    model: tipo === "ion" ? "7400" : tipo === "pm" ? "2130" : model,
    online: "true",
  };
  (["area", "building", "floor", "group", "room", "fase_energy", "code_inventory"] as const).forEach((k) => { if (f[k]) o[k] = f[k]; });
  if (f.capacity) o.capacity = Number(f.capacity) || f.capacity;
  o.metrics = "{ … las del equipo en cada lectura … }";
  return JSON.stringify(o, null, 2);
}
