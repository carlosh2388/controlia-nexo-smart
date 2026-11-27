import { Injectable, OnModuleInit } from "@nestjs/common";
import { AdapterRegistry } from "../adapter-registry.service";
import { GestionService } from "./gestion.service";
import { OrdenesAgenteService } from "./ordenes-agente.service";

/** Conecta el AdapterRegistry con el canal de ordenes del agente (evita una dependencia circular). */
@Injectable()
export class AgenteConectorService implements OnModuleInit {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly gestion: GestionService,
    private readonly ordenes: OrdenesAgenteService,
  ) {}

  onModuleInit() {
    this.registry.conectarAgente({
      manejadoPor: (device) => this.gestion.manejadoPor(device),
      ejecutar: (agente, device, orden) => this.ordenes.ejecutar(agente, device, orden),
    });
  }
}
