import { useEffect, useMemo, useState } from "react";
import { ACTION_DEFS, ROLE_LABEL, TAB_DEFS, useRoleMatrix, useSaveRole } from "../api/access";
import { useCentroVista } from "../api/centro";
import { useDeleteUser, useSaveUser, useSetPassword, useUsers, type AppUser, type UserInput } from "../api/users";
import { extractErrorMessage as apiErrorMessage } from "../api/errors";
import { useAuthStore } from "../store/auth.store";

/**
 * Usuarios y permisos (solo administradores): mantenimiento de usuarios (perfil, sedes que ve,
 * pantalla de inicio, correos, activo) y la matriz de permisos de cada perfil.
 * Perfiles: Administrador (admin, siempre todo), Operador (operator) y Consulta (viewer).
 */

const inputCls = "min-h-[40px] rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 focus:border-sky-500 focus:outline-none";
const SEDES_RESPALDO = [
  ["escuintla", "Escuintla"], ["villanueva", "Villa Nueva"], ["gineco", "Gineco"], ["amatitlan", "Amatitlán"], ["palin", "Palín"],
  ["gomera", "La Gomera"], ["santalucia", "Santa Lucía"], ["tiquisate", "Tiquisate"], ["mazatenango", "Mazatenango"], ["retalhuleu", "Retalhuleu"],
] as const;

