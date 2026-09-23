import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { createHash, randomUUID } from "crypto";
import ms from "../common/ms";
import { PrismaService } from "../prisma/prisma.service";
import { EventLogService } from "../events/event-log.service";
import type { AccessTokenPayload, AuthenticatedUser } from "./auth.types";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly eventLog: EventLogService,
  ) {}

  async validateCredentials(username: string, password: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({ where: { username } });
    if (!user) {
      throw new UnauthorizedException("Credenciales invalidas");
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      throw new UnauthorizedException("Credenciales invalidas");
    }

    return { id: user.id, username: user.username, role: user.role, authType: "user" };
  }

  async issueTokenPair(user: AuthenticatedUser): Promise<TokenPair> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>("JWT_ACCESS_SECRET"),
      expiresIn: this.configService.get<string>("JWT_ACCESS_EXPIRES_IN", "15m"),
    });

    const refreshExpiresIn = this.configService.get<string>("JWT_REFRESH_EXPIRES_IN", "7d");
    const refreshToken = await this.jwtService.signAsync({ ...payload, jti: randomUUID() }, {
      secret: this.configService.get<string>("JWT_REFRESH_SECRET"),
      expiresIn: refreshExpiresIn,
    });

    await this.prisma.refreshToken.create({
      data: {
        tokenHash: hashToken(refreshToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + ms(refreshExpiresIn)),
      },
    });

    return { accessToken, refreshToken };
  }

  async login(username: string, password: string): Promise<TokenPair> {
    const user = await this.validateCredentials(username, password);
    const tokens = await this.issueTokenPair(user);
    await this.eventLog.log({
      type: "auth.login",
      message: `Usuario ${user.username} inicio sesion`,
      userId: user.id,
    });
    return tokens;
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(refreshToken, {
        secret: this.configService.get<string>("JWT_REFRESH_SECRET"),
      });
    } catch {
      throw new UnauthorizedException("Refresh token invalido o expirado");
    }

    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token invalido o revocado");
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      throw new UnauthorizedException("Usuario no encontrado");
    }

    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      username: user.username,
      role: user.role,
      authType: "user",
    };
    const tokens = await this.issueTokenPair(authenticatedUser);

    await this.prisma.refreshToken.update({
      where: { tokenHash },
      data: {
        revokedAt: new Date(),
        replacedByTokenHash: hashToken(tokens.refreshToken),
      },
    });

    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
