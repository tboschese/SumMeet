-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "transcriptionLanguage" TEXT NOT NULL DEFAULT 'auto',
    "outputLanguage" TEXT NOT NULL DEFAULT 'match',
    "transcriptionEngine" TEXT NOT NULL DEFAULT 'cloud',
    "extractionEngine" TEXT NOT NULL DEFAULT 'cloud',
    "glossary" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Settings" ("extractionEngine", "id", "outputLanguage", "transcriptionEngine", "transcriptionLanguage", "updatedAt") SELECT "extractionEngine", "id", "outputLanguage", "transcriptionEngine", "transcriptionLanguage", "updatedAt" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
