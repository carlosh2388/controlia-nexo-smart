/**
 * Un dispositivo de un Agente_Go todavia no tiene canal de comandos de vuelta (ver
 * docs/agente-go.md): mostrar un ToggleSwitch normal ahi haria creer que encender/apagar
 * funciona, cuando en realidad el comando se pierde en silencio. Este badge deja claro que
 * por ahora solo se puede VER el estado, no cambiarlo desde el panel.
 */
export default function AgentReadOnlyBadge({ isOn }: { isOn: boolean }) {
  return (
    <span
      title="Este dispositivo lo descubrio un Agente_Go: todavia no se puede controlar desde el panel, solo ver su estado."
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-[11px] font-medium text-slate-400"
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${isOn ? "bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400)]" : "bg-slate-600"}`}
      />
      Solo lectura
    </span>
  );
}
