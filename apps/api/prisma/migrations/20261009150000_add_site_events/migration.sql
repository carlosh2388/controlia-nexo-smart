-- CreateEnum
CREATE TYPE "EventSeverity" AS ENUM ('info', 'warning', 'critical');

-- CreateTable
CREATE TABLE "site_events" (
    "id" TEXT NOT NULL,
    "agentEventId" TEXT NOT NULL,
    "buildingKey" TEXT NOT NULL,
    "deviceId" TEXT,
    "externalId" TEXT,
    "type" TEXT NOT NULL,
    "severity" "EventSeverity" NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "data" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_events_agentEventId_key" ON "site_events"("agentEventId");

-- CreateIndex
CREATE INDEX "site_events_buildingKey_occurredAt_idx" ON "site_events"("buildingKey", "occurredAt");

-- CreateIndex
CREATE INDEX "site_events_deviceId_occurredAt_idx" ON "site_events"("deviceId", "occurredAt");

-- AddForeignKey
ALTER TABLE "site_events" ADD CONSTRAINT "site_events_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
