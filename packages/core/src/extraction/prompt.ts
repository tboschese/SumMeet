// System prompt for insight extraction (SPEC §6). Encodes the quality rules;
// the model must return ONLY the JSON object matching MeetingInsightsSchema.
// The word "json" must appear for Groq's json_object response mode.

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
- Never fabricate "owner", "dueDate", or "sourceQuote". null is a valid, expected answer. Every "sourceQuote" must be copied verbatim from the transcript.
- Write all free-text fields in the meeting's own language, and set "language" to that language's ISO 639-1 code.
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
