import { BadRequestException, Injectable, OnModuleInit } from "@nestjs/common";
import { CommandAction, Device, DeviceProtocol } from "@prisma/client";
import type { DeviceAdapter } from "../adapter.interface";
import { AdapterRegistry } from "../adapter-registry.service";

/**
 * Adaptador pasivo para protocol=modbus. La API nunca habla Modbus: los medidores y generadores
 * de una sede los lee el Agente_Go de esa sede (modbussource) y llegan por POST /devices/agent-sync.
 * Existe solo para que DevicesService.update() (renombrar, asignar area) no falle al resolver el
 * adaptador del protocolo, y para rechazar con un mensaje claro cualquier intento de comando.
 */
@Injectable()
export class ModbusAgentAdapterService implements DeviceAdapter, OnModuleInit {
  readonly protocol = DeviceProtocol.modbus;

  constructor(private readonly registry: AdapterRegistry) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async publishCommand(device: Device, _action: CommandAction): Promise<void> {
    throw new BadRequestException(`"${device.name}" es de solo lectura (Modbus via Agente_Go)`);
  }

  onDeviceRegistered(_device: Device): void {
    // Nada que suscribir: el estado lo actualiza el Agente_Go en cada sync.
  }
}
