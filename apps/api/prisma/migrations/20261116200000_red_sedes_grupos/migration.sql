-- Red por fases (Telemetria 1, 2, 3) y sedes nuevas leidas por Agentes Go. Solo agrega tablas.

-- CreateTable
CREATE TABLE "red_grupos" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "red_grupos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "red_sedes" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "origen" TEXT NOT NULL DEFAULT 'nodivo',
    "grupoId" TEXT,
    "agentes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "plantilla" TEXT,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "red_sedes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "red_sedes_grupoId_idx" ON "red_sedes"("grupoId");

-- AddForeignKey
ALTER TABLE "red_sedes" ADD CONSTRAINT "red_sedes_grupoId_fkey" FOREIGN KEY ("grupoId") REFERENCES "red_grupos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Grupos iniciales. Las 10 sedes del monitoreo central quedan en Telemetria 1 sin guardarlas aqui
-- (una sede del monitoreo central sin fila en red_sedes = Telemetria 1).
INSERT INTO "red_grupos" ("id", "nombre", "color", "orden", "updatedAt") VALUES
  ('t1', 'Telemetría 1', '#3b82f6', 1, now()),
  ('t2', 'Telemetría 2', '#a78bfa', 2, now()),
  ('t3', 'Telemetría 3', '#2dd4bf', 3, now());
