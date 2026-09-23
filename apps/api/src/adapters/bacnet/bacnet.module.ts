import { Module } from "@nestjs/common";
import { AdaptersModule } from "../adapters.module";
import { DevicesModule } from "../../devices/devices.module";
import { AuthModule } from "../../auth/auth.module";
import { BacnetBridgeClientService } from "./bacnet-bridge-client.service";
import { BacnetDiscoveryService } from "./bacnet-discovery.service";
import { BacnetImportService } from "./bacnet-import.service";
import { BacnetAdapterService } from "./bacnet.adapter.service";
import { BacnetController } from "./bacnet.controller";

/**
 * Modulo autocontenido: se registra a si mismo en el AdapterRegistry existente (via
 * AdaptersModule, sin modificar ese modulo) al arrancar. No toca MQTT/HTTP/eWeLink/LoRaWAN,
 * ni DevicesModule/DevicesController (los endpoints de bacnet viven en su propio controller aqui,
 * evitando una dependencia circular entre este modulo y DevicesModule).
 */
@Module({
  imports: [AdaptersModule, DevicesModule, AuthModule],
  controllers: [BacnetController],
  providers: [BacnetBridgeClientService, BacnetDiscoveryService, BacnetImportService, BacnetAdapterService],
  exports: [BacnetDiscoveryService, BacnetImportService, BacnetAdapterService],
})
export class BacnetModule {}
