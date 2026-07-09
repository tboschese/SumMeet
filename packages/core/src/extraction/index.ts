// Extraction service (SPEC §7.6). The LLM sits behind LlmProvider so it's a
// one-class swap; parse → Zod-validate → one repair-retry lives here so every
// provider gets it for free. Per this build: provider is Groq Llama, never Claude.

import { MeetingInsightsSchema, type MeetingInsights } from "../schemas.js";
import {
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompt.js";

export interface LlmProvider {
  /** Human-readable id stored on the Insights row, e.g. "groq:llama-3.3-70b-versatile". */
  readonly id: string;
  /** One chat completion. `system` sets the rules; `user` carries the payload. */
  complete(system: string, user: string): Promise<string>;
}

export interface ExtractionResult {
  insights: MeetingInsights;
  rawOutput: string; // raw model text for debugging (persisted on Insights.rawOutput)
  provider: string;
}

/** Strip accidental ```json fences and grab the outermost { … } object. */
function extractJsonObject(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
  return t;
}

/** Parse + validate one model response into MeetingInsights, or return the error. */
function tryParse(
  raw: string,
): { ok: true; value: MeetingInsights } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonObject(raw));
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }
  const parsed = MeetingInsightsSchema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues
      .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n"),
  };
}

/**
 * Extract validated insights from a transcript. One initial call; on a schema
 * miss, one repair-retry that feeds the validation error back (SPEC §7.6,
 * CLAUDE.md hard rule #4). Never returns unvalidated model JSON.
 */
export async function extractInsights(
  transcript: string,
  provider: LlmProvider,
  opts: { outputLanguage?: string } = {},
): Promise<ExtractionResult> {
  const system = buildSystemPrompt(opts.outputLanguage);

  const first = await provider.complete(system, buildUserPrompt(transcript));
  const firstTry = tryParse(first);
  if (firstTry.ok) {
    return { insights: firstTry.value, rawOutput: first, provider: provider.id };
  }

  // Repair retry: hand the model its bad output + the exact validation errors.
  const repaired = await provider.complete(
    system,
    buildRepairPrompt(first, firstTry.error),
  );
  const secondTry = tryParse(repaired);
  if (secondTry.ok) {
    return {
      insights: secondTry.value,
      rawOutput: repaired,
      provider: provider.id,
    };
  }

  throw new Error(
    `Extraction failed schema validation after repair.\nInitial errors:\n${firstTry.error}\nAfter repair:\n${secondTry.error}`,
  );
}

export { GroqLlamaProvider } from "./groq-llama.js";
export { OllamaProvider } from "./ollama.js";
export {
  EXTRACTION_SYSTEM_PROMPT,
  buildSystemPrompt,
  buildUserPrompt,
  buildRepairPrompt,
} from "./prompt.js";
