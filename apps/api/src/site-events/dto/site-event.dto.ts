import { Type } from "class-transformer";
import { IsDateString, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export const EVENT_SEVERITIES = ["info", "warning", "critical"] as const;
export type EventSeverityValue = (typeof EVENT_SEVERITIES)[number];

/** Un evento tal como lo detecta el Agente_Go (ver apps/Agente_Go/internal/events). */
export class AgentEventDto {
  /** Id unico generado por el agente: si el mismo evento se reenvia (reintento), no se duplica. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  id!: string;

  /** externalId del dispositivo al que se refiere; vacio para eventos de toda la sede (ej. lorawan.site_silent). */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  externalId?: string;

  /** Tipo con prefijo de categoria, ej. "energy.source_generator", "generator.started", "door.opened". */
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  type!: string;

  @IsIn(EVENT_SEVERITIES)
  severity!: EventSeverityValue;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  message!: string;

  @IsOptional()
  @IsNumber()
  value?: number;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @IsDateString()
  occurredAt!: string;
}

export class ListSiteEventsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceId?: string;

  /** Prefijo de tipo/categoria, ej. "generator" o "energy.source". */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  type?: string;

  @IsOptional()
  @IsIn(EVENT_SEVERITIES)
  severity?: EventSeverityValue;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}
