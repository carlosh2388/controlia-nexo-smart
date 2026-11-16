import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

/** PUT /agents/:buildingKey/config - lo guarda la web (formulario Agente Go > Configuracion). */
export class UpdateAgentConfigDto {
  /** Secciones de protocolo, mismo formato que config.yaml (ver agent-config.util.ts). */
  @IsObject()
  config!: Record<string, unknown>;

  /** Version sobre la que se edito: si alguien guardo otra en el medio, la API responde 409. */
  @IsOptional()
  @IsInt()
  baseVersion?: number;
}

/** POST /agents/:buildingKey/config/seed - el agente sube su config.yaml la primera vez. */
export class SeedAgentConfigDto {
  @IsObject()
  config!: Record<string, unknown>;
}

/** POST /agents/:buildingKey/config/applied - el agente avisa que termino de aplicar una version. */
export class ConfigAppliedDto {
  @IsInt()
  @Min(1)
  version!: number;

  /** Fuentes que no pudieron arrancar (sin red, puerto ocupado...) o, si rejected, por que la config no es valida. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error?: string;

  /** true = la config no era valida y el agente sigue con la version anterior. */
  @IsOptional()
  @IsBoolean()
  rejected?: boolean;
}

export const SCAN_PROTOCOLS = ["modbus", "bacnet", "mqtt", "lorawan"] as const;

export class ScanItemDto {
  @IsIn(SCAN_PROTOCOLS)
  protocol!: (typeof SCAN_PROTOCOLS)[number];

  /** IP sueltas, rangos "10.0.6.1-50" o redes "10.0.6.0/24". El agente limita el total de hosts. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  targets!: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  /** Solo modbus: unit IDs a probar, ej. "1-10" o "1,2,5". */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  unitIds?: string;
}

/** POST /agents/:buildingKey/scan - pedido de descubrimiento desde la web. */
export class RequestScanDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ScanItemDto)
  items!: ScanItemDto[];
}

/** POST /agents/:buildingKey/scan/:scanId/result - avance o resultado del descubrimiento. */
export class ScanResultDto {
  @IsIn(["running", "done", "error"])
  status!: "running" | "done" | "error";

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsObject({ each: true })
  results?: Record<string, unknown>[];

  /** Hosts revisados / total, para la barra de avance. */
  @IsOptional()
  @IsObject()
  progress?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error?: string;

  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @IsOptional()
  @IsDateString()
  finishedAt?: string;
}
