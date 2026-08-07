import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assignSpeakers,
  estimateChannelBalance,
  extractInsights,
  formatTranscriptForPrompt,
  isSummeetStereoLayout,
  parseSegments,
  probeDurationSec,
  stringifyInsights,
  stringifySegments,
  toLanguageCode,
  transcribeFile,
  enhanceNotes,
} from "@summeet/core";
import type { PipelineContext } from "./context.js";
import { db } from "./db.js";
import { SectionSchema } from "@summeet/core";
import { z } from "zod";
import {
  getSecrets,
  getSettings,
  glossary,
  outputLanguage,
  sections,
  transcriptionHint,
} from "./settings.js";

/** This meeting's own sections (from its template), else the global default. */
function meetingSections(rawSections: string, settings: Parameters<typeof sections>[0]): ReturnType<typeof sections> {
  if (rawSections) {
    const parsed = z.array(SectionSchema).safeParse(JSON.parse(rawSections || "[]"));
    if (parsed.success && parsed.data.length) return parsed.data;
  }
  return sections(settings);
}

/**
 * Transcriptions in flight, keyed by meeting. The worker is single-threaded, so a hung or
 * runaway transcription blocks every meeting behind it. Two things can abort one: the
 * watchdog timeout below, and `cancelPipeline` (called when the user trashes a meeting
 * that's still processing). Aborting kills the whisper child / aborts the HTTP request.
 */
const inflight = new Map<string, AbortController>();

/** Cancel a meeting's in-flight transcription, if any — frees the worker immediately. */
export function cancelPipeline(meetingId: string): void {
  inflight.get(meetingId)?.abort();
}

/** Hard cap on a single transcription. A real meeting finishes well inside this; a hang
 * hits it and fails, rather than jamming the queue forever. */
const TRANSCRIBE_TIMEOUT_MS = 30 * 60_000;
/** A live chunk is short (tens of seconds), so it should transcribe quickly; cap it low so
 * a stuck chunk can't hold up the ones behind it. */
const SEGMENT_TIMEOUT_MS = 5 * 60_000;

/**
 * Transcribe one live chunk of a still-recording meeting and append it to the running
 * transcript, offset onto the meeting timeline (streaming transcription — SPEC A?/A0).
 * Fail-soft: a bad chunk is logged and dropped, because the full recording uploaded at
 * stop is the authoritative fallback, so the transcript is never left silently wrong.
 */
