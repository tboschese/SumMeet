import {
  GroqLlamaProvider,
  GroqWhisperProvider,
  LocalStorageProvider,
  type LlmProvider,
  type StorageProvider,
  type TranscriptionProvider,
} from "@summeet/core";
import { AUDIO_DIR } from "./paths.js";

// The pipeline's dependencies, built once from env. Swapping any provider
// (local Whisper, R2 storage, a different LLM) happens only here.
export interface PipelineContext {
  storage: StorageProvider;
  transcription: TranscriptionProvider;
  llm: LlmProvider;
}

export function buildContext(): PipelineContext {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey || groqKey === "...") {
    throw new Error(
      "GROQ_API_KEY is not set in .env — required for transcription and extraction",
    );
  }
  return {
    storage: new LocalStorageProvider(AUDIO_DIR),
    transcription: new GroqWhisperProvider(groqKey),
    llm: new GroqLlamaProvider(groqKey),
  };
}
