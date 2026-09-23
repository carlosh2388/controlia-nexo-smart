import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards, Version } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthGuard } from "../auth/guards/auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ownerUserId, type AuthenticatedUser } from "../auth/auth.types";
import { DevicesService } from "./devices.service";
import { HomeAssistantImportService } from "./home-assistant-import.service";
import { Zigbee2MqttImportService } from "./zigbee2mqtt-import.service";
import { CreateDeviceDto } from "./dto/create-device.dto";
import { UpdateDeviceDto } from "./dto/update-device.dto";
import { DeviceCommandDto } from "./dto/device-command.dto";
import { ListDevicesQueryDto } from "./dto/list-devices-query.dto";
import { DiscoverHomeAssistantDto, ImportHomeAssistantDto } from "./dto/home-assistant-import.dto";
import { DiscoverZigbee2MqttDto, ImportZigbee2MqttDto } from "./dto/zigbee2mqtt-import.dto";
import { DeviceHistoryQueryDto } from "./dto/device-history-query.dto";
import { DeviceHistoryService } from "./device-history.service";

@Controller("devices")
@UseGuards(AuthGuard, RolesGuard)
export class DevicesController {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly haImportService: HomeAssistantImportService,
    private readonly zigbee2mqttImportService: Zigbee2MqttImportService,
    private readonly historyService: DeviceHistoryService,
  ) {}

  @Version("1")
  @Get()
  findAll(@Query() query: ListDevicesQueryDto) {
    return this.devicesService.findAll(query.protocol);
  }

  @Version("1")
  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.devicesService.findOne(id);
  }

  @Version("1")
  @Get(":id/history")
  getHistory(@Param("id") id: string, @Query() query: DeviceHistoryQueryDto) {
    return this.historyService.getHistory(id, query.range);
  }

  @Version("1")
  @Roles(Role.admin)
  @Post()
  create(@Body() dto: CreateDeviceDto) {
    return this.devicesService.create(dto);
  }

  @Version("1")
  @Roles(Role.admin)
  @Post("home-assistant/discover")
  discoverHomeAssistant(@Body() dto: DiscoverHomeAssistantDto) {
    return this.haImportService.discover(dto);
  }

  @Version("1")
  @Roles(Role.admin)
  @Post("home-assistant/import")
  importHomeAssistant(@Body() dto: ImportHomeAssistantDto) {
    return this.haImportService.import(dto);
  }

  @Version("1")
  @Roles(Role.admin)
  @Post("zigbee2mqtt/discover")
  discoverZigbee2Mqtt(@Body() dto: DiscoverZigbee2MqttDto) {
    return this.zigbee2mqttImportService.discover(dto);
  }

  @Version("1")
  @Roles(Role.admin)
  @Post("zigbee2mqtt/import")
  importZigbee2Mqtt(@Body() dto: ImportZigbee2MqttDto) {
    return this.zigbee2mqttImportService.import(dto);
  }

  @Version("1")
  @Roles(Role.admin)
  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateDeviceDto) {
    return this.devicesService.update(id, dto);
  }

  @Version("1")
  @Roles(Role.admin)
  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.devicesService.remove(id);
  }

  @Version("1")
  @Roles(Role.admin, Role.operator)
  @Post(":id/command")
  sendCommand(
    @Param("id") id: string,
    @Body() dto: DeviceCommandDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.devicesService.sendCommand(id, dto.action, { userId: ownerUserId(user) });
  }
}
