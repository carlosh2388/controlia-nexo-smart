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

  /** "central": sede del monitoreo central (solo se guarda su grupo); "nodivo": sede leida por Agentes Go;
   *  "gravix": sede con su propio Gravix (VM local), que el centro consulta. */
  @IsIn(["central", "nodivo", "gravix"])
  origen!: "central" | "nodivo" | "gravix";

  /** Solo "gravix": API de la sede, ej. http://10.20.5.10:3010 */
  @IsOptional() @IsString() @MaxLength(200) @Matches(/^https?:\/\/[^\s/]+(:\d+)?\/?$/, { message: "La dirección debe ser como http://10.20.5.10:3010" })
  url?: string | null;

  /** De donde lee el Centro de mando las alarmas y correos: "api-siasa" (actual) o "gravix". Si no viene, se conserva. */
  @IsOptional() @IsIn(["api-siasa", "gravix"])
  alarmasFuente?: "api-siasa" | "gravix";

  /** Solo "gravix": clave de consulta de la sede (CENTRO_API_KEY de su .env). Si no viene, se conserva la guardada. */
  @IsOptional() @IsString() @MinLength(20) @MaxLength(200)
  apiKey?: string;

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

/** POST /red/gravix/probar: prueba la conexion con un Gravix de sede antes de guardarlo. */
export class ProbarGravixDto {
  @IsString() @MaxLength(200) @Matches(/^https?:\/\/[^\s/]+(:\d+)?\/?$/, { message: "La dirección debe ser como http://10.20.5.10:3010" })
  url!: string;

  @IsOptional() @IsString() @MinLength(20) @MaxLength(200)
  apiKey?: string;

  /** Sede ya guardada: si no viene apiKey se usa la suya. */
  @IsOptional() @IsString() @MaxLength(64)
  sedeId?: string;
}
