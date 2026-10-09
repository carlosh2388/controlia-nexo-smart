import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AgentEventDto, ListSiteEventsQueryDto } from "./dto/site-event.dto";

/**
 * Historial de eventos de las sedes. Los eventos los detecta el Agente_Go en tiempo real (es el
 * que ve cada lectura); la API solo los guarda de forma idempotente y los sirve con filtros.
 */
@Injectable()
export class SiteEventsService {
  private readonly logger = new Logger(SiteEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(buildingKey: string, events: AgentEventDto[]): Promise<number> {
    if (!events.length) return 0;

    // externalId -> deviceId, para poder consultar los eventos de un equipo concreto.
    const externalIds = [...new Set(events.map((e) => e.externalId).filter((x): x is string => !!x))];
    const deviceIdByExternal = new Map<string, string>();
    if (externalIds.length) {
      const devices = await this.prisma.device.findMany({
        where: {
          AND: [
            { metadata: { path: ["agent", "buildingKey"], equals: buildingKey } },
            { OR: externalIds.map((x) => ({ metadata: { path: ["agent", "externalId"], equals: x } })) },
          ],
        },
        select: { id: true, metadata: true },
      });
      for (const d of devices) {
        const ext = ((d.metadata as Record<string, any> | null)?.agent?.externalId ?? "") as string;
        if (ext) deviceIdByExternal.set(ext, d.id);
      }
    }

    const result = await this.prisma.siteEvent.createMany({
      data: events.map((e) => ({
        agentEventId: e.id,
        buildingKey,
        deviceId: e.externalId ? deviceIdByExternal.get(e.externalId) ?? null : null,
        externalId: e.externalId ?? null,
        type: e.type,
        severity: e.severity,
        message: e.message,
        value: e.value ?? null,
        data: (e.data ?? undefined) as Prisma.InputJsonValue | undefined,
        occurredAt: new Date(e.occurredAt),
      })),
      skipDuplicates: true,
    });
    if (result.count) this.logger.log(`${buildingKey}: ${result.count} evento(s) nuevo(s)`);
    return result.count;
  }

  async list(buildingKey: string, q: ListSiteEventsQueryDto) {
    const where: Prisma.SiteEventWhereInput = { buildingKey };
    if (q.deviceId) where.deviceId = q.deviceId;
    if (q.severity) where.severity = q.severity;
    if (q.type) where.type = { startsWith: q.type };
    if (q.from || q.to) {
      where.occurredAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }

    const [events, bySeverity] = await Promise.all([
      this.prisma.siteEvent.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        take: q.limit ?? 200,
        include: { device: { select: { id: true, name: true } } },
      }),
      this.prisma.siteEvent.groupBy({ by: ["severity"], where, _count: { _all: true } }),
    ]);

    return {
      buildingKey,
      counts: Object.fromEntries(bySeverity.map((s) => [s.severity, s._count._all])),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        severity: e.severity,
        message: e.message,
        value: e.value,
        data: e.data,
        occurredAt: e.occurredAt.toISOString(),
        deviceId: e.deviceId,
        deviceName: e.device?.name ?? null,
        externalId: e.externalId,
      })),
    };
  }
}
