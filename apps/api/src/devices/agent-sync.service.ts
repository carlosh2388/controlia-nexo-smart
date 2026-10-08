import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EventLogService } from "../events/event-log.service";
import { AgentSyncDto } from "./dto/agent-sync.dto";

export interface AgentMetadata {
  buildingKey: string;
  externalId: string;
  source: "go-agent";
  discoveredAt: string;
  pendingReview: boolean;
}

/**
 * Recibe el lote de un Agente_Go y hace upsert directo en Device/DeviceState, saltandose
 * DevicesService.create()/update() a proposito: esos metodos llaman a
 * `adapterRegistry.resolve(protocol).onDeviceRegistered()`, que es para que el adaptador
 * EN PROCESO (mqtt/http/bacnet dentro de esta misma API) empiece a manejar el dispositivo.
 * Un dispositivo que llega por un Agente_Go ya esta siendo escuchado por ese agente en la
 * red del edificio remoto - si tambien lo registraramos en un adaptador local, competirian
 * por el mismo dispositivo (o el adaptador local fallaria por no poder alcanzar esa red).
 *
 * Los dispositivos nuevos quedan con areaId=null y metadata.agent.pendingReview=true: el
 * mapeo a un area/sala real siempre lo hace un humano despues (ver docs/agente-go.md,
 * seccion "Por que el mapeo semantico no se automatiza").
 */
@Injectable()
export class AgentSyncService {
  private readonly logger = new Logger(AgentSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventLog: EventLogService,
  ) {}

  async sync(dto: AgentSyncDto) {
    let created = 0;
    let updated = 0;
    let skippedExisting = 0;
    // Cuenta TODO lo que el agente vio en esta pasada, incluido lo que ya existia por otra via -
    // esto es lo que responde "cuantos dispositivos por protocolo esta autodescubriendo de verdad",
    // que es distinto de "cuantos dispositivos nuevos crea" (un edificio ya totalmente importado
    // puede autodescubrir 30 dispositivos reales y crear 0 filas nuevas - eso no es una falla).
    const byProtocol: Record<string, number> = {};

    for (const item of dto.devices) {
      byProtocol[item.protocol] = (byProtocol[item.protocol] ?? 0) + 1;
      const existing = await this.prisma.device.findFirst({
        where: {
          AND: [
            { metadata: { path: ["agent", "buildingKey"], equals: dto.buildingKey } },
            { metadata: { path: ["agent", "externalId"], equals: item.externalId } },
          ],
        },
      });

      // No es un dispositivo que ya trajo ESTE agente - pero puede que ya exista igual, importado
      // por un camino distinto (BacnetImportService, el adaptador LoRaWAN en proceso, un import
      // manual de Zigbee2MQTT). Si es asi, ni se crea ni se toca: ese dispositivo ya tiene su
      // adaptador original escribiendole el estado y probablemente ya tiene area asignada -
      // duplicarlo o pelearle el estado seria exactamente el problema que esto evita.
      if (!existing) {
        const foreign = await this.findExistingByPhysicalIdentity(item);
        if (foreign) {
          skippedExisting += 1;
          continue;
        }
      }

      if (existing) {
        await this.applyState(existing.id, item);

        // Si el dispositivo se creo antes de que el source supiera reportar topics (o con otra
        // version del agente), completarlos ahora: pasa de "solo lectura" a controlable sin
        // duplicar el dispositivo ni pedirle al usuario que lo re-confirme.
        const needsNameUpdate = item.name !== existing.name;
        const needsTopicUpdate =
          (item.stateTopic && item.stateTopic !== existing.stateTopic) ||
          (item.commandTopic && item.commandTopic !== existing.commandTopic);
        if (needsNameUpdate || needsTopicUpdate) {
          let metadata: Record<string, unknown> | undefined;
          if (item.mqttJson) {
            metadata = { ...((existing.metadata as Record<string, unknown> | null) ?? {}), mqttJson: item.mqttJson };
          }
          await this.prisma.device.update({
            where: { id: existing.id },
            data: {
              name: item.name,
              stateTopic: item.stateTopic ?? undefined,
              commandTopic: item.commandTopic ?? undefined,
              metadata: metadata as Prisma.InputJsonValue | undefined,
            },
          });
        }
        updated += 1;
      } else {
        const metadata: { agent: AgentMetadata; mqttJson?: unknown } = {
          agent: {
            buildingKey: dto.buildingKey,
            externalId: item.externalId,
            source: "go-agent",
            discoveredAt: new Date().toISOString(),
            pendingReview: true,
          },
        };
        if (item.mqttJson) metadata.mqttJson = item.mqttJson;

        const device = await this.prisma.device.create({
          data: {
            name: item.name,
            protocol: item.protocol,
            kind: item.kind,
            stateTopic: item.stateTopic,
            commandTopic: item.commandTopic,
            payloadOn: "ON",
            payloadOff: "OFF",
            metadata: metadata as unknown as Prisma.InputJsonValue,
          },
        });
        await this.applyState(device.id, item);
        created += 1;
      }
    }

    await this.eventLog.log({
      type: "agent.sync",
      message: `Agente "${dto.buildingKey}" sincronizo ${dto.devices.length} dispositivo(s) (${created} nuevos, ${updated} actualizados, ${skippedExisting} ya existian por otra via)`,
      payload: {
        buildingKey: dto.buildingKey,
        agentVersion: dto.agentVersion,
        created,
        updated,
        skippedExisting,
        byProtocol,
        syncedAt: new Date().toISOString(),
      },
    });

    this.logger.log(
      `agent-sync buildingKey=${dto.buildingKey} total=${dto.devices.length} created=${created} updated=${updated} skippedExisting=${skippedExisting}`,
    );

    return { total: dto.devices.length, created, updated, skippedExisting, byProtocol };
  }

