import { useEffect, useMemo, useRef } from "react";
import { useCentroVista, type CentroVista } from "../../api/centro";
import { useGravixBus, type DatosCentro } from "../../store/gravix.store";
import Gravix, { type GravixAlarma } from "./Gravix";
import type { Accion, Pestana } from "./comandos";

/** Vista vacia para perfiles sin Centro de mando (Gravix igual navega entre pestañas). */
const VISTA_VACIA: CentroVista = {
  generado: "",
  dias: [],
  totales: { sedes: 0, sedes_responden: 0, sedes_ok: 0, medidores: 0, medidores_ok: 0, medidores_fuera: 0, criticos: 0, abiertos: 0, reconexiones: 0 },
  sedes: [],
  actividad: [],
  recibido: "",
  atrasado: false,
  error: null,
};

/**
 * Gravix en el marco de la aplicacion: aparece en todas las pestañas. Usa los datos que publica el
 * Centro de mando (o, si todavia no se abrio, la vista del centro sin unir) y, para las acciones del
 * centro estando en otra pestaña, cambia a esa pestaña y deja la accion pendiente.
 */
export default function GravixGlobal({ pestana, permitidas, irPestana }: { pestana: Pestana; permitidas: Set<Pestana>; irPestana: (p: Pestana) => void }) {
  const datos = useGravixBus((s) => s.datos);
  const ejecutarCentro = useGravixBus((s) => s.ejecutarCentro);
  const setPendiente = useGravixBus((s) => s.setPendiente);
  const conCentro = permitidas.has("centro");
  const vistaQ = useCentroVista();

  const respaldo = useMemo(() => {
    const vista = vistaQ.data ?? VISTA_VACIA;
    const alarmas: GravixAlarma[] = vista.sedes.flatMap((s) =>
      s.abiertos.map((a) => ({ codigo: a.codigo, titulo: a.titulo, severidad: a.severidad, dispositivo: a.dispositivo, sedeId: s.id, sedeNombre: s.nombre })),
    );
    return { vista, equipos: new Map(), alarmas, esAdmin: false, sedeActual: null, grupos: [], grupoDe: () => null } as DatosCentro;
  }, [vistaQ.data]);
  const d = datos ?? respaldo;

  const centroRef = useRef(ejecutarCentro);
  centroRef.current = ejecutarCentro;
  const ejecutar = (a: Accion) => {
    if (pestana === "centro" && centroRef.current) centroRef.current(a);
    else if (conCentro) {
      setPendiente(a);
      irPestana("centro");
    }
  };

  // Al salir del Centro de mando no queda ninguna accion pendiente vieja.
  useEffect(() => {
    if (pestana !== "centro") setPendiente(null);
  }, [pestana, setPendiente]);

  return (
    <Gravix
      vista={d.vista}
      equipos={d.equipos}
      alarmas={d.alarmas}
      esAdmin={d.esAdmin}
      sedeActual={pestana === "centro" ? d.sedeActual : null}
      grupos={d.grupos}
      grupoDe={d.grupoDe}
      vistaActual={d.vistaActual ?? "mapa"}
      ejecutar={ejecutar}
      pestanas={[...permitidas]}
      pestanaActual={pestana}
      irPestana={irPestana}
      conDatos={!!datos || !!vistaQ.data}
    />
  );
}

/** Lo monta el Centro de mando: publica sus datos para Gravix y ejecuta la accion pendiente. */
export function PublicarGravix({ datos, ejecutar }: { datos: DatosCentro; ejecutar: (a: Accion) => void }) {
  const publicar = useGravixBus((s) => s.publicar);
  const retirar = useGravixBus((s) => s.retirar);
  const pendiente = useGravixBus((s) => s.pendiente);
  const setPendiente = useGravixBus((s) => s.setPendiente);
  const ejRef = useRef(ejecutar);
  ejRef.current = ejecutar;
  // Se publica en cada render del centro (los datos cambian cada 15 s); el centro no se suscribe, no hay ciclo.
  useEffect(() => {
    publicar(datos, (a) => ejRef.current(a));
  });
  useEffect(() => () => retirar(), [retirar]);
  useEffect(() => {
    if (!pendiente) return;
    setPendiente(null);
    ejRef.current(pendiente);
  }, [pendiente, setPendiente]);
  return null;
}
