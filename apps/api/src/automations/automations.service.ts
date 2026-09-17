import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EventLogService } from "../events/event-log.service";
import { CreateAutomationRuleDto } from "./dto/create-automation-rule.dto";
import { UpdateAutomationRuleDto } from "./dto/update-automation-rule.dto";
import { RULE_INCLUDE } from "./automations.constants";

@Injectable()
export class AutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventLog: EventLogService,
  ) {}

  findAll() {
    return this.prisma.automationRule.findMany({
      include: RULE_INCLUDE,
      orderBy: { name: "asc" },
    });
  }

  async findOne(id: string) {
    const rule = await this.prisma.automationRule.findUnique({
      where: { id },
      include: RULE_INCLUDE,
    });
    if (!rule) {
      throw new NotFoundException("Regla de automatizacion no encontrada");
    }
    return rule;
  }

  async findExecutions(id: string) {
    await this.findOne(id);
    return this.prisma.ruleExecution.findMany({
      where: { ruleId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async create(dto: CreateAutomationRuleDto, userId?: string) {
    const rule = await this.prisma.automationRule.create({
      data: {
        name: dto.name,
        description: dto.description,
        enabled: dto.enabled ?? true,
        createdBy: userId,
        triggers: {
          create: dto.triggers.map((t) => ({
            type: t.type,
            deviceId: t.deviceId,
            operator: t.operator,
            value: t.value,
            scheduleTime: t.scheduleTime,
            scheduleDays: t.scheduleDays ?? [],
          })),
        },
        conditions: {
          create: (dto.conditions ?? []).map((c) => ({ deviceId: c.deviceId, operator: c.operator, value: c.value })),
        },
        actions: {
          create: dto.actions.map((a, index) => ({
            deviceId: a.deviceId,
            action: a.action,
            delayMs: a.delayMs ?? 0,
            order: a.order ?? index,
          })),
        },
      },
      include: RULE_INCLUDE,
    });

    await this.eventLog.log({
      type: "automation.created",
      message: `Regla de automatizacion "${rule.name}" creada`,
      userId,
    });

    return rule;
  }

  async update(id: string, dto: UpdateAutomationRuleDto, userId?: string) {
    await this.findOne(id);

    const rule = await this.prisma.$transaction(async (tx) => {
      if (dto.triggers) {
        await tx.ruleTrigger.deleteMany({ where: { ruleId: id } });
      }
      if (dto.conditions) {
        await tx.ruleCondition.deleteMany({ where: { ruleId: id } });
      }
      if (dto.actions) {
        await tx.ruleAction.deleteMany({ where: { ruleId: id } });
      }

      return tx.automationRule.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          enabled: dto.enabled,
          triggers: dto.triggers
            ? {
                create: dto.triggers.map((t) => ({
                  type: t.type,
                  deviceId: t.deviceId,
                  operator: t.operator,
                  value: t.value,
                  scheduleTime: t.scheduleTime,
                  scheduleDays: t.scheduleDays ?? [],
                })),
              }
            : undefined,
          conditions: dto.conditions
            ? { create: dto.conditions.map((c) => ({ deviceId: c.deviceId, operator: c.operator, value: c.value })) }
            : undefined,
          actions: dto.actions
            ? {
                create: dto.actions.map((a, index) => ({
                  deviceId: a.deviceId,
                  action: a.action,
                  delayMs: a.delayMs ?? 0,
                  order: a.order ?? index,
                })),
              }
            : undefined,
        },
        include: RULE_INCLUDE,
      });
    });

    await this.eventLog.log({
      type: "automation.updated",
      message: `Regla de automatizacion "${rule.name}" actualizada`,
      userId,
    });

    return rule;
  }

  async remove(id: string, userId?: string) {
    const rule = await this.findOne(id);
    await this.prisma.automationRule.delete({ where: { id } });
    await this.eventLog.log({
      type: "automation.deleted",
      message: `Regla de automatizacion "${rule.name}" eliminada`,
      userId,
    });
  }
}
