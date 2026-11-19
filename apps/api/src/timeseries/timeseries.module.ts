import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AgentsModule } from "../agents/agents.module";
import { GapDetectorService } from "./gap-detector.service";
import { TimeseriesService } from "./timeseries.service";
import { PilotService } from "./pilot.service";
import { PilotController } from "./pilot.controller";
import { QualityService } from "./quality.service";
import { InfluxWriterService } from "./influx-writer.service";

@Module({
  imports: [AuthModule, AgentsModule],
  controllers: [PilotController],
  providers: [GapDetectorService, TimeseriesService, PilotService, QualityService, InfluxWriterService],
  exports: [TimeseriesService, InfluxWriterService],
})
export class TimeseriesModule {}
