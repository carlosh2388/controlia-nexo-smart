import { IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { Role } from "@prisma/client";
import { TABS } from "../../access/access.constants";

export class CreateUserDto {
  @IsString()
  @MinLength(3)
  username!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsEnum(Role)
  role!: Role;

  @IsOptional() @IsString() @MaxLength(120)
  fullName?: string;

  @IsOptional() @IsEmail()
  email?: string;

  /** Ids de sedes del centro de mando; vacio = todas. */
  @IsOptional() @IsArray() @IsString({ each: true })
  sites?: string[];

  @IsOptional() @IsIn(TABS as unknown as string[])
  homeTab?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;

  @IsOptional() @IsBoolean()
  receivesAlarmEmails?: boolean;
}

export class UpdateUserDto {
  @IsOptional() @IsEnum(Role)
  role?: Role;

  @IsOptional() @IsString() @MaxLength(120)
  fullName?: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  sites?: string[];

  @IsOptional() @IsIn(TABS as unknown as string[])
  homeTab?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;

  @IsOptional() @IsBoolean()
  receivesAlarmEmails?: boolean;
}

export class SetPasswordDto {
  @IsString()
  @MinLength(6)
  password!: string;
}
