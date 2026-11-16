import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards, Version } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthGuard } from "../auth/guards/auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { UsersService } from "./users.service";
import { CreateUserDto, SetPasswordDto, UpdateUserDto } from "./dto/create-user.dto";

@Controller("users")
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.admin)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Version("1")
  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Version("1")
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Version("1")
  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.usersService.update(id, dto, actor.id);
  }

  @Version("1")
  @Post(":id/password")
  @HttpCode(HttpStatus.NO_CONTENT)
  async setPassword(@Param("id") id: string, @Body() dto: SetPasswordDto) {
    await this.usersService.setPassword(id, dto.password);
  }

  @Version("1")
  @Delete(":id")
  remove(@Param("id") id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.usersService.remove(id, actor.id);
  }
}
