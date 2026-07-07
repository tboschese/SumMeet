"use client";

import { useCallback, useRef, useState } from "react";
import { createMeeting } from "@/lib/api";
import { formatElapsed, MeetingRecorder, RecorderError } from "@/lib/recorder";

type Mode = "idle" | "recording" | "uploading";

export function RecordBar({ onCreated }: { onCreated: () => void }) {
  const recorderRef = useRef<MeetingRecorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [micOn, setMicOn] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (blob: Blob, filename: string, title?: string) => {
      setMode("uploading");
      setError(null);
      try {
        await createMeeting(blob, title, filename);
        onCreated();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed.");
      } finally {
        setMode("idle");
        setElapsed(0);
      }
    },
    [onCreated],
  );

  const startRecording = useCallback(async () => {
    setError(null);
    const rec = new MeetingRecorder({
      onTick: setElapsed,
      onStop: (blob) => {
        void upload(
          blob,
          "recording.webm",
          `Recording ${new Date().toLocaleString()}`,
        );
      },
      onError: (e) => {
        setError(e.message);
        setMode("idle");
      },
    });
    recorderRef.current = rec;
    try {
      await rec.start();
      setMicOn(true);
      setMode("recording");
    } catch (e) {
      setError(e instanceof RecorderError ? e.message : "Could not start recording.");
      setMode("idle");
    }
  }, [upload]);

  const stopRecording = useCallback(() => recorderRef.current?.stop(), []);

  const toggleMic = useCallback(() => {
    setMicOn((on) => {
      const next = !on;
      recorderRef.current?.setMicEnabled(next);
      return next;
    });
  }, []);

  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) void upload(file, file.name, file.name.replace(/\.[^.]+$/, ""));
    },
    [upload],
  );

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      {mode !== "recording" ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={startRecording}
            disabled={mode === "uploading"}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            ● Record meeting
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={mode === "uploading"}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
          >
            Upload audio
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".webm,.m4a,.mp3,.wav,.ogg,.opus,audio/*"
            onChange={onPickFile}
            className="hidden"
          />
          {mode === "uploading" && (
            <span className="text-sm text-neutral-500">Uploading…</span>
          )}
          <span className="ml-auto text-xs text-neutral-400">
            Pick the meeting tab &amp; enable “Share tab audio”.
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={stopRecording}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
          >
            ■ Stop
          </button>
          <span className="font-mono text-lg tabular-nums">
            {formatElapsed(elapsed)}
          </span>
          <span className="flex items-center gap-1.5 text-sm text-red-600">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" />
            capturing
          </span>
          <button
            type="button"
            onClick={toggleMic}
            className="ml-auto rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            {micOn ? "Mic on" : "Mic off"}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error}
        </p>
      )}
    </div>
  );
}
