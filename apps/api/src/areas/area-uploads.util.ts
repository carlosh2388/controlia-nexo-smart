import { ConfigService } from "@nestjs/config";
import path from "node:path";

/**
 * Carpeta donde se guardan las fotos de area subidas por el usuario. Relativa al cwd del proceso
 * (apps/api en dev via npm workspace, /app en el contenedor Docker) para no depender de __dirname
 * (que cambia entre ts-node y el build compilado). En docker-compose se monta como volumen para
 * que sobreviva a los redeploys del contenedor "api" (el contenedor "web" es estatico/stateless).
 */
export function getAreaUploadsDir(config: ConfigService): string {
  return path.resolve(config.get<string>("AREA_UPLOADS_DIR", "uploads/areas"));
}

export const AREA_UPLOADS_URL_PREFIX = "/uploads/areas/";
