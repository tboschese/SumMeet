import { isMine, parseInsights } from "@summeet/core";
import type { FastifyInstance } from "fastify";
import type { PipelineContext } from "../context.js";
import { db } from "../db.js";
import { getSecrets, getSettings } from "../settings.js";

// Ask questions of your own meetings, in the app — "list today's main tasks", "what's
// still open on the Citrus project". A retrieval step gathers the structured insights,
// the extraction LLM answers over them. It runs on whichever engine Settings picks
// (local Ollama or cloud Groq), so a fully-offline install answers offline too.

/** Compact, bounded context: the model gets structure, not raw transcripts. */
async function buildContext(): Promise<{ text: string; meetings: number }> {
  const today = new Date().toISOString().slice(0, 10);
  // Recent live meetings with their active insights — newest first, capped.
  const rows = await db.meeting.findMany({
    where: { deletedAt: null, insights: { some: { active: true } } },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: {
      title: true,
      createdAt: true,
      notes: true,
      insights: { where: { active: true }, take: 1, select: { data: true } },
    },
  });

  const blocks: string[] = [];
  for (const m of rows) {
    const raw = m.insights[0]?.data;
    if (!raw) continue;
    let ins;
    try {
      ins = parseInsights(raw);
    } catch {
      continue;
    }
    const date = new Date(m.createdAt).toISOString().slice(0, 10);
    const lines = [`### ${m.title} (${date})`];
    if (ins.tldr) lines.push(`TL;DR: ${ins.tldr}`);
    for (const a of ins.actionItems) {
      const who = isMine(a.owner) ? "You" : (a.owner ?? "unassigned");
      lines.push(`- TASK [${who}${a.dueDate ? `, due ${a.dueDate}` : ""}]: ${a.task}`);
    }
    for (const d of ins.decisions) lines.push(`- DECISION: ${d.decision}`);
    if (m.notes?.trim()) lines.push(`Notes: ${m.notes.trim()}`);
    blocks.push(lines.join("\n"));
  }

  return {
    text: `Today is ${today}.\n\n${blocks.join("\n\n")}`,
    meetings: blocks.length,
  };
}

const SYSTEM = [
  "You are the user's meeting assistant. Answer questions using ONLY the meeting data",
  "provided — decision records extracted from their own meetings.",
  "Rules:",
  "- Ground every claim in the data; cite the meeting title in parentheses.",
  "- If the data does not contain the answer, say so plainly. Never invent tasks,",
  "  owners, dates, or decisions.",
  '- "You" in a TASK means the user themselves — their own commitments.',
  "- Be concise. Prefer a short list to a paragraph. Answer in the user's language.",
].join("\n");

export function registerAskRoutes(app: FastifyInstance, ctx: PipelineContext): void {
  app.post<{ Body: { question?: string } }>("/api/ask", async (request, reply) => {
    const question = request.body?.question?.trim();
    if (!question) return reply.code(400).send({ error: "question is required" });

    const { text, meetings } = await buildContext();
    if (meetings === 0) {
      return { answer: "There are no summarised meetings to search yet.", meetings: 0 };
    }

    const settings = await getSettings();
    const { llm } = ctx.resolve(settings, await getSecrets());
    const user = `MEETINGS:\n"""\n${text}\n"""\n\nQUESTION: ${question}`;
    try {
      const answer = await llm.complete(SYSTEM, user);
      return { answer: answer.trim(), meetings, provider: llm.id };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      request.log.error({ err }, "ask failed");
      return reply.code(502).send({ error: reason });
    }
  });
}
