import "../env.js"; // load repo-root .env (GROQ_API_KEY)
import { readFile } from "node:fs/promises";
import { extractInsights, GroqLlamaProvider } from "@summeet/core";

// Isolated-session CLI (SPEC §11, Session 2):
//   pnpm extract <transcript.txt>
// Prints the validated MeetingInsights JSON.
async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: pnpm extract <transcript.txt>");
    process.exit(1);
  }
  const transcript = await readFile(input, "utf8").catch(() => {
    console.error(`file not found: ${input}`);
    process.exit(1);
  });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === "...") {
    console.error("GROQ_API_KEY is not set in .env");
    process.exit(1);
  }

  const provider = new GroqLlamaProvider(apiKey);
  console.error(`Extracting insights via ${provider.id} …`);
  const started = Date.now();
  const { insights, provider: id } = await extractInsights(
    transcript as string,
    provider,
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.error(
    `\n✓ valid insights in ${elapsed}s via ${id} — language=${insights.language}, ${insights.actionItems.length} action items, ${insights.decisions.length} decisions\n`,
  );
  console.log(JSON.stringify(insights, null, 2));
}

main().catch((err) => {
  console.error("\n✗ extraction failed:", err.message);
  process.exit(1);
});
