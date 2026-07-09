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
