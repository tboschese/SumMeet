// Transcription abstraction (SPEC §7.4). The MVP impl is GroqWhisperProvider;
// a LocalWhisperProvider (faster-whisper, "private mode") drops in behind the
// same interface later without touching the pipeline.

export interface TranscriptSegment {
  start: number; // seconds, absolute in the full recording's timeline
  end: number; // seconds
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  language: string;
}

export interface TranscribeOptions {
  language?: string; // ISO 639-1 hint; omit to auto-detect
}

export interface TranscriptionProvider {
  /** Transcribe a single audio buffer (one file/chunk). */
  transcribe(
    audio: Buffer,
    opts?: TranscribeOptions,
  ): Promise<TranscriptionResult>;
  /** Human-readable id stored on the Transcript row, e.g. "groq:whisper-large-v3-turbo". */
  readonly id: string;
}

export { GroqWhisperProvider } from "./groq.js";
export { transcribeFile } from "./transcribe-file.js";
