#!/usr/bin/env -S npx tsx
// SumMeet MCP server (roadmap A12).
//
// Exposes the meeting history as read-only tools an assistant (Claude Desktop, etc.) can
// query: "what did I commit to this week?", "every decision about pricing". It talks to
// the *local* API over HTTP — the same data path the panel uses — so nothing leaves the
// machine unless the user points a cloud assistant at it, and it can never write.
//
// Wire it into Claude Desktop's config (see apps/mcp/README.md). The SumMeet app must be
// running (or `pnpm dev`), since this is a thin client over its API.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.SUMMEET_API_BASE ?? "http://localhost:8080";

async function api(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SumMeet API ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Every tool returns its data as pretty JSON text — the shape assistants read best. */
function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: "summeet", version: "0.1.0" });

server.registerTool(
  "search_meetings",
  {
    title: "Search meetings",
    description:
      "Find meetings by a title substring and/or status. Returns a page of matches " +
      "(id, title, status, date). Use get_meeting for the full decision record.",
    inputSchema: {
      query: z.string().optional().describe("Case-insensitive title substring."),
      status: z
        .enum(["UPLOADED", "TRANSCRIBING", "TRANSCRIBED", "EXTRACTING", "COMPLETED", "FAILED"])
        .optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
    },
  },
  async ({ query, status, limit }) => {
    const p = new URLSearchParams();
    if (query) p.set("q", query);
    if (status) p.set("status", status);
    p.set("pageSize", String(limit ?? 20));
    return jsonResult(await api(`/api/meetings?${p}`));
  },
);

server.registerTool(
  "get_meeting",
  {
    title: "Get a meeting",
    description:
      "The full decision record for one meeting: the active insights (TL;DR, summary, " +
      "action items, decisions, …) and the transcript.",
    inputSchema: { id: z.string().describe("Meeting id from search_meetings.") },
  },
  async ({ id }) => jsonResult(await api(`/api/meetings/${encodeURIComponent(id)}`)),
);

server.registerTool(
  "list_commitments",
  {
    title: "List commitments",
    description:
      "Action items across all meetings, each with its meeting and source quote. " +
      'owner="You" narrows to the user\'s own commitments — the primary question ' +
      '("what did I commit to?"). Optional date range on the meeting date.',
    inputSchema: {
      owner: z.string().optional().describe('e.g. "You", or a name/role substring.'),
      from: z.string().optional().describe("ISO date, inclusive (YYYY-MM-DD)."),
      to: z.string().optional().describe("ISO date, inclusive."),
      limit: z.number().int().min(1).max(1000).optional(),
    },
  },
  async ({ owner, from, to, limit }) => {
    const p = new URLSearchParams();
    if (owner) p.set("owner", owner);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (limit) p.set("limit", String(limit));
    return jsonResult(await api(`/api/insights/commitments?${p}`));
  },
);

server.registerTool(
  "list_decisions",
  {
    title: "List decisions",
    description:
      "Decisions across all meetings, each with its meeting, rationale and source quote. " +
      "Optional date range on the meeting date.",
    inputSchema: {
      from: z.string().optional().describe("ISO date, inclusive (YYYY-MM-DD)."),
      to: z.string().optional().describe("ISO date, inclusive."),
      limit: z.number().int().min(1).max(1000).optional(),
    },
  },
  async ({ from, to, limit }) => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (limit) p.set("limit", String(limit));
    return jsonResult(await api(`/api/insights/decisions?${p}`));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
