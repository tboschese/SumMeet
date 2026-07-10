import type { TranscriptSegment } from "../schemas.js";

export const SELF_LABEL = "You";
export const OTHERS_LABEL = "Others";

/**
 * Render the transcript for the LLM, labelling turns when the recording carried
 * separate channels (SPEC A1). Consecutive segments from the same speaker are
 * merged into one turn, so the label overhead is a couple of tokens per turn —
 * not per segment. Falls back to the plain text when there's no speaker data
 * (mono uploads), costing exactly what it did before.
 */
export function formatTranscriptForPrompt(
  segments: TranscriptSegment[],
  fullText: string,
): { text: string; labelled: boolean } {
  const hasSpeakers = segments.some((s) => s.speaker === "self" || s.speaker === "others");
  if (!hasSpeakers) return { text: fullText, labelled: false };

  const lines: string[] = [];
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    const label =
      current === "self" ? SELF_LABEL : current === "others" ? OTHERS_LABEL : "Unknown";
    lines.push(`${label}: ${buffer.join(" ")}`);
    buffer = [];
  };

  for (const seg of segments) {
    const speaker = seg.speaker ?? null;
    if (speaker !== current) {
      flush();
      current = speaker;
    }
    buffer.push(seg.text);
  }
  flush();

  return { text: lines.join("\n"), labelled: true };
}
