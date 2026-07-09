import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractInsights,
  stringifyInsights,
  stringifySegments,
  transcribeFile,
} from "@summeet/core";
import type { PipelineContext } from "./context.js";
import { db } from "./db.js";
import { getSettings, outputLanguage, transcriptionHint } from "./settings.js";

/**
 * The worker pipeline (SPEC §7.3), fail-soft (CLAUDE.md hard rule #7): read
 * audio → transcribe → extract → persist, driving status
 * TRANSCRIBING → EXTRACTING → COMPLETED. Any error sets FAILED + a
 * human-readable reason; it never throws out of here.
 */
export async function runPipeline(
  meetingId: string,
  ctx: PipelineContext,
  log?: (msg: string) => void,
): Promise<void> {
  let tmpDir: string | undefined;
  try {
    const meeting = await db.meeting.findUnique({ where: { id: meetingId } });
    if (!meeting) throw new Error(`meeting ${meetingId} not found`);
    if (!meeting.audioKey) throw new Error("meeting has no audio");

    const settings = await getSettings();
    const { transcription: transcriber, llm } = ctx.resolve(settings);

    // 1. Read audio from storage → a temp file for ffmpeg.
    const buf = await ctx.storage.get(meeting.audioKey);
    tmpDir = await mkdtemp(path.join(tmpdir(), "summeet-pipe-"));
    const audioPath = path.join(tmpDir, meeting.audioKey);
    await writeFile(audioPath, buf);

    // 2. Transcribe (preprocess + chunk/stitch live inside transcribeFile).
    await db.meeting.update({
      where: { id: meetingId },
      data: { status: "TRANSCRIBING", error: null },
    });
    log?.(`pipeline ${meetingId}: transcribing`);
    const transcript = await transcribeFile(audioPath, transcriber, {
      language: transcriptionHint(settings),
    });

    const durationSec =
      transcript.segments.length > 0
        ? Math.round(transcript.segments[transcript.segments.length - 1]!.end)
        : null;

    await db.transcript.upsert({
      where: { meetingId },
      create: {
        meetingId,
        fullText: transcript.text,
        segments: stringifySegments(transcript.segments),
        provider: transcriber.id,
      },
      update: {
        fullText: transcript.text,
        segments: stringifySegments(transcript.segments),
        provider: transcriber.id,
      },
    });

    // 3. Extract insights (parse/validate/repair inside extractInsights).
    await db.meeting.update({
      where: { id: meetingId },
      data: { status: "EXTRACTING", durationSec },
    });
    log?.(`pipeline ${meetingId}: extracting`);
    const { insights, rawOutput, provider } = await extractInsights(
      transcript.text,
      llm,
      { outputLanguage: outputLanguage(settings) },
    );

    await db.insights.upsert({
      where: { meetingId },
      create: {
        meetingId,
        data: stringifyInsights(insights),
        rawOutput,
        provider,
      },
      update: {
        data: stringifyInsights(insights),
        rawOutput,
        provider,
      },
    });

    // 4. Done.
    await db.meeting.update({
      where: { id: meetingId },
      data: { status: "COMPLETED", language: insights.language, error: null },
    });

    // Discard the recording — the product is the insights + transcript, not the
    // audio. Keeps nothing sensitive on disk once processing succeeds.
    if (meeting.audioKey) {
      await ctx.storage.delete(meeting.audioKey).catch(() => {});
      await db.meeting.update({
        where: { id: meetingId },
        data: { audioKey: null },
      });
    }
    log?.(`pipeline ${meetingId}: COMPLETED`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log?.(`pipeline ${meetingId}: FAILED — ${reason}`);
    await db.meeting
      .update({
        where: { id: meetingId },
        data: { status: "FAILED", error: reason },
      })
      .catch(() => {
        /* if even this fails, swallow — never crash the worker */
      });
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  }
}
