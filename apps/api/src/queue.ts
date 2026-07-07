// In-process, in-memory job queue (SPEC §7.2). Single-user local = one meeting
// at a time is plenty; no pg-boss/Redis. Not durable — a crash mid-job is
// recovered by the startup sweep (server.ts) re-enqueuing stuck meetings.

export class Queue {
  private readonly pending: string[] = [];
  private draining = false;

  constructor(
    private readonly handler: (meetingId: string) => Promise<void>,
    private readonly log?: (msg: string, err?: unknown) => void,
  ) {}

  enqueue(meetingId: string): void {
    this.pending.push(meetingId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let id: string | undefined;
      while ((id = this.pending.shift()) !== undefined) {
        try {
          await this.handler(id);
        } catch (err) {
          // The pipeline is fail-soft (marks FAILED itself); this is a last
          // resort so one bad job never kills the loop or the process.
          this.log?.(`queue: handler threw for meeting ${id}`, err);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
