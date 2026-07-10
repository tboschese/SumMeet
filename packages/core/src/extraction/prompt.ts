// System prompt for insight extraction (SPEC §6). Encodes the quality rules;
// the model must return ONLY the JSON object matching MeetingInsightsSchema.
// The word "json" must appear for Groq's json_object response mode.

import { languageName, MATCH_MEETING } from "../languages.js";

/**
 * The language rule: by default insights are written in the meeting's own
 * language; a configured outputLanguage forces them into that language instead
 * (e.g. a Portuguese meeting summarized in English).
 */
function languageRule(outputLanguage?: string): string {
  if (!outputLanguage || outputLanguage === MATCH_MEETING) {
    return `- Write all free-text fields in the meeting's own language, and set "language" to that language's ISO 639-1 code.`;
  }
  const name = languageName(outputLanguage);
  return `- Write ALL free-text fields in ${name} (${outputLanguage}), regardless of the language spoken in the meeting. Translate as needed, but keep every "sourceQuote" VERBATIM in the original spoken language. Set "language" to "${outputLanguage}".`;
}

/**
 * Domain vocabulary (people, products, jargon). Helps the model spell owners and
 * products correctly instead of echoing a garbled transcript (SPEC A6).
 */
function glossaryRule(glossary?: string): string {
  const terms = glossary?.trim();
  if (!terms) return "";
  return `\n\nKnown names and terms for this meeting (spell them exactly like this; the transcript may misspell them):\n${terms}\nStill never invent an owner who isn't in the transcript — correcting a spelling is allowed, inventing a person is not.`;
}

/**
 * Speaker labels come from the recorder's stereo channels (SPEC A1). They make
 * ownership decidable for the question that matters most — "what did *I* commit
 * to?" — without a diarization model.
 */
function speakerRule(labelled?: boolean): string {
  if (!labelled) return "";
  return `\n\nThe transcript is labelled by speaker. Lines beginning "You:" were spoken by the person recording the meeting; lines beginning "Others:" by the other participants.
- Use this for ownership: a commitment made on a "You:" line belongs to the recorder — set "owner" to "You" unless they name themselves.
- A commitment an "Others:" line assigns to a named person belongs to that person.
- The "You:"/"Others:" prefixes are NOT spoken words. Never include them in a "sourceQuote"; quote only the words that were said.`;
}

/** Build the system prompt, honoring the configured insights language + glossary. */
export function buildSystemPrompt(
  outputLanguage?: string,
  glossary?: string,
  speakerLabelled?: boolean,
): string {
  return (
    EXTRACTION_SYSTEM_PROMPT.replace(LANGUAGE_RULE_TOKEN, languageRule(outputLanguage)) +
    speakerRule(speakerLabelled) +
    glossaryRule(glossary)
  );
}

const LANGUAGE_RULE_TOKEN = "{{LANGUAGE_RULE}}";

export const EXTRACTION_SYSTEM_PROMPT = `You are an expert meeting analyst. You turn a raw meeting transcript into a structured decision record. The extraction IS the product — it must be good enough that a reader would rather read your output than the transcript.

Return ONLY a single valid JSON object (no prose, no markdown fences) with EXACTLY this shape:

{
  "tldr": string,                       // one to two sentences: the "if you read nothing else"
  "executiveSummary": string,           // one paragraph
  "keyPoints": string[],                // 3–7 bullets
  "actionItems": [                      // commitments someone actually made
    {
      "task": string,                   // the commitment, imperative voice
      "owner": string | null,           // person/role if inferable, else null
      "dueDate": string | null,         // ISO date OR natural language ("next Friday"), else null
      "priority": "high" | "medium" | "low" | null,
      "sourceQuote": string | null      // verbatim transcript span it came from
    }
  ],
  "decisions": [                        // choices the group settled on
    {
      "decision": string,               // what was decided, stated plainly
      "rationale": string | null,       // why, if stated
      "sourceQuote": string | null
    }
  ],
  "topics": [
    { "title": string, "summary": string }   // short label + 1–2 sentence summary
  ],
  "language": string                    // detected language, ISO 639-1 (e.g. "pt", "en")
}

Rules:
- Action items are commitments someone made, NOT every task mentioned. If nobody owned it, set "owner" to null — do not invent one.
- Decisions are choices the group settled on, NOT options merely discussed. Discussion without resolution is a topic, not a decision.
- Never fabricate "owner", "dueDate", or "sourceQuote". null is a valid, expected answer.
- "sourceQuote" is your evidence: for EVERY action item and decision, copy the single verbatim transcript span it came from. Use null only when there is genuinely no supporting span — an item that has a clear basis in the transcript but a null sourceQuote is a mistake.
- Infer "priority" only from real urgency cues in the transcript — a hard/near deadline, words like "urgent"/"ASAP"/"critical"/"blocker", or something blocking others. With no such signal, use null; do not guess.
- "owner" may be a name ("Sarah") or a role ("the infra team") if the transcript makes it clear; otherwise null.
{{LANGUAGE_RULE}}
- The rules above are language-agnostic — apply them whatever the meeting's language.
- Output the JSON object only. No commentary, no code fences.`;

export function buildUserPrompt(transcript: string): string {
  return `Here is the meeting transcript. Extract the decision record as the JSON object described.\n\nTRANSCRIPT:\n"""\n${transcript}\n"""`;
}

export function buildRepairPrompt(
  badOutput: string,
  validationError: string,
): string {
  return `Your previous response did not match the required JSON schema.

Validation errors:
${validationError}

Your previous (invalid) response was:
"""
${badOutput}
"""

Return a corrected JSON object that fixes these errors and matches the schema exactly. Output the JSON object only — no prose, no code fences.`;
}
