import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EventsModule } from "../events/events.module";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";

@Module({
  imports: [AuthModule, EventsModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
