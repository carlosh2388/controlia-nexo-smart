import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { EventLogService } from "../events/event-log.service";
import { ownerUserId, type AuthenticatedUser } from "../auth/auth.types";
import { maskSecrets, restoreSecrets, validateAgentConfig, type AgentProtocolsConfig } from "./agent-config.util";
import type { ConfigAppliedDto, RequestScanDto, ScanResultDto, UpdateAgentConfigDto } from "./dto/agents.dto";

/**
 * Configuracion remota de los Agente_Go y descubrimiento de equipos en la red de cada sede.
 *
 * El agente no expone puertos: todo lo inicia el. Cada pocos segundos consulta GET /control; si la
 * version de config subio la descarga y la aplica sin reiniciar, y si hay un escaneo pendiente lo
 * ejecuta y sube el resultado. La web solo escribe aca y lee el avance.
 */
@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventLog: EventLogService,
  ) {}

  /** Ultimo sync de cada buildingKey (lee el ultimo EventLog "agent.sync" de cada uno). */
  async latestSyncs() {
    const recent = await this.prisma.eventLog.findMany({
      where: { type: "agent.sync" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const latestByBuilding = new Map<string, (typeof recent)[number]>();
    for (const entry of recent) {
      const buildingKey = (entry.payload as Record<string, unknown> | null)?.buildingKey as string | undefined;
      if (!buildingKey || latestByBuilding.has(buildingKey)) continue;
      latestByBuilding.set(buildingKey, entry);
    }

    return [...latestByBuilding.entries()].map(([buildingKey, entry]) => ({
      buildingKey,
      ...(entry.payload as Record<string, unknown>),
    }));
  }

  /** Agentes conocidos (con config guardada o que alguna vez sincronizaron) y su estado. */
  async list() {
    const [configs, syncs] = await Promise.all([this.prisma.agentConfig.findMany(), this.latestSyncs()]);
    const keys = new Set([...configs.map((c) => c.buildingKey), ...syncs.map((s) => s.buildingKey)]);
    return [...keys].sort().map((buildingKey) => {
      const cfg = configs.find((c) => c.buildingKey === buildingKey);
      return {
        buildingKey,
        hasConfig: !!cfg,
        version: cfg?.version ?? null,
        appliedVersion: cfg?.appliedVersion ?? null,
        appliedAt: cfg?.appliedAt?.toISOString() ?? null,
        applyError: cfg?.applyError ?? null,
        updatedAt: cfg?.updatedAt.toISOString() ?? null,
        lastSync: syncs.find((s) => s.buildingKey === buildingKey) ?? null,
      };
    });
  }

  async getConfig(buildingKey: string, user: AuthenticatedUser) {
    const row = await this.prisma.agentConfig.findUnique({ where: { buildingKey } });
    if (!row) throw new NotFoundException(`El agente "${buildingKey}" todavia no tiene configuracion remota`);
    const config = row.config as AgentProtocolsConfig;
    return {
      buildingKey,
      version: row.version,
      appliedVersion: row.appliedVersion,
      appliedAt: row.appliedAt?.toISOString() ?? null,
      applyError: row.applyError,
      updatedAt: row.updatedAt.toISOString(),
      // Solo el propio agente recibe contraseñas y llaves; la web las ve enmascaradas.
      config: user.role === Role.agent ? config : maskSecrets(config),
    };
  }

  async updateConfig(buildingKey: string, dto: UpdateAgentConfigDto, user: AuthenticatedUser) {
    const current = await this.prisma.agentConfig.findUnique({ where: { buildingKey } });
    if (current && dto.baseVersion !== undefined && dto.baseVersion !== current.version) {
      throw new ConflictException(
        `Alguien guardo la version ${current.version} mientras editabas la ${dto.baseVersion}. Recarga para ver sus cambios.`,
      );
    }
    const config = restoreSecrets(validateAgentConfig(dto.config), (current?.config as AgentProtocolsConfig) ?? null);

    const row = current
      ? await this.prisma.agentConfig.update({
          where: { buildingKey },
          data: {
            config: config as Prisma.InputJsonValue,
            version: { increment: 1 },
            applyError: null,
            updatedById: ownerUserId(user) ?? null,
          },
        })
      : await this.prisma.agentConfig.create({
          data: { buildingKey, config: config as Prisma.InputJsonValue, updatedById: ownerUserId(user) ?? null },
        });

    await this.eventLog.log({
      type: "agent.config",
      userId: ownerUserId(user),
      message: `Configuracion del agente "${buildingKey}" guardada como v${row.version}`,
      payload: { buildingKey, version: row.version },
    });
    return this.getConfig(buildingKey, user);
  }

  /**
   * Primera conexion de un agente que todavia no tiene config remota: sube la de su config.yaml para
   * que se pueda editar desde la web sin volver a cargar todo a mano. Si ya existe, no la pisa.
   */
  async seed(buildingKey: string, rawConfig: Record<string, unknown>, user: AuthenticatedUser) {
    const existing = await this.prisma.agentConfig.findUnique({ where: { buildingKey } });
    if (!existing) {
      const config = validateAgentConfig(rawConfig);
      await this.prisma.agentConfig.create({
        data: { buildingKey, config: config as Prisma.InputJsonValue, appliedVersion: 1, appliedAt: new Date() },
      });
      this.logger.log(`${buildingKey}: config remota creada desde el config.yaml del agente`);
    }
    return this.getConfig(buildingKey, user);
  }

  /** Lo consulta el agente cada pocos segundos: version vigente y escaneo pendiente. */
  async control(buildingKey: string) {
    const row = await this.prisma.agentConfig.findUnique({
      where: { buildingKey },
      select: { version: true, scanRequest: true },
    });
    return { configVersion: row?.version ?? 0, scan: row?.scanRequest ?? null };
  }

  async reportApplied(buildingKey: string, dto: ConfigAppliedDto) {
    const row = await this.prisma.agentConfig.findUnique({ where: { buildingKey } });
    if (!row) throw new NotFoundException(`El agente "${buildingKey}" no tiene configuracion remota`);
    await this.prisma.agentConfig.update({
      where: { buildingKey },
      data: dto.rejected
        ? { applyError: dto.error ?? "Config rechazada por el agente" }
        : { appliedVersion: dto.version, appliedAt: new Date(), applyError: dto.error ?? null },
    });
    await this.eventLog.log({
      type: "agent.config.applied",
      message: dto.rejected
        ? `El agente "${buildingKey}" rechazo la v${dto.version}: ${dto.error}`
        : `El agente "${buildingKey}" aplico la configuracion v${dto.version}${dto.error ? ` (con problemas: ${dto.error})` : ""}`,
      payload: { buildingKey, version: dto.version, error: dto.error ?? null, rejected: !!dto.rejected },
    });
    return { ok: true };
  }

  async requestScan(buildingKey: string, dto: RequestScanDto) {
    const row = await this.prisma.agentConfig.findUnique({ where: { buildingKey } });
    if (!row) throw new NotFoundException(`El agente "${buildingKey}" todavia no se conecto con configuracion remota`);
    const id = randomUUID();
    const requestedAt = new Date().toISOString();
    await this.prisma.agentConfig.update({
      where: { buildingKey },
      data: {
        scanRequest: { id, requestedAt, items: dto.items } as unknown as Prisma.InputJsonValue,
        scanResult: { id, status: "pending", requestedAt, results: [] } as Prisma.InputJsonValue,
      },
    });
    return { id, status: "pending", requestedAt, results: [] };
  }

  async getScan(buildingKey: string) {
    const row = await this.prisma.agentConfig.findUnique({ where: { buildingKey }, select: { scanResult: true } });
    return row?.scanResult ?? null;
  }

  async reportScan(buildingKey: string, scanId: string, dto: ScanResultDto) {
    const row = await this.prisma.agentConfig.findUnique({ where: { buildingKey } });
    const current = row?.scanResult as Record<string, unknown> | null | undefined;
    // Un resultado de un escaneo viejo (la web pidio otro mientras tanto) se descarta.
    if (!row || current?.id !== scanId) return { ok: false };
    const finished = dto.status !== "running";
    await this.prisma.agentConfig.update({
      where: { buildingKey },
      data: {
        scanResult: { ...current, ...dto, id: scanId } as unknown as Prisma.InputJsonValue,
        ...(finished ? { scanRequest: Prisma.DbNull } : {}),
      },
    });
    return { ok: true };
  }
}