const fecha = (s: string | null) => (s ? new Date(s).toLocaleString("es-GT", { dateStyle: "short", timeStyle: "short" }) : "nunca");
const iniciales = (u: AppUser) => (u.fullName || u.username).split(/[\s.]+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase();
const AVATAR = ["bg-sky-600", "bg-emerald-600", "bg-amber-600", "bg-violet-600", "bg-rose-600"];

const NUEVO: UserInput & { username: string } = { username: "", fullName: "", email: "", role: "viewer", sites: [], homeTab: "centro", active: true, receivesAlarmEmails: false, password: "" };

export default function Usuarios() {
  const users = useUsers();
  const me = useAuthStore((s) => s.user);
  const vista = useCentroVista();
  const sedes = useMemo(
    () => (vista.data?.sedes.length ? vista.data.sedes.map((s) => [s.id, s.nombre] as const) : SEDES_RESPALDO),
    [vista.data],
  );
  const [selId, setSelId] = useState<string | "nuevo" | null>(null);
  const [form, setForm] = useState<UserInput & { username: string }>(NUEVO);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [pwd, setPwd] = useState("");
  const save = useSaveUser();
  const setPassword = useSetPassword();
  const del = useDeleteUser();

  const list = users.data ?? [];
  const sel = selId && selId !== "nuevo" ? list.find((u) => u.id === selId) ?? null : null;

  useEffect(() => {
    if (selId === null && list.length) setSelId(list[0].id);
  }, [list, selId]);
  useEffect(() => {
    setMsg(null);
    setPwd("");
    if (selId === "nuevo") setForm(NUEVO);
    else if (sel) setForm({ username: sel.username, fullName: sel.fullName ?? "", email: sel.email ?? "", role: sel.role, sites: sel.sites, homeTab: sel.homeTab, active: sel.active, receivesAlarmEmails: sel.receivesAlarmEmails });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId, sel?.id]);

  const matrix = useRoleMatrix();
  const roleTabs = (role: string) => (role === "admin" ? TAB_DEFS.map((t) => t.key as string) : matrix.data?.roles[role as "operator" | "viewer"]?.tabs ?? ["centro"]);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const todas = (form.sites ?? []).length === 0;

  const guardar = async () => {
    setMsg(null);
    try {
      const data: UserInput = { ...form, email: form.email || undefined, fullName: form.fullName || undefined };
      if (selId === "nuevo") {
        if (!form.password || form.password.length < 6) return setMsg({ ok: false, t: "La contraseña debe tener al menos 6 caracteres" });
        const u = await save.mutateAsync({ id: null, data });
        setSelId(u.id);
      } else if (sel) {
        const { username: _u, password: _p, ...rest } = data;
        await save.mutateAsync({ id: sel.id, data: rest });
      }
      setMsg({ ok: true, t: "Cambios guardados" });
    } catch (e) {
      setMsg({ ok: false, t: apiErrorMessage(e) });
    }
  };

  const cambiarClave = async () => {
    if (!sel || pwd.length < 6) return setMsg({ ok: false, t: "La contraseña nueva debe tener al menos 6 caracteres" });
    try {
      await setPassword.mutateAsync({ id: sel.id, password: pwd });
      setPwd("");
      setMsg({ ok: true, t: "Contraseña cambiada: sus sesiones abiertas se cerraron" });
    } catch (e) {
      setMsg({ ok: false, t: apiErrorMessage(e) });
    }
  };

  const eliminar = async () => {
    if (!sel || !window.confirm(`¿Eliminar el usuario ${sel.username}? Esta acción no se puede deshacer.`)) return;
    try {
      await del.mutateAsync(sel.id);
      setSelId(null);
    } catch (e) {
      setMsg({ ok: false, t: apiErrorMessage(e) });
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(260px,1fr)_minmax(0,2fr)]">
      {/* ---------- lista ---------- */}
      <section aria-label="Usuarios" className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Usuarios</span>
          <button type="button" onClick={() => setSelId("nuevo")} className="min-h-[36px] rounded-lg bg-sky-600 px-3 text-sm font-semibold text-white hover:bg-sky-500">
            + Nuevo usuario
          </button>
        </div>
        {users.isLoading && <p className="text-sm text-slate-500">Cargando…</p>}
        {users.isError && <p className="text-sm text-rose-300">{apiErrorMessage(users.error)}</p>}
        {list.map((u, i) => (
          <button
            key={u.id}
            type="button"
            onClick={() => setSelId(u.id)}
            aria-pressed={selId === u.id}
            className={`flex items-center gap-3 rounded-lg border p-2.5 text-left transition-colors ${selId === u.id ? "border-sky-500 bg-slate-800" : "border-slate-800 bg-slate-950/60 hover:border-slate-700"}`}
          >
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold text-white ${AVATAR[i % AVATAR.length]}`}>{iniciales(u)}</span>
            <span className="min-w-0 flex-1">
              <b className="block truncate text-sm text-slate-100">{u.fullName || u.username}</b>
              <small className="block truncate text-xs text-slate-400">
                {u.username} · {ROLE_LABEL[u.role]} · {u.sites.length ? `${u.sites.length} sede(s)` : "todas las sedes"}
              </small>
            </span>
            <span className={`text-xs font-bold ${u.active ? "text-emerald-300" : "text-slate-500"}`}>{u.active ? "Activo" : "Inactivo"}</span>
          </button>
        ))}
      </section>

      {/* ---------- ficha ---------- */}
      <section aria-label="Datos del usuario" className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        {!sel && selId !== "nuevo" ? (
          <p className="text-sm text-slate-500">Elija un usuario.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">{selId === "nuevo" ? "Nuevo usuario" : `Usuario · ${form.username}`}</span>
              {msg && <span className={`text-sm ${msg.ok ? "text-emerald-300" : "text-rose-300"}`}>{msg.t}</span>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Usuario
                <input className={inputCls} value={form.username} readOnly={selId !== "nuevo"} onChange={(e) => set({ username: e.target.value.trim() })} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Nombre
                <input className={inputCls} value={form.fullName ?? ""} onChange={(e) => set({ fullName: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Correo
                <input className={inputCls} type="email" value={form.email ?? ""} onChange={(e) => set({ email: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Perfil
                <select className={inputCls} value={form.role} onChange={(e) => set({ role: e.target.value as AppUser["role"], homeTab: "centro" })}>
                  {Object.entries(ROLE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Pantalla al entrar
                <select className={inputCls} value={form.homeTab} onChange={(e) => set({ homeTab: e.target.value })}>
                  {TAB_DEFS.filter((t) => roleTabs(form.role ?? "viewer").includes(t.key) && t.key !== "usuarios").map((t) => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </select>
              </label>
              {selId === "nuevo" && (
                <label className="flex flex-col gap-1 text-xs text-slate-400">
                  Contraseña inicial
                  <input className={inputCls} type="password" autoComplete="new-password" value={form.password ?? ""} onChange={(e) => set({ password: e.target.value })} />
                </label>
              )}
            </div>

            <fieldset className="rounded-lg border border-slate-800 p-3">
              <legend className="px-1 text-xs font-bold uppercase tracking-wider text-slate-400">Sedes que puede ver</legend>
              <label className="flex min-h-[34px] items-center gap-2 text-sm font-semibold text-slate-200">
                <input type="checkbox" className="h-4 w-4 accent-sky-500" checked={todas} onChange={() => set({ sites: todas ? [sedes[0][0]] : [] })} />
                Todas las sedes
              </label>
              <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-3 lg:grid-cols-5">
                {sedes.map(([id, nombre]) => {
                  const on = todas || (form.sites ?? []).includes(id);
                  return (
                    <label key={id} className={`flex min-h-[34px] items-center gap-2 text-sm ${todas ? "text-slate-500" : "text-slate-200"}`}>
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-sky-500"
                        checked={on}
                        disabled={todas}
                        onChange={() => set({ sites: on ? (form.sites ?? []).filter((x) => x !== id) : [...(form.sites ?? []), id] })}
                      />
                      {nombre}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <label className="flex min-h-[36px] items-center gap-2 text-sm text-slate-200">
                <input type="checkbox" className="h-4 w-4 accent-sky-500" checked={!!form.receivesAlarmEmails} onChange={(e) => set({ receivesAlarmEmails: e.target.checked })} />
                Recibe los correos de alarmas de sus sedes
              </label>
              <label className="flex min-h-[36px] items-center gap-2 text-sm text-slate-200">
                <input type="checkbox" className="h-4 w-4 accent-sky-500" checked={!!form.active} disabled={sel?.id === me?.id} onChange={(e) => set({ active: e.target.checked })} />
                Usuario activo
              </label>
            </div>
            {form.receivesAlarmEmails && (
              <p className="text-xs text-amber-200/80">
                Hoy los correos los envía cada sede (api-SIASA) a su lista configurada. Esta marca queda guardada para cuando Nodivo envíe los correos.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={guardar} disabled={save.isPending} className="min-h-[40px] rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50">
                {save.isPending ? "Guardando…" : selId === "nuevo" ? "Crear usuario" : "Guardar"}
              </button>
              {sel && (
                <>
                  <input className={`${inputCls} w-44`} type="password" placeholder="Contraseña nueva" autoComplete="new-password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
                  <button type="button" onClick={cambiarClave} className="min-h-[40px] rounded-lg border border-slate-700 bg-slate-800 px-3 text-sm text-slate-200 hover:bg-slate-700">
                    Cambiar contraseña
                  </button>
                  {sel.id !== me?.id && (
                    <button type="button" onClick={eliminar} className="min-h-[40px] rounded-lg border border-rose-900 px-3 text-sm text-rose-300 hover:bg-rose-950">
                      Eliminar
                    </button>
                  )}
                  <span className="text-xs text-slate-500">Último acceso: {fecha(sel.lastLoginAt)}</span>
                </>
              )}
            </div>
          </>
        )}
      </section>

      <Matriz />
    </div>
  );
}

/* ---------- matriz de permisos por perfil ---------- */
function Matriz() {
  const matrix = useRoleMatrix();
  const saveRole = useSaveRole();
  const [err, setErr] = useState<string | null>(null);
  const m = matrix.data;
  const toggle = async (role: "operator" | "viewer", kind: "tabs" | "actions", key: string) => {
    if (!m) return;
    const cur = m.roles[role];
    const list = cur[kind].includes(key) ? cur[kind].filter((x) => x !== key) : [...cur[kind], key];
    setErr(null);
    try {
      await saveRole.mutateAsync({ role, tabs: kind === "tabs" ? list : cur.tabs, actions: kind === "actions" ? list : cur.actions });
    } catch (e) {
      setErr(apiErrorMessage(e));
    }
  };
  const fila = (kind: "tabs" | "actions", key: string, label: string, help: string, locked: boolean) => (
    <div key={`${kind}-${key}`} className="grid grid-cols-[minmax(0,1fr)_repeat(3,96px)] items-center gap-2 border-t border-slate-800/80 px-2 py-1 sm:grid-cols-[minmax(0,1fr)_repeat(3,130px)]">
      <span className="flex flex-col">
        <span className="text-sm text-slate-100">{label}</span>
        <small className="text-xs text-slate-500">{help}</small>
      </span>
      <label className="grid min-h-[40px] place-items-center"><input type="checkbox" className="h-[18px] w-[18px] accent-sky-500" checked disabled aria-label={`Administrador: ${label}`} /></label>
      {(["operator", "viewer"] as const).map((r) => (
        <label key={r} className="grid min-h-[40px] place-items-center">
          <input
            type="checkbox"
            className="h-[18px] w-[18px] accent-sky-500"
            aria-label={`${ROLE_LABEL[r]}: ${label}`}
            checked={kind === "tabs" && key === "centro" ? true : !!m?.roles[r][kind].includes(key)}
            disabled={locked || saveRole.isPending}
            onChange={() => void toggle(r, kind, key)}
          />
        </label>
      ))}
    </div>
  );
  return (
    <section aria-label="Perfiles y permisos" className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-4 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Perfiles · qué pestañas ve y qué puede hacer cada uno</span>
        <span className={`text-xs ${err ? "text-rose-300" : "text-slate-500"}`}>{err ?? "El Administrador siempre tiene todo. Se guarda al marcar; aplica al volver a entrar."}</span>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[520px]">
          <div className="grid grid-cols-[minmax(0,1fr)_repeat(3,96px)] gap-2 px-2 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-400 sm:grid-cols-[minmax(0,1fr)_repeat(3,130px)]">
            <span>Permiso</span><span className="text-center">Administrador</span><span className="text-center">Operador</span><span className="text-center">Consulta</span>
          </div>
          <div className="px-2 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-sky-300">Pestañas del menú</div>
          {TAB_DEFS.map((t) => fila("tabs", t.key, t.label, t.help, t.key === "centro" || t.key === "usuarios"))}
          <div className="px-2 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-sky-300">Acciones</div>
          {ACTION_DEFS.map((a) => fila("actions", a.key, a.label, a.help, false))}
        </div>
      </div>
    </section>
  );
}
