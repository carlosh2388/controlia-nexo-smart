import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AccessController } from "./access.controller";
import { AccessService } from "./access.service";
import { ActionGuard } from "./action.guard";

/** Perfiles y permisos del menu (Usuarios y permisos). Global: otros modulos usan ActionGuard. */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AccessController],
  providers: [AccessService, ActionGuard],
  exports: [AccessService, ActionGuard],
})
export class AccessModule {}
