import { Module } from "@nestjs/common";
import { AdaptersModule } from "../adapters.module";
import { AuthModule } from "../../auth/auth.module";
import { GestionController } from "./gestion.controller";
import { PlanAgenteService } from "./plan-agente.service";

/** Rutas para que un Agente_Go maneje equipos de la API central (plan de lectura, ordenes, gestion). */
@Module({
  imports: [AdaptersModule, AuthModule],
  controllers: [GestionController],
  providers: [PlanAgenteService],
})
export class GestionAgenteModule {}
