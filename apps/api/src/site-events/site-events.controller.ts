import { Controller, Get, Param, Query, UseGuards, Version } from "@nestjs/common";
import { AuthGuard } from "../auth/guards/auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { SiteEventsService } from "./site-events.service";
import { ListSiteEventsQueryDto } from "./dto/site-event.dto";

@Controller("sites")
@UseGuards(AuthGuard, RolesGuard)
export class SiteEventsController {
  constructor(private readonly siteEvents: SiteEventsService) {}

  /** Historial de eventos de una sede (buildingKey del Agente_Go), del mas reciente al mas antiguo. */
  @Version("1")
  @Get(":buildingKey/events")
  list(@Param("buildingKey") buildingKey: string, @Query() query: ListSiteEventsQueryDto) {
    return this.siteEvents.list(buildingKey, query);
  }
}
