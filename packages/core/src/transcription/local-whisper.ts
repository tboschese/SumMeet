import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  TranscribeOptions,
  TranscriptionProvider,
  TranscriptionResult,
} from "./index.js";

/** whisper.cpp's `-oj` output shape (offsets are milliseconds). */
interface WhisperCppJson {
  result?: { language?: string };
  transcription?: {
    offsets: { from: number; to: number };
    text: string;
  }[];
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      reject(
        new Error(
          `Failed to run ${cmd} (is it installed and on PATH?): ${err.message}`,
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr}`)),
    );
  });
}

/**
 * Local, offline transcription via whisper.cpp — the "private mode" the
 * TranscriptionProvider seam exists for (SPEC §7.4, Appendix A A3). Nothing
 * leaves the machine and there is no API cost.
 *
 * whisper.cpp only reads 16 kHz mono PCM WAV, so we transcode the incoming
 * buffer with ffmpeg first.
 */
export class LocalWhisperProvider implements TranscriptionProvider {
  readonly id: string;

  constructor(
    private readonly modelPath: string,
    private readonly binary = "whisper-cli",
  ) {
    this.id = `local:whisper.cpp/${path.basename(modelPath)}`;
  }

  async transcribe(
    audio: Buffer,
    opts: TranscribeOptions = {},
  ): Promise<TranscriptionResult> {
    const dir = await mkdtemp(path.join(tmpdir(), "summeet-whisper-"));
    try {
      const input = path.join(dir, "in.audio");
      const wav = path.join(dir, "in.wav");
      const outBase = path.join(dir, "out");
      await writeFile(input, audio);

      // whisper.cpp requires 16 kHz mono signed-16 PCM.
      await run("ffmpeg", [
        "-y", "-i", input,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        wav,
      ]);

      const args = [
        "-m", this.modelPath,
        "-f", wav,
        "-oj", // write <outBase>.json
        "-of", outBase,
        "-np", // no progress prints
      ];
      if (opts.language) args.push("-l", opts.language);
      // whisper.cpp conditions on an initial prompt — pins names/jargon.
      if (opts.prompt) args.push("--prompt", opts.prompt);
      await run(this.binary, args);

      const raw = await readFile(`${outBase}.json`, "utf8");
      const data = JSON.parse(raw) as WhisperCppJson;

      const segments = (data.transcription ?? [])
        .map((s) => ({
          start: s.offsets.from / 1000,
          end: s.offsets.to / 1000,
          text: s.text.trim(),
        }))
        .filter((s) => s.text.length > 0);

      return {
        text: segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim(),
        segments,
        language: data.result?.language ?? opts.language ?? "unknown",
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
