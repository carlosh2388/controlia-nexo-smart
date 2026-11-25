import { Type } from "class-transformer";
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from "class-validator";

/** GET /exportar/historial - historial de varios equipos y metricas por rango de fechas, en Excel. */
export class ExportarHistorialDto {
  /**
   * Equipos separados por coma:
   *  - "p:<deviceId>": equipo leido por un Agente Go (en este servidor o en un Gravix de sede).
   *  - "c:<sede>:<medidor>": medidor de Telemetria 1 (monitoreo central, EBO -> api-SIASA).
   */
  @IsString()
  @MaxLength(6000)
  equipos!: string;

  /** Nombre visible de cada equipo, separado por "|", en el mismo orden. */
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  nombres?: string;

  /** Nombre de la sede de cada equipo, separado por "|", en el mismo orden. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  sedes?: string;

  /** Metricas separadas por coma. Las del monitoreo central: ebo:kw, ebo:v, ebo:a. Puede ir vacio si se piden armonicos. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  metricas?: string;

  /** Armonicos del ION7400: señales "v,i", fases "a,b,c", ordenes "3,5,7" (1 a 63) y modo pct|valor|ambos. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  armSenales?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  armFases?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  armOrdenes?: string;

  @IsOptional()
  @IsIn(["pct", "valor", "ambos"])
  armModo?: "pct" | "valor" | "ambos";

  /** Nombre de cada metrica para la columna, separado por "|", en el mismo orden. */
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  etiquetas?: string;

  @IsISO8601()
  desde!: string;

  @IsISO8601()
  hasta!: string;

  /** Un dato cada N segundos (promedio). Si el rango es muy grande se agranda solo. */
  @Type(() => Number)
  @IsIn([60, 300, 900, 3600, 86400])
  step!: number;
}
