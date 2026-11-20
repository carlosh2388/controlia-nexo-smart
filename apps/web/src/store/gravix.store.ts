import { create } from "zustand";
import type { CentroVista } from "../api/centro";
import type { Accion } from "../components/asistente/comandos";
import type { GravixAlarma, GravixEquipo } from "../components/asistente/Gravix";

/**
 * Puente entre el Centro de mando y Gravix (que vive en el marco de la aplicacion, en todas las
 * pestañas). El Centro de mando publica aqui sus datos ya unidos (sedes, equipos, alarmas, telemetrias)
 * y la funcion que navega dentro de el. Si Gravix pide algo del centro estando en otra pestaña, deja la
 * accion "pendiente": el Centro de mando la ejecuta en cuanto se monta.
 */
export interface DatosCentro {
  vista: CentroVista;
  equipos: Map<string, GravixEquipo[]>;
  alarmas: GravixAlarma[];
  esAdmin: boolean;
  sedeActual: string | null;
  grupos: { id: string; nombre: string }[];
  grupoDe: (sedeId: string) => string | null;
}

interface GravixBus {
  datos: DatosCentro | null;
  ejecutarCentro: ((a: Accion) => void) | null;
  pendiente: Accion | null;
  publicar: (datos: DatosCentro, ejecutar: (a: Accion) => void) => void;
  retirar: () => void;
  setPendiente: (a: Accion | null) => void;
}

export const useGravixBus = create<GravixBus>()((set) => ({
  datos: null,
  ejecutarCentro: null,
  pendiente: null,
  publicar: (datos, ejecutarCentro) => set({ datos, ejecutarCentro }),
  // Al salir del Centro de mando se conservan los ultimos datos (para consultas), pero no su navegacion.
  retirar: () => set({ ejecutarCentro: null }),
  setPendiente: (pendiente) => set({ pendiente }),
}));
