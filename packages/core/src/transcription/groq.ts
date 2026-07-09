import type {
  TranscribeOptions,
  TranscriptionProvider,
  TranscriptionResult,
} from "./index.js";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3-turbo";

interface GroqVerboseSegment {
  start: number;
  end: number;
  text: string;
}

interface GroqVerboseResponse {
  text: string;
  language?: string;
  segments?: GroqVerboseSegment[];
}

/**
 * Groq Whisper transcription (SPEC §7.4). Uses the OpenAI-compatible
 * /audio/transcriptions endpoint with response_format=verbose_json so we get
 * per-segment timestamps. Chunking/stitching lives one layer up
 * (transcribeFile); this provider transcribes exactly one buffer.
 */
export class GroqWhisperProvider implements TranscriptionProvider {
  readonly id = `groq:${MODEL}`;

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("GROQ_API_KEY is required");
  }

  async transcribe(
    audio: Buffer,
    opts: TranscribeOptions = {},
  ): Promise<TranscriptionResult> {
    const form = new FormData();
    // Groq infers the format from the filename extension; we always feed .opus.
    form.append("file", new Blob([audio], { type: "audio/ogg" }), "audio.opus");
    form.append("model", MODEL);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    if (opts.language) form.append("language", opts.language);
    if (opts.prompt) form.append("prompt", opts.prompt); // vocabulary hint

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Groq transcription failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as GroqVerboseResponse;
    const segments = (data.segments ?? []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));

    return {
      text: data.text.trim(),
      segments,
      language: data.language ?? opts.language ?? "unknown",
    };
  }
}
