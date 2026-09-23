import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";
import { HomeAssistantImportService } from "./home-assistant-import.service";
import { Zigbee2MqttImportService } from "./zigbee2mqtt-import.service";
import { DeviceHistoryService } from "./device-history.service";
import { DeviceHistoryRecorderService } from "./device-history-recorder.service";
import { CommandsProcessor } from "./commands.processor";
import { COMMANDS_QUEUE } from "./devices.constants";
import { AdaptersModule } from "../adapters/adapters.module";
import { AuthModule } from "../auth/auth.module";
import { EventsModule } from "../events/events.module";

@Module({
  imports: [
    BullModule.registerQueue({ name: COMMANDS_QUEUE }),
    AdaptersModule,
    AuthModule,
    EventsModule,
  ],
  controllers: [DevicesController],
  providers: [
    DevicesService,
    CommandsProcessor,
    HomeAssistantImportService,
    Zigbee2MqttImportService,
    DeviceHistoryService,
    DeviceHistoryRecorderService,
  ],
  exports: [DevicesService],
})
export class DevicesModule {}
