import path from "node:path";
import {
  GroqLlamaProvider,
  GroqWhisperProvider,
  LocalStorageProvider,
  LocalWhisperProvider,
  OllamaProvider,
  type LlmProvider,
  type Settings,
  type StorageProvider,
  type TranscriptionProvider,
} from "@summeet/core";
import { AUDIO_DIR, DATA_DIR, REPO_ROOT } from "./paths.js";

// Local engine configuration (all overridable via .env).
export const WHISPER_BIN = process.env.WHISPER_BIN || "whisper-cli";
// Relative model paths resolve against the repo root, not the cwd.
export const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH
  ? path.resolve(REPO_ROOT, process.env.WHISPER_MODEL_PATH)
  : path.join(DATA_DIR, "models", "ggml-large-v3-turbo.bin");
export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL || "http://localhost:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";

/**
 * The pipeline's dependencies. Providers are resolved per job from the user's
 * settings — this is the seam (SPEC §7.4/§7.6) that lets "cloud" (Groq) and
 * "local" (whisper.cpp + Ollama, free & offline) coexist, and even mix.
 */
export interface PipelineContext {
  storage: StorageProvider;
  resolve(settings: Settings): {
    transcription: TranscriptionProvider;
    llm: LlmProvider;
  };
}

function requireGroqKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key || key === "...") {
    throw new Error(
      "GROQ_API_KEY is not set in .env — required for the cloud engine. " +
        "Switch to the local engine in Settings to run offline.",
    );
  }
  return key;
}

export function buildContext(): PipelineContext {
  return {
    storage: new LocalStorageProvider(AUDIO_DIR),

    resolve(settings) {
      const transcription: TranscriptionProvider =
        settings.transcriptionEngine === "local"
          ? new LocalWhisperProvider(WHISPER_MODEL_PATH, WHISPER_BIN)
          : new GroqWhisperProvider(requireGroqKey());

      const llm: LlmProvider =
        settings.extractionEngine === "local"
          ? new OllamaProvider(OLLAMA_MODEL, OLLAMA_BASE_URL)
          : new GroqLlamaProvider(requireGroqKey());

      return { transcription, llm };
    },
  };
}
