import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../api/client";
import { extractErrorMessage } from "../../api/errors";

interface EquipoGestion {
  id: string;
  nombre: string;
  protocolo: "http" | "mqtt" | "lorawan" | "bacnet";
  tipo: string;
  area: string | null;
  nivel: string | null;
  gestor: "agente" | "api";
  estado: string | null;
  actualizado: string | null;
}

interface RespuestaGestion {
  agente: string;
  conectado: boolean;
  respaldo: boolean;
  ultimoContacto: string | null;
  equipos: EquipoGestion[];
}

const PROTO: Record<EquipoGestion["protocolo"], string> = {
  http: "Home Assistant",
  mqtt: "MQTT / Zigbee",
  lorawan: "LoRaWAN",
  bacnet: "Aires (BACnet)",
};

function hace(iso: string | null) {
  if (!iso) return "sin dato";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 172800) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} días`;
}

/**
 * Equipos > Equipos que maneja: que equipos de la API central (Home Assistant, MQTT, LoRaWAN,
 * aires BACnet) lee y controla este Agente Go en lugar de la API. Se pasan uno por uno y se
 * devuelven con un clic; si el agente se cae, la API los retoma sola hasta que vuelva.
 */
export default function GestionAgente({ bk, esAdmin }: { bk: string; esAdmin: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["agents", bk, "gestion"],
    queryFn: async () => (await apiClient.get<RespuestaGestion>(`/agents/${encodeURIComponent(bk)}/gestion`)).data,
    refetchInterval: 10_000,
  });
  const [proto, setProto] = useState<"todos" | EquipoGestion["protocolo"]>("todos");
  const [quien, setQuien] = useState<"todos" | "agente" | "api">("todos");
  const [texto, setTexto] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [aviso, setAviso] = useState<{ ok: boolean; msg: string } | null>(null);

  const asignar = useMutation({
    mutationFn: async ({ ids, gestor }: { ids: string[]; gestor: "agente" | "api" }) =>
      (await apiClient.put<{ cambiados: number }>(`/agents/${encodeURIComponent(bk)}/gestion`, { deviceIds: ids, gestor })).data,
    onSuccess: (r, v) => {
      setSel(new Set());
      setAviso({ ok: true, msg: `${r.cambiados} equipo(s) ahora los maneja ${v.gestor === "agente" ? `el agente ${bk}` : "la API central"}.` });
      void qc.invalidateQueries({ queryKey: ["agents", bk, "gestion"] });
    },
    onError: (e) => setAviso({ ok: false, msg: extractErrorMessage(e, "No se pudo cambiar quién maneja los equipos") }),
  });

  const equipos = q.data?.equipos ?? [];
  const lista = useMemo(() => {
    const t = texto.trim().toLowerCase();
    return equipos.filter(
      (e) =>
        (proto === "todos" || e.protocolo === proto) &&
        (quien === "todos" || e.gestor === quien) &&
        (!t || `${e.nombre} ${e.area ?? ""} ${e.nivel ?? ""}`.toLowerCase().includes(t)),
    );
  }, [equipos, proto, quien, texto]);

  const conteo = useMemo(() => {
    const c: Record<string, { agente: number; total: number }> = {};
    for (const e of equipos) {
      c[e.protocolo] ??= { agente: 0, total: 0 };
      c[e.protocolo].total += 1;
      if (e.gestor === "agente") c[e.protocolo].agente += 1;
    }
    return c;
  }, [equipos]);

  if (q.isLoading) return <p className="py-8 text-center text-sm text-slate-500">Cargando equipos…</p>;
  if (q.isError) return <p className="text-sm text-rose-300">{extractErrorMessage(q.error, "No se pudo cargar la lista de equipos")}</p>;
  const d = q.data!;
  const elegidos = lista.filter((e) => sel.has(e.id));
  const aAgente = elegidos.filter((e) => e.gestor === "api").map((e) => e.id);
  const aApi = elegidos.filter((e) => e.gestor === "agente").map((e) => e.id);
  const todosMarcados = lista.length > 0 && lista.every((e) => sel.has(e.id));

  const cambiar = (ids: string[], gestor: "agente" | "api") => {
    if (!ids.length) return;
    const txt =
      gestor === "agente"
        ? `¿Pasar ${ids.length} equipo(s) al agente ${bk}? El agente los va a leer y a ejecutar sus órdenes. Si el agente se cae, la API los retoma sola.`
        : `¿Devolver ${ids.length} equipo(s) a la API central? La API vuelve a leerlos y controlarlos como antes.`;
    if (window.confirm(txt)) asignar.mutate({ ids, gestor });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold ${
              d.respaldo ? "bg-amber-500/15 text-amber-200" : d.conectado ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${d.respaldo ? "bg-amber-400" : d.conectado ? "bg-emerald-400" : "bg-rose-400"}`} />
            {d.respaldo ? "Agente caído: la API maneja sus equipos en respaldo" : d.conectado ? "Agente conectado" : "Agente sin conexión"}
          </span>
          <span className="text-sm text-slate-400">Último contacto: {hace(d.ultimoContacto)}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(Object.keys(PROTO) as EquipoGestion["protocolo"][]).map((p) => (
            <div key={p} className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2">
              <div className="text-xs text-slate-500">{PROTO[p]}</div>
              <div className="text-base font-semibold text-slate-100">
                {conteo[p]?.agente ?? 0} <span className="text-sm font-normal text-slate-500">de {conteo[p]?.total ?? 0} por el agente</span>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Los equipos no cambian de nombre, área, historial ni automatizaciones: solo cambia quién habla con ellos. Solo se pueden pasar
          equipos a un agente conectado.
        </p>
      </div>

      {aviso && (
        <p className={`rounded-lg px-3 py-2 text-sm ${aviso.ok ? "bg-emerald-500/10 text-emerald-200" : "bg-rose-500/10 text-rose-200"}`}>{aviso.msg}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select value={proto} onChange={(e) => setProto(e.target.value as typeof proto)} className="min-h-[38px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100" aria-label="Protocolo">
          <option value="todos">Todos los protocolos</option>
          {(Object.keys(PROTO) as EquipoGestion["protocolo"][]).map((p) => (
            <option key={p} value={p}>{PROTO[p]}</option>
          ))}
        </select>
        <select value={quien} onChange={(e) => setQuien(e.target.value as typeof quien)} className="min-h-[38px] rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100" aria-label="Quién lo maneja">
          <option value="todos">Los maneja cualquiera</option>
          <option value="api">Los maneja la API</option>
          <option value="agente">Los maneja el agente</option>
        </select>
        <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Buscar por nombre o área" className="min-h-[38px] min-w-[200px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 placeholder:text-slate-600" />
        {esAdmin && (
          <>
            <button type="button" disabled={!aAgente.length || asignar.isPending || !d.conectado || d.respaldo} onClick={() => cambiar(aAgente, "agente")} className="min-h-[38px] rounded-lg bg-sky-600 px-3 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-40">
              Pasar al agente ({aAgente.length})
            </button>
            <button type="button" disabled={!aApi.length || asignar.isPending} onClick={() => cambiar(aApi, "api")} className="min-h-[38px] rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-40">
              Devolver a la API ({aApi.length})
            </button>
          </>
        )}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-800">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-slate-900 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              {esAdmin && (
                <th className="w-10 px-3 py-2">
                  <input type="checkbox" aria-label="Marcar todos" checked={todosMarcados} onChange={() => setSel(todosMarcados ? new Set() : new Set(lista.map((e) => e.id)))} />
                </th>
              )}
              <th className="px-3 py-2">Equipo</th>
              <th className="px-3 py-2">Protocolo</th>
              <th className="px-3 py-2">Área</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Lo maneja</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((e) => (
              <tr key={e.id} className="border-t border-slate-800/70">
                {esAdmin && (
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Marcar ${e.nombre}`}
                      checked={sel.has(e.id)}
                      onChange={() => {
                        const n = new Set(sel);
                        if (n.has(e.id)) n.delete(e.id);
                        else n.add(e.id);
                        setSel(n);
                      }}
                    />
                  </td>
                )}
                <td className="px-3 py-2 font-medium text-slate-100">{e.nombre}</td>
                <td className="px-3 py-2 text-slate-300">{PROTO[e.protocolo]}</td>
                <td className="px-3 py-2 text-slate-400">{[e.area, e.nivel].filter(Boolean).join(" · ") || "—"}</td>
                <td className="px-3 py-2 text-slate-300">
                  {e.estado ?? "—"} <span className="text-xs text-slate-500">{hace(e.actualizado)}</span>
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${e.gestor === "agente" ? "bg-sky-500/15 text-sky-200" : "bg-slate-700/40 text-slate-300"}`}>
                    {e.gestor === "agente" ? (d.respaldo ? "Agente (API en respaldo)" : `Agente ${bk}`) : "API central"}
                  </span>
                </td>
              </tr>
            ))}
            {!lista.length && (
              <tr>
                <td colSpan={esAdmin ? 6 : 5} className="px-3 py-6 text-center text-slate-500">No hay equipos con ese filtro.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
