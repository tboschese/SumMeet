import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { parseInsights, parseSegments } from "@summeet/core";
import type { FastifyInstance } from "fastify";
import type { PipelineContext } from "../context.js";
import { db } from "../db.js";
import type { Queue } from "../queue.js";

function defaultTitle(filename?: string): string {
  if (filename) {
    const base = filename.replace(/\.[^.]+$/, "").trim();
    if (base) return base;
  }
  return `Meeting ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
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

    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === "file" && part.fieldname === "audio") {
        filename = part.filename;
        if (part.mimetype) contentType = part.mimetype;
        audio = await part.toBuffer();
      } else if (part.type === "field" && part.fieldname === "title") {
        title = String(part.value);
      }
    }

    if (!audio || audio.byteLength === 0) {
      return reply
        .code(400)
        .send({ error: "missing 'audio' file part (or it was empty)" });
    }

    const meeting = await db.meeting.create({
      data: { title: title?.trim() || defaultTitle(filename), status: "UPLOADED" },
    });
    const audioKey = `${meeting.id}.webm`;
    await ctx.storage.put(audioKey, audio, contentType);
    await db.meeting.update({ where: { id: meeting.id }, data: { audioKey } });

    queue.enqueue(meeting.id);
    return reply.code(201).send({ id: meeting.id, status: "UPLOADED" });
  });

  // List: newest first.
  app.get("/api/meetings", async () => {
    return db.meeting.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        status: true,
        durationSec: true,
        createdAt: true,
      },
    });
  });

  // Detail: meeting + transcript + insights (JSON parsed/validated on read).
  app.get<{ Params: { id: string } }>("/api/meetings/:id", async (request, reply) => {
    const meeting = await db.meeting.findUnique({
      where: { id: request.params.id },
      include: { transcript: true, insights: true },
    });
    if (!meeting) return reply.code(404).send({ error: "meeting not found" });

    const { transcript, insights, ...meetingRow } = meeting;
    return {
      meeting: meetingRow,
      transcript: transcript
        ? {
            fullText: transcript.fullText,
            segments: parseSegments(transcript.segments),
            provider: transcript.provider,
          }
        : null,
      insights: insights
        ? { data: parseInsights(insights.data), provider: insights.provider }
        : null,
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
}