  /**
   * Ultimo sync reportado por cada buildingKey (uno por agente activo) - lee el ultimo EventLog
   * "agent.sync" de cada uno. Es lo que alimenta el panel "Actividad del agente" en el frontend:
   * responde "esta funcionando de verdad" aunque no haya creado ningun dispositivo nuevo.
   */
  async getStatus() {
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

  /**
   * Busca un dispositivo YA EXISTENTE (creado por cualquier via, no solo por un agente) que sea
   * fisicamente el mismo que el agente acaba de reportar, usando la identidad real de cada
   * protocolo - no el externalId del agente, que un import manual nunca conoce:
   *  - mqtt: mismo stateTopic (el topico real del broker es la identidad fisica del dispositivo).
   *  - lorawan: mismo devEui (asi identifica el adaptador LoRaWAN en proceso a sus sensores).
   *  - bacnet: mismo host + unitKey (asi los identifica BacnetImportService/BacnetAdapterService).
   */
  private async findExistingByPhysicalIdentity(
    item: AgentSyncDto["devices"][number],
  ): Promise<{ id: string } | null> {
    if (item.protocol === "mqtt" && item.stateTopic) {
      return this.prisma.device.findFirst({
        where: { protocol: "mqtt", stateTopic: item.stateTopic },
        select: { id: true },
      });
    }

    if (item.protocol === "lorawan") {
      const devEui = item.externalId.split(":")[1];
      if (!devEui) return null;
      return this.prisma.device.findFirst({
        where: { protocol: "lorawan", metadata: { path: ["devEui"], equals: devEui } },
        select: { id: true },
      });
    }

    if (item.protocol === "bacnet") {
      const [, host, unitKey] = item.externalId.split(":");
      if (!host || !unitKey) return null;
      return this.prisma.device.findFirst({
        where: {
          protocol: "bacnet",
          AND: [
            { metadata: { path: ["bacnet", "host"], equals: host } },
            { metadata: { path: ["bacnet", "unitKey"], equals: unitKey } },
          ],
        },
        select: { id: true },
      });
    }

    return null;
  }

  /**
   * Un sensor (temperatura/humedad/etc.) no siempre trae "state" on/off - solo lecturas. Si
   * gateamos esto con "sin state, no hago nada" (como estaba antes), un sensor real nunca
   * guarda sus lecturas. "online" default al crear replica la misma convencion que ya usan
   * los sensores LoRaWAN existentes (Device.state.state = "online"/"offline", no on/off).
   */
  private async applyState(deviceId: string, item: AgentSyncDto["devices"][number]) {
    if (!item.state && !item.readings) return;

    await this.prisma.deviceState.upsert({
      where: { deviceId },
      create: {
        deviceId,
        state: item.state ?? "online",
        readings: item.readings as Prisma.InputJsonValue | undefined,
      },
      update: {
        ...(item.state ? { state: item.state } : {}),
        ...(item.readings ? { readings: item.readings as Prisma.InputJsonValue } : {}),
      },
    });
  }
}
