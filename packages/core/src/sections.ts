import { z } from "zod";

/**
 * The user composes their summary from a fixed catalogue (SPEC A5) — picking
 * which sections appear and in what order. Deliberately "locked": no free-text
 * prompt, so the Insight contract (§6) can never be talked out of shape.
 *
 * Sections the user didn't pick aren't described in the prompt and aren't
 * generated, which makes a shorter summary genuinely cheaper, not just shorter.
 */
export const SECTION_KEYS = [
  "tldr",
  "executiveSummary",
  "keyPoints",
  "myCommitments",
  "actionItems",
  "decisions",
  "openQuestions",
  "risks",
  "nextSteps",
  "metrics",
  "topics",
] as const;

export const SectionSchema = z.enum(SECTION_KEYS);
export type SectionKey = z.infer<typeof SectionSchema>;

export interface SectionSpec {
  key: SectionKey;
  label: string;
  hint: string;
  /**
   * Derived sections are rendered from data another section already produced —
   * they cost the model nothing. "myCommitments" is just the action items the
   * speaker diarization (A1) attributed to you.
   */
  derivedFrom?: SectionKey;
}

export const SECTIONS: SectionSpec[] = [
  { key: "tldr", label: "TL;DR", hint: "One or two sentences — the whole meeting." },
  { key: "executiveSummary", label: "Executive summary", hint: "A single paragraph." },
  { key: "keyPoints", label: "Key points", hint: "3–7 bullets worth remembering." },
  {
    key: "myCommitments",
    label: "Your commitments",
    hint: "What you personally committed to. Needs a stereo recording (speaker labels).",
    derivedFrom: "actionItems",
  },
  { key: "actionItems", label: "Action items", hint: "Commitments, with owner, due date and priority." },
  { key: "decisions", label: "Decisions", hint: "What the group actually settled on, and why." },
  { key: "openQuestions", label: "Open questions", hint: "Raised but left unanswered." },
  { key: "risks", label: "Risks & blockers", hint: "What could derail things, with severity." },
  { key: "nextSteps", label: "Next steps", hint: "What happens after this meeting." },
  { key: "metrics", label: "Numbers mentioned", hint: "Figures, targets and deadlines stated." },
  { key: "topics", label: "Topics", hint: "What was discussed, summarized per topic." },
];

/** The default record: what the product shipped with before A5. */
export const DEFAULT_SECTIONS: SectionKey[] = [
  "tldr",
  "executiveSummary",
  "keyPoints",
  "actionItems",
  "decisions",
  "topics",
];

export function sectionSpec(key: SectionKey): SectionSpec {
  return SECTIONS.find((s) => s.key === key)!;
}

/** Only these reach the model; derived sections need nothing generated for them. */
export function generatedSections(sections: SectionKey[]): SectionKey[] {
  const keys = new Set<SectionKey>();
  for (const key of sections) {
    const spec = sectionSpec(key);
    keys.add(spec.derivedFrom ?? key);
  }
  return [...keys];
}
