import { readFile } from "node:fs/promises";
import {
  cleanupTmp,
  fileSizeBytes,
  makeTmpDir,
  MAX_TRANSCRIBE_BYTES,
  planChunks,
  preprocessToOpus,
  probeDurationSec,
  stitchSegments,
  type RawChunkTranscript,
} from "../audio/index.js";
import type {
  TranscribeOptions,
  TranscriptionProvider,
  TranscriptionResult,
} from "./index.js";

/**
 * End-to-end transcription of a file on disk (SPEC §7.3 steps 2–3):
 * preprocess → (chunk if over the size limit) → transcribe each chunk →
 * stitch segments back onto one timeline. The provider only ever sees a
 * single buffer; all the audio plumbing is here.
 */
export async function transcribeFile(
  inputPath: string,
  provider: TranscriptionProvider,
  opts: TranscribeOptions = {},
): Promise<TranscriptionResult> {
  const tmp = await makeTmpDir();
  try {
    const opus = await preprocessToOpus(inputPath, tmp);
    const size = await fileSizeBytes(opus);

    // Small enough to send in one shot — no chunking needed.
    if (size <= MAX_TRANSCRIBE_BYTES) {
      const buf = await readFile(opus);
      return provider.transcribe(buf, opts);
    }

    // Too big: cut into overlapping windows, transcribe each, stitch.
    const totalSec = await probeDurationSec(opus);
    const chunks = await planChunks(opus, tmp, totalSec);

    const raw: RawChunkTranscript[] = [];
    let language = opts.language ?? "unknown";
    for (const chunk of chunks) {
      const buf = await readFile(chunk.path);
      const result = await provider.transcribe(buf, opts);
      if (result.language && result.language !== "unknown") {
        language = result.language;
      }
      raw.push({
        segments: result.segments,
        offsetSec: chunk.offsetSec,
        boundaryEndSec: chunk.boundaryEndSec,
      });
    }

    const { segments, text } = stitchSegments(raw);
    return { text, segments, language };
  } finally {
    await cleanupTmp(tmp);
  }
}
