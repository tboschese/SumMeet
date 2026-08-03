// Does compressing the upload destroy speaker attribution?
//
// A 46-minute meeting is rejected today (WAV at 48 kHz stereo is 11.5 MB/min against a
// 500 MB cap), so the recorder has to compress. But diarization reads per-channel
// energy, and lossy stereo coding can collapse the two channels into mid/side — which
// would silently break who-said-what. Measure it instead of assuming.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { assignSpeakers } from "@summeet/core";

const RATE = 48000, SECS = 24;

/**
 * The hard case, not the easy one: both channels carry noise-like signal the whole time
 * (speech is noise-like, not tonal), and "you" only *dominates* during your windows —
 * the meeting keeps bleeding in. That is where a codec's stereo coupling would smear the
 * channels together and quietly break attribution.
 */
function build(): Buffer {
  const n = RATE * SECS;
  const buf = Buffer.alloc(n * 4);
  const noise = () => (Math.random() * 2 - 1) * 32768;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const you = (t >= 6 && t < 10) || (t >= 16 && t < 20);
    // Meeting always present; you speak over it, clearly louder, in your windows.
    const l = noise() * 0.05;
    const r = noise() * (you ? 0.30 : 0.01);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l))), i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r))), i * 4 + 2);
  }
  return buf;
}

const run = (args: string[]) =>
  new Promise<void>((res, rej) => {
    const p = spawn("ffmpeg", args);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg " + c))));
  });

await mkdir("/tmp/compress-check", { recursive: true });
const wav = "/tmp/compress-check/src.wav";
await new Promise<void>((res, rej) => {
  const p = spawn("ffmpeg", ["-y","-v","error","-f","s16le","-ar",String(RATE),"-ac","2","-i","pipe:0",wav]);
  p.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg " + c))));
  p.stdin.end(build());
});

const segments = [
  { start: 0, end: 6, text: "meeting" },
  { start: 6, end: 10, text: "you" },
  { start: 10, end: 16, text: "meeting" },
  { start: 16, end: 20, text: "you" },
];
// The question is whether compression *changes the answer*, not whether this synthetic
// hits some ideal: the uncompressed WAV is the baseline, and a codec that agrees with it
// preserves everything diarization reads.

const candidates: { name: string; file: string; args: string[] }[] = [
  { name: "opus 32k", file: "/tmp/compress-check/o32.ogg",
    args: ["-c:a","libopus","-b:a","32k","-ac","2"] },
  { name: "opus 64k", file: "/tmp/compress-check/o64.ogg",
    args: ["-c:a","libopus","-b:a","64k","-ac","2"] },
  { name: "opus 96k", file: "/tmp/compress-check/o96.ogg",
    args: ["-c:a","libopus","-b:a","96k","-ac","2"] },
  { name: "flac 16k", file: "/tmp/compress-check/f16.flac",
    args: ["-c:a","flac","-ar","16000","-ac","2"] },
];

const mb = (f: string) => (statSync(f).size / 1e6);
const perHour = (f: string) => (mb(f) / SECS) * 3600;

console.log(`  ${"formato".padEnd(12)} ${"MB/hora".padStart(8)}  atribuição`);
const base = await assignSpeakers(wav, segments as never);
const baseLabels = base.segments.map((s: { speaker?: string | null }) => s.speaker ?? null);
console.log(`  ${"wav (hoje)".padEnd(12)} ${perHour(wav).toFixed(0).padStart(8)}  ${JSON.stringify(baseLabels)}`);

let failures = 0;
for (const c of candidates) {
  await run(["-y","-v","error","-i",wav,...c.args,c.file]);
  const { segments: got } = await assignSpeakers(c.file, segments as never);
  const labels = got.map((s: { speaker?: string | null }) => s.speaker ?? null);
  const ok = JSON.stringify(labels) === JSON.stringify(baseLabels);
  if (!ok) failures++;
  console.log(`  ${c.name.padEnd(12)} ${perHour(c.file).toFixed(0).padStart(8)}  ${JSON.stringify(labels)} ${ok ? "✓ igual ao WAV" : "✗ DIVERGE do WAV"}`);
}
console.log(`\n  limite de upload: 524 MB → hoje o WAV estoura em 45,5 min`);
process.exit(failures === 0 ? 0 : 1);
