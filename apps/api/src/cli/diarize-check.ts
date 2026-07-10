// Synthetic verification of speaker attribution. The pipeline deletes meeting
// audio, so the only way to regression-test the two real-world cases (headphones,
// speakers) is to build them.
import { spawn } from "node:child_process";
import { assignSpeakers } from "@summeet/core";

const RATE = 16000, SECS = 20;
const rand = () => Math.random() * 2 - 1;

/** Speech-shaped: loud bursts with gaps, like someone talking. */
function videoAt(t: number, loud: number): number {
  const speaking = (t < 6 || t >= 8) && Math.sin(t * 3) > -0.5;
  return speaking ? loud : 40;
}

type Mode = "headphones" | "speakers" | "quiet-meeting-noisy-mic";

function build(mode: Mode): Buffer {
  // The regression: the user's real recording had system RMS 0.016 and mic RMS
  // 0.024 — the meeting was mixed quietly and the mic's room tone was louder.
  // A pure loudness ratio handed the video's words to "self".
  const loud = mode === "quiet-meeting-noisy-mic" ? 400 : 1500;
  const ambient = mode === "quiet-meeting-noisy-mic" ? 260 : 150;
  const n = RATE * SECS;
  const buf = Buffer.alloc(n * 4); // stereo s16
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const l = videoAt(t, loud) * rand();
    const userSpeaking = t >= 6 && t < 8;
    let r = ambient * rand();                   // ambient room tone
    if (userSpeaking) r += 2000 * rand();       // your voice
    if (mode === "speakers") r += 1.27 * l;     // the meeting, off the speakers
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l))), i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r))), i * 4 + 2);
  }
  return buf;
}

function toWav(pcm: Buffer, out: string): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn("ffmpeg", ["-y", "-v", "error", "-f", "s16le", "-ar", String(RATE),
      "-ac", "2", "-i", "pipe:0", out]);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg " + c))));
    p.stdin.end(pcm);
  });
}

const segments = [
  { start: 0, end: 6, text: "video talking" },
  { start: 6, end: 8, text: "eu vou fechar o relatorio ate sexta" },
  { start: 8, end: 20, text: "video talking again" },
];
const expected: Record<Mode, (string | null)[]> = {
  headphones: ["others", "self", "others"],
  speakers: [null, null, null],
  // The video's words must never come back as "self", however quiet the meeting.
  "quiet-meeting-noisy-mic": ["others", "self", "others"],
};

let failures = 0;
for (const mode of ["headphones", "speakers", "quiet-meeting-noisy-mic"] as const) {
  const file = `/tmp/diarize-${mode}.wav`;
  await toWav(build(mode), file);
  const { segments: got, echoGain } = await assignSpeakers(file, segments as never);
  const labels = got.map((s: { speaker?: string | null }) => s.speaker ?? null);
  const ok = JSON.stringify(labels) === JSON.stringify(expected[mode]);
  if (!ok) failures++;
  console.log(`\n  ${ok ? "✓" : "✗"} ${mode}: echoGain=${echoGain.toFixed(2)}`);
  console.log(`      got      ${JSON.stringify(labels)}`);
  console.log(`      expected ${JSON.stringify(expected[mode])}`);
}

console.log(failures === 0 ? "\n  ALL PASS" : `\n  ${failures} FAILED`);
process.exit(failures ? 1 : 0);
