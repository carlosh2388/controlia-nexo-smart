import { IsArray, IsString } from "class-validator";

export class RolePermissionDto {
  @IsArray()
  @IsString({ each: true })
  tabs!: string[];

  @IsArray()
  @IsString({ each: true })
  actions!: string[];
}
