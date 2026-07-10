import { z } from "zod";
import { SectionSchema } from "./sections.js";

// ── Meeting status (source of truth; SQLite stores this as a String) ──────────
// TRANSCRIBED is a deliberate resting state, not a failure: when auto-extract is
// off, the pipeline stops after transcription and waits for the user to ask for
// insights. Lets a cheap local Whisper run always, while the LLM (cloud or a
// heavy local model) runs only on demand.
export const MeetingStatus = z.enum([
  "UPLOADED",
  "TRANSCRIBING",
  "TRANSCRIBED",
  "EXTRACTING",
  "COMPLETED",
  "FAILED",
]);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

// ── Processing engines (SPEC §7.4/§7.6 seams; Appendix A A3 "private mode") ───
// "cloud" = Groq APIs (fast, cheap, audio/transcript leaves the machine).
// "local" = whisper.cpp + Ollama (free, offline, nothing leaves the machine).
export const EngineSchema = z.enum(["cloud", "local"]);
export type Engine = z.infer<typeof EngineSchema>;

/** Language of the app's own interface — independent of the meeting's language. */
export const UiLanguageSchema = z.enum(["en", "pt-BR"]);
export type UiLanguage = z.infer<typeof UiLanguageSchema>;

// ── User settings (server-side, so every client inherits them) ───────────────
export const SettingsSchema = z.object({
  /** Interface language. Not to be confused with outputLanguage (the insights). */
  uiLanguage: UiLanguageSchema,
  /** "auto" (let Whisper detect) or an ISO 639-1 code hint. */
  transcriptionLanguage: z.string().min(2),
  /** "match" (use the meeting's language) or an ISO 639-1 code for the insights. */
  outputLanguage: z.string().min(2),
  /** Which engine transcribes the audio. */
  transcriptionEngine: EngineSchema,
  /** Which engine extracts the insights. Can differ from transcription. */
  extractionEngine: EngineSchema,
  /** Names, products and jargon — biases transcription and extraction (SPEC A6). */
  glossary: z.string().max(4000),
  /**
   * Run extraction automatically after transcription. Turn it off to decouple
   * the two: transcribe cheaply now, generate insights later (and decide then
   * whether the transcript goes to a cloud model).
   */
  autoExtract: z.boolean(),
  /** Which sections the summary contains, in order (SPEC A5). */
  summarySections: z.array(SectionSchema).min(1),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * What the API returns. The API key itself is NEVER serialized — only whether
 * one is configured — so it can't leak to a browser (hard rule §7.2).
 */
export const SettingsViewSchema = SettingsSchema.extend({
  hasGroqApiKey: z.boolean(),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

/**
 * What the API accepts. `groqApiKey` is write-only: omit to leave it untouched,
 * pass "" to clear it, pass a value to replace it.
 */
export const SettingsUpdateSchema = SettingsSchema.extend({
  groqApiKey: z.string().optional(),
});
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

/**
 * Who spoke (SPEC A1 "diarization"). No model, no extra API call: the recorder
 * already captures two physically separate sources — tab audio (everyone else)
 * and the microphone (you) — so it stores them as stereo channels and we read
 * the speaker off per-segment channel energy. `null` when we can't know: mono
 * uploads, older recordings, or an ambiguous/silent span.
 */
export const SpeakerSchema = z.enum(["self", "others"]).nullable();
export type Speaker = z.infer<typeof SpeakerSchema>;

// ── Transcript segments (stored as a JSON String; §8) ─────────────────────────
export const TranscriptSegmentSchema = z.object({
  start: z.number(), // seconds, absolute in the recording's timeline
  end: z.number(),
  text: z.string(),
  speaker: SpeakerSchema.optional(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptSegmentsSchema = z.array(TranscriptSegmentSchema);

// ── The Insight contract (§6) ─────────────────────────────────────────────────
export const ActionItemSchema = z.object({
  task: z.string(), // the commitment, imperative voice
  owner: z.string().nullable(), // person/role if inferable from context, else null
  dueDate: z.string().nullable(), // ISO date OR natural-language deadline ("next Friday"), else null
  priority: z.enum(["high", "medium", "low"]).nullable(),
  sourceQuote: z.string().nullable(), // verbatim transcript span this was derived from
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

export const DecisionSchema = z.object({
  decision: z.string(), // what was decided, stated plainly
  rationale: z.string().nullable(), // why, if stated
  sourceQuote: z.string().nullable(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const TopicSchema = z.object({
  title: z.string(), // short label
  summary: z.string(), // 1–2 sentences
});
export type Topic = z.infer<typeof TopicSchema>;

// ── Enrichment sections (SPEC A5) ────────────────────────────────────────────
export const RiskSchema = z.object({
  risk: z.string(), // the risk or blocker, stated plainly
  severity: z.enum(["high", "medium", "low"]).nullable(),
  sourceQuote: z.string().nullable(),
});
export type Risk = z.infer<typeof RiskSchema>;

export const OpenQuestionSchema = z.object({
  question: z.string(), // raised but left unanswered
  askedBy: z.string().nullable(),
  sourceQuote: z.string().nullable(),
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

export const MetricSchema = z.object({
  label: z.string(), // what the number measures
  value: z.string(), // as stated ("40%", "R$ 2M", "3 weeks")
  sourceQuote: z.string().nullable(),
});
export type Metric = z.infer<typeof MetricSchema>;

/**
 * Every field carries a default so a section the user didn't ask for can simply
 * be omitted by the model (cheaper prompt AND cheaper output), and so insights
 * persisted before a field existed still parse. `language` stays required — it
 * isn't a section.
 */
export const MeetingInsightsSchema = z.object({
  tldr: z.string().default(""), // one to two sentences, the "if you read nothing else"
  executiveSummary: z.string().default(""), // one paragraph
  keyPoints: z.array(z.string()).default([]), // 3–7 bullets
  actionItems: z.array(ActionItemSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  topics: z.array(TopicSchema).default([]),
  risks: z.array(RiskSchema).default([]),
  openQuestions: z.array(OpenQuestionSchema).default([]),
  nextSteps: z.array(z.string()).default([]),
  metrics: z.array(MetricSchema).default([]),
  language: z.string(), // detected, ISO 639-1 (e.g. "pt", "en")
});
export type MeetingInsights = z.infer<typeof MeetingInsightsSchema>;
