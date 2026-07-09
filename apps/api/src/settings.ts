import { AUTO_DETECT, MATCH_MEETING, type Settings } from "@summeet/core";
import { db } from "./db.js";

const SINGLETON = "singleton";

/** Read settings, creating the singleton row with defaults on first use. */
export async function getSettings(): Promise<Settings> {
  const row = await db.settings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  });
  return {
    transcriptionLanguage: row.transcriptionLanguage,
    outputLanguage: row.outputLanguage,
    transcriptionEngine: row.transcriptionEngine as Settings["transcriptionEngine"],
    extractionEngine: row.extractionEngine as Settings["extractionEngine"],
    glossary: row.glossary,
  };
}

export async function saveSettings(next: Settings): Promise<Settings> {
  const row = await db.settings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...next },
    update: next,
  });
  return {
    transcriptionLanguage: row.transcriptionLanguage,
    outputLanguage: row.outputLanguage,
    transcriptionEngine: row.transcriptionEngine as Settings["transcriptionEngine"],
    extractionEngine: row.extractionEngine as Settings["extractionEngine"],
    glossary: row.glossary,
  };
}

/** Whisper wants an ISO code or nothing at all (auto-detect). */
export function transcriptionHint(s: Settings): string | undefined {
  return s.transcriptionLanguage === AUTO_DETECT
    ? undefined
    : s.transcriptionLanguage;
}

/** The extractor writes in the meeting's language unless one is forced. */
export function outputLanguage(s: Settings): string | undefined {
  return s.outputLanguage === MATCH_MEETING ? undefined : s.outputLanguage;
}

/** Vocabulary hint for both stages; undefined when the user set none. */
export function glossary(s: Settings): string | undefined {
  const g = s.glossary?.trim();
  return g ? g : undefined;
}
