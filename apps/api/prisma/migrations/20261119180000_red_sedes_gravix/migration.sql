-- Sedes con su propio Gravix (origen "gravix"): direccion de su API y la clave de consulta del
-- Centro de mando, cifrada (AES-256-GCM, ver apps/api/src/red/gravix.service.ts). Solo agrega columnas.
ALTER TABLE "red_sedes" ADD COLUMN "url" TEXT;
ALTER TABLE "red_sedes" ADD COLUMN "apiKeyEnc" TEXT;
