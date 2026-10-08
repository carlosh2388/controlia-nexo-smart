import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { DeviceKind, DeviceProtocol } from "@prisma/client";
import { MqttJsonConfigDto } from "./mqtt-json-config.dto";

/** Un dispositivo tal como lo reporta el Agente_Go: crudo, sin areaId (eso lo asigna un humano despues). */
export class AgentSyncDeviceDto {
  /** Identificador estable dentro de esa red (ej. "zigbee2mqtt:Dimmer_Oficina3", "bacnet:a1"). No cambia entre syncs. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  externalId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsEnum(DeviceProtocol)
  protocol!: DeviceProtocol;

  @IsEnum(DeviceKind)
  kind!: DeviceKind;

  /**
   * "on"/"off" para lo accionable (switches, climas); "online"/"offline" para sensores puros
   * (mismo valor que ya usan los sensores LoRaWAN existentes en Device.state.state - no tienen
   * un estado on/off real, solo reportan que estan transmitiendo).
   */
  @IsOptional()
  @IsIn(["on", "off", "online", "offline"])
  state?: "on" | "off" | "online" | "offline";

  @IsOptional()
  @IsObject()
  readings?: Record<string, unknown>;

  /**
   * Solo para protocol="mqtt": si el source del agente conoce los topics reales (ej. mqttsource,
   * que replica el esquema de Zigbee2MQTT), el dispositivo queda controlable de verdad apenas se
   * confirma - la API lo registra en su propio adaptador MQTT en proceso (el mismo mecanismo que
   * ya usa "Sin Home Assistant (MQTT directo)"), en vez de quedar en solo lectura para siempre.
   * Ver AgentSyncService y docs/agente-go.md.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  stateTopic?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  commandTopic?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MqttJsonConfigDto)
  mqttJson?: MqttJsonConfigDto;
}

/** Body de POST /devices/agent-sync: un lote de dispositivos descubiertos por un Agente_Go de un edificio. */
export class AgentSyncDto {
  /** Identifica de que edificio/sitio viene el lote (config.buildingKey del agente, ej. "tec3-nivel10"). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  buildingKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  agentVersion?: string;

  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => AgentSyncDeviceDto)
  devices!: AgentSyncDeviceDto[];
}
