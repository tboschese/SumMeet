-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "deletedAt" DATETIME;

-- CreateIndex
CREATE INDEX "Meeting_deletedAt_createdAt_idx" ON "Meeting"("deletedAt", "createdAt");
