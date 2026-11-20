import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AsistenteController } from "./asistente.controller";
import { AsistenteService } from "./asistente.service";

/** Solo en el servidor central: Gravix IA del Centro de mando. */
@Module({
  imports: [AuthModule],
  controllers: [AsistenteController],
  providers: [AsistenteService],
})
export class AsistenteModule {}
