import { Module } from "@nestjs/common";
import { AreasController } from "./areas.controller";
import { AreasService } from "./areas.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [AreasController],
  providers: [AreasService],
})
export class AreasModule {}
