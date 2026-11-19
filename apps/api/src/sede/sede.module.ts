import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AgentsModule } from "../agents/agents.module";
import { TimeseriesModule } from "../timeseries/timeseries.module";
import { AlarmasModule } from "../alarmas/alarmas.module";
import { SedeController } from "./sede.controller";
import { SedeService } from "./sede.service";

/** Solo se carga con GRAVIX_MODO=sede (ver app.module.ts). */
@Module({
  imports: [AuthModule, AgentsModule, TimeseriesModule, AlarmasModule],
  controllers: [SedeController],
  providers: [SedeService],
})
export class SedeModule {}
