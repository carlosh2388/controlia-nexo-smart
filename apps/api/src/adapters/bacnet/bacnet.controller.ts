import { Body, Controller, NotFoundException, Param, Post, UseGuards, Version } from "@nestjs/common";
import { Device, DeviceProtocol, Role } from "@prisma/client";
import { AuthGuard } from "../../auth/guards/auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { DevicesService } from "../../devices/devices.service";
import { DiscoverBacnetDto, ImportBacnetDto } from "../../devices/dto/bacnet-import.dto";
import { ClimateCommandDto } from "../../devices/dto/climate-command.dto";
import { BacnetDiscoveryService } from "./bacnet-discovery.service";
import { BacnetImportService } from "./bacnet-import.service";
import { BacnetAdapterService } from "./bacnet.adapter.service";

/**
 * Endpoints especificos de BACnet: descubrir/importar unidades de AC desde un gateway
 * (mismo patron que home-assistant/zigbee2mqtt en DevicesController) y el control completo
 * de climatizacion, que no encaja en el generico "/devices/:id/command" (on/off) porque
 * necesita modo/temperatura/ventilador/swing/rango en un solo request ("Aplicar").
 */
@Controller("devices")
@UseGuards(AuthGuard, RolesGuard)
export class BacnetController {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly discoveryService: BacnetDiscoveryService,
    private readonly importService: BacnetImportService,
    private readonly adapterService: BacnetAdapterService,
  ) {}

  @Version("1")
  @Roles(Role.admin)
  @Post("bacnet/discover")
  discover(@Body() dto: DiscoverBacnetDto) {
    return this.discoveryService.discover(dto);
  }

  @Version("1")
  @Roles(Role.admin)
  @Post("bacnet/import")
  import(@Body() dto: ImportBacnetDto) {
    return this.importService.import(dto);
  }

  @Version("1")
  @Roles(Role.admin, Role.operator)
  @Post(":id/climate")
  async setClimate(@Param("id") id: string, @Body() dto: ClimateCommandDto) {
    const device = await this.devicesService.findOne(id);
    if (device.protocol !== DeviceProtocol.bacnet) {
      throw new NotFoundException(`"${device.name}" no es un dispositivo de climatizacion BACnet`);
    }
    await this.adapterService.setClimate(device as unknown as Device, dto);
    return this.devicesService.findOne(id);
  }
}
