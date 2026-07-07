// Tiny helpers for the SQLite JSON-as-String columns (SPEC §8.1): always
// JSON.parse + Zod-validate on read, JSON.stringify on write, so app code never
// touches raw strings. Migrating to Postgres later = swap these for Json columns.

import {
  MeetingInsightsSchema,
  TranscriptSegmentsSchema,
  type MeetingInsights,
  type TranscriptSegment,
} from "./schemas.js";

export function stringifySegments(segments: TranscriptSegment[]): string {
  return JSON.stringify(TranscriptSegmentsSchema.parse(segments));
}

export function parseSegments(raw: string): TranscriptSegment[] {
  return TranscriptSegmentsSchema.parse(JSON.parse(raw));
}

export function stringifyInsights(insights: MeetingInsights): string {
  return JSON.stringify(MeetingInsightsSchema.parse(insights));
}

export function parseInsights(raw: string): MeetingInsights {
  return MeetingInsightsSchema.parse(JSON.parse(raw));
}
