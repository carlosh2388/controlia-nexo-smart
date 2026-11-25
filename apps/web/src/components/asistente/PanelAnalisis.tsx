import { useEffect } from "react";
import type { Analisis, Informe } from "./ingeniero";

/** Respuesta de Gravix con orden fijo: conclusion, puntos, fuente y siguientes pasos. */
export function RespuestaAnalisis({ a, onFrase }: { a: Analisis; onFrase: (f: string) => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      <strong className="text-[14px] leading-snug text-slate-50">{a.titulo}</strong>
      {a.puntos.map((p) => (
        <div key={p.k} className="flex flex-col gap-0.5">
          <span className="text-[11px] font-bold text-sky-300">{p.k}</span>
          <span className="text-[13px] leading-relaxed text-slate-200">{p.v}</span>
        </div>
      ))}
      <span className="border-t border-slate-700/70 pt-2 text-[11px] leading-snug text-slate-400">Fuente: {a.fuente}.</span>
      {a.sigue.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {a.sigue.map((s) => (
            <button key={s} type="button" onClick={() => onFrase(s)} className="min-h-[34px] rounded-lg border border-sky-800 px-2.5 text-left text-[12px] font-semibold text-sky-200 hover:bg-sky-950">{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Pasos reales de la consulta en curso. */
export function PasosAnalisis({ pasos }: { pasos: string[] }) {
  return (
    <ul className="gx-msg gx-el m-0 flex list-none flex-col gap-2" aria-label="Analizando">
      {pasos.map((p, i) => (
        <li key={`${i}-${p}`} className="flex items-center gap-2">
          {i < pasos.length - 1 ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="3" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
          ) : (
            <svg className="gx-gira" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7cc4ff" strokeWidth="3" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
          )}
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}

const TONO = { ok: "text-emerald-300", adv: "text-amber-300", crit: "text-rose-300", info: "text-sky-300" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function imprimir(i: Informe) {
  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) return;
  w.document.write(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe del turno</title><style>body{font:14px/1.5 Arial,sans-serif;margin:32px;color:#111}h1{margin:0 0 4px}h2{font-size:16px;margin:20px 0 6px;border-bottom:1px solid #999}.r{display:flex;gap:28px;margin:16px 0}.r b{font-size:22px;display:block}ul{margin:0;padding-left:20px}</style></head><body><h1>Informe del turno</h1><div>Energía IGSS · ${esc(i.generado)}</div><div class="r">${i.resumen.map((r) => `<div>${esc(r.k)}<b>${esc(r.v)}</b></div>`).join("")}</div>${i.secciones.map((s) => `<h2>${esc(s.titulo)}</h2><ul>${s.filas.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`).join("")}</body></html>`,
  );
  w.document.close();
  w.focus();
  w.print();
}

export function InformeTurno({ informe, onEscuchar, onCerrar }: { informe: Informe; onEscuchar: () => void; onCerrar: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onCerrar]);
  return (
    <div className="cm-modal" role="presentation" onClick={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="caja cm !max-w-[900px]" role="dialog" aria-label="Informe del turno">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-5 py-4">
          <div className="min-w-[200px] flex-1">
            <strong className="block text-lg text-slate-50">Informe del turno</strong>
            <span className="text-xs text-slate-400">{informe.generado}</span>
          </div>
          <button type="button" onClick={onEscuchar} className="min-h-[40px] rounded-lg bg-sky-600 px-4 text-sm font-bold text-white hover:bg-sky-500">Escuchar</button>
          <button type="button" onClick={() => imprimir(informe)} className="min-h-[40px] rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-100 hover:bg-slate-800">Imprimir o PDF</button>
          <button type="button" onClick={onCerrar} aria-label="Cerrar el informe" className="grid h-10 w-10 place-items-center rounded-lg text-slate-300 hover:bg-slate-800">✕</button>
        </div>
        <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
          {informe.resumen.map((r) => (
            <div key={r.k} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
              <span className="text-xs text-slate-400">{r.k}</span>
              <b className={`mono block text-2xl ${TONO[r.tono]}`}>{r.v}</b>
            </div>
          ))}
        </div>
        <div className="grid gap-x-8 gap-y-5 px-5 pb-6 md:grid-cols-2">
          {informe.secciones.map((s) => (
            <section key={s.titulo}>
              <b className="text-[13px] text-sky-300">{s.titulo}</b>
              <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed text-slate-200">
                {s.filas.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
