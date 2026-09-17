import { ArrayUnique, IsArray, IsEnum, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength, ValidateIf } from "class-validator";
import { ComparisonOperator, RuleTriggerType } from "@prisma/client";

/**
 * device_state (default): dispara cuando el estado de `deviceId` cumple operator+value.
 * schedule: dispara a `scheduleTime` (HH:mm, hora del servidor) en los `scheduleDays` indicados
 * (vacio = todos los dias); no usa deviceId/operator/value.
 */
export class RuleTriggerDto {
  @IsOptional()
  @IsEnum(RuleTriggerType)
  type: RuleTriggerType = RuleTriggerType.device_state;

  @ValidateIf((dto: RuleTriggerDto) => dto.type !== RuleTriggerType.schedule)
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsEnum(ComparisonOperator)
  operator: ComparisonOperator = ComparisonOperator.eq;

  @ValidateIf((dto: RuleTriggerDto) => dto.type !== RuleTriggerType.schedule)
  @IsString()
  @MinLength(1)
  value?: string;

  @ValidateIf((dto: RuleTriggerDto) => dto.type === RuleTriggerType.schedule)
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: "scheduleTime debe tener formato HH:mm (24h)" })
  scheduleTime?: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  @ArrayUnique()
  scheduleDays?: number[];
}