export async function runSegment(
  meetingId: string,
  segmentPath: string,
  offsetSec: number,
  boundaryEndSec: number,
  ctx: PipelineContext,
  log?: (msg: string) => void,
): Promise<void> {
  try {
    const meeting = await db.meeting.findUnique({
      where: { id: meetingId },
      include: { transcript: true },
    });
    if (!meeting || meeting.deletedAt) return; // cancelled or gone while queued
    // Only a meeting still being recorded takes live chunks. A chunk that somehow arrives
    // after `finish` has run would otherwise splice text into a transcript the user has
    // already read — and whose insights were drawn from it.
    if (meeting.status !== "TRANSCRIBING") {
      log?.(`segment ${meetingId}: ignored — meeting is ${meeting.status}, not recording`);
      return;
    }

    const settings = await getSettings();
    const { transcription } = ctx.resolve(settings, await getSecrets());

    // Equalise the two speakers before the downmix, exactly as the full pipeline does —
    // otherwise a quiet voice is averaged away and Whisper transcribes only the loud side.
    // Estimated per chunk, which also tracks a speaker who gets quieter as the meeting goes on.
    const balance = isSummeetStereoLayout(meeting.channelLayout)
      ? ((await estimateChannelBalance(segmentPath)) ?? undefined)
      : undefined;

    // Whisper decides the language per call, and a chunk is short: in a test run one chunk
    // of an English meeting came back in Portuguese. So the first chunk that lands on a
    // language we recognise pins it for the rest of the recording. An explicit setting
    // still wins over both.
    const language = transcriptionHint(settings) ?? toLanguageCode(meeting.language);

    const abort = new AbortController();
    inflight.set(meetingId, abort);
    const watchdog = setTimeout(() => abort.abort(), SEGMENT_TIMEOUT_MS);
    let result: Awaited<ReturnType<typeof transcribeFile>>;
    try {
      result = await transcribeFile(segmentPath, transcription, {
        language,
        prompt: glossary(settings),
        balance,
        signal: abort.signal,
      });
    } finally {
      clearTimeout(watchdog);
      inflight.delete(meetingId);
    }
    if (!language) {
      const detected = toLanguageCode(result.language);
      if (detected) {
        await db.meeting.update({ where: { id: meetingId }, data: { language: detected } });
        log?.(`segment ${meetingId}: language pinned to ${detected} for the rest of the recording`);
      }
    }

    // Shift the chunk's segments onto the meeting timeline and merge into the running
    // transcript, ordered by start.
    //
    // Chunks overlap on purpose: each one's audio runs a few seconds past the point where
    // the next takes over, so a phrase straddling a cut is transcribed whole instead of
    // being sliced in half (measured: without this, every cut swallowed a phrase). Two
    // rules keep that overlap from showing up twice —
    //   1. drop what starts past this chunk's boundary: the next chunk covers it from its
    //      own start, with context (same rule as `stitchSegments` for oversized uploads);
    //   2. drop what is entirely inside what we already have — the head of this chunk
    //      re-transcribing the previous one's tail. Only *fully* covered segments go, so a
    //      segment that reaches past the end is kept: a duplicated phrase is cheap, a
    //      missing one is not.
    const existing = meeting.transcript ? parseSegments(meeting.transcript.segments) : [];
    const coveredTo = existing.reduce((max, s) => Math.max(max, s.end), 0);
    const shifted = result.segments
      .map((s) => ({ ...s, start: s.start + offsetSec, end: s.end + offsetSec }))
      .filter((s) => s.start < boundaryEndSec && s.end > coveredTo);
    const merged = [...existing, ...shifted].sort((a, b) => a.start - b.start);
    const fullText = merged.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();

    await db.transcript.upsert({
      where: { meetingId },
      create: { meetingId, fullText, segments: stringifySegments(merged), provider: transcription.id },
      update: { fullText, segments: stringifySegments(merged) },
    });
    log?.(
      `segment ${meetingId} @${offsetSec.toFixed(0)}s: +${shifted.length} kept of ` +
        `${result.segments.length} (${merged.length} total)`,
    );
  } catch (err) {
    log?.(`segment ${meetingId} @${offsetSec.toFixed(0)}s: skipped — ${String(err)}`);
  } finally {
    await rm(segmentPath, { force: true }).catch(() => {});
  }
}

/**
 * Delete the recording once the transcript exists — the product is the insights
 * + transcript, and nothing sensitive should linger on disk.
 */
async function discardAudio(
  ctx: PipelineContext,
  meetingId: string,
  audioKey: string | null,
): Promise<void> {
  if (!audioKey) return;
  await ctx.storage.delete(audioKey).catch(() => {});
  await db.meeting.update({ where: { id: meetingId }, data: { audioKey: null } });
}

/**
 * Extract insights from a meeting's stored transcript and mark it COMPLETED.
 * Needs no audio, so it works for TRANSCRIBED meetings (whose recording is
 * already gone) and for re-running extraction on a COMPLETED one.
 * Throws on failure — callers decide whether to surface or absorb it.
 */
