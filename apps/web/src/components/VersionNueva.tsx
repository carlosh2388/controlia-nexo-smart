import { useEffect, useState } from "react";

const ARCHIVO = /assets\/index-[\w-]+\.js/;

/** Avisa cuando se publico otra version y esta pestaña quedo con la anterior. */
export default function VersionNueva() {
  const [hay, setHay] = useState(false);
  useEffect(() => {
    const actual = [...document.scripts].map((s) => ARCHIVO.exec(s.src)?.[0]).find(Boolean);
    if (!actual) return;
    const revisar = async () => {
      if (document.hidden) return;
      try {
        const html = await (await fetch(`${import.meta.env.BASE_URL}index.html`, { cache: "no-store" })).text();
        const publicado = ARCHIVO.exec(html)?.[0];
        if (publicado) setHay(publicado !== actual);
      } catch {
        /* sin red: se revisa en la proxima vuelta */
      }
    };
    void revisar();
    const t = setInterval(() => void revisar(), 120_000);
    document.addEventListener("visibilitychange", revisar);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", revisar);
    };
  }, []);
  if (!hay) return null;
  return (
    <div role="status" className="fixed left-1/2 top-3 z-[200] flex -translate-x-1/2 items-center gap-3 rounded-xl border border-sky-500 bg-slate-900 px-4 py-2 text-sm text-slate-100 shadow-xl">
      <span>Hay una versión nueva de Nodivo.</span>
      <button type="button" onClick={() => window.location.reload()} className="min-h-[44px] rounded-lg bg-sky-600 px-3 font-semibold hover:bg-sky-500">Actualizar</button>
    </div>
  );
}
