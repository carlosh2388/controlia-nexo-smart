import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { DeviceKind, Prisma } from "@prisma/client";
import type { Subscription } from "rxjs";
import { PrismaService } from "../prisma/prisma.service";
import { DeviceStateBus } from "../state-bus/device-state-bus.service";

/**
 * Guarda cada lectura con datos (readings) de un sensor en DeviceReading, para poder graficar
 * tendencias por fecha. Solo dispositivos kind=sensor (LoRaWAN LEO-S592 por ahora): los de
 * climatizacion BACnet se sondean cada 10s y generarian demasiado volumen sin que se haya
 * pedido historial para ellos todavia.
 */
@Injectable()
export class DeviceHistoryRecorderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("DeviceHistoryRecorder");
  private subscription?: Subscription;
  private readonly kindCache = new Map<string, DeviceKind>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateBus: DeviceStateBus,
  ) {}

  onModuleInit() {
    this.subscription = this.stateBus.events$.subscribe((event) => {
      if (!event.readings) return;
      this.recordIfSensor(event.deviceId, event.readings).catch((err) => {
        this.logger.warn(`No se pudo guardar historico de "${event.deviceId}": ${(err as Error).message}`);
      });
    });
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
  }

  private async recordIfSensor(deviceId: string, readings: Record<string, unknown>) {
    let kind = this.kindCache.get(deviceId);
    if (!kind) {
      const device = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { kind: true } });
      if (!device) return;
      kind = device.kind;
      this.kindCache.set(deviceId, kind);
    }
    if (kind !== DeviceKind.sensor) return;

    await this.prisma.deviceReading.create({
      data: { deviceId, readings: readings as Prisma.InputJsonValue },
    });
  }
}
