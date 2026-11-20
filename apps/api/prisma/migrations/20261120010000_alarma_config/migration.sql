-- Configuracion de alarmas y correos del Gravix de sede editada desde el Centro de mando. Solo agrega.
CREATE TABLE "alarma_config" (
    "id" TEXT NOT NULL DEFAULT 'unica',
    "datos" JSONB NOT NULL,
    "actualizadoPor" TEXT,
    "actualizado" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "alarma_config_pkey" PRIMARY KEY ("id")
);
