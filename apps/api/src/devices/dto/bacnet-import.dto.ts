import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, MinLength, ValidateNested } from "class-validator";

export class DiscoverBacnetDto {
  @IsString()
  @MinLength(1)
  host!: string;

  @IsOptional()
  @IsInt()
  port?: number;
}

class ImportBacnetUnitDto {
  @IsString()
  @MinLength(1)
  unitKey!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  areaId?: string;
}

export class ImportBacnetDto {
  @IsString()
  @MinLength(1)
  host!: string;

  @IsOptional()
  @IsInt()
  port?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ImportBacnetUnitDto)
  units!: ImportBacnetUnitDto[];
}
