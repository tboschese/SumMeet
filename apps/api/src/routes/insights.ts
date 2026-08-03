import { isMine, parseInsights } from "@summeet/core";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { db } from "../db.js";

// Cross-meeting aggregation over the active insight version of each live meeting. These
// power the MCP server (roadmap A12) — "what did I commit to this week?", "every decision
// about pricing" — and are read-only. Insights are JSON in a TEXT column, so the flatten
// happens in JS; at local scale (hundreds of meetings) that's fine.

interface DateRange {
  from?: string; // ISO date, inclusive
  to?: string; // ISO date, inclusive (end of day)
}

function meetingWhere(range: DateRange): Prisma.MeetingWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  if (range.from) createdAt.gte = new Date(range.from);
  if (range.to) {
    const end = new Date(range.to);
    end.setHours(23, 59, 59, 999);
    createdAt.lte = end;
  }
  return {
    deletedAt: null,
    ...(range.from || range.to ? { createdAt } : {}),
  };
}

/** Live meetings that have an active insights version, with that version parsed. */
async function activeInsights(range: DateRange) {
  const meetings = await db.meeting.findMany({
    where: { ...meetingWhere(range), insights: { some: { active: true } } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      createdAt: true,
      insights: { where: { active: true }, take: 1, select: { data: true } },
    },
  });
  return meetings.flatMap((m) => {
    const raw = m.insights[0]?.data;
    if (!raw) return [];
    try {
      return [{ meeting: m, insights: parseInsights(raw) }];
    } catch {
      return []; // a corrupt row shouldn't sink the whole query
    }
  });
}

export function registerInsightRoutes(app: FastifyInstance): void {
  /** Action items across meetings. `owner=You` narrows to the recorder's own
   * commitments (the primary job); any other value matches that owner loosely. */
  app.get<{ Querystring: { owner?: string; from?: string; to?: string; limit?: string } }>(
    "/api/insights/commitments",
    async (request) => {
      const { owner, from, to } = request.query;
      const limit = Math.min(Number(request.query.limit) || 200, 1000);
      const rows = await activeInsights({ from, to });

      const commitments = rows.flatMap(({ meeting, insights }) =>
        insights.actionItems
          .filter((a) => {
            if (!owner) return true;
            if (owner.toLowerCase() === "you") return isMine(a.owner);
            return (a.owner ?? "").toLowerCase().includes(owner.toLowerCase());
          })
          .map((a) => ({
            meetingId: meeting.id,
            meetingTitle: meeting.title,
            meetingDate: meeting.createdAt,
            task: a.task,
            owner: a.owner,
            dueDate: a.dueDate,
            priority: a.priority,
            sourceQuote: a.sourceQuote,
          })),
      );
      return { commitments: commitments.slice(0, limit), total: commitments.length };
    },
  );

  /** Decisions across meetings. */
  app.get<{ Querystring: { from?: string; to?: string; limit?: string } }>(
    "/api/insights/decisions",
    async (request) => {
      const { from, to } = request.query;
      const limit = Math.min(Number(request.query.limit) || 200, 1000);
      const rows = await activeInsights({ from, to });

      const decisions = rows.flatMap(({ meeting, insights }) =>
        insights.decisions.map((d) => ({
          meetingId: meeting.id,
          meetingTitle: meeting.title,
          meetingDate: meeting.createdAt,
          decision: d.decision,
          rationale: d.rationale,
          sourceQuote: d.sourceQuote,
        })),
      );
      return { decisions: decisions.slice(0, limit), total: decisions.length };
    },
  );
}
