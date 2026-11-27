import { CommandAction, Device, DeviceProtocol } from "@prisma/client";
import type { OrdenAgente } from "./agente/ordenes-agente.service";

/**
 * Contrato comun que debe implementar cada protocolo soportado
 * (mqtt, http, y en fases futuras modbus/bacnet/lorawan).
 * Agregar un protocolo nuevo implica solo crear una clase que
 * implemente esta interfaz y registrarla en el AdapterRegistry;
 * devices/realtime/frontend no cambian.
 */
export interface DeviceAdapter {
  readonly protocol: DeviceProtocol;

  /** Envia un comando (on/off) al dispositivo real. */
  publishCommand(device: Device, action: CommandAction): Promise<void>;

  /** Se invoca cuando se registra o actualiza un dispositivo de este protocolo, para (re)suscribirse a su estado. */
  onDeviceRegistered(device: Device): Promise<void> | void;

  /**
   * La misma orden que ejecutaria publishCommand, pero descrita para que la ejecute un Agente_Go en
   * la red del edificio (dispositivo con metadata.gestor.agente). Sin este metodo el protocolo no
   * se puede controlar por agente.
   */
  ordenPara?(device: Device, action: CommandAction): OrdenAgente;
}

export const DEVICE_ADAPTER = "DEVICE_ADAPTER";
