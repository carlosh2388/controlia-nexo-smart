import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RedModule } from "../red/red.module";
import { CentroController } from "./centro.controller";
import { CentroService } from "./centro.service";
import { AnaliticaService } from "./analitica.service";

@Module({
  imports: [AuthModule, RedModule],
  controllers: [CentroController],
  providers: [CentroService, AnaliticaService],
})
export class CentroModule {}
