/**
 * Pestañas del menu y acciones que se pueden dar por perfil (rol). La misma lista usa la web para
 * armar el menu. El admin siempre tiene todo; "centro" (pantalla de inicio) siempre se ve.
 */
export const TABS = ["centro", "operativa", "edificio", "gestion", "sedes", "agente", "config", "gravix", "usuarios"] as const;
export type Tab = (typeof TABS)[number];

export const ACTIONS = ["reconocer", "excel", "agentes", "correos"] as const;
export type Action = (typeof ACTIONS)[number];

/** Pestañas que nunca se pueden quitar ("centro") o que solo tiene el admin ("usuarios"). */
export const TAB_ALWAYS: Tab = "centro";
export const TAB_ADMIN_ONLY: Tab = "usuarios";
