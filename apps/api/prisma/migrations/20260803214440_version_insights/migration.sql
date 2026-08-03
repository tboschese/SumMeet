-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Insights" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "meetingId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "rawOutput" TEXT,
    "provider" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Insights_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Insights" ("createdAt", "data", "id", "meetingId", "provider", "rawOutput") SELECT "createdAt", "data", "id", "meetingId", "provider", "rawOutput" FROM "Insights";
DROP TABLE "Insights";
ALTER TABLE "new_Insights" RENAME TO "Insights";
CREATE INDEX "Insights_meetingId_createdAt_idx" ON "Insights"("meetingId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
