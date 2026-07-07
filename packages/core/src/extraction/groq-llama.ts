import type { LlmProvider } from "./index.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

interface GroqChatResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Groq-hosted Llama 3.3 70B for insight extraction (this build's LLM — no
 * Anthropic). Uses the OpenAI-compatible chat/completions endpoint with
 * response_format json_object and temperature 0 for stable structured output.
 */
export class GroqLlamaProvider implements LlmProvider {
  readonly id = `groq:${MODEL}`;

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("GROQ_API_KEY is required");
  }

  async complete(system: string, user: string): Promise<string> {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Groq extraction failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as GroqChatResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Groq returned an empty completion");
    return content;
  }
}
