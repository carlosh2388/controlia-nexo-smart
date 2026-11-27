import { Module } from "@nestjs/common";
import { AdapterRegistry } from "./adapter-registry.service";
import { MqttAdapterService } from "./mqtt/mqtt.adapter.service";
import { HttpAdapterService } from "./http/http.adapter.service";
import { LorawanAdapterService } from "./lorawan/lorawan.adapter.service";
import { ModbusAgentAdapterService } from "./modbus/modbus-agent.adapter.service";
import { GestionService } from "./agente/gestion.service";
import { OrdenesAgenteService } from "./agente/ordenes-agente.service";
import { AgenteConectorService } from "./agente/agente-conector.service";

@Module({
  providers: [
    AdapterRegistry,
    MqttAdapterService,
    HttpAdapterService,
    LorawanAdapterService,
    ModbusAgentAdapterService,
    GestionService,
    OrdenesAgenteService,
    AgenteConectorService,
  ],
  exports: [AdapterRegistry, MqttAdapterService, HttpAdapterService, LorawanAdapterService, GestionService, OrdenesAgenteService],
})
export class AdaptersModule {}
