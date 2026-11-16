import { useId, useState, type ReactNode } from "react";
import { SECRET_MASK } from "../../api/agents";
import { describeTarget, isValidIp } from "../../utils/agentConfig";
import ToggleSwitch from "../ToggleSwitch";

export const inputClass =
  "w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:opacity-50";

export type Tone = "amber" | "orange" | "violet" | "emerald" | "teal";

export const TONES: Record<Tone, { text: string; bg: string; chip: string; bar: string }> = {
  amber: { text: "text-amber-300", bg: "bg-amber-500/15", chip: "border-amber-500/30 bg-amber-500/10 text-amber-200", bar: "bg-amber-400" },
  orange: { text: "text-orange-300", bg: "bg-orange-500/15", chip: "border-orange-500/30 bg-orange-500/10 text-orange-200", bar: "bg-orange-400" },
  violet: { text: "text-violet-300", bg: "bg-violet-500/15", chip: "border-violet-500/30 bg-violet-500/10 text-violet-200", bar: "bg-violet-400" },
  emerald: { text: "text-emerald-300", bg: "bg-emerald-500/15", chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200", bar: "bg-emerald-400" },
  teal: { text: "text-teal-300", bg: "bg-teal-500/15", chip: "border-teal-500/30 bg-teal-500/10 text-teal-200", bar: "bg-teal-400" },
};

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-400">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p className="mt-1 text-[11px] text-rose-300">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[11px] text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  disabled,
  validate,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  disabled?: boolean;
  validate?: (v: string) => string | undefined;
}) {
  const error = value && validate ? validate(value) : undefined;
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        <input id={id} className={inputClass} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

export function IpField(props: Omit<Parameters<typeof TextField>[0], "validate">) {
  return <TextField {...props} validate={(v) => (isValidIp(v) ? undefined : "Escribe una IP como 10.0.6.26")} />;
}

/** Numero entero con limites; se guarda solo si es valido, mientras tanto muestra lo que se escribe. */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
  disabled,
  defaultValue,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number) => void;
  min: number;
  max: number;
  hint?: ReactNode;
  disabled?: boolean;
  /** Si se indica y el valor es distinto, aparece "volver a X". */
  defaultValue?: number;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value === undefined ? "" : String(value));
  const n = Number(shown);
  const invalid = shown !== "" && (!Number.isInteger(n) || n < min || n > max);
  const nonDefault = defaultValue !== undefined && value !== undefined && value !== defaultValue;
  return (
    <Field
      label={label}
      error={invalid ? `Debe ser un numero entre ${min} y ${max}` : undefined}
      hint={
        nonDefault ? (
          <span className="text-amber-300">
            No estandar ·{" "}
            <button type="button" className="underline" onClick={() => { setText(null); onChange(defaultValue!); }} disabled={disabled}>
              volver a {defaultValue}
            </button>
          </span>
        ) : (
          hint
        )
      }
    >
      {(id) => (
        <input
          id={id}
          inputMode="numeric"
          className={`${inputClass} tabular-nums`}
          value={shown}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value !== "" && Number.isInteger(v) && v >= min && v <= max) onChange(v);
          }}
          onBlur={() => setText(null)}
        />
      )}
    </Field>
  );
}

/** Contraseña o token: la API la manda enmascarada; si no se toca, se conserva la guardada. */
export function SecretField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const masked = value === SECRET_MASK;
  return (
    <Field label={label} hint={masked ? "Guardada · escribe para reemplazarla" : undefined}>
      {(id) => (
        <input
          id={id}
          type="password"
          autoComplete="new-password"
          className={inputClass}
          value={value}
          disabled={disabled}
          onFocus={(e) => masked && e.target.select()}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** Lista de IP, rangos y redes como chips. Enter o coma agrega; se valida igual que en el agente. */
export function TargetsInput({
  label,
  targets,
  onChange,
  tone,
  disabled,
  placeholder = "10.0.6.26, 10.0.6.1-50 o 10.0.6.0/24 + Enter",
  hint,
}: {
  label: string;
  targets: string[];
  onChange: (next: string[]) => void;
  tone: Tone;
  disabled?: boolean;
  placeholder?: string;
  hint?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();

  function commit() {
    const values = text.split(/[,\s]+/).filter(Boolean);
    if (!values.length) return;
    const bad = values.find((v) => !describeTarget(v));
    if (bad) {
      setError(`"${bad}" no es valido. Escribe una IP (10.0.6.26), un rango (10.0.6.1-50) o una red (10.0.6.0/24).`);
      return;
    }
    setError(undefined);
    setText("");
    onChange([...targets, ...values.filter((v) => !targets.includes(v))]);
  }

  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        <div className={`flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 p-1.5 ${disabled ? "opacity-50" : ""}`}>
          {targets.map((t) => {
            const info = describeTarget(t);
            return (
              <span key={t} className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${TONES[tone].chip}`}>
                <span className="tabular-nums">{t}</span>
                <span className="text-[10px] opacity-60">
                  {info?.kind}
                  {info && info.hosts > 1 ? ` · ${info.hosts}` : ""}
                </span>
                <button
                  type="button"
                  aria-label={`Quitar ${t}`}
                  disabled={disabled}
                  className="ml-0.5 opacity-60 hover:opacity-100"
                  onClick={() => onChange(targets.filter((x) => x !== t))}
                >
                  ×
                </button>
              </span>
            );
          })}
          <input
            id={id}
            value={text}
            disabled={disabled}
            placeholder={targets.length ? "" : placeholder}
            className="min-w-[160px] flex-1 bg-transparent px-1.5 py-1 text-sm text-slate-100 outline-none placeholder:text-slate-600"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commit();
              }
            }}
            onBlur={commit}
          />
        </div>
      )}
    </Field>
  );
}

/** Encabezado comun de cada tarjeta de protocolo. */
export function ProtocolCard({
  title,
  description,
  badge,
  tone,
  enabled,
  onToggle,
  mode,
  disabled,
  children,
}: {
  title: string;
  description: string;
  badge: string;
  tone: Tone;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  /** "consulta": el agente se conecta a los equipos. "escucha": los equipos le envian al agente. */
  mode: "consulta" | "escucha";
  disabled?: boolean;
  children: ReactNode;
}) {
  const t = TONES[tone];
  return (
    <article className={`rounded-2xl border p-5 transition-colors ${enabled ? "border-slate-800 bg-slate-900/80" : "border-slate-800/60 bg-slate-900/40"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[11px] font-bold ${t.bg} ${t.text}`}>{badge}</div>
          <div className="min-w-0">
            <h3 className={`font-medium ${enabled ? "text-slate-100" : "text-slate-400"}`}>{title}</h3>
            <p className="text-xs text-slate-500">{description}</p>
          </div>
        </div>
        <ToggleSwitch checked={enabled} onChange={onToggle} disabled={disabled} />
      </div>
      <div className={`mt-4 space-y-4 ${enabled ? "" : "opacity-50"}`}>
        <span
          className={`inline-block rounded-full border px-2.5 py-0.5 text-xs ${
            mode === "escucha" ? "border-violet-500/40 text-violet-300" : "border-sky-500/40 text-sky-300"
          }`}
        >
          {mode === "escucha" ? "El agente escucha · los equipos le envían" : "El agente consulta a los equipos"}
        </span>
        {children}
      </div>
    </article>
  );
}