export async function extractAndPersist(
  meetingId: string,
  ctx: PipelineContext,
  log?: (msg: string) => void,
): Promise<void> {
  const meeting = await db.meeting.findUnique({
    where: { id: meetingId },
    include: { transcript: true },
  });
  if (!meeting) throw new Error(`meeting ${meetingId} not found`);
  if (!meeting.transcript) throw new Error("no transcript to extract from");

  const settings = await getSettings();
  const { llm } = ctx.resolve(settings, await getSecrets());

  await db.meeting.update({
    where: { id: meetingId },
    data: { status: "EXTRACTING", error: null },
  });
  log?.(`extract ${meetingId}: extracting`);

  // Speaker labels live on the stored segments; rebuild the labelled transcript
  // so on-demand extraction gets the same ownership signal the pipeline does.
  const { text, labelled } = formatTranscriptForPrompt(
    parseSegments(meeting.transcript.segments),
    meeting.transcript.fullText,
  );
  const { insights, rawOutput, provider } = await extractInsights(text, llm, {
    outputLanguage: outputLanguage(settings),
    glossary: glossary(settings),
    speakerLabelled: labelled,
    sections: meetingSections(meeting.sections, settings),
    meetingDate: meeting.createdAt,
  });
  const data = stringifyInsights(insights);
  // Keep the previous version instead of overwriting it: re-extracting can come back
  // worse, and the audio is already gone, so the old insights are all there is to fall
  // back to. Deactivate the current version, insert this one as active — in one
  // transaction so there's never zero or two active versions.
  await db.$transaction([
    db.insights.updateMany({ where: { meetingId, active: true }, data: { active: false } }),
    db.insights.create({ data: { meetingId, data, rawOutput, provider, active: true } }),
  ]);
  await pruneInsightVersions(meetingId);
  await db.meeting.update({
    where: { id: meetingId },
    data: { status: "COMPLETED", language: insights.language, error: null },
  });

  // If the user jotted notes during the meeting, expand them from the transcript now
  // Best-effort, never fails the meeting. Notes are usually saved by
  // the widget just after upload, so they're here by the time extraction finishes.
  if (meeting.notes.trim()) {
    try {
      const { enhanced } = await enhanceNotes(meeting.notes, meeting.transcript.fullText, llm);
      await db.meeting.update({
        where: { id: meetingId },
        data: { enhancedNotes: JSON.stringify(enhanced) },
      });
      log?.(`extract ${meetingId}: enhanced ${enhanced.notes.length} notes`);
    } catch (err) {
      log?.(`extract ${meetingId}: note enhancement skipped — ${String(err)}`);
    }
  }
  log?.(`extract ${meetingId}: COMPLETED`);
}

/** Cap the version history so it can't grow without bound. Never touches the active
 * one, and keeps the newest few — enough to undo a bad re-run, not a full archive. */
const MAX_INSIGHT_VERSIONS = 10;
async function pruneInsightVersions(meetingId: string): Promise<void> {
  const versions = await db.insights.findMany({
    where: { meetingId },
    orderBy: { createdAt: "desc" },
    select: { id: true, active: true },
  });
  const removable = versions.filter((v) => !v.active).slice(MAX_INSIGHT_VERSIONS - 1);
  if (removable.length > 0) {
    await db.insights.deleteMany({ where: { id: { in: removable.map((v) => v.id) } } });
  }
}

/** Fail-soft wrapper for the worker: a failure marks FAILED, never throws. */
export async function runExtraction(
  meetingId: string,
  ctx: PipelineContext,
  log?: (msg: string) => void,
): Promise<void> {
  try {
    await extractAndPersist(meetingId, ctx, log);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log?.(`extract ${meetingId}: FAILED — ${reason}`);
    await db.meeting
      .update({ where: { id: meetingId }, data: { status: "FAILED", error: reason } })
      .catch(() => {});
  }
}

/**
 * Finalize a streamed meeting at recording stop. If live chunks produced a transcript,
 * diarize it over the full recording (cheap ffmpeg energy pass — no re-transcription) and
 * finish; otherwise fall back to the full pipeline over the uploaded audio. Fail-soft: any
 * error in the fast path falls back to the full pipeline, which still has the audio.
 */
