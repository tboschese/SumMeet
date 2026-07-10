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
  stringifyInsights,
  stringifySegments,
  transcribeFile,
} from "@summeet/core";
import type { PipelineContext } from "./context.js";
import { db } from "./db.js";
import {
  getSecrets,
  getSettings,
  glossary,
  outputLanguage,
  sections,
  transcriptionHint,
} from "./settings.js";

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
    sections: sections(settings),
  });
  const data = stringifyInsights(insights);
  await db.insights.upsert({
    where: { meetingId },
    create: { meetingId, data, rawOutput, provider },
    update: { data, rawOutput, provider },
  });
  await db.meeting.update({
    where: { id: meetingId },
    data: { status: "COMPLETED", language: insights.language, error: null },
  });
  log?.(`extract ${meetingId}: COMPLETED`);
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

    const transcript = await transcribeFile(audioPath, transcriber, {
      language: transcriptionHint(settings),
      prompt: glossary(settings),
      balance,
    });

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
      if (attributed.echoGain >= 1) {
        // Speakers, not headphones: the mic re-recorded the meeting louder than
        // the user's own voice, so every label would be a coin flip.
        log?.(
          `pipeline ${meetingId}: speaker attribution skipped ` +
            `(echo gain ${attributed.echoGain.toFixed(2)} — use headphones)`,
        );
      }
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
      },
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
