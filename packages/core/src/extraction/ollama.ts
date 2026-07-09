import type { LlmProvider } from "./index.js";

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

/**
 * Local, offline insight extraction via Ollama — "private mode" behind the same
 * LlmProvider seam (SPEC §7.6, Appendix A A3). Free, and the transcript never
 * leaves the machine.
 *
 * Uses Ollama's native /api/chat with format:"json", which constrains the model
 * to emit a JSON object (the repair-retry in extractInsights still guards it).
 */
export class OllamaProvider implements LlmProvider {
  readonly id: string;

  constructor(
    private readonly model: string,
    private readonly baseUrl = "http://localhost:11434",
  ) {
    this.id = `ollama:${model}`;
  }

  async complete(system: string, user: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: "json",
          options: { temperature: 0 },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
    } catch {
      throw new Error(
        `Could not reach Ollama at ${this.baseUrl}. Is it running? (\`ollama serve\`)`,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama extraction failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    if (data.error) throw new Error(`Ollama error: ${data.error}`);
    const content = data.message?.content;
    if (!content) throw new Error("Ollama returned an empty completion");
    return content;
  }
}
