import {
  AUTO_DETECT,
  DEFAULT_SECTIONS,
  MATCH_MEETING,
  SectionSchema,
  type SectionKey,
  type Settings,
  type SettingsUpdate,
  type SettingsView,
} from "@summeet/core";
import { z } from "zod";
import { db } from "./db.js";

const SINGLETON = "singleton";

/** Secrets never travel to a client; they only reach the providers. */
export interface Secrets {
  groqApiKey?: string;
}

async function row() {
  return db.settings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  });
}

/** Read settings, creating the singleton row with defaults on first use. */
export async function getSettings(): Promise<Settings> {
  const r = await row();
  return {
    uiLanguage: r.uiLanguage as Settings["uiLanguage"],
    transcriptionLanguage: r.transcriptionLanguage,
    outputLanguage: r.outputLanguage,
    transcriptionEngine: r.transcriptionEngine as Settings["transcriptionEngine"],
    extractionEngine: r.extractionEngine as Settings["extractionEngine"],
    glossary: r.glossary,
    autoExtract: r.autoExtract,
    summarySections: parseSections(r.summarySections),
  };
}

/** Stored as a JSON string (SQLite has no array type). Bad/empty falls back. */
function parseSections(raw: string): SectionKey[] {
  if (!raw.trim()) return DEFAULT_SECTIONS;
  const parsed = z.array(SectionSchema).min(1).safeParse(
    (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })(),
  );
  return parsed.success ? parsed.data : DEFAULT_SECTIONS;
}

/** Safe to serialize: reveals only whether a key exists, never its value. */
export async function getSettingsView(): Promise<SettingsView> {
  const [settings, secrets] = await Promise.all([getSettings(), getSecrets()]);
  return { ...settings, hasGroqApiKey: !!secrets.groqApiKey };
}

/**
 * Keys configured in the UI win over the .env fallback — a desktop/mobile user
 * has no .env to edit (SPEC A0).
 */
export async function getSecrets(): Promise<Secrets> {
  const r = await row();
  const fromDb = r.groqApiKey.trim();
  if (fromDb) return { groqApiKey: fromDb };
  const fromEnv = process.env.GROQ_API_KEY?.trim();
  return { groqApiKey: fromEnv && fromEnv !== "..." ? fromEnv : undefined };
}

export async function saveSettings(next: SettingsUpdate): Promise<SettingsView> {
  const { groqApiKey, summarySections, ...rest } = next;
  const data = {
    ...rest,
    summarySections: JSON.stringify(summarySections),
    ...(groqApiKey !== undefined && { groqApiKey }),
  };
  await db.settings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...data },
    // Omitted key = leave as-is; "" = clear it.
    update: data,
  });
  return getSettingsView();
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

/** Sections the summary should contain, in order. */
export function sections(s: Settings): SectionKey[] {
  return s.summarySections?.length ? s.summarySections : DEFAULT_SECTIONS;
}
