import { ForbiddenException, Injectable } from "@nestjs/common";
import { Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { ACTIONS, TABS, TAB_ADMIN_ONLY, TAB_ALWAYS, type Action } from "./access.constants";

export interface Access {
  role: Role;
  tabs: string[];
  actions: string[];
  /** Ids de las sedes del centro de mando que puede ver; vacio = todas. */
  sites: string[];
  homeTab: string;
}

const ALL: Pick<Access, "tabs" | "actions"> = { tabs: [...TABS], actions: [...ACTIONS] };

@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Permisos de cada perfil editable (operator, viewer). */
  async matrix() {
    const rows = await this.prisma.rolePermission.findMany();
    const of = (role: Role) => rows.find((r) => r.role === role) ?? { tabs: [TAB_ALWAYS], actions: [] };
    return {
      tabs: TABS,
      actions: ACTIONS,
      roles: {
        admin: ALL,
        operator: { tabs: of(Role.operator).tabs, actions: of(Role.operator).actions },
        viewer: { tabs: of(Role.viewer).tabs, actions: of(Role.viewer).actions },
      },
    };
  }

  async setRole(role: Role, tabs: string[], actions: string[]) {
    if (role !== Role.operator && role !== Role.viewer) {
      throw new ForbiddenException("Solo se editan los perfiles Operador y Consulta");
    }
    const cleanTabs = Array.from(new Set([TAB_ALWAYS, ...tabs.filter((t) => (TABS as readonly string[]).includes(t) && t !== TAB_ADMIN_ONLY)]));
    const cleanActions = Array.from(new Set(actions.filter((a) => (ACTIONS as readonly string[]).includes(a))));
    await this.prisma.rolePermission.upsert({
      where: { role },
      update: { tabs: cleanTabs, actions: cleanActions },
      create: { role, tabs: cleanTabs, actions: cleanActions },
    });
    return this.matrix();
  }

  /** Permisos efectivos de quien hace la peticion. Una API key no tiene menu ni sedes restringidas. */
  async forUser(user: AuthenticatedUser): Promise<Access> {
    if (user.authType !== "user") return { role: user.role, ...ALL, sites: [], homeTab: TAB_ALWAYS };
    const u = await this.prisma.user.findUnique({ where: { id: user.id } });
    const role = u?.role ?? user.role;
    const perm = role === Role.admin ? ALL : (await this.prisma.rolePermission.findUnique({ where: { role } })) ?? { tabs: [TAB_ALWAYS], actions: [] };
    const tabs = Array.from(new Set([TAB_ALWAYS, ...perm.tabs]));
    const home = u?.homeTab && tabs.includes(u.homeTab) ? u.homeTab : TAB_ALWAYS;
    return { role, tabs, actions: perm.actions, sites: u?.sites ?? [], homeTab: home };
  }

  async can(user: AuthenticatedUser, action: Action) {
    const a = await this.forUser(user);
    return a.actions.includes(action);
  }

  /** true si el usuario puede ver la sede (sites vacio = todas). */
  static seesSite(access: Access, siteId: string) {
    return access.sites.length === 0 || access.sites.includes(siteId);
  }
}
