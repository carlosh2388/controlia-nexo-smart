import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";
import { ScheduleModule } from "@nestjs/schedule";
import { LoggerModule } from "nestjs-pino";
import IORedis from "ioredis";
import { PrismaModule } from "./prisma/prisma.module";
import { StateBusModule } from "./state-bus/state-bus.module";
import { EventsModule } from "./events/events.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { AdaptersModule } from "./adapters/adapters.module";
import { DevicesModule } from "./devices/devices.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { AutomationsModule } from "./automations/automations.module";
import { EwelinkModule } from "./adapters/ewelink/ewelink.module";
import { BacnetModule } from "./adapters/bacnet/bacnet.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { AreasModule } from "./areas/areas.module";
import { SiteEventsModule } from "./site-events/site-events.module";
import { AgentsModule } from "./agents/agents.module";
import { AccessModule } from "./access/access.module";
import { CentroModule } from "./centro/centro.module";
import { RedModule } from "./red/red.module";
import { AsistenteModule } from "./asistente/asistente.module";
import { SedeModule } from "./sede/sede.module";
import { ExportarModule } from "./exportar/exportar.module";

/**
 * GRAVIX_MODO=central (por defecto): servidor central con Centro de mando, red y TEC 3.
 * GRAVIX_MODO=sede: Gravix local de una sede (VM con Docker): agente, historial, huecos, normas,
 * alarmas y la API /sede que consulta el Centro de mando. Ver docs/gravix-sede.md.
 */
const MODO_SEDE = process.env.GRAVIX_MODO === "sede";
const SOLO_CENTRAL = [EwelinkModule, BacnetModule, AutomationsModule, AreasModule, CentroModule, RedModule, AsistenteModule, ExportarModule];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || "info",
        transport:
          process.env.NODE_ENV === "production"
            ? undefined
            : { target: "pino-pretty", options: { singleLine: true } },
      },
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: new IORedis(config.get<string>("REDIS_URL", "redis://localhost:6379"), {
          maxRetriesPerRequest: null,
        }),
      }),
    }),
    PrismaModule,
    StateBusModule,
    EventsModule,
    AuthModule,
    UsersModule,
    AdaptersModule,
    DevicesModule,
    RealtimeModule,
    ApiKeysModule,
    SiteEventsModule,
    AgentsModule,
    AccessModule,
    ...(MODO_SEDE ? [SedeModule] : SOLO_CENTRAL),
  ],
})
export class AppModule {}
