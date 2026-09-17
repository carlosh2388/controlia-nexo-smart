import { Controller, Get, Param, UseGuards, Version } from "@nestjs/common";
import { AuthGuard } from "../auth/guards/auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { AreasService } from "./areas.service";

@Controller("areas")
@UseGuards(AuthGuard, RolesGuard)
export class AreasController {
  constructor(private readonly areasService: AreasService) {}

  @Version("1")
  @Get()
  findAll() {
    return this.areasService.findAll();
  }

  @Version("1")
  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.areasService.findOne(id);
  }
}
