import "../env.js"; // load repo-root .env (GROQ_API_KEY)
import { access } from "node:fs/promises";
import { GroqWhisperProvider, transcribeFile } from "@summeet/core";

// Isolated-session CLI (SPEC §11, Session 1):
//   pnpm transcribe <audio> [--language pt]
// Prints the transcript text + segments JSON so we can eyeball a real sample.
async function main() {
  const args = process.argv.slice(2);
  const langFlag = args.indexOf("--language");
  const langValueIdx = langFlag === -1 ? -1 : langFlag + 1;
  const language = langValueIdx === -1 ? undefined : args[langValueIdx];
  const input = args.find(
    (a, i) => !a.startsWith("--") && i !== langValueIdx,
  );

  if (!input) {
    console.error("usage: pnpm transcribe <audio-file> [--language <iso>]");
    process.exit(1);
  }
  await access(input).catch(() => {
    console.error(`file not found: ${input}`);
    process.exit(1);
  });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === "...") {
    console.error("GROQ_API_KEY is not set in .env");
    process.exit(1);
  }

  const provider = new GroqWhisperProvider(apiKey);
  console.error(`Transcribing ${input} via ${provider.id} …`);
  const started = Date.now();
  const result = await transcribeFile(input, provider, { language });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.error(
    `\n✓ done in ${elapsed}s — language=${result.language}, ${result.segments.length} segments\n`,
  );
  console.log("──── TEXT ────");
  console.log(result.text);
  console.log("\n──── SEGMENTS (JSON) ────");
  console.log(JSON.stringify(result.segments, null, 2));
}

main().catch((err) => {
  console.error("\n✗ transcription failed:", err.message);
  process.exit(1);
});
