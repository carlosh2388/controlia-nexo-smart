import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsLatitude, IsLongitude, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from "class-validator";

/** POST /red/grupos y PATCH /red/grupos/:id */
export class GrupoDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60)
  nombre?: string;

  /** Color del grupo en el arbol y el mapa (#rrggbb). */
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/)
  color?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  orden?: number;
}

/** PUT /red/sedes/:id: crea o actualiza una sede de la red. */
export class SedeDto {
  @IsString() @MinLength(2) @MaxLength(80)
  nombre!: string;

  /** "central": sede del monitoreo central (solo se guarda su grupo); "nodivo": sede leida por Agentes Go. */
  @IsIn(["central", "nodivo"])
  origen!: "central" | "nodivo";

  @IsOptional() @IsString() @MaxLength(40)
  grupoId?: string | null;

  /** buildingKey de los Agentes Go que leen la sede. */
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @Matches(/^[a-z0-9][a-z0-9-]{1,62}$/, { each: true })
  agentes?: string[];

  @IsOptional() @Type(() => Number) @IsLatitude()
  lat?: number | null;

  @IsOptional() @Type(() => Number) @IsLongitude()
  lon?: number | null;

  @IsOptional() @IsString() @MaxLength(40)
  plantilla?: string | null;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  orden?: number;
}
