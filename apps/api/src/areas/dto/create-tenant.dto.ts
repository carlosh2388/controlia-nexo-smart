import { IsString, MinLength } from "class-validator";

export class CreateTenantDto {
  /** Nombre para mostrar, ej. "TEC 3 - Nivel 4". */
  @IsString()
  @MinLength(2)
  name!: string;

  @IsString()
  @MinLength(1)
  building!: string;

  /** Etiqueta corta del nivel, ej. "Nivel 4" (se usa en el selector). */
  @IsString()
  @MinLength(1)
  level!: string;
}
