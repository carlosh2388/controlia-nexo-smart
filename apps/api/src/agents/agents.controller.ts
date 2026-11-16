import { Body, Controller, Get, Param, Post, Put, UseGuards, Version } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthGuard } from "../auth/guards/auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { AgentsService } from "./agents.service";
import {
  ConfigAppliedDto,
  RequestScanDto,
  ScanResultDto,
  SeedAgentConfigDto,
  UpdateAgentConfigDto,
} from "./dto/agents.dto";

const HUMANS = [Role.admin, Role.operator, Role.viewer];

@Controller("agents")
@UseGuards(AuthGuard, RolesGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  /** Agentes conocidos con su version de config (guardada y aplicada) y su ultimo sync. */
  @Version("1")
  @Roles(...HUMANS)
  @Get()
  list() {
    return this.agents.list();
  }

  /** La web la recibe con los secretos enmascarados; el agente (role=agent), completa. */
  @Version("1")
  @Roles(...HUMANS, Role.agent)
  @Get(":buildingKey/config")
  getConfig(@Param("buildingKey") buildingKey: string, @CurrentUser() user: AuthenticatedUser) {
    return this.agents.getConfig(buildingKey, user);
  }

  @Version("1")
  @Roles(Role.admin)
  @Put(":buildingKey/config")
  updateConfig(
    @Param("buildingKey") buildingKey: string,
    @Body() dto: UpdateAgentConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.agents.updateConfig(buildingKey, dto, user);
  }

  @Version("1")
  @Roles(Role.agent, Role.admin)
  @Post(":buildingKey/config/seed")
  seed(
    @Param("buildingKey") buildingKey: string,
    @Body() dto: SeedAgentConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.agents.seed(buildingKey, dto.config, user);
  }

  @Version("1")
  @Roles(Role.agent)
  @Post(":buildingKey/config/applied")
  configApplied(@Param("buildingKey") buildingKey: string, @Body() dto: ConfigAppliedDto) {
    return this.agents.reportApplied(buildingKey, dto);
  }

  @Version("1")
  @Roles(Role.agent)
  @Get(":buildingKey/control")
  control(@Param("buildingKey") buildingKey: string) {
    return this.agents.control(buildingKey);
  }

  @Version("1")
  @Roles(Role.admin, Role.operator)
  @Post(":buildingKey/scan")
  requestScan(@Param("buildingKey") buildingKey: string, @Body() dto: RequestScanDto) {
    return this.agents.requestScan(buildingKey, dto);
  }

  @Version("1")
  @Roles(...HUMANS)
  @Get(":buildingKey/scan")
  getScan(@Param("buildingKey") buildingKey: string) {
    return this.agents.getScan(buildingKey);
  }

  @Version("1")
  @Roles(Role.agent)
  @Post(":buildingKey/scan/:scanId/result")
  reportScan(
    @Param("buildingKey") buildingKey: string,
    @Param("scanId") scanId: string,
    @Body() dto: ScanResultDto,
  ) {
    return this.agents.reportScan(buildingKey, scanId, dto);
  }
}
