import { Type } from "class-transformer";
import { IsBoolean, IsEnum, IsOptional, IsString, MinLength, ValidateNested } from "class-validator";
import { DeviceKind, DeviceProtocol } from "@prisma/client";
import { HttpDeviceConfigDto } from "./http-device-config.dto";
import { DeviceGroupDto } from "./device-group.dto";
import { EwelinkDeviceConfigDto } from "./ewelink-device-config.dto";
import { MqttJsonConfigDto } from "./mqtt-json-config.dto";
import { BacnetDeviceConfigDto } from "./bacnet-device-config.dto";

/** Actualizacion parcial de un dispositivo. Si se envia httpConfig, reemplaza la configuracion HTTP completa. */
export class UpdateDeviceDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsEnum(DeviceProtocol)
  protocol?: DeviceProtocol;

  @IsOptional()
  @IsEnum(DeviceKind)
  kind?: DeviceKind;

  @IsOptional()
  @IsString()
  commandTopic?: string;

  @IsOptional()
  @IsString()
  stateTopic?: string;

  @IsOptional()
  @IsString()
  payloadOn?: string;

  @IsOptional()
  @IsString()
  payloadOff?: string;

  @IsOptional()
  @IsString()
  httpBaseUrl?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => HttpDeviceConfigDto)
  httpConfig?: HttpDeviceConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceGroupDto)
  group?: DeviceGroupDto;

  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  /** Area a la que pertenece (Vista de edificio). Enviar "" para quitarle el area asignada. */
  @IsOptional()
  @IsString()
  areaId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => EwelinkDeviceConfigDto)
  ewelinkConfig?: EwelinkDeviceConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => MqttJsonConfigDto)
  mqttJson?: MqttJsonConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacnetDeviceConfigDto)
  bacnetConfig?: BacnetDeviceConfigDto;
}
