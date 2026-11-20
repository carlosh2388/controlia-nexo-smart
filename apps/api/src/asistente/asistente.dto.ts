import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from "class-validator";

export class TurnoDto {
  @IsIn(["usuario", "gravix"])
  rol!: "usuario" | "gravix";

  @IsString() @MaxLength(4000)
  texto!: string;
}

/** POST /asistente/preguntar */
export class PreguntaDto {
  @IsString() @MinLength(1) @MaxLength(1000)
  pregunta!: string;

  /** Ultimos turnos de la conversacion (texto plano), para preguntas de seguimiento. */
  @IsOptional() @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => TurnoDto)
  historial?: TurnoDto[];

  /** Sede abierta en el Centro de mando cuando se hizo la pregunta. */
  @IsOptional() @IsString() @MaxLength(100)
  sedeActual?: string;
}
