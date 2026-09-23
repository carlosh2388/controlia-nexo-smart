import { Injectable, NotFoundException } from "@nestjs/common";
import { DeviceKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { HistoryRange } from "./dto/device-history-query.dto";

function sinceFor(range: HistoryRange): Date {
  const now = new Date();
  switch (range) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "15d":
      return new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
}

@Injectable()
export class DeviceHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getHistory(deviceId: string, range: HistoryRange = "today") {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new NotFoundException("Dispositivo no encontrado");
    if (device.kind !== DeviceKind.sensor) {
      throw new NotFoundException(`"${device.name}" no es un sensor; no tiene historico de lecturas`);
    }

    const since = sinceFor(range);
    const rows = await this.prisma.deviceReading.findMany({
      where: { deviceId, recordedAt: { gte: since } },
      orderBy: { recordedAt: "asc" },
      select: { recordedAt: true, readings: true },
    });

    return {
      deviceId,
      deviceName: device.name,
      range,
      points: rows.map((r) => ({ t: r.recordedAt.toISOString(), ...(r.readings as Record<string, unknown>) })),
    };
  }
}
