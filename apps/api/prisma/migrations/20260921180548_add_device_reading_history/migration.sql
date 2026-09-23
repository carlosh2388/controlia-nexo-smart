-- CreateTable
CREATE TABLE "device_readings" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "readings" JSONB NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_readings_deviceId_recordedAt_idx" ON "device_readings"("deviceId", "recordedAt");

-- AddForeignKey
ALTER TABLE "device_readings" ADD CONSTRAINT "device_readings_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
