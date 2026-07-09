import { z } from "zod";

// ── Meeting status (source of truth; SQLite stores this as a String) ──────────
export const MeetingStatus = z.enum([
  "UPLOADED",
  "TRANSCRIBING",
  "EXTRACTING",
  "COMPLETED",
  "FAILED",
]);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

// ── User settings (server-side, so the extension inherits them too) ───────────
export const SettingsSchema = z.object({
  /** "auto" (let Whisper detect) or an ISO 639-1 code hint. */
  transcriptionLanguage: z.string().min(2),
  /** "match" (use the meeting's language) or an ISO 639-1 code for the insights. */
  outputLanguage: z.string().min(2),
});
export type Settings = z.infer<typeof SettingsSchema>;

// ── Transcript segments (stored as a JSON String; §8) ─────────────────────────
export const TranscriptSegmentSchema = z.object({
  start: z.number(), // seconds, absolute in the recording's timeline
  end: z.number(),
  text: z.string(),
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

export const MeetingInsightsSchema = z.object({
  tldr: z.string(), // one to two sentences, the "if you read nothing else"
  executiveSummary: z.string(), // one paragraph
  keyPoints: z.array(z.string()), // 3–7 bullets
  actionItems: z.array(ActionItemSchema),
  decisions: z.array(DecisionSchema),
  topics: z.array(TopicSchema),
  language: z.string(), // detected, ISO 639-1 (e.g. "pt", "en")
});
export type MeetingInsights = z.infer<typeof MeetingInsightsSchema>;
