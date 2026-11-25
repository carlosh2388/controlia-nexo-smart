CREATE TABLE "plano_puntos" (
    "sede" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "usuario" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plano_puntos_pkey" PRIMARY KEY ("sede","clave")
);
