import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { CommandAction, CommandStatus, DeviceProtocol } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AdapterRegistry } from "../adapters/adapter-registry.service";
import { EventLogService } from "../events/event-log.service";
import { CreateDeviceDto } from "./dto/create-device.dto";
import { UpdateDeviceDto } from "./dto/update-device.dto";
import { COMMANDS_QUEUE } from "./devices.constants";
import { restoreRedactedSecrets, sanitizeDevice } from "./device-secrets.util";

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapterRegistry: AdapterRegistry,
    private readonly eventLog: EventLogService,
    @InjectQueue(COMMANDS_QUEUE) private readonly commandsQueue: Queue,
  ) {}

  async findAll(protocols?: DeviceProtocol[]) {
    const devices = await this.prisma.device.findMany({
      where: protocols?.length ? { protocol: { in: protocols } } : undefined,
      include: { state: true },
      orderBy: { name: "asc" },
    });
    return devices.map(sanitizeDevice);
  }

  async findOne(id: string) {
    const device = await this.prisma.device.findUnique({
      where: { id },
      include: { state: true },
    });
    if (!device) {
      throw new NotFoundException("Dispositivo no encontrado");
    }
    return sanitizeDevice(device);
  }

  async create(dto: CreateDeviceDto) {
    const metadata: Record<string, unknown> = {};
    if (dto.httpConfig) metadata.http = dto.httpConfig;
    if (dto.group) metadata.group = dto.group;
    if (dto.hidden !== undefined) metadata.hidden = dto.hidden;
    if (dto.ewelinkConfig) metadata.ewelink = dto.ewelinkConfig;
    if (dto.mqttJson) metadata.mqttJson = dto.mqttJson;
    if (dto.bacnetConfig) metadata.bacnet = dto.bacnetConfig;

    const device = await this.prisma.device.create({
      data: {
        name: dto.name,
        protocol: dto.protocol,
        kind: dto.kind,
        commandTopic: dto.commandTopic,
        stateTopic: dto.stateTopic,
        payloadOn: dto.payloadOn ?? "ON",
        payloadOff: dto.payloadOff ?? "OFF",
        httpBaseUrl: dto.httpBaseUrl,
        areaId: dto.areaId || undefined,
        metadata: Object.keys(metadata).length ? (metadata as object) : undefined,
      },
    });

    await this.adapterRegistry.resolve(device.protocol).onDeviceRegistered(device);
    await this.eventLog.log({
      type: "device.registered",
      message: `Dispositivo "${device.name}" registrado (${device.protocol})`,
      deviceId: device.id,
    });

    return sanitizeDevice(device);
  }

  async update(id: string, dto: UpdateDeviceDto) {
    const existing = await this.prisma.device.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException("Dispositivo no encontrado");
    }
    restoreRedactedSecrets(existing.metadata, dto);

    let metadata: Record<string, unknown> | undefined;
    if (dto.httpConfig || dto.group || dto.hidden !== undefined || dto.ewelinkConfig || dto.mqttJson || dto.bacnetConfig) {
      metadata = { ...((existing.metadata as Record<string, unknown> | null) ?? {}) };
      if (dto.httpConfig) metadata.http = dto.httpConfig;
      if (dto.group) metadata.group = dto.group;
      if (dto.hidden !== undefined) metadata.hidden = dto.hidden;
      if (dto.ewelinkConfig) metadata.ewelink = dto.ewelinkConfig;
      if (dto.mqttJson) metadata.mqttJson = dto.mqttJson;
      if (dto.bacnetConfig) metadata.bacnet = dto.bacnetConfig;
    }

    const device = await this.prisma.device.update({
      where: { id },
      data: {
        name: dto.name,
        protocol: dto.protocol,
        kind: dto.kind,
        commandTopic: dto.commandTopic,
        stateTopic: dto.stateTopic,
        payloadOn: dto.payloadOn,
        payloadOff: dto.payloadOff,
        httpBaseUrl: dto.httpBaseUrl,
        areaId: dto.areaId === undefined ? undefined : dto.areaId === "" ? null : dto.areaId,
        metadata: metadata as object | undefined,
      },
    });

    // Re-registra el dispositivo en su adaptador para que recargue la config (ej. reinicia el polling HTTP con la nueva plantilla).
    await this.adapterRegistry.resolve(device.protocol).onDeviceRegistered(device);
    await this.eventLog.log({
      type: "device.updated",
      message: `Dispositivo "${device.name}" actualizado`,
      deviceId: device.id,
    });

    if (existing.protocol !== device.protocol) {
      await this.eventLog.log({
        type: "device.protocol_changed",
        message: `Dispositivo "${device.name}" cambio de protocolo ${existing.protocol} -> ${device.protocol}; el adaptador anterior puede seguir escuchando su configuracion previa`,
        deviceId: device.id,
      });
    }

    return this.findOne(device.id);
  }

  async remove(id: string) {
    const device = await this.findOne(id);
    await this.prisma.device.delete({ where: { id } });
    await this.eventLog.log({
      type: "device.deleted",
      message: `Dispositivo "${device.name}" eliminado`,
      deviceId: id,
    });
  }

  /** Encola el comando; el CommandsProcessor lo despacha al adaptador correspondiente de forma asincrona con reintentos. */
  async sendCommand(
    deviceId: string,
    action: CommandAction,
    options: { userId?: string; ruleId?: string; delayMs?: number } = {},
  ) {
    const device = await this.findOne(deviceId);

    const command = await this.prisma.command.create({
      data: {
        deviceId: device.id,
        action,
        status: CommandStatus.pending,
        requestedBy: options.userId,
        triggeredById: options.ruleId,
      },
    });

    await this.commandsQueue.add(
      "dispatch",
      { commandId: command.id },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        delay: options.delayMs,
      },
    );

    return command;
  }
}
