import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Role } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { CreateUserDto, UpdateUserDto } from "./dto/create-user.dto";

const SAFE_SELECT = {
  id: true,
  username: true,
  role: true,
  fullName: true,
  email: true,
  sites: true,
  homeTab: true,
  active: true,
  receivesAlarmEmails: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.user.findMany({ select: SAFE_SELECT, orderBy: { username: "asc" } });
  }

  async create(dto: CreateUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { username: dto.username } });
    if (existing) {
      throw new ConflictException("El nombre de usuario ya existe");
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const { password: _password, ...rest } = dto;
    return this.prisma.user.create({
      data: { ...rest, passwordHash },
      select: SAFE_SELECT,
    });
  }

  async update(id: string, dto: UpdateUserDto, actorId?: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException("Usuario no encontrado");
    // Que nadie se quede sin administrador: el ultimo admin activo no se degrada ni se desactiva.
    if (user.role === Role.admin && ((dto.role && dto.role !== Role.admin) || dto.active === false)) {
      const admins = await this.prisma.user.count({ where: { role: Role.admin, active: true } });
      if (admins <= 1) throw new BadRequestException("Es el unico administrador activo: no se puede quitar");
    }
    if (actorId === id && dto.active === false) throw new BadRequestException("No puede desactivar su propio usuario");
    return this.prisma.user.update({ where: { id }, data: dto, select: SAFE_SELECT });
  }

  async setPassword(id: string, password: string) {
    const passwordHash = await bcrypt.hash(password, 12);
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });
    // Cierra las sesiones abiertas de ese usuario.
    await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async remove(id: string, actorId?: string) {
    if (actorId === id) throw new BadRequestException("No puede eliminar su propio usuario");
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (user?.role === Role.admin && (await this.prisma.user.count({ where: { role: Role.admin } })) <= 1) {
      throw new BadRequestException("Es el unico administrador: no se puede eliminar");
    }
    await this.prisma.user.delete({ where: { id } });
  }
}
