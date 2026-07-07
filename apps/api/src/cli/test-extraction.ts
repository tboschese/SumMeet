import { strict as assert } from "node:assert";
import { extractInsights, type LlmProvider } from "@summeet/core";

// Deterministic test of the parse → validate → repair logic (SPEC §11 Session 2
// "done when": malformed model output is caught and repaired). No API key needed
// — the LlmProvider is faked so we control exactly what the "model" returns.

const VALID_JSON = JSON.stringify({
  tldr: "The team agreed to ship the iOS beta on Friday.",
  executiveSummary: "A weekly sync covering the mobile launch, pricing, and data migration.",
  keyPoints: ["iOS checkout done", "Two payment bugs open", "Pricing moving to three tiers"],
  actionItems: [
    {
      task: "Redesign the pricing page",
      owner: "James",
      dueDate: "next Tuesday",
      priority: "medium",
      sourceQuote: "I'll take the pricing page redesign",
    },
  ],
  decisions: [
    {
      decision: "Ship the iOS beta on Friday",
      rationale: "Assuming the two payment bugs are fixed",
      sourceQuote: "we launch the beta on Friday",
    },
  ],
  topics: [{ title: "Data migration", summary: "Move to the new DB at month end." }],
  language: "en",
});

/** Returns a scripted sequence of responses, one per complete() call. */
function scriptedProvider(responses: string[]): LlmProvider {
  let i = 0;
  return {
    id: "fake:test",
    async complete() {
      const r = responses[Math.min(i, responses.length - 1)] ?? "";
      i++;
      return r;
    },
  };
}

async function run() {
  // 1) Valid on first try — no repair needed.
  {
    const p = scriptedProvider([VALID_JSON]);
    const { insights } = await extractInsights("transcript", p);
    assert.equal(insights.decisions[0]?.decision, "Ship the iOS beta on Friday");
    console.log("✓ case 1: valid-on-first-try passes");
  }

  // 2) Malformed first (missing required fields + junk), valid on repair.
  {
    const p = scriptedProvider(['{"tldr": "oops", not json at all', VALID_JSON]);
    const { insights, rawOutput } = await extractInsights("transcript", p);
    assert.equal(insights.actionItems[0]?.owner, "James");
    assert.equal(rawOutput, VALID_JSON, "rawOutput should be the repaired response");
    console.log("✓ case 2: malformed → caught → repaired passes");
  }

  // 3) Schema-invalid first (valid JSON, wrong shape), valid on repair.
  {
    const bad = JSON.stringify({ tldr: "x", keyPoints: "should be an array" });
    const p = scriptedProvider([bad, VALID_JSON]);
    const { insights } = await extractInsights("transcript", p);
    assert.equal(insights.language, "en");
    console.log("✓ case 3: schema-invalid → caught → repaired passes");
  }

  // 4) Still invalid after repair — must throw, never return unvalidated JSON.
  {
    const p = scriptedProvider(["garbage", "still garbage"]);
    await assert.rejects(
      () => extractInsights("transcript", p),
      /after repair/i,
      "should throw when repair also fails",
    );
    console.log("✓ case 4: invalid-after-repair throws (no unvalidated output)");
  }

  console.log("\nAll extraction repair-logic tests passed.");
}

run().catch((err) => {
  console.error("✗ test failed:", err);
  process.exit(1);
});
