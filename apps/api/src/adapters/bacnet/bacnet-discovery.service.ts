import { BadRequestException, Injectable } from "@nestjs/common";
import { BacnetBridgeClientService } from "./bacnet-bridge-client.service";
import { DiscoverBacnetDto } from "../../devices/dto/bacnet-import.dto";

export interface DiscoveredBacnetUnit {
  unitKey: string;
  name: string;
  hasMode: boolean;
  hasFan: boolean;
  hasSwing: boolean;
  hasTempRange: boolean;
  sample: { on: boolean | null; roomTemp: number | null; setRoomTemp: number | null };
}

/** Descubre las unidades de AC controlables en un gateway BACnet (via bacnet-bridge) para el checklist de importacion. */
@Injectable()
export class BacnetDiscoveryService {
  constructor(private readonly bridge: BacnetBridgeClientService) {}

  async discover(dto: DiscoverBacnetDto): Promise<DiscoveredBacnetUnit[]> {
    let result;
    try {
      result = await this.bridge.discover(dto.host);
    } catch (err) {
      throw new BadRequestException(
        `No se pudo descubrir el gateway BACnet en ${dto.host}: ${(err as Error).message}`,
      );
    }

    return result.units.map((unit) => ({
      unitKey: unit.unitKey,
      name: `AC ${unit.unitKey.toUpperCase()}`,
      hasMode: !!unit.points.modeCommand,
      hasFan: !!unit.points.fanCommand,
      hasSwing: !!unit.points.swingCommand,
      hasTempRange: !!(unit.points.tempRangeUpperCommand && unit.points.tempRangeLowerCommand),
      sample: unit.sample,
    }));
  }
}
