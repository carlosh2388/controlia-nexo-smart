import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsIP, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

/** GET /pilot/devices/:id/series */
export class SeriesQueryDto {
  @IsString()
  @MaxLength(80)
  metric!: string;

  /** Ventana hacia atras desde ahora (maximo 7 dias). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(7 * 24 * 60)
  minutes?: number;
}

/** GET /pilot/devices/:id/compare - comparativo lectura directa vs AS-P (Fase B). */
export class CompareQueryDto {
  /** Ventana hacia atras desde ahora (maximo 7 dias). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(7 * 24 * 60)
  minutes?: number;
}

/** GET /pilot/devices/:id/excel - historial en Excel (varias variables). */
export class ExcelQueryDto {
  /** Claves separadas por coma (ej. active_power_total,voltage_a_n). */
  @IsString()
  @MaxLength(800)
  metrics!: string;

  /** Nombres para las columnas, separados por "|", en el mismo orden. */
  @IsOptional()
  @IsString()
  @MaxLength(1200)
  labels?: string;

  /** Ventana hacia atras (maximo 90 dias). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(90 * 24 * 60)
  minutes?: number;

  /** Un dato cada N segundos. */
  @IsOptional()
  @Type(() => Number)
  @IsIn([60, 900, 3600, 86400])
  step?: number;
}

/** GET /pilot/:buildingKey/cumplimiento */
export class CumplimientoQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(31)
  dias?: number;

  @IsOptional() @IsIn(["ntsd", "ieee519", "en50160"])
  norma?: "ntsd" | "ieee519" | "en50160";
}

/** GET /pilot/devices/:id/pronostico */
export class PronosticoQueryDto {
  @IsString() @MaxLength(80)
  metric!: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(60)
  dias?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(14)
  horizonte?: number;
}

/** PUT /pilot/devices/:id/umbrales */
export class UmbralesDto {
  @IsIn(["ntsd", "ieee519", "en50160"])
  norma!: "ntsd" | "ieee519" | "en50160";

  /** Solo los valores que cambian respecto de la norma (tension, desbalance, thdV, thdI, pst, fp, freq, carga, nominal). */
  @IsOptional()
  limites?: Record<string, number>;
}

/** POST /pilot/devices/:id/probar - una lectura Modbus de prueba (solo funcion 03). */
export class ProbarLecturaDto {
  @IsIP(4)
  ip!: string;

  @IsInt() @Min(1) @Max(65535)
  port!: number;

  @IsInt() @Min(0) @Max(255)
  unitId!: number;

  @IsString() @MaxLength(40)
  perfil!: string;
}

/** GET /pilot/devices/:id/gaps */
export class GapsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

/**
 * PUT /pilot/devices/:id/connection - datos para leer el equipo directo (Fase B), editados en la
 * pestaña Piloto Gravix > Conexion. Se guardan en Device.metadata.directConnection.
 */
export class DirectConnectionDto {
  @IsIP(4)
  ip!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  /** null = el ID por defecto del equipo, todavia sin confirmar. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(247)
  unitId?: number | null;

  /** Equipo que hace de puente RS-485 (misma IP, distinto ID). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  viaDeviceId?: string | null;

  @IsBoolean()
  enabled!: boolean;

  @IsBoolean()
  compareWithAsp!: boolean;

  @IsIn([15, 30, 60])
  intervalSeconds!: number;
}
