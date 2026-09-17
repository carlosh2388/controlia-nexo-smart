-- CreateEnum
CREATE TYPE "RuleTriggerType" AS ENUM ('device_state', 'schedule');

-- AlterTable
ALTER TABLE "rule_triggers" ADD COLUMN     "scheduleDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "scheduleTime" TEXT,
ADD COLUMN     "type" "RuleTriggerType" NOT NULL DEFAULT 'device_state',
ALTER COLUMN "deviceId" DROP NOT NULL,
ALTER COLUMN "value" DROP NOT NULL;
