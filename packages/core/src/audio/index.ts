import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TranscriptSegment } from "../transcription/index.js";

// Groq caps transcription uploads at ~25 MB. Stay under it with margin.
// Overridable via env so the chunk/stitch path can be exercised on small
// samples in tests without a 2-hour recording (defaults are production values).
const numEnv = (name: string, fallback: number): number => {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const MAX_TRANSCRIBE_BYTES = numEnv(
  "MAX_TRANSCRIBE_BYTES",
  24 * 1024 * 1024,
);

// Chunking windows (SPEC §7.5): ~10-min windows with a few seconds of overlap
// so a sentence split at a boundary still lands whole in one chunk.
export const WINDOW_SEC = numEnv("CHUNK_WINDOW_SEC", 600);
export const OVERLAP_SEC = numEnv("CHUNK_OVERLAP_SEC", 5);

/** Run a CLI binary, capturing stdout; reject with stderr on non-zero exit. */
function run(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      reject(
        new Error(
          `Failed to run ${cmd} (is it installed and on PATH?): ${err.message}`,
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`${cmd} exited ${code}: ${stderr}`)),
    );
  });
}

/**
 * Transcode to 16 kHz mono Opus @ 24 kbps (SPEC §7.5) — Whisper's native rate,
 * tiny files. Returns the path to the compressed .opus in `outDir`.
 */
export async function preprocessToOpus(
  inputPath: string,
  outDir: string,
): Promise<string> {
  const out = path.join(outDir, "preprocessed.opus");
  await run("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libopus",
    "-b:a",
    "24k",
    out,
  ]);
  return out;
}

/** Duration in seconds via ffprobe. */
export async function probeDurationSec(filePath: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) {
    throw new Error(`Could not read duration from ${filePath}`);
  }
  return seconds;
}

export interface AudioChunk {
  path: string;
  /** Seconds to add to this chunk's segment timestamps to place them globally. */
  offsetSec: number;
  /**
   * Absolute end (seconds) that this chunk "owns". Segments starting at/after
   * this belong to the next chunk's overlap tail and are dropped on stitch.
   */
  boundaryEndSec: number;
}

/**
 * Cut the audio into overlapping ~10-min windows. Chunk i spans
 * [i*WINDOW, i*WINDOW + WINDOW + OVERLAP): the trailing OVERLAP is extra
 * context whose duplicate tail is discarded at stitch time (boundaryEndSec).
 * Callers must rm() each chunk path when done.
 */
export async function planChunks(
  filePath: string,
  outDir: string,
  totalSec: number,
): Promise<AudioChunk[]> {
  const count = Math.max(1, Math.ceil(totalSec / WINDOW_SEC));
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * WINDOW_SEC;
    const isLast = i === count - 1;
    const duration = WINDOW_SEC + (isLast ? 0 : OVERLAP_SEC);
    const out = path.join(outDir, `chunk-${i}.opus`);
    const args = ["-y", "-ss", String(start), "-i", filePath];
    if (!isLast) args.push("-t", String(duration));
    // Re-encode (not -c copy): stream-copying Opus at arbitrary cut points is
    // unreliable; the audio is already tiny so re-encoding is cheap.
    args.push("-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", out);
    await run("ffmpeg", args);
    chunks.push({
      path: out,
      offsetSec: start,
      boundaryEndSec: isLast ? Number.POSITIVE_INFINITY : (i + 1) * WINDOW_SEC,
    });
  }
  return chunks;
}

export interface RawChunkTranscript {
  segments: TranscriptSegment[]; // timestamps relative to the chunk (start ~0)
  offsetSec: number;
  boundaryEndSec: number;
}

/**
 * Stitch per-chunk segments into one timeline: add each chunk's offset to its
 * timestamps and drop the overlap tail (segments whose absolute start falls
 * past the chunk's boundary — they belong to the next chunk). Returns global
 * segments and the concatenated full text.
 */
export function stitchSegments(chunks: RawChunkTranscript[]): {
  segments: TranscriptSegment[];
  text: string;
} {
  const segments: TranscriptSegment[] = [];
  for (const chunk of chunks) {
    for (const seg of chunk.segments) {
      const absStart = seg.start + chunk.offsetSec;
      if (absStart >= chunk.boundaryEndSec) continue; // overlap tail → skip
      segments.push({
        start: absStart,
        end: seg.end + chunk.offsetSec,
        text: seg.text,
      });
    }
  }
  const text = segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { segments, text };
}

/** Create a private temp dir; caller is responsible for cleanupTmp(). */
export async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "summeet-audio-"));
}

export async function cleanupTmp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function fileSizeBytes(filePath: string): Promise<number> {
  const buf = await readFile(filePath);
  return buf.byteLength;
}
