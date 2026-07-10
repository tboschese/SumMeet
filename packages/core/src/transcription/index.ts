// Transcription abstraction (SPEC §7.4). The MVP impl is GroqWhisperProvider;
// a LocalWhisperProvider (faster-whisper, "private mode") drops in behind the
// same interface later without touching the pipeline.

// TranscriptSegment's shape lives in schemas.ts (source of truth, §8).
export type { TranscriptSegment } from "../schemas.js";
import type { TranscriptSegment } from "../schemas.js";

export interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  language: string;
}

export interface TranscribeOptions {
  language?: string; // ISO 639-1 hint; omit to auto-detect
  /**
   * Vocabulary hint ("initial prompt"): people, product and domain terms.
   * Whisper conditions on it, so names get spelled right instead of guessed —
   * the cheapest quality win for small local models (SPEC A6).
   */
  prompt?: string;
}

export interface TranscriptionProvider {
  /** Transcribe a single audio buffer (one file/chunk). */
  transcribe(
    audio: Buffer,
    opts?: TranscribeOptions,
  ): Promise<TranscriptionResult>;
  /** Human-readable id stored on the Transcript row, e.g. "groq:whisper-large-v3-turbo". */
  readonly id: string;
  /**
   * Largest buffer this provider accepts, if it has a limit. Chunking exists to
   * satisfy an API's upload cap — a local binary has none, so it transcribes the
   * whole file in one pass (better context, and it avoids paying whisper.cpp's
   * ~12s Metal init once per chunk). `undefined` = no limit.
   */
  readonly maxInputBytes?: number;
}

export { GroqWhisperProvider } from "./groq.js";
export { LocalWhisperProvider } from "./local-whisper.js";
export { transcribeFile } from "./transcribe-file.js";
