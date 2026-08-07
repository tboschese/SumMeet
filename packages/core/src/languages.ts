// Language options shared by the API, the web settings UI, and the prompts.
// Pure data — safe to import in the browser.

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "pt", label: "Português" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "nl", label: "Nederlands" },
  { code: "ja", label: "日本語" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

/** Transcription: let Whisper detect the spoken language. */
export const AUTO_DETECT = "auto";
/** Insights: write them in whatever language the meeting was held in. */
export const MATCH_MEETING = "match";

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

export function isKnownLanguage(code: string): boolean {
  return LANGUAGES.some((l) => l.code === code);
}

/** English names Whisper reports for the languages we support. Its verbose output names
 * the language ("english"), while every API that *takes* a language wants the ISO code. */
const WHISPER_NAMES: Record<string, LanguageCode> = {
  english: "en",
  portuguese: "pt",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  dutch: "nl",
  japanese: "ja",
};

/**
 * A transcriber's reported language as an ISO 639-1 code, or undefined when we can't be
 * sure — callers pass it back as a language hint, and a hint we invented is worse than
 * none. Accepts both the code (whisper.cpp) and the English name (Groq's verbose JSON).
 */
export function toLanguageCode(reported: string | undefined | null): LanguageCode | undefined {
  const raw = reported?.trim().toLowerCase();
  if (!raw || raw === "unknown" || raw === AUTO_DETECT) return undefined;
  const known = LANGUAGES.find((l) => l.code === raw);
  if (known) return known.code;
  return WHISPER_NAMES[raw];
}
