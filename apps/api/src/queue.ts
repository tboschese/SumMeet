// In-process, in-memory job queue (SPEC §7.2). Single-user local = one meeting
// at a time is plenty; no pg-boss/Redis. Not durable — a crash mid-job is
// recovered by the startup sweep (worker.ts) re-enqueuing stuck meetings.

/**
 * "full" runs the whole pipeline (needs the audio). "extract" only re-runs
 * extraction over a stored transcript — the audio is deleted as soon as the
 * transcript exists, so anything past that point must use this kind.
 */
export type JobKind = "full" | "extract";

export interface Job {
  meetingId: string;
  kind: JobKind;
}

export class Queue {
  private readonly pending: Job[] = [];
  private draining = false;

  constructor(
    private readonly handler: (job: Job) => Promise<void>,
    private readonly log?: (msg: string, err?: unknown) => void,
  ) {}

  enqueue(meetingId: string, kind: JobKind = "full"): void {
    this.pending.push({ meetingId, kind });
    void this.drain();
  }

  /** How many jobs are waiting (excluding the one in flight). */
  get size(): number {
    return this.pending.length;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let job: Job | undefined;
      while ((job = this.pending.shift()) !== undefined) {
        try {
          await this.handler(job);
        } catch (err) {
          // The pipeline is fail-soft (marks FAILED itself); this is a last
          // resort so one bad job never kills the loop or the process.
          this.log?.(`queue: handler threw for meeting ${job.meetingId}`, err);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
