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

// ── Speaker attribution from stereo channels (SPEC A1, zero-cost diarization) ─
// The recorder writes tab audio to the left channel and the mic to the right.
// Comparing per-segment energy tells us who spoke, with no model and no extra
// API call. Speakerphone bleeds the tab into the mic, so we require the mic to
// be clearly louder before calling a span "self".

const ENERGY_WINDOW_SEC = 0.1;
const ENERGY_SAMPLE_RATE = 8000; // plenty for loudness; keeps the decode cheap
/** Mic must beat the tab by this factor to count as "you" (echo tolerance). */
const SELF_DOMINANCE = 1.5;
/** Below this RMS both channels are effectively silence → unknown speaker. */
const SILENCE_RMS = 120; // int16 scale
/** Your voice must beat the *predicted echo* by this much to count as "you". */
const ECHO_MARGIN = 2;
/** Too few loud windows to fit a gain — assume headphones (no echo). */
const ECHO_MIN_WINDOWS = 20;
/** A quiet quantile of mic/system: the moments you weren't talking. */
const ECHO_GAIN_QUANTILE = 0.2;
/** Beyond this the "echo" is really a mic pointed at a speaker at full blast. */
const MAX_ECHO_GAIN = 3;
/**
 * Past this, the mic hears the room louder than it hears you (measured: laptop
 * speakers at volume 100 put the meeting into the mic 5x louder than the user's
 * own voice). No threshold can separate you from the echo there, so we decline to
 * attribute rather than sign someone else's words with your name.
 */
const ECHO_UNRELIABLE = 1;

/**
 * When you listen on speakers, the mic re-records everyone else. That echo scales
 * with the output volume: measured on an M2 Pro, the mic/system energy ratio ran
 * 0.09 at volume 30 but 1.27 at volume 100 — past a fixed 1.5 threshold the
 * meeting's own audio starts getting signed with your name.
 *
 * Echo is roughly a constant gain on the system signal, so estimate that gain
 * from the audio itself: over windows where the system is clearly playing, the
 * *quiet* quantile of mic/system is the ratio when you were silent — i.e. the
 * echo. Your actual voice then has to clear that, not a constant. On headphones
 * the gain collapses to ~0 and the old threshold applies unchanged.
 */
export function estimateEchoGain(left: Float64Array, right: Float64Array): number {
  const ratios: number[] = [];
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const l = left[i]!;
    if (l < SILENCE_RMS * 2) continue; // system not clearly playing: tells us nothing
    ratios.push(right[i]! / l);
  }
  if (ratios.length < ECHO_MIN_WINDOWS) return 0;
  ratios.sort((a, b) => a - b);
  const g = ratios[Math.floor(ratios.length * ECHO_GAIN_QUANTILE)]!;
  return Math.min(g, MAX_ECHO_GAIN);
}

/** Number of audio channels, via ffprobe. Mono audio can't be diarized this way. */
export async function probeChannels(filePath: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=channels",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 1;
}

export interface ChannelEnergy {
  left: Float64Array; // RMS per window
  right: Float64Array;
  windowSec: number;
}

/**
 * Stream the audio as 8 kHz stereo PCM and reduce it to per-window RMS for each
 * channel. Streaming (rather than buffering the whole PCM) keeps a 60-minute
 * meeting to a few hundred KB of energy data.
 */
export function computeChannelEnergy(filePath: string): Promise<ChannelEnergy> {
  return new Promise((resolve, reject) => {
    const samplesPerWindow = Math.round(ENERGY_SAMPLE_RATE * ENERGY_WINDOW_SEC);
    const left: number[] = [];
    const right: number[] = [];
    let sumL = 0;
    let sumR = 0;
    let count = 0;
    let carry: Buffer = Buffer.alloc(0);

    const child = spawn("ffmpeg", [
      "-v", "error",
      "-i", filePath,
      "-ac", "2",
      "-ar", String(ENERGY_SAMPLE_RATE),
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-",
    ]);

    child.stdout.on("data", (chunk: Buffer) => {
      let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      // Each frame is 4 bytes: int16 left + int16 right (interleaved).
      const usable = buf.length - (buf.length % 4);
      for (let i = 0; i < usable; i += 4) {
        const l = buf.readInt16LE(i);
        const r = buf.readInt16LE(i + 2);
        sumL += l * l;
        sumR += r * r;
        if (++count === samplesPerWindow) {
          left.push(Math.sqrt(sumL / count));
          right.push(Math.sqrt(sumR / count));
          sumL = sumR = count = 0;
        }
      }
      carry = buf.subarray(usable);
    });

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => reject(new Error(`ffmpeg failed: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
      if (count > 0) {
        left.push(Math.sqrt(sumL / count));
        right.push(Math.sqrt(sumR / count));
      }
      resolve({
        left: Float64Array.from(left),
        right: Float64Array.from(right),
        windowSec: ENERGY_WINDOW_SEC,
      });
    });
  });
}

/** A transcript segment can straddle a speaker change, so vote per 100ms window
 * rather than averaging RMS across the whole span: an average is dominated by
 * whichever voice was louder, not by who spoke most of it. Windows that are
 * silent, or where neither channel clearly dominates, don't vote. */
function voteSpeaker(
  left: Float64Array,
  right: Float64Array,
  startSec: number,
  endSec: number,
  windowSec: number,
  echoGain: number,
): "self" | "others" | null {
  const from = Math.max(0, Math.floor(startSec / windowSec));
  const to = Math.min(left.length, Math.ceil(endSec / windowSec));
  let selfWins = 0;
  let othersWins = 0;

  // On speakers the mic already carries `echoGain × left`; anything at or below
  // that is the meeting talking to itself, not you.
  const selfThreshold = Math.max(SELF_DOMINANCE, echoGain * ECHO_MARGIN);

  for (let i = from; i < to; i++) {
    const l = left[i]!;
    const r = right[i]!;
    if (Math.max(l, r) < SILENCE_RMS) continue; // silence
    if (r > l * selfThreshold) selfWins++;
    else if (l > r * SELF_DOMINANCE) othersWins++;
    // otherwise: both active (speakerphone bleed / crosstalk) — no vote
  }

  const voiced = selfWins + othersWins;
  if (voiced === 0) return null;
  // Require a clear majority; a genuinely split segment stays unattributed.
  if (selfWins > othersWins * 1.5) return "self";
  if (othersWins > selfWins * 1.5) return "others";
  return null;
}

/**
 * Label each segment with who spoke, using the stereo channels. Returns the
 * segments untouched (speaker undefined) when the audio isn't stereo — mono
 * uploads simply carry no speaker information.
 */
export async function assignSpeakers(
  filePath: string,
  segments: TranscriptSegment[],
): Promise<{ segments: TranscriptSegment[]; echoGain: number }> {
  if (segments.length === 0) return { segments, echoGain: 0 };
  if ((await probeChannels(filePath)) < 2) return { segments, echoGain: 0 };

  const { left, right, windowSec } = await computeChannelEnergy(filePath);
  if (left.length === 0) return { segments, echoGain: 0 };

  const echoGain = estimateEchoGain(left, right);
  if (echoGain >= ECHO_UNRELIABLE) return { segments, echoGain };

  return {
    segments: segments.map((seg) => ({
      ...seg,
      speaker: voteSpeaker(left, right, seg.start, seg.end, windowSec, echoGain),
    })),
    echoGain,
  };
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
