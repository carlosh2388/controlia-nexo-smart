import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AuthModule } from "../auth/auth.module";
import { RedController } from "./red.controller";
import { RedService } from "./red.service";
import { GravixService } from "./gravix.service";
import { GravixProxyInterceptor } from "./gravix-proxy.interceptor";

/** Solo en el servidor central (GRAVIX_MODO=central): red por fases y sedes Gravix. */
@Module({
  imports: [AuthModule],
  controllers: [RedController],
  providers: [RedService, GravixService, { provide: APP_INTERCEPTOR, useClass: GravixProxyInterceptor }],
  exports: [GravixService],
})
export class RedModule {}
