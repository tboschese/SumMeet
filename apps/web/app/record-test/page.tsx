"use client";

// Isolated recorder harness (SPEC §11, Session 4): Record/Stop, timer, live
// indicator, mic toggle, "forgot to share tab audio" handling, and a local
// download of the resulting .webm — no upload, no API. Prove capture works
// here before wiring it into the app (Session 5).

import { useCallback, useRef, useState } from "react";
import {
  formatElapsed,
  MeetingRecorder,
  RecorderError,
} from "@/lib/recorder";

type Status = "idle" | "recording" | "done";

export default function RecordTestPage() {
  const recorderRef = useRef<MeetingRecorder | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [micOn, setMicOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobSize, setBlobSize] = useState(0);

  const start = useCallback(async () => {
    setError(null);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null);
    setElapsed(0);

    const rec = new MeetingRecorder({
      onTick: setElapsed,
      onStop: (blob) => {
        setBlobUrl(URL.createObjectURL(blob));
        setBlobSize(blob.size);
        setStatus("done");
      },
      onError: (e) => {
        setError(e.message);
        setStatus("idle");
      },
    });
    recorderRef.current = rec;
    try {
      await rec.start();
      setMicOn(true);
      setStatus("recording");
    } catch (e) {
      setError(
        e instanceof RecorderError ? e.message : "Could not start recording.",
      );
      setStatus("idle");
    }
  }, [blobUrl]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const toggleMic = useCallback(() => {
    setMicOn((on) => {
      const next = !on;
      recorderRef.current?.setMicEnabled(next);
      return next;
    });
  }, []);

  return (
    <main className="mx-auto min-h-screen max-w-xl px-6 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Recorder test</h1>
      <p className="mt-1 text-sm text-ink-soft/70">
        Isolated capture harness. Pick a meeting tab and enable{" "}
        <strong>Share tab audio</strong>; your mic is captured too.
      </p>

      <div className="mt-8 rounded-lg border border-brand-light/60 bg-white p-6">
        <div className="flex items-center gap-4">
          {status !== "recording" ? (
            <button
              type="button"
              onClick={start}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
            >
              ● Record
            </button>
          ) : (
            <button
              type="button"
              onClick={stop}
              className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink/90"
            >
              ■ Stop
            </button>
          )}

          <span className="font-mono text-lg tabular-nums">
            {formatElapsed(elapsed)}
          </span>

          {status === "recording" && (
            <span className="flex items-center gap-1.5 text-sm text-red-600">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" />
              capturing
            </span>
          )}

          {status === "recording" && (
            <button
              type="button"
              onClick={toggleMic}
              className="ml-auto rounded-md border border-brand-light px-3 py-1.5 text-sm text-brand hover:bg-brand-tint"
            >
              {micOn ? "Mic on" : "Mic off"}
            </button>
          )}
        </div>

        {error && (
          <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {error}
          </p>
        )}

        {status === "done" && blobUrl && (
          <div className="mt-6 border-t border-neutral-100 pt-6">
            <p className="text-sm font-medium text-ink">
              Recording ready — {(blobSize / 1024 / 1024).toFixed(2)} MB
            </p>
            <audio controls src={blobUrl} className="mt-3 w-full" />
            <a
              href={blobUrl}
              download="summeet-recording.webm"
              className="mt-3 inline-block rounded-md border border-brand-light px-3 py-1.5 text-sm text-brand hover:bg-brand-tint"
            >
              Download .webm
            </a>
            <p className="mt-3 text-xs text-ink-soft/70">
              Play it back: you should hear <strong>both</strong> the tab and
              your own voice. If your voice is missing, the mic wasn&apos;t
              mixed in.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
