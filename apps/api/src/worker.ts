import type { FastifyBaseLogger } from "fastify";
import type { PipelineContext } from "./context.js";
import { db } from "./db.js";
import { runPipeline } from "./pipeline.js";
import { Queue } from "./queue.js";

// Statuses that mean "work is not finished" — swept and re-enqueued on startup
// (crash recovery, SPEC §9).
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
    (id) => runPipeline(id, ctx, (m) => log.info(m)),
    (m, err) => log.error({ err }, m),
  );

  const stuck = await db.meeting.findMany({
    where: { status: { in: [...UNFINISHED] } },
    select: { id: true },
  });
  if (stuck.length > 0) {
    log.info(`recovery sweep: re-enqueuing ${stuck.length} unfinished meeting(s)`);
    for (const m of stuck) queue.enqueue(m.id);
  }

  return queue;
}
