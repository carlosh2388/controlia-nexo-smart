import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AccessService } from "./access.service";
import type { Action } from "./access.constants";

export const ACTION_KEY = "requiredAction";
/** La ruta exige que el perfil del usuario tenga esta accion (ej. "excel"). Va despues de AuthGuard. */
export const RequireAction = (action: Action) => SetMetadata(ACTION_KEY, action);

@Injectable()
export class ActionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<Action>(ACTION_KEY, [context.getHandler(), context.getClass()]);
    if (!action) return true;
    const user = context.switchToHttp().getRequest().user;
    if (!user || !(await this.access.can(user, action))) {
      throw new ForbiddenException("Su perfil no tiene permiso para esta accion");
    }
    return true;
  }
}
