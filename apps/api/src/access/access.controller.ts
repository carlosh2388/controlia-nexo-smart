import { Body, Controller, Get, Param, ParseEnumPipe, Put, UseGuards, Version } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthGuard } from "../auth/guards/auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { AccessService } from "./access.service";
import { RolePermissionDto } from "./dto/role-permission.dto";

@Controller("access")
@UseGuards(AuthGuard, RolesGuard)
export class AccessController {
  constructor(private readonly access: AccessService) {}

  /** Lo que ve y puede hacer el usuario de la sesion: arma el menu y la pantalla de inicio. */
  @Version("1")
  @Get("me")
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.access.forUser(user);
  }

  @Version("1")
  @Get("roles")
  @Roles(Role.admin)
  matrix() {
    return this.access.matrix();
  }

  @Version("1")
  @Put("roles/:role")
  @Roles(Role.admin)
  setRole(@Param("role", new ParseEnumPipe(Role)) role: Role, @Body() dto: RolePermissionDto) {
    return this.access.setRole(role, dto.tabs, dto.actions);
  }
}
