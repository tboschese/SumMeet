"use client";

import { useCallback, useRef, useState } from "react";
import {
  ACCEPTED_AUDIO_HINT,
  isAcceptedAudio,
  MAX_UPLOAD_BYTES,
  SUMMEET_STEREO_LAYOUT,
} from "@summeet/core/media";
import { createMeeting } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatElapsed, MeetingRecorder, RecorderError } from "@/lib/recorder";

type Mode = "idle" | "recording" | "uploading";

export function RecordBar({ onCreated }: { onCreated: () => void }) {
  const t = useT();
  const recorderRef = useRef<MeetingRecorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [micOn, setMicOn] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (blob: Blob, filename: string, title?: string, channelLayout?: string) => {
      setMode("uploading");
      setError(null);
      try {
        await createMeeting(blob, title, filename, channelLayout);
        onCreated();
      } catch (e) {
        setError(e instanceof Error ? e.message : t("rec.uploadFailed"));
      } finally {
        setMode("idle");
        setElapsed(0);
      }
    },
    [onCreated, t],
  );

  const startRecording = useCallback(async () => {
    setError(null);
    const rec = new MeetingRecorder({
      onTick: setElapsed,
      onStop: (blob) => {
        // Our recorder wrote the stereo layout, so it may declare it.
        void upload(
          blob,
          "recording.webm",
          `Recording ${new Date().toLocaleString()}`,
          SUMMEET_STEREO_LAYOUT,
        );
      },
      onError: (e) => {
        setError(t(`rec.err.${e.code}`));
        setMode("idle");
      },
    });
    recorderRef.current = rec;
    try {
      await rec.start();
      setMicOn(true);
      setMode("recording");
    } catch (e) {
      setError(e instanceof RecorderError ? t(`rec.err.${e.code}`) : t("rec.startFailed"));
      setMode("idle");
    }
  }, [upload, t]);

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
      if (!file) return;
      if (!isAcceptedAudio(file.name, file.type)) {
        setError(t("rec.badType", { list: ACCEPTED_AUDIO_HINT }));
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(t("rec.tooLarge"));
        return;
      }
      void upload(file, file.name, file.name.replace(/\.[^.]+$/, ""));
    },
    [upload, t],
  );

  return (
    <div className="rounded-lg border border-brand-light/60 bg-white p-4">
      {mode !== "recording" ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={startRecording}
            disabled={mode === "uploading"}
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
          >
            {t("rec.record")}
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={mode === "uploading"}
            className="rounded-md border border-brand-light px-4 py-2 text-sm font-medium text-brand hover:bg-brand-tint disabled:opacity-60"
          >
            {t("rec.upload")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".webm,.m4a,.mp3,.wav,.ogg,.opus,audio/*"
            onChange={onPickFile}
            className="hidden"
          />
          {mode === "uploading" && (
            <span className="text-sm text-brand">{t("rec.uploading")}</span>
          )}
          <span className="ml-auto text-xs text-ink-soft/50">
            {t("rec.hint")}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={stopRecording}
            className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink/90"
          >
            {t("rec.stop")}
          </button>
          <span className="font-mono text-lg tabular-nums text-ink">
            {formatElapsed(elapsed)}
          </span>
          <span className="flex items-center gap-1.5 text-sm text-red-600">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" />
            {t("rec.capturing")}
          </span>
          <button
            type="button"
            onClick={toggleMic}
            className="ml-auto rounded-md border border-brand-light px-3 py-1.5 text-sm text-brand hover:bg-brand-tint"
          >
            {micOn ? t("rec.micOn") : t("rec.micOff")}
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
