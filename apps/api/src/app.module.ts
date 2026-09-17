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
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { AreasModule } from "./areas/areas.module";

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
    AutomationsModule,
    EwelinkModule,
    ApiKeysModule,
    AreasModule,
  ],
})
export class AppModule {}
