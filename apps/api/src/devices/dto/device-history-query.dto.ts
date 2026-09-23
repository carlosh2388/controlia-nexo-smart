import { IsIn, IsOptional } from "class-validator";

export const HISTORY_RANGES = ["today", "7d", "15d", "30d"] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

export class DeviceHistoryQueryDto {
  @IsOptional()
  @IsIn(HISTORY_RANGES)
  range?: HistoryRange;
}
