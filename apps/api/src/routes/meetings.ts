import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  ACCEPTED_AUDIO_HINT,
  enhanceNotes,
  EnhancedNotesSchema,
  isAcceptedAudio,
  isSummeetStereoLayout,
  MeetingQuerySchema,
  parseInsights,
  parseSegments,
  SectionSchema,
  SUMMEET_STEREO_LAYOUT,
} from "@summeet/core";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { PipelineContext } from "../context.js";
import { db } from "../db.js";
import type { Queue } from "../queue.js";
import { extractAndPersist } from "../pipeline.js";
import { getSecrets, getSettings } from "../settings.js";
import { defaultTemplateSections } from "./templates.js";

function defaultTitle(filename?: string): string {
  if (filename) {
    const base = filename.replace(/\.[^.]+$/, "").trim();
    if (base) return base;
  }
  return `Meeting ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
}

/** Every string leaf of a parsed JSON value, joined — a searchable, readable blob of
 * the insights (summary, decisions, quotes…) without the JSON punctuation. */
function jsonText(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) jsonText(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) jsonText(v, out);
  return out;
}

/** A short excerpt of `text` centred on the first case-insensitive hit of `q`. */
function excerpt(text: string, q: string, before = 40, after = 90): string | null {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - before);
  const end = Math.min(text.length, i + q.length + after);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
}

/** Where a content-search hit landed and a readable excerpt of it. Title first (no
 * excerpt — the title is already shown), then the transcript, then the summary. Null
 * when the row matched only on structural JSON (e.g. a field name), which never needs a
 * badge. */
function locateMatch(
  q: string,
  title: string,
  transcript?: string | null,
  insightsData?: string | null,
): { matchedIn: "title" | "transcript" | "summary" | null; snippet: string | null } {
  if (title.toLowerCase().includes(q.toLowerCase())) return { matchedIn: "title", snippet: null };
  if (transcript) {
    const s = excerpt(transcript, q);
    if (s) return { matchedIn: "transcript", snippet: s };
  }
  if (insightsData) {
    try {
      const s = excerpt(jsonText(JSON.parse(insightsData)).join(" · "), q);
      if (s) return { matchedIn: "summary", snippet: s };
    } catch {
      /* corrupt JSON — no excerpt */
    }
  }
  return { matchedIn: null, snippet: null };
}

export function registerMeetingRoutes(
  app: FastifyInstance,
  ctx: PipelineContext,
  queue: Queue,
): void {
  // Create: accept a recorded/uploaded audio blob → store → row → enqueue.
  app.post("/api/meetings", async (request, reply) => {
    let title: string | undefined;
    let audio: Buffer | undefined;
    let filename: string | undefined;
    let contentType = "audio/webm";
    // Only our own recorders may claim the stereo layout; a plain upload can't.
    let channelLayout: string | null = null;
    let uploadedSections: string[] | undefined; // template sections chosen for this upload

    let tooLarge = false;
    try {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "file" && part.fieldname === "audio") {
          filename = part.filename;
          if (part.mimetype) contentType = part.mimetype;
          // Reject wrong types before buffering the whole thing.
          if (!isAcceptedAudio(part.filename ?? "", part.mimetype)) {
            return reply.code(400).send({
              error: `unsupported file type. Accepted: ${ACCEPTED_AUDIO_HINT}`,
            });
          }
          audio = await part.toBuffer();
          if (part.file.truncated) tooLarge = true;
        } else if (part.type === "field" && part.fieldname === "title") {
          title = String(part.value);
        } else if (part.type === "field" && part.fieldname === "channelLayout") {
          const claimed = String(part.value);
          channelLayout = isSummeetStereoLayout(claimed) ? SUMMEET_STEREO_LAYOUT : null;
        } else if (part.type === "field" && part.fieldname === "sections") {
          const parsed = z.array(SectionSchema).safeParse(JSON.parse(String(part.value)));
          if (parsed.success && parsed.data.length) uploadedSections = parsed.data;
        }
      }
    } catch (err) {
      request.log.error({ err }, "upload parse failed");
      return reply.code(400).send({ error: "could not read the upload" });
    }

    if (tooLarge) {
      return reply.code(413).send({ error: "file too large" });
    }
    if (!audio || audio.byteLength === 0) {
      return reply
        .code(400)
        .send({ error: "missing 'audio' file part (or it was empty)" });
    }

    // Which sections this meeting's summary will have: the template picked in the upload
    // (browser path), else the user's default template. Native recordings send none, so
    // they get the default — which is the whole point of a default template.
    let meetingSections = uploadedSections;
    if (!meetingSections) {
      const def = await defaultTemplateSections();
      meetingSections = def.length ? def : undefined;
    }

    const meeting = await db.meeting.create({
      data: {
        title: title?.trim() || defaultTitle(filename),
        status: "UPLOADED",
        channelLayout,
        sections: meetingSections ? JSON.stringify(meetingSections) : "",
      },
    });
    // Keep the real extension: the browser sends .webm, the desktop recorder .ogg.
    // ffmpeg sniffs content rather than trusting names, but a key that lies about its
    // format makes every later diagnosis harder.
    const ext = filename?.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? ".webm";
    const audioKey = `${meeting.id}${ext}`;
    await ctx.storage.put(audioKey, audio, contentType);
    await db.meeting.update({ where: { id: meeting.id }, data: { audioKey } });

    queue.enqueue(meeting.id);
    return reply.code(201).send({ id: meeting.id, status: "UPLOADED" });
  });

  // List: newest first, paginated and filterable. Returns the page plus the total, so
  // the panel can render page controls without a second round trip.
  app.get<{
    Querystring: {
      page?: string;
      pageSize?: string;
      q?: string;
      status?: string;
      trash?: string;
    };
  }>("/api/meetings", async (request) => {
    const query = MeetingQuerySchema.parse(request.query);

    // Trash is a separate view, never mixed into the list — a deleted meeting showing
    // up among live ones is worse than not being able to find it.
    const where: Prisma.MeetingWhereInput = {
      deletedAt: query.trash ? { not: null } : null,
      ...(query.status ? { status: query.status } : {}),
      // "none" is the explicit unfiled bucket; any other id filters to that folder.
      ...(query.folderId
        ? { folderId: query.folderId === "none" ? null : query.folderId }
        : {}),
      // Content search: match the title, what was said (transcript) or what was
      // extracted (the active insights JSON — this also covers a summary written in a
      // different output language than the transcript). SQLite LIKE is case-insensitive
      // for ASCII; Prisma parameterises it, so the text can't be a wildcard injection.
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q } },
              { transcript: { fullText: { contains: query.q } } },
              { insights: { some: { active: true, data: { contains: query.q } } } },
            ],
          }
        : {}),
    };

    // On a search we pull the transcript + active insights of the page's rows to build a
    // "matched here" excerpt. Only when searching, and only the current page (≤ pageSize),
    // so a plain listing stays as lean as before.
    const searching = Boolean(query.q);
    const [meetings, total] = await Promise.all([
      db.meeting.findMany({
        where,
        orderBy: query.trash ? { deletedAt: "desc" } : { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          title: true,
          status: true,
          durationSec: true,
          createdAt: true,
          deletedAt: true,
          folderId: true,
          ...(searching
            ? {
                transcript: { select: { fullText: true } },
                insights: { where: { active: true }, take: 1, select: { data: true } },
              }
            : {}),
        },
      }),
      db.meeting.count({ where }),
    ]);

    const shaped = meetings.map((m) => {
      if (!searching) return m;
      const { transcript, insights, ...rest } = m as typeof m & {
        transcript?: { fullText: string } | null;
        insights?: { data: string }[];
      };
      const hit = locateMatch(query.q!, rest.title, transcript?.fullText, insights?.[0]?.data);
      return { ...rest, matchedIn: hit.matchedIn, snippet: hit.snippet };
    });

    return {
      meetings: shaped,
      total,
      page: query.page,
      pageSize: query.pageSize,
      pages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  });

  /** How many meetings are in the trash — for the badge on the trash link. */
  app.get("/api/meetings/trash/count", async () => {
    return { count: await db.meeting.count({ where: { deletedAt: { not: null } } }) };
  });

  /** Live meetings in a time window, for the home calendar. Unpaginated — a month holds
   * few enough rows — with just what a day cell needs. `hasNotes` flags the ones you
   * typed your own notes into. The client passes the window as instants and buckets by
   * local date, so day boundaries are always the user's, not UTC's. */
  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/api/meetings/calendar",
    async (request) => {
      const { from, to } = request.query;
      const createdAt: Prisma.DateTimeFilter = {};
      if (from) createdAt.gte = new Date(from);
      if (to) createdAt.lt = new Date(to);
      const meetings = await db.meeting.findMany({
        where: { deletedAt: null, ...(from || to ? { createdAt } : {}) },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          durationSec: true,
          folderId: true,
          notes: true,
        },
      });
      return {
        meetings: meetings.map(({ notes, ...m }) => ({ ...m, hasNotes: notes.trim().length > 0 })),
      };
    },
  );

  /** Restore a meeting from the trash. */
  app.post<{ Params: { id: string } }>(
    "/api/meetings/:id/restore",
    async (request, reply) => {
      const meeting = await db.meeting.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!meeting) return reply.code(404).send({ error: "meeting not found" });
      await db.meeting.update({
        where: { id: meeting.id },
        data: { deletedAt: null },
      });
      return { ok: true };
    },
  );

  /** Empty the trash: purge every meeting already in it. */
  app.post("/api/meetings/trash/empty", async () => {
    const trashed = await db.meeting.findMany({
      where: { deletedAt: { not: null } },
      select: { id: true, audioKey: true },
    });
    for (const meeting of trashed) {
      if (meeting.audioKey) {
        await ctx.storage.delete(meeting.audioKey).catch(() => {});
      }
    }
    const { count } = await db.meeting.deleteMany({
      where: { deletedAt: { not: null } },
    });
    return { ok: true, purged: count };
  });

  // Detail: meeting + transcript + the active insights version (JSON parsed on read),
  // plus the list of versions so the UI can offer a rollback.
  app.get<{ Params: { id: string } }>("/api/meetings/:id", async (request, reply) => {
    const meeting = await db.meeting.findUnique({
      where: { id: request.params.id },
      include: {
        transcript: true,
        insights: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!meeting) return reply.code(404).send({ error: "meeting not found" });

    const { transcript, insights, ...meetingRow } = meeting;
    const active = insights.find((i) => i.active) ?? insights[0];
    // The user's notes, expanded from the transcript. Parsed here so the
    // panel gets structure; empty until enhancement runs.
    let enhancedNotes: unknown = null;
    if (meetingRow.enhancedNotes) {
      const parsed = EnhancedNotesSchema.safeParse(
        JSON.parse(meetingRow.enhancedNotes),
      );
      if (parsed.success && parsed.data.notes.length > 0) enhancedNotes = parsed.data;
    }
    return {
      meeting: meetingRow,
      enhancedNotes,
      transcript: transcript
        ? {
            fullText: transcript.fullText,
            segments: parseSegments(transcript.segments),
            provider: transcript.provider,
          }
        : null,
      insights: active
        ? { id: active.id, data: parseInsights(active.data), provider: active.provider }
        : null,
      // Newest first; the UI shows a picker only when there's more than one.
      insightVersions: insights.map((i) => ({
        id: i.id,
        provider: i.provider,
        active: i.active,
        createdAt: i.createdAt,
      })),
    };
  });

  // Retry: re-enqueue a FAILED meeting.
  app.post<{ Params: { id: string } }>(
    "/api/meetings/:id/retry",
    async (request, reply) => {
      const meeting = await db.meeting.findUnique({
        where: { id: request.params.id },
      });
      if (!meeting) return reply.code(404).send({ error: "meeting not found" });
      if (meeting.status !== "FAILED") {
        return reply
          .code(409)
          .send({ error: `cannot retry a meeting in status ${meeting.status}` });
      }
      await db.meeting.update({
        where: { id: meeting.id },
        data: { status: "UPLOADED", error: null },
      });
      queue.enqueue(meeting.id);
      return { id: meeting.id, status: "UPLOADED" };
    },
  );

  // Audio: stream the recording from disk (optional, for in-app playback).
  app.get<{ Params: { id: string } }>(
    "/api/meetings/:id/audio",
    async (request, reply) => {
      const meeting = await db.meeting.findUnique({
        where: { id: request.params.id },
        select: { audioKey: true },
      });
      if (!meeting?.audioKey || !ctx.storage.localPath) {
        return reply.code(404).send({ error: "audio not available" });
      }
      const filePath = ctx.storage.localPath(meeting.audioKey);
      const info = await stat(filePath).catch(() => null);
      if (!info) return reply.code(404).send({ error: "audio not available" });
      reply.header("Content-Length", info.size);
      reply.type("audio/webm");
      return reply.send(createReadStream(filePath));
    },
  );

  // Rename: update the meeting title.
  app.patch<{ Params: { id: string }; Body: { title?: string; notes?: string } }>(
    "/api/meetings/:id",
    async (request, reply) => {
      const title = request.body?.title?.trim();
      const notes = request.body?.notes; // may be "" to clear; undefined = leave as is
      if (title === undefined && notes === undefined) {
        return reply.code(400).send({ error: "nothing to update" });
      }
      if (title !== undefined && !title) {
        return reply.code(400).send({ error: "title cannot be empty" });
      }
      const exists = await db.meeting.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!exists) return reply.code(404).send({ error: "meeting not found" });
      await db.meeting.update({
        where: { id: exists.id },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(notes !== undefined ? { notes } : {}),
        },
      });
      return { ok: true };
    },
  );

  // Re-extract: re-run extraction over the stored transcript (no re-recording,
  // no re-transcription). Also promotes a TRANSCRIBED meeting to COMPLETED.
  app.post<{ Params: { id: string } }>(
    "/api/meetings/:id/reextract",
    async (request, reply) => {
      const meeting = await db.meeting.findUnique({
        where: { id: request.params.id },
        select: { id: true, transcript: { select: { id: true } } },
      });
      if (!meeting) return reply.code(404).send({ error: "meeting not found" });
      if (!meeting.transcript) {
        return reply.code(400).send({ error: "no transcript to extract from" });
      }
      try {
        await extractAndPersist(meeting.id, ctx, (m) => request.log.info(m));
        return { ok: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await db.meeting
          .update({ where: { id: meeting.id }, data: { status: "FAILED", error: reason } })
          .catch(() => {});
        return reply.code(500).send({ error: reason });
      }
    },
  );

  // Apply a template's sections to this meeting and re-run the summary with them — the
  // detail-page template picker. Persists the sections so a later re-extract keeps them.
  app.post<{ Params: { id: string }; Body: { sections?: unknown } }>(
    "/api/meetings/:id/sections",
    async (request, reply) => {
      const parsed = z.array(SectionSchema).min(1).safeParse(request.body?.sections);
      if (!parsed.success) return reply.code(400).send({ error: "pick at least one section" });
      const meeting = await db.meeting.findUnique({
        where: { id: request.params.id },
        select: { id: true, transcript: { select: { id: true } } },
      });
      if (!meeting) return reply.code(404).send({ error: "meeting not found" });
      await db.meeting.update({
        where: { id: meeting.id },
        data: { sections: JSON.stringify(parsed.data) },
      });
      if (!meeting.transcript) return { ok: true, reextracted: false };
      try {
        await extractAndPersist(meeting.id, ctx, (m) => request.log.info(m));
        return { ok: true, reextracted: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: reason });
      }
    },
  );

  // Enhance the user's notes from the transcript. Needs a transcript and
  // some notes; stores the result on the meeting and returns it.
  app.post<{ Params: { id: string } }>(
    "/api/meetings/:id/enhance-notes",
    async (request, reply) => {
      const meeting = await db.meeting.findUnique({
        where: { id: request.params.id },
        select: { id: true, notes: true, transcript: { select: { fullText: true } } },
      });
      if (!meeting) return reply.code(404).send({ error: "meeting not found" });
      if (!meeting.transcript) {
        return reply.code(400).send({ error: "no transcript to enhance from" });
      }
      if (!meeting.notes.trim()) {
        return reply.code(400).send({ error: "no notes to enhance" });
      }
      const settings = await getSettings();
      const { llm } = ctx.resolve(settings, await getSecrets());
      try {
        const { enhanced } = await enhanceNotes(meeting.notes, meeting.transcript.fullText, llm);
        await db.meeting.update({
          where: { id: meeting.id },
          data: { enhancedNotes: JSON.stringify(enhanced) },
        });
        return { ok: true, enhancedNotes: enhanced };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: reason });
      }
    },
  );

  // Roll back to an earlier insights version. Makes the chosen version active and the
  // rest inactive — the current one isn't discarded, so you can roll forward again.
  app.post<{ Params: { id: string; versionId: string } }>(
    "/api/meetings/:id/insights/:versionId/activate",
    async (request, reply) => {
      const version = await db.insights.findFirst({
        where: { id: request.params.versionId, meetingId: request.params.id },
        select: { id: true },
      });
      if (!version) return reply.code(404).send({ error: "insights version not found" });
      await db.$transaction([
        db.insights.updateMany({
          where: { meetingId: request.params.id, active: true },
          data: { active: false },
        }),
        db.insights.update({ where: { id: version.id }, data: { active: true } }),
      ]);
      return { ok: true };
    },
  );

  // Batch: summarize every meeting resting at TRANSCRIBED. Queued (not inline)
  // because a local LLM takes ~40s each and this must not block the request.
  app.post("/api/meetings/extract-pending", async () => {
    const pending = await db.meeting.findMany({
      where: { status: "TRANSCRIBED", deletedAt: null },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (pending.length === 0) return { queued: 0 };

    // Flip to EXTRACTING up front: they really are queued, and it lets the UI
    // poll immediately instead of waiting for the worker to reach each one.
    await db.meeting.updateMany({
      where: { id: { in: pending.map((m) => m.id) } },
      data: { status: "EXTRACTING", error: null },
    });
    for (const m of pending) queue.enqueue(m.id, "extract");
    return { queued: pending.length };
  });

  // Delete: remove the row (transcript/insights cascade) and the audio file.
  /**
   * Delete = move to the trash. The recording is discarded once transcribed, so the
   * insights and transcript are all that remain of a meeting: a hard delete is
   * unrecoverable, and the panel used to fire one from a `window.confirm` the desktop
   * webview never even showed. Restore is a click; purging is a deliberate act.
   *
   * `?permanent=true` purges, for the trash view's "delete forever".
   */
  app.delete<{ Params: { id: string }; Querystring: { permanent?: string } }>(
    "/api/meetings/:id",
    async (request, reply) => {
      const meeting = await db.meeting.findUnique({
        where: { id: request.params.id },
        select: { id: true, audioKey: true },
      });
      if (!meeting) return reply.code(404).send({ error: "meeting not found" });

      if (request.query.permanent !== "true") {
        await db.meeting.update({
          where: { id: meeting.id },
          data: { deletedAt: new Date() },
        });
        return { ok: true, trashed: true };
      }

      if (meeting.audioKey) {
        await ctx.storage.delete(meeting.audioKey).catch(() => {
          /* file may already be gone — deleting the row is what matters */
        });
      }
      await db.meeting.delete({ where: { id: meeting.id } });
      return { ok: true, purged: true };
    },
  );
}
