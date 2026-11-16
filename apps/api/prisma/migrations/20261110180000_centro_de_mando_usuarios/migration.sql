-- Centro de mando + mantenimiento de usuarios. Solo agrega columnas y tablas: no cambia nada existente.

-- AlterTable: datos del usuario (todos con valor por defecto, los usuarios actuales quedan igual)
ALTER TABLE "users" ADD COLUMN "fullName" TEXT,
ADD COLUMN "email" TEXT,
ADD COLUMN "sites" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "homeTab" TEXT NOT NULL DEFAULT 'centro',
ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "receivesAlarmEmails" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "lastLoginAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role" "Role" NOT NULL,
    "tabs" TEXT[],
    "actions" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role")
);

-- Permisos iniciales (los del mockup aprobado). Operador = operator, Consulta = viewer. Hoy todos los
-- usuarios ven todas las pestañas: para no quitarle nada a nadie el dia del cambio, operator y viewer
-- arrancan viendo las mismas pestañas que ya usan; el administrador las ajusta despues.
INSERT INTO "role_permissions" ("role", "tabs", "actions", "updatedAt") VALUES
  ('operator', ARRAY['centro','operativa','edificio','gestion','sedes','agente','config','gravix'], ARRAY['reconocer','excel'], now()),
  ('viewer',   ARRAY['centro','operativa','edificio','gestion','sedes','agente','config','gravix'], ARRAY[]::TEXT[], now());

-- CreateTable
CREATE TABLE "centro_lecturas" (
    "time" TIMESTAMPTZ(3) NOT NULL,
    "sede" TEXT NOT NULL,
    "medidor" TEXT NOT NULL,
    "kw" DOUBLE PRECISION,
    "vProm" DOUBLE PRECISION,
    "aProm" DOUBLE PRECISION,
    "estado" TEXT NOT NULL,

    CONSTRAINT "centro_lecturas_pkey" PRIMARY KEY ("sede","medidor","time")
);

SELECT create_hypertable('centro_lecturas', 'time', chunk_time_interval => INTERVAL '1 day', create_default_indexes => false);
ALTER TABLE "centro_lecturas" SET (timescaledb.compress, timescaledb.compress_segmentby = 'sede, medidor', timescaledb.compress_orderby = 'time DESC');
SELECT add_compression_policy('centro_lecturas', INTERVAL '7 days');