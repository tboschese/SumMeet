import "../env.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../paths.js";
import {
  extractInsights,
  GroqLlamaProvider,
  GroqWhisperProvider,
  LocalWhisperProvider,
  OllamaProvider,
  transcribeFile,
  type LlmProvider,
  type MeetingInsights,
  type TranscriptionProvider,
} from "@summeet/core";

// Engine evaluation harness (SPEC §13.7). Answers, with numbers rather than
// vibes: how much quality do the free/offline engines actually cost?
//
//   pnpm eval:engines <audio> <ground-truth.txt>
//
// Transcription is scored against the ground-truth text (WER + whether the
// people's names survive). Extraction is scored on the ground-truth transcript
// (so the LLM is judged independently of transcription errors), measuring the
// failures that matter: FABRICATED owners and non-verbatim quotes — the things
// SPEC §6 forbids and small models do anyway.

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/** Word-level edit distance / reference length. */
function wordErrorRate(reference: string, hypothesis: string): number {
  const r = norm(reference).split(" ");
  const h = norm(hypothesis).split(" ");
  const d: number[][] = Array.from({ length: r.length + 1 }, () =>
    new Array<number>(h.length + 1).fill(0),
  );
  for (let i = 0; i <= r.length; i++) d[i]![0] = i;
  for (let j = 0; j <= h.length; j++) d[0]![j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  return d[r.length]![h.length]! / r.length;
}

/** Capitalised words in the reference = the people/products that must survive. */
function properNouns(reference: string): string[] {
  const stop = new Set(["i", "the", "we", "so", "okay", "next", "one", "great", "good", "yes", "sure", "will", "let", "alright", "perfect", "thanks", "marketing"]);
  const found = new Set<string>();
  for (const m of reference.matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-z]{2,})\b/gm)) {
    const w = m[1]!.toLowerCase();
    if (!stop.has(w)) found.add(w);
  }
  return [...found];
}

interface ExtractionScore {
  actionItems: number;
  decisions: number;
  topics: number;
  fabricatedOwners: string[];
  nonVerbatimQuotes: number;
  quotedItems: number;
  totalItems: number;
}

/** An owner or quote that isn't in the transcript was invented by the model. */
function scoreExtraction(insights: MeetingInsights, transcript: string): ExtractionScore {
  const t = norm(transcript);
  const fabricatedOwners: string[] = [];
  let nonVerbatimQuotes = 0;
  let quotedItems = 0;
  let totalItems = 0;

  const checkQuote = (q: string | null) => {
    totalItems++;
    if (!q) return;
    quotedItems++;
    if (!t.includes(norm(q))) nonVerbatimQuotes++;
  };

  for (const a of insights.actionItems) {
    checkQuote(a.sourceQuote);
    if (a.owner) {
      const first = norm(a.owner).split(" ")[0] ?? "";
      if (first && !t.includes(first)) fabricatedOwners.push(a.owner);
    }
  }
  for (const d of insights.decisions) checkQuote(d.sourceQuote);

  return {
    actionItems: insights.actionItems.length,
    decisions: insights.decisions.length,
    topics: insights.topics.length,
    fabricatedOwners,
    nonVerbatimQuotes,
    quotedItems,
    totalItems,
  };
}

async function ollamaModels(): Promise<string[]> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

async function main() {
  const [audioPath, truthPath] = process.argv.slice(2);
  if (!audioPath || !truthPath) {
    console.error("usage: pnpm eval:engines <audio> <ground-truth.txt>");
    process.exit(1);
  }
  const truth = await readFile(truthPath, "utf8");
  const names = properNouns(truth);
  // A/B the glossary: pass the very names we score on as a vocabulary hint.
  const glossary = process.env.EVAL_GLOSSARY ?? names.join(", ");
  const useGlossary = process.env.EVAL_USE_GLOSSARY === "1";
  const groqKey = process.env.GROQ_API_KEY;
  const hasGroq = !!groqKey && groqKey !== "...";
  // Resolve against the repo root, not the CLI's cwd.
  const modelDir = process.env.WHISPER_MODEL_DIR ?? path.join(DATA_DIR, "models");

  console.log(`\nground-truth names to preserve: ${names.join(", ")}`);
  console.log(`glossary: ${useGlossary ? `ON (${glossary})` : "OFF"}\n`);

  // ── Transcription ────────────────────────────────────────────────────────
  const transcribers: [string, TranscriptionProvider][] = [];
  for (const m of ["ggml-base.bin", "ggml-large-v3-turbo.bin"]) {
    transcribers.push([`local:${m}`, new LocalWhisperProvider(`${modelDir}/${m}`)]);
  }
  if (hasGroq) transcribers.push(["cloud:groq-whisper", new GroqWhisperProvider(groqKey)]);

  console.log("── TRANSCRIPTION ".padEnd(72, "─"));
  console.log("engine".padEnd(32) + "WER".padEnd(9) + "names kept".padEnd(14) + "time");
  for (const [label, provider] of transcribers) {
    try {
      const t0 = Date.now();
      const out = await transcribeFile(audioPath, provider, {
        language: "en",
        prompt: useGlossary ? glossary : undefined,
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const wer = wordErrorRate(truth, out.text);
      const lower = norm(out.text);
      const kept = names.filter((n) => lower.includes(n));
      console.log(
        label.padEnd(32) +
          `${(wer * 100).toFixed(1)}%`.padEnd(9) +
          `${kept.length}/${names.length}`.padEnd(14) +
          `${secs}s`,
      );
    } catch (err) {
      console.log(label.padEnd(32) + `skipped (${(err as Error).message.slice(0, 40)})`);
    }
  }

  // ── Extraction (on the clean transcript, to isolate the LLM) ─────────────
  const available = await ollamaModels();
  const llms: [string, LlmProvider][] = available.map((m) => [
    `local:${m}`,
    new OllamaProvider(m),
  ]);
  if (hasGroq) llms.push(["cloud:groq-llama-3.3-70b", new GroqLlamaProvider(groqKey)]);

  console.log("\n── EXTRACTION (on ground-truth transcript) ".padEnd(72, "─"));
  console.log(
    "engine".padEnd(32) +
      "items".padEnd(8) +
      "decis".padEnd(8) +
      "FAKE owners".padEnd(14) +
      "bad quotes".padEnd(13) +
      "time",
  );
  for (const [label, llm] of llms) {
    try {
      const t0 = Date.now();
      const { insights } = await extractInsights(truth, llm, {
        glossary: useGlossary ? glossary : undefined,
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const s = scoreExtraction(insights, truth);
      console.log(
        label.padEnd(32) +
          String(s.actionItems).padEnd(8) +
          String(s.decisions).padEnd(8) +
          (s.fabricatedOwners.length ? `${s.fabricatedOwners.length} ${s.fabricatedOwners.join(",")}` : "0").padEnd(14) +
          `${s.nonVerbatimQuotes}/${s.quotedItems}`.padEnd(13) +
          `${secs}s`,
      );
    } catch (err) {
      console.log(label.padEnd(32) + `FAILED (${(err as Error).message.slice(0, 45)})`);
    }
  }
  console.log(
    "\nFAKE owners = owner name absent from the transcript (SPEC §6 violation).",
  );
  console.log("bad quotes  = sourceQuotes that are not verbatim spans of the transcript.\n");
}

main().catch((err) => {
  console.error("eval failed:", err);
  process.exit(1);
});
