import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SiteEventsController } from "./site-events.controller";
import { SiteEventsService } from "./site-events.service";

@Module({
  imports: [AuthModule],
  controllers: [SiteEventsController],
  providers: [SiteEventsService],
  exports: [SiteEventsService],
})
export class SiteEventsModule {}
