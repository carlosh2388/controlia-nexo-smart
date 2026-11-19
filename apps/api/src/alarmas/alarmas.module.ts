import { Module } from "@nestjs/common";
import { AlarmasService } from "./alarmas.service";

/** Motor de alarmas y correos del Gravix de sede. Solo se carga con GRAVIX_MODO=sede (via SedeModule). */
@Module({
  providers: [AlarmasService],
  exports: [AlarmasService],
})
export class AlarmasModule {}
