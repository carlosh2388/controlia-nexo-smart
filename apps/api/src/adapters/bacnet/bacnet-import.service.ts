import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { DeviceKind, DeviceProtocol } from "@prisma/client";
import { BacnetBridgeClientService } from "./bacnet-bridge-client.service";
import { DevicesService } from "../../devices/devices.service";
import { ImportBacnetDto } from "../../devices/dto/bacnet-import.dto";
import { CreateDeviceDto } from "../../devices/dto/create-device.dto";
import { BacnetPointsDto } from "../../devices/dto/bacnet-device-config.dto";

@Injectable()
export class BacnetImportService {
  private readonly logger = new Logger("BacnetImport");

  constructor(
    private readonly bridge: BacnetBridgeClientService,
    private readonly devicesService: DevicesService,
  ) {}

  async import(dto: ImportBacnetDto) {
    let discovered;
    try {
      discovered = await this.bridge.discover(dto.host);
    } catch (err) {
      throw new BadRequestException(
        `No se pudo volver a consultar el gateway BACnet en ${dto.host}: ${(err as Error).message}`,
      );
    }

    const byKey = new Map(discovered.units.map((u) => [u.unitKey, u]));
    const created: unknown[] = [];
    const failed: { unitKey: string; error: string }[] = [];

    for (const requested of dto.units) {
      const unit = byKey.get(requested.unitKey);
      if (!unit) {
        failed.push({ unitKey: requested.unitKey, error: "La unidad ya no aparece en el gateway" });
        continue;
      }

      const createDto: CreateDeviceDto = {
        name: requested.name,
        protocol: DeviceProtocol.bacnet,
        kind: DeviceKind.climate,
        areaId: requested.areaId,
        bacnetConfig: {
          host: dto.host,
          port: dto.port,
          unitKey: unit.unitKey,
          points: unit.points as unknown as BacnetPointsDto,
          modeStates: unit.modeStates ?? undefined,
          fanStates: unit.fanStates ?? undefined,
        },
      };

      try {
        created.push(await this.devicesService.create(createDto));
      } catch (err) {
        this.logger.warn(`No se pudo importar la unidad "${requested.unitKey}": ${(err as Error).message}`);
        failed.push({ unitKey: requested.unitKey, error: (err as Error).message });
      }
    }

    return { created, failed };
  }
}
