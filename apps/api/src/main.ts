import "reflect-metadata";
import fs from "node:fs";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { WsAdapter } from "@nestjs/platform-ws";
import { Logger, ValidationPipe, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Logger as PinoLogger } from "nestjs-pino";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { startExternalGateway } from "./external-gateway";
import { getAreaUploadsDir, AREA_UPLOADS_URL_PREFIX } from "./areas/area-uploads.util";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );

  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService);

  app.useWebSocketAdapter(new WsAdapter(app));

  await app.register(fastifyCors as any, {
    origin: config.get<string>("CORS_ORIGIN", "http://localhost:5173"),
    credentials: true,
  });

  await app.register(fastifyMultipart as any, {
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    throwFileSizeLimit: true,
  });

  const areaUploadsDir = getAreaUploadsDir(config);
  fs.mkdirSync(areaUploadsDir, { recursive: true });
  await app.register(fastifyStatic as any, {
    root: areaUploadsDir,
    prefix: AREA_UPLOADS_URL_PREFIX,
  });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const port = config.get<number>("API_PORT", 3000);
  await app.listen(port, "0.0.0.0");
  Logger.log(`API lista en http://localhost:${port}/api/v1`, "Bootstrap");

  const externalPort = config.get<number>("EXTERNAL_API_PORT");
  if (externalPort) {
    startExternalGateway(externalPort, port);
  }
}

bootstrap();
