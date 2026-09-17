const DEVICE_NAME_SELECT = { device: { select: { id: true, name: true } } };

export const RULE_INCLUDE = {
  triggers: { include: DEVICE_NAME_SELECT },
  conditions: { include: DEVICE_NAME_SELECT },
  actions: { orderBy: { order: "asc" as const }, include: DEVICE_NAME_SELECT },
} as const;
