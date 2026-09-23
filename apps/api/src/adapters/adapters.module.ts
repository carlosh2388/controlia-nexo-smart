import { Module } from "@nestjs/common";
import { AdapterRegistry } from "./adapter-registry.service";
import { MqttAdapterService } from "./mqtt/mqtt.adapter.service";
import { HttpAdapterService } from "./http/http.adapter.service";
import { LorawanAdapterService } from "./lorawan/lorawan.adapter.service";

@Module({
  providers: [AdapterRegistry, MqttAdapterService, HttpAdapterService, LorawanAdapterService],
  exports: [AdapterRegistry, MqttAdapterService, HttpAdapterService, LorawanAdapterService],
})
export class AdaptersModule {}
