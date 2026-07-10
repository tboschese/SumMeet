import {
  AUTO_DETECT,
  MATCH_MEETING,
  type Settings,
  type SettingsUpdate,
  type SettingsView,
} from "@summeet/core";
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
    transcriptionLanguage: r.transcriptionLanguage,
    outputLanguage: r.outputLanguage,
    transcriptionEngine: r.transcriptionEngine as Settings["transcriptionEngine"],
    extractionEngine: r.extractionEngine as Settings["extractionEngine"],
    glossary: r.glossary,
    autoExtract: r.autoExtract,
  };
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
  const { groqApiKey, ...rest } = next;
  await db.settings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...rest, ...(groqApiKey !== undefined && { groqApiKey }) },
    // Omitted key = leave as-is; "" = clear it.
    update: { ...rest, ...(groqApiKey !== undefined && { groqApiKey }) },
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
