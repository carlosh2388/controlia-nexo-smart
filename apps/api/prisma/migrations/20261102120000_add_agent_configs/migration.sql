-- CreateTable
CREATE TABLE "agent_configs" (
    "buildingKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL,
    "appliedVersion" INTEGER,
    "appliedAt" TIMESTAMP(3),
    "applyError" TEXT,
    "scanRequest" JSONB,
    "scanResult" JSONB,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_configs_pkey" PRIMARY KEY ("buildingKey")
);
