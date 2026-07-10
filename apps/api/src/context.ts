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
// qwen2.5:7b measured at parity with Groq Llama 3.3 70B on our eval (SPEC
// §13.7); llama3.2:3b emits no sourceQuotes at all, so it is not a default.
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";

/**
 * The pipeline's dependencies. Providers are resolved per job from the user's
 * settings — this is the seam (SPEC §7.4/§7.6) that lets "cloud" (Groq) and
 * "local" (whisper.cpp + Ollama, free & offline) coexist, and even mix.
 */
export interface PipelineContext {
  storage: StorageProvider;
  /** Secrets are passed in, never read from the environment here (SPEC A0). */
  resolve(
    settings: Settings,
    secrets: { groqApiKey?: string },
  ): {
    transcription: TranscriptionProvider;
    llm: LlmProvider;
  };
}

function requireGroqKey(secrets: { groqApiKey?: string }): string {
  if (!secrets.groqApiKey) {
    throw new Error(
      "No Groq API key configured — required for the cloud engine. " +
        "Add one in Settings, or switch that stage to the local engine to run offline.",
    );
  }
  return secrets.groqApiKey;
}

export function buildContext(): PipelineContext {
  return {
    storage: new LocalStorageProvider(AUDIO_DIR),

    resolve(settings, secrets) {
      const transcription: TranscriptionProvider =
        settings.transcriptionEngine === "local"
          ? new LocalWhisperProvider(WHISPER_MODEL_PATH, WHISPER_BIN)
          : new GroqWhisperProvider(requireGroqKey(secrets));

      const llm: LlmProvider =
        settings.extractionEngine === "local"
          ? new OllamaProvider(OLLAMA_MODEL, OLLAMA_BASE_URL)
          : new GroqLlamaProvider(requireGroqKey(secrets));

      return { transcription, llm };
    },
  };
}
