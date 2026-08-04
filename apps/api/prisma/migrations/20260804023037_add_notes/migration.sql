-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Meeting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "folderId" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "audioKey" TEXT,
    "channelLayout" TEXT,
    "durationSec" INTEGER,
    "language" TEXT,
    "error" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Meeting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Meeting_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Meeting" ("audioKey", "channelLayout", "createdAt", "deletedAt", "durationSec", "error", "folderId", "id", "language", "status", "title", "updatedAt", "userId") SELECT "audioKey", "channelLayout", "createdAt", "deletedAt", "durationSec", "error", "folderId", "id", "language", "status", "title", "updatedAt", "userId" FROM "Meeting";
DROP TABLE "Meeting";
ALTER TABLE "new_Meeting" RENAME TO "Meeting";
CREATE INDEX "Meeting_deletedAt_createdAt_idx" ON "Meeting"("deletedAt", "createdAt");
CREATE INDEX "Meeting_folderId_idx" ON "Meeting"("folderId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
