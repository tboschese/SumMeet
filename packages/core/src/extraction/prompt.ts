// System prompt for insight extraction (SPEC §6). Encodes the quality rules;
// the model must return ONLY the JSON object matching MeetingInsightsSchema.
// The word "json" must appear for Groq's json_object response mode.
//
// The shape is assembled from the sections the user picked (SPEC A5): a section
// nobody asked for is neither described nor generated, so a leaner summary costs
// fewer tokens in and out. Zod fills the omitted fields with their defaults.

import { languageName, MATCH_MEETING } from "../languages.js";
import { DEFAULT_SECTIONS, generatedSections, type SectionKey } from "../sections.js";

/** JSON shape + inline docs for each generatable section. */
const FIELD_SPEC: Record<string, string> = {
  tldr: `  "tldr": string,                       // one to two sentences: the "if you read nothing else"`,
  executiveSummary: `  "executiveSummary": string,           // one paragraph`,
  keyPoints: `  "keyPoints": string[],                // 3–7 bullets`,
  actionItems: `  "actionItems": [                      // commitments someone actually made
    {
      "task": string,                   // the commitment, imperative voice
      "owner": string | null,           // person/role if inferable, else null
      "dueDate": string | null,         // ISO date (YYYY-MM-DD), else null
      "priority": "high" | "medium" | "low" | null,
      "sourceQuote": string | null      // verbatim transcript span it came from
    }
  ],`,
  decisions: `  "decisions": [                        // choices the group settled on
    {
      "decision": string,               // what was decided, stated plainly
      "rationale": string | null,       // why, if stated
      "sourceQuote": string | null
    }
  ],`,
  topics: `  "topics": [
    { "title": string, "summary": string }   // short label + 1–2 sentence summary
  ],`,
  risks: `  "risks": [                            // things that could derail the work
    {
      "risk": string,                   // the risk or blocker, stated plainly
      "severity": "high" | "medium" | "low" | null,
      "sourceQuote": string | null
    }
  ],`,
  openQuestions: `  "openQuestions": [                    // raised but left UNANSWERED in this meeting
    {
      "question": string,
      "askedBy": string | null,
      "sourceQuote": string | null
    }
  ],`,
  nextSteps: `  "nextSteps": string[],                // what happens after this meeting, in order`,
  metrics: `  "metrics": [                          // figures, targets and deadlines actually stated
    {
      "label": string,                  // what the number measures
      "value": string,                  // as stated ("40%", "R$ 2M", "3 weeks")
      "sourceQuote": string | null
    }
  ],`,
};

/** Extra quality rules that only make sense when a section was requested. */
const SECTION_RULES: Record<string, string> = {
  actionItems: `- Action items are commitments someone made, NOT every task mentioned. If nobody owned it, set "owner" to null — do not invent one.`,
  decisions: `- Decisions are choices the group settled on, NOT options merely discussed. Discussion without resolution is a topic, not a decision.`,
  openQuestions: `- An open question is one nobody answered during the meeting. If it was answered, it is not an open question.`,
  risks: `- Only list risks that were actually voiced. Do not infer risks the participants never raised.`,
  metrics: `- Only include numbers that were stated out loud. Never compute, estimate or round them.`,
  nextSteps: `- Next steps are agreed follow-ups. If none were agreed, return an empty array.`,
};

function languageRule(outputLanguage?: string): string {
  if (!outputLanguage || outputLanguage === MATCH_MEETING) {
    return `- Write all free-text fields in the meeting's own language, and set "language" to that language's ISO 639-1 code.`;
  }
  const name = languageName(outputLanguage);
  return `- Write ALL free-text fields in ${name} (${outputLanguage}), regardless of the language spoken in the meeting. Translate as needed, but keep every "sourceQuote" VERBATIM in the original spoken language. Set "language" to "${outputLanguage}".`;
}

function speakerRule(labelled?: boolean): string {
  if (!labelled) return "";
  return `
- The transcript is labelled by speaker. Lines beginning "You:" were spoken by the person recording the meeting; "Others:" by other participants.
- Use this for ownership: a commitment made on a "You:" line belongs to the recorder — set "owner" to "You" unless they name themselves. A commitment an "Others:" line assigns to a named person belongs to that person.
- The "You:"/"Others:" prefixes are NOT spoken words. Never include them in a "sourceQuote"; quote only the words that were said.`;
}

