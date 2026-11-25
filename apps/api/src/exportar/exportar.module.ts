import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RedModule } from "../red/red.module";
import { TimeseriesModule } from "../timeseries/timeseries.module";
import { ExportarController } from "./exportar.controller";
import { ExportarService } from "./exportar.service";

/** Solo en el central: exportacion de historial de varias sedes y equipos a Excel. */
@Module({
  imports: [AuthModule, RedModule, TimeseriesModule],
  controllers: [ExportarController],
  providers: [ExportarService],
})
export class ExportarModule {}
