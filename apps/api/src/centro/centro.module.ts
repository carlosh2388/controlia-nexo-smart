import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CentroController } from "./centro.controller";
import { CentroService } from "./centro.service";

@Module({
  imports: [AuthModule],
  controllers: [CentroController],
  providers: [CentroService],
})
export class CentroModule {}
