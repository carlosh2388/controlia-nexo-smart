import { Type } from "class-transformer";
import { IsArray, IsInt, IsOptional, IsString, MinLength, ValidateNested } from "class-validator";

export class BacnetObjectRefDto {
  @IsInt()
  type!: number;

  @IsInt()
  instance!: number;
}

/** Puntos BACnet de una unidad de aire acondicionado, resueltos una vez en el descubrimiento (ver BacnetDiscoveryService). */
export class BacnetPointsDto {
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  startStopCommand!: BacnetObjectRefDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  startStopStatus?: BacnetObjectRefDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  modeCommand?: BacnetObjectRefDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  modeStatus?: BacnetObjectRefDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  fanCommand?: BacnetObjectRefDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  fanStatus?: BacnetObjectRefDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  swingCommand?: BacnetObjectRefDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  swingStatus?: BacnetObjectRefDto;

  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  setRoomTemp!: BacnetObjectRefDto;

  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  roomTemp!: BacnetObjectRefDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  tempRangeUpperCommand?: BacnetObjectRefDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  tempRangeLowerCommand?: BacnetObjectRefDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  tempRangeUpperStatus?: BacnetObjectRefDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  tempRangeLowerStatus?: BacnetObjectRefDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetObjectRefDto)
  alarm?: BacnetObjectRefDto;
}

/**
 * Configuracion de una unidad de AC controlada via el gateway BACnet/IP (ej. "AC Smart 5" VRF).
 * host/port apuntan al gateway (no hay IP por unidad, todas comparten el mismo dispositivo BACnet).
 * Los object refs se resuelven una vez en el descubrimiento y quedan fijos; releer nombres en cada
 * poll seria costoso (el gateway expone miles de objetos) e innecesario una vez mapeados.
 */
export class BacnetDeviceConfigDto {
  @IsString()
  @MinLength(1)
  host!: string;

  @IsOptional()
  @IsInt()
  port?: number;

  /** Identificador de la unidad segun el naming del gateway (ej. "a1", "b3"). Solo informativo/debug. */
  @IsString()
  @MinLength(1)
  unitKey!: string;

  @ValidateNested()
  @Type(() => BacnetPointsDto)
  points!: BacnetPointsDto;

  /** Texto de cada estado del objeto multi-state de modo (State_Text), en el orden real del dispositivo (indice 0 = valor 1). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  modeStates?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fanStates?: string[];
}
