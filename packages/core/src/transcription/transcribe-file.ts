import { readFile } from "node:fs/promises";
import {
  cleanupTmp,
  estimateChannelBalance,
  fileSizeBytes,
  makeTmpDir,
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
    // Only for audio a SumMeet recorder declared: in `summeet-stereo-v1` the two
    // channels are two different people, recorded at whatever gain their hardware
    // happened to use. Averaging them buries the quieter one. An arbitrary stereo
    // upload is just music — balancing its channels would be meaningless.
    const balance = opts.balanceChannels
      ? ((await estimateChannelBalance(inputPath)) ?? undefined)
      : undefined;
    const opus = await preprocessToOpus(inputPath, tmp, balance);
    const size = await fileSizeBytes(opus);

    // Chunk only to satisfy a provider's upload cap. Local providers have none,
    // so they see the whole recording in one pass.
    const cap = provider.maxInputBytes;
    if (cap === undefined || size <= cap) {
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
