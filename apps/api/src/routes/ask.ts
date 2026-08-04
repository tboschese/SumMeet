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
    // Phrase the context in natural language, not machine labels: a small model tends to
    // echo whatever shape it's given, so if it does copy something, it should still read
    // like a sentence rather than "TASK [You, due …]".
    const date = new Date(m.createdAt).toLocaleDateString("en-CA");
    const lines = [`Meeting "${m.title}" on ${date}.`];
    if (ins.tldr) lines.push(`In short: ${ins.tldr}`);
    for (const a of ins.actionItems) {
      const who = isMine(a.owner) ? "the user" : (a.owner ?? "someone");
      const due = a.dueDate ? `, by ${a.dueDate}` : "";
      lines.push(`${who} agreed to: ${a.task}${due}.`);
    }
    for (const d of ins.decisions) lines.push(`They decided: ${d.decision}.`);
    if (m.notes?.trim()) lines.push(`The user's own notes: ${m.notes.trim()}`);
    blocks.push(lines.join("\n"));
  }

  return {
    text: `Today is ${today}.\n\n${blocks.join("\n\n")}`,
    meetings: blocks.length,
  };
}

const SYSTEM = [
  "You are the user's meeting assistant. Talk to them the way a helpful colleague would —",
  "warm, natural, conversational, in flowing sentences. Answer their question directly, as",
  "if you were chatting.",
  "",
  "You answer using ONLY the meeting data provided (decision records from their own",
  "meetings). Ground what you say in it and mention the meeting by name naturally in the",
  "sentence — 'In the sales sync you agreed to…' — not as a citation tag. If several things",
  "match, weave them into a short list of hyphen bullets, but open and close with a natural",
  "line so it reads like a reply, not a dump.",
  "",
  "Never invent tasks, owners, dates or decisions; if the meetings don't cover it, just say",
  'so, plainly and kindly. "You" in a TASK is the user themselves — their own commitments.',
  "",
  "Write plain text only: no HTML, no JSON, no code blocks, no tables, no headings. Reply in",
  "the user's language.",
  "",
  "Example — for 'what did I commit to?' a good answer reads like:",
  "\"You've got two things on your plate. In the sales sync you said you'd finish the sales",
  "report by Friday, and in the planning meeting you took on reviewing the game rules and",
  'writing a guide for them." — natural sentences, the meeting named in passing, no braces',
  "or tags.",
].join("\n");

/** Belt-and-braces cleanup, because small local models wrap answers in JSON or HTML no
 * matter what the prompt says. Recover the prose inside so the user never sees the
 * scaffolding. */
function cleanAnswer(raw: string): string {
  let text = raw.replace(/```[a-z]*\n?/gi, "").trim();

  // If the model returned a JSON object/array, keep the human sentences inside it: the
  // string leaves (and sentence-like keys) are the actual answer.
  if (/^[[{]/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      const parts: string[] = [];
      const walk = (v: unknown) => {
        if (typeof v === "string") parts.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          for (const [k, val] of Object.entries(v)) {
            if (/\s/.test(k)) parts.push(k); // a sentence used as a key
            walk(val);
          }
        }
      };
      walk(parsed);
      if (parts.length) text = parts.join("\n\n");
    } catch {
      // Not valid JSON — fall through and strip the obvious scaffolding below.
      text = text.replace(/^[[{]|[}\]]$/g, "").replace(/^\s*"|"\s*:?\s*$/gm, "");
    }
  }

  return text
    .replace(/<\/?[a-z][^>]*>/gi, "") // HTML tags
    .replace(/<[^>]*>/g, "") // stray/empty angle pairs like <>
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/^[\s{}[\]":,]+/, "") // stray scaffolding leaked onto the front
    .replace(/[\s{}[\]"]+$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
      const answer = cleanAnswer(await llm.complete(SYSTEM, user));
      // Persist the search so it's there next time (the user asked for this).
      const saved = await db.askLog.create({
        data: { question, answer, provider: llm.id },
      });
      return { id: saved.id, answer, meetings, provider: llm.id };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      request.log.error({ err }, "ask failed");
      return reply.code(502).send({ error: reason });
    }
  });

  /** Recent questions, newest first — the Ask page's history. */
  app.get<{ Querystring: { limit?: string } }>("/api/ask/history", async (request) => {
    const limit = Math.min(Number(request.query.limit) || 20, 100);
    const history = await db.askLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, question: true, answer: true, provider: true, createdAt: true },
    });
    return { history };
  });

  /** Forget one saved question, or clear them all with ?all=true. */
  app.delete<{ Params: { id: string }; Querystring: { all?: string } }>(
    "/api/ask/history/:id",
    async (request) => {
      if (request.query.all === "true") {
        const { count } = await db.askLog.deleteMany({});
        return { ok: true, cleared: count };
      }
      await db.askLog.delete({ where: { id: request.params.id } }).catch(() => {});
      return { ok: true };
    },
  );
}
