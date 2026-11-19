-- Alarmas y correos del Gravix de sede (mismas reglas y columnas que api_eventos de api-SIASA) y la
-- opcion del Centro de mando para elegir de donde lee las alarmas de cada sede. Solo agrega.

-- CreateTable
CREATE TABLE "alarma_eventos" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "sede" TEXT NOT NULL,
    "evento" TEXT NOT NULL,
    "severidad" TEXT NOT NULL,
    "dispositivo" TEXT,
    "inventario" TEXT,
    "inicio" TIMESTAMPTZ(3) NOT NULL,
    "fin" TIMESTAMPTZ(3),
    "duracionS" INTEGER,
    "detalle" JSONB,
    "notificadoEn" TIMESTAMPTZ(3),
    "cierreNotificadoEn" TIMESTAMPTZ(3),
    "intentosCorreo" INTEGER NOT NULL DEFAULT 0,
    "creadoEn" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alarma_eventos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alarma_correos" (
    "id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "asunto" TEXT NOT NULL,
    "codigos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "para" TEXT,
    "enviado" BOOLEAN NOT NULL DEFAULT false,
    "motivo" TEXT,
    "texto" TEXT,
    "html" TEXT,
    "creadoEn" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alarma_correos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alarma_eventos_codigo_key" ON "alarma_eventos"("codigo");
CREATE INDEX "alarma_eventos_inicio_idx" ON "alarma_eventos"("inicio" DESC);
CREATE INDEX "alarma_eventos_fin_idx" ON "alarma_eventos"("fin");
CREATE INDEX "alarma_correos_creadoEn_idx" ON "alarma_correos"("creadoEn" DESC);

-- AlterTable
ALTER TABLE "red_sedes" ADD COLUMN "alarmasFuente" TEXT NOT NULL DEFAULT 'api-siasa';
