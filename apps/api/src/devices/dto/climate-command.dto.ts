import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min } from "class-validator";

/**
 * Comando parcial para una unidad de climatizacion: se envian solo los campos que el usuario
 * cambio en el panel (patron "Aplicar" del frontend), no un estado completo.
 */
export class ClimateCommandDto {
  @IsOptional()
  @IsBoolean()
  on?: boolean;

  /** Debe ser uno de los textos reales del dispositivo (Device.metadata.bacnet.modeStates), ej. "COOL". */
  @IsOptional()
  @IsString()
  mode?: string;

  @IsOptional()
  @IsNumber()
  @Min(10)
  @Max(35)
  temperature?: number;

  /** Debe ser uno de los textos reales del dispositivo (Device.metadata.bacnet.fanStates), ej. "LOW". */
  @IsOptional()
  @IsString()
  fanSpeed?: string;

  @IsOptional()
  @IsBoolean()
  swing?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(10)
  @Max(35)
  tempRangeLow?: number;

  @IsOptional()
  @IsNumber()
  @Min(10)
  @Max(35)
  tempRangeHigh?: number;
}

export const CLIMATE_MODE_TRANSLATIONS: Record<string, string> = {
  COOL: "FRIO",
  HEAT: "CALOR",
  FAN: "VENT",
  DRY: "DESHU",
  AUTO: "AUTO",
};

export const CLIMATE_FAN_TRANSLATIONS: Record<string, string> = {
  LOW: "BAJA",
  MIDDLE: "MEDIA",
  MED: "MEDIA",
  HIGH: "ALTA",
  AUTO: "AUTO",
};