function glossaryRule(glossary?: string): string {
  const terms = glossary?.trim();
  if (!terms) return "";
  return `

Known names and terms for this meeting (spell them exactly like this; the transcript may misspell them):
${terms}
Still never invent an owner who isn't in the transcript — correcting a spelling is allowed, inventing a person is not.`;
}

export interface PromptOptions {
  outputLanguage?: string;
  glossary?: string;
  speakerLabelled?: boolean;
  /** Sections the user asked for, in their order. Defaults to the classic set. */
  sections?: SectionKey[];
  /**
   * When the meeting happened, ISO. Without it the model has no idea what "next
   * Monday" means and invents one — a real recording came back with a due date three
   * years in the past.
   */
  meetingDate?: Date;
}

/** Build the system prompt for exactly the requested sections. */
export function buildSystemPrompt(opts: PromptOptions = {}): string {
  const wanted = generatedSections(opts.sections?.length ? opts.sections : DEFAULT_SECTIONS);

  const shape = wanted
    .map((k) => FIELD_SPEC[k])
    .filter(Boolean)
    .join("\n");

  const extraRules = wanted
    .map((k) => SECTION_RULES[k])
    .filter(Boolean)
    .join("\n");

  return `You are an expert meeting analyst. You turn a raw meeting transcript into a structured decision record. The extraction IS the product — it must be good enough that a reader would rather read your output than the transcript.

Return ONLY a single valid JSON object (no prose, no markdown fences) with EXACTLY this shape:

{
${shape}
  "language": string                    // detected language, ISO 639-1 (e.g. "pt", "en")
}

Include every key listed above and no others.

Rules:
${extraRules}
- Never fabricate an owner, a date, a number or a "sourceQuote". null (or an empty array) is a valid, expected answer.
${dateRule(opts.meetingDate, opts.outputLanguage)}
- "sourceQuote" is your evidence: copy the single verbatim transcript span the item came from. Use null only when there is genuinely no supporting span — an item with a clear basis in the transcript but a null sourceQuote is a mistake.
- Infer "priority"/"severity" only from real urgency cues in the transcript — a hard deadline, words like "urgent"/"critical"/"blocker", or something blocking others. With no such signal, use null; do not guess.
${languageRule(opts.outputLanguage)}${speakerRule(opts.speakerLabelled)}
- The rules above are language-agnostic — apply them whatever the meeting's language.
- Output the JSON object only. No commentary, no code fences.${glossaryRule(opts.glossary)}`;
}

const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const addDays = (d: Date, n: number): Date => {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
};

/**
 * The transcript says "next Monday"; only the meeting's own date says which Monday.
 *
 * Anchoring alone is not enough: given the date and the weekday, a 70B model still
 * answered "next Monday" with the following *Friday*. Calendar arithmetic is cheap and
 * exact here and expensive and unreliable in a language model, so resolve every weekday
 * ourselves and hand over the answers. All the model has to do is match a phrase.
 */
function dateRule(meetingDate?: Date, language?: string): string {
  if (!meetingDate) {
    return '- "dueDate" must be null unless the transcript states an absolute date. Never compute one.';
  }
  const today = WEEKDAYS[meetingDate.getDay()]!;

  // The next occurrence of each weekday, strictly after the meeting. Named in the
  // meeting's own language as well as English: a Portuguese transcript says "na
  // segunda", and against an English-only table the model reached for the meeting's
  // own weekday instead — an answer four days wrong.
  const upcoming = WEEKDAYS.map((name, index) => {
    const delta = (index - meetingDate.getDay() + 7) % 7 || 7;
    const date = addDays(meetingDate, delta);
    const local = language
      ? date.toLocaleDateString(language, { weekday: "long" })
      : undefined;
    const label = local && local.toLowerCase() !== name.toLowerCase() ? `${name}/${local}` : name;
    return `${label} = ${iso(date)}`;
  }).join(", ");

  const endOfMonth = new Date(meetingDate.getFullYear(), meetingDate.getMonth() + 1, 0);

  return (
    `- The meeting took place on ${iso(meetingDate)}, a ${today}. Write "dueDate" as ` +
    `YYYY-MM-DD, resolved against that date. Do not compute dates yourself — use these:\n` +
    `    today = ${iso(meetingDate)}, tomorrow = ${iso(addDays(meetingDate, 1))}, ` +
    `end of this month = ${iso(endOfMonth)}\n` +
    `    the next: ${upcoming}\n` +
    `  A vague deadline ("soon", "later", "next quarter") is null. Never guess a date.`
  );
}

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
