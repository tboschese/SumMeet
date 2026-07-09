-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "transcriptionLanguage" TEXT NOT NULL DEFAULT 'auto',
    "outputLanguage" TEXT NOT NULL DEFAULT 'match',
    "updatedAt" DATETIME NOT NULL
);
