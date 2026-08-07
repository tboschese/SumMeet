import type { FastifyBaseLogger } from "fastify";
import type { PipelineContext } from "./context.js";
import { db } from "./db.js";
import { runExtraction, runFinish, runPipeline, runSegment } from "./pipeline.js";
import { Queue } from "./queue.js";

// Statuses that mean "work is not finished" — swept and re-enqueued on startup
// (crash recovery, SPEC §9). TRANSCRIBED is excluded: it's a resting state.
const UNFINISHED = ["UPLOADED", "TRANSCRIBING", "EXTRACTING"] as const;

/**
 * Wire the in-memory queue to the pipeline and run the startup recovery sweep.
 * Returns the queue so routes can enqueue new uploads.
 */
export async function startWorker(
  ctx: PipelineContext,
  log: FastifyBaseLogger,
): Promise<Queue> {
  const queue = new Queue(
    (job) => {
      if (job.kind === "extract") return runExtraction(job.meetingId, ctx, (m) => log.info(m));
      if (job.kind === "finish") return runFinish(job.meetingId, ctx, (m) => log.info(m));
      if (job.kind === "segment" && job.segment)
        return runSegment(
          job.meetingId,
          job.segment.path,
          job.segment.offsetSec,
          job.segment.boundaryEndSec,
          ctx,
          (m) => log.info(m),
        );
      return runPipeline(job.meetingId, ctx, (m) => log.info(m));
    },
    (m, err) => log.error({ err }, m),
  );

  const stuck = await db.meeting.findMany({
    where: { status: { in: [...UNFINISHED] } },
    select: { id: true, status: true, audioKey: true, transcript: { select: { id: true } } },
  });
  if (stuck.length > 0) {
    log.info(`recovery sweep: ${stuck.length} unfinished meeting(s)`);
    for (const m of stuck) {
      // Extraction died part-way. Having no audio is normal here — it is discarded the
      // moment the transcript exists — so just run extraction again.
      if (m.status === "EXTRACTING") {
        queue.enqueue(m.id, "extract");
        continue;
      }
      // A streamed recording that has its audio: it stopped, but finalizing didn't
      // complete. Re-run that, not extraction — it re-checks that the live transcript
      // covers the recording and transcribes the file whole if it doesn't.
      if (m.audioKey && m.transcript) {
        queue.enqueue(m.id, "finish");
        continue;
      }
      // A streamed meeting exists from its first live chunk, before any recording is
      // attached — so TRANSCRIBING with no audio means the recorder never got to stop
      // (it died, or we did). There is nothing to re-run: keep whatever the live chunks
      // transcribed, and say plainly that the rest is gone. If the recorder is in fact
      // still alive, its /finish call overwrites this with the full recording.
      if (!m.audioKey) {
        const reason =
          m.status === "TRANSCRIBING"
            ? "the recording was interrupted before it finished"
            : "the upload was interrupted before the audio was saved";
        await db.meeting.update({
          where: { id: m.id },
          data: m.transcript
            ? { status: "TRANSCRIBED", error: null }
            : { status: "FAILED", error: reason },
        });
        log.info(
          `recovery sweep: meeting ${m.id} has no audio — ` +
            (m.transcript ? "kept the live transcript" : reason),
        );
        continue;
      }
      // Audio on disk and nothing transcribed from it yet: the ordinary interrupted
      // upload — run the pipeline over it.
      queue.enqueue(m.id, "full");
    }
  }

  return queue;
}
