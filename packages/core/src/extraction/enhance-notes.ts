// Enhance the user's own meeting notes from the transcript.
//
// The user jots rough bullets during the call ("pricing concerns", "Q3 timeline unclear");
// afterwards each bullet becomes an anchor and the model fills in what was actually said
// about it, grounded in a verbatim quote. The user's line is preserved exactly (the UI
// shows it dark); the detail is the AI's addition (shown gray). It never invents — if the
// transcript doesn't cover a note, the detail is left empty.

import { EnhancedNotesSchema, type EnhancedNotes } from "../schemas.js";
import type { LlmProvider } from "./index.js";

const SYSTEM = [
  "You expand a user's rough meeting notes using the transcript of that meeting.",
  "You are given the user's note lines (their anchors) and the full transcript.",
  "",
  "For EACH note line, in the same order, return:",
  '- "note": the user\'s line, copied EXACTLY as given (do not rewrite it).',
  '- "detail": one or two sentences of what the transcript actually says about that note',
  "  — the substance, decisions, numbers, who said what. If the transcript does not cover",
  '  the note, use an empty string "". Never invent; only report what was said.',
  '- "sourceQuote": one verbatim sentence from the transcript that supports the detail, or',
  "  null if there is no detail.",
  "",
  "Return ONLY a JSON object of this exact shape, nothing else:",
  '{ "notes": [ { "note": "...", "detail": "...", "sourceQuote": "..." | null } ] }',
  "Keep the note lines and their order identical to the input. Write detail in the user's",
  "language.",
].join("\n");

function extractJsonObject(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last > first ? text.slice(first, last + 1) : text;
}

/**
 * Split the user's freeform notes into anchor lines. Bullets, numbered lists and plain
 * lines all count; blank lines are dropped. This is what the model must preserve and
 * expand, one per line.
 */
export function splitNotes(notes: string): string[] {
  return notes
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 0);
}

export interface EnhanceResult {
  enhanced: EnhancedNotes;
  rawOutput: string;
  provider: string;
}

/**
 * Expand the notes from the transcript. Falls back to the raw note lines with empty
 * details if the model returns nothing usable — the user's notes must never be lost to a
 * bad model response.
 */
export async function enhanceNotes(
  notes: string,
  transcript: string,
  llm: LlmProvider,
): Promise<EnhanceResult> {
  const lines = splitNotes(notes);
  const fallback = (): EnhancedNotes => ({
    notes: lines.map((note) => ({ note, detail: "", sourceQuote: null })),
  });
  if (lines.length === 0) return { enhanced: { notes: [] }, rawOutput: "", provider: llm.id };

  const user = [
    "NOTES (one anchor per line):",
    lines.map((l, i) => `${i + 1}. ${l}`).join("\n"),
    "",
    "TRANSCRIPT:",
    `"""\n${transcript}\n"""`,
  ].join("\n");

  const rawOutput = await llm.complete(SYSTEM, user);
  const parsed = EnhancedNotesSchema.safeParse(
    JSON.parse(extractJsonObject(rawOutput)),
  );

  // Keep the user's exact lines regardless of what the model echoed for "note": the
  // anchors are the user's, and the model only supplies the details.
  if (parsed.success && parsed.data.notes.length > 0) {
    const enhanced: EnhancedNotes = {
      notes: lines.map((note, i) => ({
        note,
        detail: parsed.data.notes[i]?.detail ?? "",
        sourceQuote: parsed.data.notes[i]?.sourceQuote ?? null,
      })),
    };
    return { enhanced, rawOutput, provider: llm.id };
  }
  return { enhanced: fallback(), rawOutput, provider: llm.id };
}
