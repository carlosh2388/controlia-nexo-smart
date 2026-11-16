-- TimescaleDB: la imagen docker/postgres trae la extension y la precarga (shared_preload_libraries).
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- CreateEnum
CREATE TYPE "ReadingQuality" AS ENUM ('real', 'recuperada', 'estimada');

-- CreateEnum
CREATE TYPE "GapStatus" AS ENUM ('open', 'closed', 'recovered', 'partial', 'estimated', 'unrecoverable');

-- CreateTable
CREATE TABLE "readings" (
    "time" TIMESTAMPTZ(3) NOT NULL,
    "deviceId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "quality" "ReadingQuality" NOT NULL DEFAULT 'real',

    CONSTRAINT "readings_pkey" PRIMARY KEY ("deviceId","metric","time")
);

-- CreateTable
CREATE TABLE "reading_gaps" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "cause" TEXT NOT NULL,
    "status" "GapStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reading_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reading_gaps_deviceId_startedAt_idx" ON "reading_gaps"("deviceId", "startedAt");

-- CreateIndex
CREATE INDEX "reading_gaps_status_idx" ON "reading_gaps"("status");

-- AddForeignKey
ALTER TABLE "reading_gaps" ADD CONSTRAINT "reading_gaps_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hypertable: particiones de 1 dia. Sin los indices por defecto de TimescaleDB: la llave primaria
-- (deviceId, metric, time) ya cubre las consultas por equipo y rango de tiempo.
SELECT create_hypertable('readings', 'time', chunk_time_interval => INTERVAL '1 day', create_default_indexes => false);

-- Compresion automatica de lo que tenga mas de 7 dias (agrupado por equipo y variable).
ALTER TABLE "readings" SET (timescaledb.compress, timescaledb.compress_segmentby = '"deviceId", metric', timescaledb.compress_orderby = 'time DESC');
SELECT add_compression_policy('readings', INTERVAL '7 days');
