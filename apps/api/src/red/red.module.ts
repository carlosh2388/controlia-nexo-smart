import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RedController } from "./red.controller";
import { RedService } from "./red.service";

@Module({
  imports: [AuthModule],
  controllers: [RedController],
  providers: [RedService],
})
export class RedModule {}
