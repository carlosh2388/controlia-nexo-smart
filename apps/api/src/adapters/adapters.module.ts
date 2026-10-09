import { Module } from "@nestjs/common";
import { AdapterRegistry } from "./adapter-registry.service";
import { MqttAdapterService } from "./mqtt/mqtt.adapter.service";
import { HttpAdapterService } from "./http/http.adapter.service";
import { LorawanAdapterService } from "./lorawan/lorawan.adapter.service";
import { ModbusAgentAdapterService } from "./modbus/modbus-agent.adapter.service";

@Module({
  providers: [AdapterRegistry, MqttAdapterService, HttpAdapterService, LorawanAdapterService, ModbusAgentAdapterService],
  exports: [AdapterRegistry, MqttAdapterService, HttpAdapterService, LorawanAdapterService],
})
export class AdaptersModule {}