export async function runFinish(
  meetingId: string,
  ctx: PipelineContext,
  log?: (msg: string) => void,
): Promise<void> {
  const meeting = await db.meeting.findUnique({
    where: { id: meetingId },
    include: { transcript: true },
  });
  if (!meeting) throw new Error(`meeting ${meetingId} not found`);

  const live = meeting.transcript ? parseSegments(meeting.transcript.segments) : [];
  // No usable live transcript → transcribe the full recording, exactly as a plain upload.
  if (live.length === 0) return runPipeline(meetingId, ctx, log);

  let tmpDir: string | undefined;
  try {
    // Write the full recording out once — used both to check coverage and to diarize.
    let audioPath: string | undefined;
    if (meeting.audioKey) {
      const buf = await ctx.storage.get(meeting.audioKey);
      tmpDir = await mkdtemp(path.join(tmpdir(), "summeet-finish-"));
      audioPath = path.join(tmpDir, meeting.audioKey);
      await writeFile(audioPath, buf);
    }

    // Safety: only trust the live transcript if it actually covers the recording. A recorder
    // that dropped chunks leaves gaps; rather than ship a holey transcript, fall back to
    // transcribing the whole file (current behaviour). 85% is slack for the tail/rounding.
    if (audioPath) {
      const liveEnd = live.length ? live[live.length - 1]!.end : 0;
      const fullDuration = await probeDurationSec(audioPath).catch(() => 0);
      if (fullDuration > 0 && liveEnd < fullDuration * 0.85) {
        log?.(
          `finish ${meetingId}: live covers ${liveEnd.toFixed(0)}/${fullDuration.toFixed(0)}s ` +
            `(<85%); transcribing the full recording instead`,
        );
        return runPipeline(meetingId, ctx, log);
      }
    }

    // Diarize the live transcript over the full recording — who spoke, from the stereo
    // channels. No model, no re-transcription: this is the whole speedup.
    let segments = live;
    if (audioPath && isSummeetStereoLayout(meeting.channelLayout)) {
      const attributed = await assignSpeakers(audioPath, live);
      segments = attributed.segments;
      log?.(`finish ${meetingId}: diarized live transcript (echo gain ${attributed.echoGain.toFixed(2)})`);
    }

    const durationSec =
      segments.length > 0 ? Math.round(segments[segments.length - 1]!.end) : null;
    await db.transcript.update({
      where: { meetingId },
      data: { segments: stringifySegments(segments) },
    });

    const settings = await getSettings();
    await db.meeting.update({
      where: { id: meetingId },
      data: { status: settings.autoExtract ? "EXTRACTING" : "TRANSCRIBED", durationSec, error: null },
    });
    log?.(`finish ${meetingId}: transcript ready from ${live.length} live segments`);

    if (settings.autoExtract) {
      await extractAndPersist(meetingId, ctx, log); // throws → caught below → full fallback
    }
    // The transcript is the artifact; drop the recording (kept only as the fallback).
    await discardAudio(ctx, meetingId, meeting.audioKey);
  } catch (err) {
    log?.(`finish ${meetingId}: fast finalize failed (${String(err)}); full pipeline`);
    await runPipeline(meetingId, ctx, log); // audio is still there unless we got past discard
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The worker pipeline (SPEC §7.3), fail-soft (CLAUDE.md hard rule #7): read
 * audio → transcribe → extract → persist, driving status
 * TRANSCRIBING → EXTRACTING → COMPLETED — or stopping at TRANSCRIBED when
 * auto-extract is off. Any error sets FAILED + a human-readable reason; it
 * never throws out of here.
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
    const secrets = await getSecrets();
    const { transcription: transcriber, llm } = ctx.resolve(settings, secrets);

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
    // Equalise the two speakers before the downmix, but only for audio one of our
    // recorders declared. Log it: a quiet speaker averaged away is invisible in the
    // output — all you see is a transcript missing your own voice.
    const balance = isSummeetStereoLayout(meeting.channelLayout)
      ? ((await estimateChannelBalance(audioPath)) ?? undefined)
      : undefined;
    if (isSummeetStereoLayout(meeting.channelLayout)) {
      log?.(
        `pipeline ${meetingId}: channel balance ` +
          (balance
            ? `others=${balance.left.toFixed(3)} you=${balance.right.toFixed(3)}`
            : "none (one side never spoke)"),
      );
    }

    // Guard the transcription: a per-meeting AbortController lets a cancel (trashing a
    // still-processing meeting) or the watchdog timeout kill the whisper child / abort the
    // HTTP request, so one stuck job can never block every meeting behind it on the single
    // in-process worker.
    const abort = new AbortController();
    inflight.set(meetingId, abort);
    const watchdog = setTimeout(() => abort.abort(), TRANSCRIBE_TIMEOUT_MS);
    let transcript: Awaited<ReturnType<typeof transcribeFile>>;
    try {
      transcript = await transcribeFile(audioPath, transcriber, {
        language: transcriptionHint(settings),
        prompt: glossary(settings),
        balance,
        signal: abort.signal,
      });
    } finally {
      clearTimeout(watchdog);
      inflight.delete(meetingId);
    }

    // Who spoke, straight from the stereo channels (left = others, right = you).
    // Free: no model, no extra API call — just an ffmpeg energy pass.
    //
    // Only for audio a SumMeet recorder declared it wrote: a stereo file alone
    // carries no such meaning, and guessing would attribute a stranger's
    // commitment to "You" on any panned upload. Undeclared audio stays unlabelled.
    let segments = transcript.segments;
    if (isSummeetStereoLayout(meeting.channelLayout)) {
      const attributed = await assignSpeakers(audioPath, transcript.segments);
      segments = attributed.segments;
      // Always log the echo gain, not only when it crosses the skip threshold: when
      // attribution comes back mixed up, this number (and whether it was close to the
      // line) is the only way to tell bleed apart from a bug, and the audio is gone.
      const skipped = attributed.echoGain >= 1;
      log?.(
        `pipeline ${meetingId}: speaker attribution ` +
          `${skipped ? "skipped" : "kept"} (echo gain ${attributed.echoGain.toFixed(2)}` +
          `${skipped ? " — speakers, not headphones" : ""})`,
      );
    }

    const durationSec =
      segments.length > 0 ? Math.round(segments[segments.length - 1]!.end) : null;

    await db.transcript.upsert({
      where: { meetingId },
      create: {
        meetingId,
        fullText: transcript.text,
        segments: stringifySegments(segments),
        provider: transcriber.id,
      },
      update: {
        fullText: transcript.text,
        segments: stringifySegments(segments),
        provider: transcriber.id,
      },
    });

    // The recording has served its purpose — the transcript is the artifact.
    await discardAudio(ctx, meetingId, meeting.audioKey);

    // 2b. Stop here when the user wants to decide later whether — and with which
    // engine — to spend on insights. A resting state, not a failure.
    if (!settings.autoExtract) {
      await db.meeting.update({
        where: { id: meetingId },
        data: { status: "TRANSCRIBED", durationSec, error: null },
      });
      log?.(`pipeline ${meetingId}: TRANSCRIBED (auto-extract off)`);
      return;
    }

    // 3. Extract insights (parse/validate/repair inside extractInsights).
    await db.meeting.update({
      where: { id: meetingId },
      data: { status: "EXTRACTING", durationSec },
    });
    log?.(`pipeline ${meetingId}: extracting`);
    const prompted = formatTranscriptForPrompt(segments, transcript.text);
    const { insights, rawOutput, provider } = await extractInsights(
      prompted.text,
      llm,
      {
        outputLanguage: outputLanguage(settings),
        glossary: glossary(settings),
        speakerLabelled: prompted.labelled,
        sections: sections(settings),
      meetingDate: meeting.createdAt,
      },
    );

    // First extraction on the initial run, but go through the same versioned path so a
    // later re-extraction has a baseline to keep.
    await db.$transaction([
      db.insights.updateMany({ where: { meetingId, active: true }, data: { active: false } }),
      db.insights.create({
        data: { meetingId, data: stringifyInsights(insights), rawOutput, provider, active: true },
      }),
    ]);
    await pruneInsightVersions(meetingId);

    // 4. Done.
    await db.meeting.update({
      where: { id: meetingId },
      data: { status: "COMPLETED", language: insights.language, error: null },
    });
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
