import { IsInt, IsOptional, IsString, MinLength } from "class-validator";

export class CreateAreaDto {
  @IsString()
  tenantId!: string;

  @IsString()
  @MinLength(2)
  name!: string;

  /** Archivo en apps/web/public/areas/. Si no se envia, la UI muestra un marcador generico. */
  @IsOptional()
  @IsString()
  imageFile?: string;

  @IsOptional()
  @IsInt()
  order?: number;
}
