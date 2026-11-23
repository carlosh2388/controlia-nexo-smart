import { Module } from "@nestjs/common";
import { TimeseriesModule } from "../timeseries/timeseries.module";
import { AlarmasService } from "./alarmas.service";

/** Motor de alarmas y correos del Gravix de sede. Solo se carga con GRAVIX_MODO=sede (via SedeModule). */
@Module({
  imports: [TimeseriesModule],
  providers: [AlarmasService],
  exports: [AlarmasService],
})
export class AlarmasModule {}
