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
        return runSegment(job.meetingId, job.segment.path, job.segment.offsetSec, ctx, (m) =>
          log.info(m),
        );
      return runPipeline(job.meetingId, ctx, (m) => log.info(m));
    },
    (m, err) => log.error({ err }, m),
  );

  const stuck = await db.meeting.findMany({
    where: { status: { in: [...UNFINISHED] } },
    select: { id: true, transcript: { select: { id: true } } },
  });
  if (stuck.length > 0) {
    log.info(`recovery sweep: re-enqueuing ${stuck.length} unfinished meeting(s)`);
    for (const m of stuck) {
      // A transcript means the audio was already discarded — re-running the full
      // pipeline would fail on the missing recording. Resume from extraction.
      queue.enqueue(m.id, m.transcript ? "extract" : "full");
    }
  }

  return queue;
}
