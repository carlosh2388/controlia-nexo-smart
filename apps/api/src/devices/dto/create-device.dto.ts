import { Type } from "class-transformer";
import { IsBoolean, IsEnum, IsOptional, IsString, MinLength, ValidateIf, ValidateNested } from "class-validator";
import { DeviceKind, DeviceProtocol } from "@prisma/client";
import { HttpDeviceConfigDto } from "./http-device-config.dto";
import { DeviceGroupDto } from "./device-group.dto";
import { EwelinkDeviceConfigDto } from "./ewelink-device-config.dto";
import { MqttJsonConfigDto } from "./mqtt-json-config.dto";
import { BacnetDeviceConfigDto } from "./bacnet-device-config.dto";

export class CreateDeviceDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsEnum(DeviceProtocol)
  protocol!: DeviceProtocol;

  /** switch (default): expone un toggle on/off. sensor: solo reporta lecturas (temperatura, humedad, etc), sin comandos. */
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

  @ValidateIf((dto: CreateDeviceDto) => dto.protocol === DeviceProtocol.http)
  @IsString()
  @MinLength(1)
  httpBaseUrl?: string;

  /** Requerido cuando protocol = http: define como se enciende/apaga/lee el estado del dispositivo. */
  @ValidateIf((dto: CreateDeviceDto) => dto.protocol === DeviceProtocol.http)
  @ValidateNested()
  @Type(() => HttpDeviceConfigDto)
  httpConfig?: HttpDeviceConfigDto;

  /** Si se envia, este dispositivo se muestra agrupado con otros que compartan el mismo group.key. */
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceGroupDto)
  group?: DeviceGroupDto;

  /** Si es true, el dispositivo no se muestra en el panel principal (se puede volver a mostrar despues). */
  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  /** Area a la que pertenece (Vista de edificio). Opcional; se puede asignar despues. */
  @IsOptional()
  @IsString()
  areaId?: string;

  /** Requerido cuando protocol = ewelink: control LAN directo, sin nube ni Home Assistant. */
  @ValidateIf((dto: CreateDeviceDto) => dto.protocol === DeviceProtocol.ewelink)
  @ValidateNested()
  @Type(() => EwelinkDeviceConfigDto)
  ewelinkConfig?: EwelinkDeviceConfigDto;

  /** Opcional cuando protocol = mqtt: soporte para payloads JSON (ej. Zigbee2MQTT) en vez de texto plano. */
  @IsOptional()
  @ValidateNested()
  @Type(() => MqttJsonConfigDto)
  mqttJson?: MqttJsonConfigDto;

  /** Requerido cuando protocol = bacnet: config de la unidad de AC resuelta por el descubrimiento BACnet. */
  @ValidateIf((dto: CreateDeviceDto) => dto.protocol === DeviceProtocol.bacnet)
  @ValidateNested()
  @Type(() => BacnetDeviceConfigDto)
  bacnetConfig?: BacnetDeviceConfigDto;
}
