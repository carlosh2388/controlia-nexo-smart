-- Base del COMPARATIVO TimescaleDB vs InfluxDB (contenedor db-comparativo). Misma tabla "readings",
-- mismos bloques de 1 dia y misma compresion que produccion (migracion 20261103120000), para que la
-- comparacion refleje el uso real. Solo recibe las lecturas de energia; empieza vacia.
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TYPE "ReadingQuality" AS ENUM ('real', 'recuperada', 'estimada');

CREATE TABLE "readings" (
    "time" TIMESTAMPTZ(3) NOT NULL,
    "deviceId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "quality" "ReadingQuality" NOT NULL DEFAULT 'real',
    CONSTRAINT "readings_pkey" PRIMARY KEY ("deviceId", "metric", "time")
);

SELECT create_hypertable('readings', 'time', chunk_time_interval => INTERVAL '1 day', create_default_indexes => false);
ALTER TABLE "readings" SET (timescaledb.compress, timescaledb.compress_segmentby = '"deviceId", metric', timescaledb.compress_orderby = 'time DESC');
SELECT add_compression_policy('readings', INTERVAL '7 days');
