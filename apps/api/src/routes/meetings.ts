import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  ACCEPTED_AUDIO_HINT,
  extractInsights,
  isAcceptedAudio,
  parseInsights,
  parseSegments,
  stringifyInsights,
} from "@summeet/core";
import type { FastifyInstance } from "fastify";
import type { PipelineContext } from "../context.js";
import { db } from "../db.js";
import type { Queue } from "../queue.js";
import { getSettings, outputLanguage } from "../settings.js";

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

  // Rename: update the meeting title.
  app.patch<{ Params: { id: string }; Body: { title?: string } }>(
    "/api/meetings/:id",
    async (request, reply) => {
      const title = request.body?.title?.trim();
      if (!title) return reply.code(400).send({ error: "title is required" });
      const exists = await db.meeting.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!exists) return reply.code(404).send({ error: "meeting not found" });
      await db.meeting.update({ where: { id: exists.id }, data: { title } });
      return { ok: true };
    },
  );

  // Re-extract: re-run extraction over the stored transcript (no re-recording,
  // no re-transcription) — for iterating on the prompt during validation.
  app.post<{ Params: { id: string } }>(
    "/api/meetings/:id/reextract",
    async (request, reply) => {
      const meeting = await db.meeting.findUnique({
        where: { id: request.params.id },
        include: { transcript: true },
      });
      if (!meeting) return reply.code(404).send({ error: "meeting not found" });
      if (!meeting.transcript) {
        return reply.code(400).send({ error: "no transcript to extract from" });
      }
      try {
        const settings = await getSettings();
        const { llm } = ctx.resolve(settings);
        const { insights, rawOutput, provider } = await extractInsights(
          meeting.transcript.fullText,
          llm,
          { outputLanguage: outputLanguage(settings) },
        );
        const data = stringifyInsights(insights);
        await db.insights.upsert({
          where: { meetingId: meeting.id },
          create: { meetingId: meeting.id, data, rawOutput, provider },
          update: { data, rawOutput, provider },
        });
        await db.meeting.update({
          where: { id: meeting.id },
          data: { language: insights.language },
        });
        return { ok: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: reason });
      }
    },
  );

  // Delete: remove the row (transcript/insights cascade) and the audio file.
  app.delete<{ Params: { id: string } }>(
    "/api/meetings/:id",
    async (request, reply) => {
      const meeting = await db.meeting.findUnique({
        where: { id: request.params.id },
        select: { id: true, audioKey: true },
      });
      if (!meeting) return reply.code(404).send({ error: "meeting not found" });

      if (meeting.audioKey) {
        await ctx.storage.delete(meeting.audioKey).catch(() => {
          /* file may already be gone — deleting the row is what matters */
        });
      }
      await db.meeting.delete({ where: { id: meeting.id } });
      return { ok: true };
    },
  );
}
