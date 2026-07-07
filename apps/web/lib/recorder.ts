// Client-only meeting recorder (SPEC §7.1a). Captures tab audio (other
// participants) via getDisplayMedia + the user's mic via getUserMedia, mixes
// them with the Web Audio API, and records a single .webm blob with a timeslice
// so long/backgrounded recordings don't drop audio. No server involvement.

export type RecorderErrorCode =
  | "TAB_AUDIO_MISSING" // user shared a tab but forgot "share tab audio" (#1 miss)
  | "DISPLAY_DENIED" // user cancelled / denied the screen-share picker
  | "MIC_DENIED" // user denied the microphone
  | "UNSUPPORTED" // browser lacks the needed APIs
  | "UNKNOWN";

export class RecorderError extends Error {
  constructor(
    public readonly code: RecorderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RecorderError";
  }
}

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return "audio/webm";
}

export interface RecorderCallbacks {
  onTick?: (elapsedSec: number) => void;
  onStop?: (blob: Blob) => void;
  onError?: (err: RecorderError) => void;
}

export class MeetingRecorder {
  private displayStream?: MediaStream;
  private micStream?: MediaStream;
  private audioCtx?: AudioContext;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private startedAt = 0;
  private mimeType = "audio/webm";

  constructor(private readonly cb: RecorderCallbacks = {}) {}

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  /** Request permissions, mix the two sources, and start recording. */
  async start(): Promise<void> {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getDisplayMedia ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      throw new RecorderError(
        "UNSUPPORTED",
        "This browser doesn't support tab-audio capture. Use desktop Chrome or Edge.",
      );
    }

    // 1. Tab audio (other participants). video:true is required to get the
    //    picker; we discard the video track and keep only the audio.
    try {
      this.displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    } catch {
      throw new RecorderError(
        "DISPLAY_DENIED",
        "Screen share was cancelled. Click Record and pick the meeting tab.",
      );
    }

    const tabAudio = this.displayStream.getAudioTracks();
    // Drop the video track immediately — we only wanted audio.
    for (const t of this.displayStream.getVideoTracks()) t.stop();

    if (tabAudio.length === 0) {
      // The #1 support issue: shared a tab but didn't tick "share tab audio".
      this.cleanup();
      throw new RecorderError(
        "TAB_AUDIO_MISSING",
        "You didn't share the tab's audio. Click Record again and enable “Share tab audio” in the picker.",
      );
    }

    // 2. Microphone (the user's own voice — never comes back through the tab).
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.cleanup();
      throw new RecorderError(
        "MIC_DENIED",
        "Microphone access was denied. Without it, your own voice isn't recorded.",
      );
    }

    // 3. Mix both sources into one stream (Web Audio).
    this.audioCtx = new AudioContext();
    const dest = this.audioCtx.createMediaStreamDestination();
    this.audioCtx
      .createMediaStreamSource(new MediaStream(tabAudio))
      .connect(dest);
    this.audioCtx.createMediaStreamSource(this.micStream).connect(dest);

    // 4. Record with a timeslice so nothing is lost if the tab is backgrounded.
    this.mimeType = pickMimeType();
    this.chunks = [];
    this.recorder = new MediaRecorder(dest.stream, { mimeType: this.mimeType });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mimeType });
      this.cleanup();
      this.cb.onStop?.(blob);
    };
    this.recorder.onerror = () => {
      this.cb.onError?.(new RecorderError("UNKNOWN", "Recording error."));
    };

    // If the user stops the share from the browser's native bar, end cleanly.
    tabAudio[0]?.addEventListener("ended", () => {
      if (this.isRecording) this.stop();
    });

    this.recorder.start(1000);
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      this.cb.onTick?.(Math.floor((Date.now() - this.startedAt) / 1000));
    }, 1000);
  }

  /** Mute/unmute the mic without stopping the recording. */
  setMicEnabled(enabled: boolean): void {
    for (const t of this.micStream?.getAudioTracks() ?? []) t.enabled = enabled;
  }

  /** Stop recording; the blob is delivered via onStop. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop(); // fires onstop → blob + cleanup
    } else {
      this.cleanup();
    }
  }

  /** Release all tracks and the audio context. */
  private cleanup(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const t of this.displayStream?.getTracks() ?? []) t.stop();
    for (const t of this.micStream?.getTracks() ?? []) t.stop();
    if (this.audioCtx && this.audioCtx.state !== "closed") {
      void this.audioCtx.close();
    }
    this.displayStream = undefined;
    this.micStream = undefined;
    this.audioCtx = undefined;
  }
}

export function formatElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
    .toString()
    .padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
