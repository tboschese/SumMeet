"use client";

// The floating recorder widget (a small always-on-top window the desktop app shows,
// e.g. when it detects a meeting). Same recording controls as RecordBar, stripped to a
// single button + a live meter — so you can start/stop without switching to the app, and
// see at a glance that both channels are actually being captured.

import { useCallback, useEffect, useRef, useState } from "react";
import { saveMeetingNotes } from "@/lib/api";
import { isNativeShell, nativeRecorder, widgetWindow, type CaptureStatus } from "@/lib/native";

/** RMS is linear, hearing is not: map to dB so normal speech fills the bar. */
function width(rms: number): number {
  if (rms <= 0) return 0;
  return Math.min(100, Math.max(0, ((20 * Math.log10(rms) + 60) / 50) * 100));
}

function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function WidgetPage() {
  const [mode, setMode] = useState<"idle" | "recording" | "uploading">("idle");
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reflect state the app already holds: another window (or auto-start) may have begun
  // recording, and the widget must not disagree with it.
  useEffect(() => {
    if (!isNativeShell()) return;
    const tick = async () => {
      try {
        const s = await nativeRecorder.status();
        setStatus(s);
        setMode((m) => (s.recording ? "recording" : m === "uploading" ? "uploading" : "idle"));
      } catch {
        /* between polls */
      }
    };
    void tick();
    poll.current = setInterval(tick, 250);
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      await nativeRecorder.start(`Recording ${new Date().toLocaleString()}`);
      setMode("recording");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setMode("idle");
    }
  }, []);

  const stop = useCallback(async () => {
    setMode("uploading");
    try {
      // stop() hands back the meeting id the recorder just created, so the notes typed
      // during the call can be attached to it — they'll show alongside the transcript.
      const meetingId = await nativeRecorder.stop();
      const typed = notes.trim();
      if (meetingId && typed) {
        await saveMeetingNotes(meetingId, typed).catch(() => {
          /* the recording is safe; notes are best-effort */
        });
      }
      setNotes("");
      setNotesOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setMode("idle");
    }
  }, [notes]);

  // The window is chromeless, so it has to grow/shrink itself for the notes area.
  useEffect(() => {
    void widgetWindow.resize(notesOpen);
  }, [notesOpen]);

  const recording = mode === "recording" || status?.recording;

  return (
    <main className="flex h-screen w-screen select-none flex-col bg-white/95">
      <div className="flex items-center gap-2 px-3 py-2" data-tauri-drag-region>
        <button
          type="button"
          onClick={recording ? stop : start}
          disabled={mode === "uploading"}
          className={`flex h-9 shrink-0 items-center gap-2 rounded-full px-3 text-sm font-medium text-white disabled:opacity-60 ${
            recording ? "bg-ink hover:bg-ink/90" : "bg-red-600 hover:bg-red-700"
          }`}
          title={recording ? "Stop" : "Record"}
        >
          <span
            className={`h-2.5 w-2.5 rounded-full bg-white ${recording ? "animate-pulse" : ""}`}
          />
          {mode === "uploading" ? "…" : recording ? clock(status?.elapsed_secs ?? 0) : "Rec"}
        </button>

        {recording ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Bar level={status?.system ?? 0} label="others" />
            <Bar level={status?.mic ?? 0} label="you" clipping={(status?.mic_peak ?? 0) >= 0.98} />
          </div>
        ) : (
          <span className="flex-1 truncate text-xs text-ink-soft/60">{error ?? "SumMeet"}</span>
        )}

        {/* Notes toggle: available while recording, and stays open so you can keep
            jotting. The dot marks unsaved notes. */}
        <button
          type="button"
          onClick={() => setNotesOpen((o) => !o)}
          title="Notes"
          className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${
            notesOpen ? "border-brand bg-brand-tint text-brand" : "border-brand-light text-ink-soft/70 hover:bg-brand-tint"
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M4 5h16M4 12h16M4 19h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {notes.trim() && !notesOpen && (
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-brand" />
          )}
        </button>
      </div>

      {notesOpen && (
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes — saved with this meeting's transcript"
          autoFocus
          className="mx-3 mb-2 flex-1 resize-none rounded-md border border-brand-light bg-white px-2 py-1.5 text-xs text-ink placeholder:text-ink-soft/40 focus:border-brand focus:outline-none"
        />
      )}
    </main>
  );
}

function Bar({ level, label, clipping }: { level: number; label: string; clipping?: boolean }) {
  return (
    <div className="flex items-center gap-1.5" title={label}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-brand-tint">
        <div
          className={`h-full rounded-full transition-[width] duration-100 ${
            clipping ? "bg-amber-500" : "bg-brand"
          }`}
          style={{ width: `${clipping ? 100 : width(level)}%` }}
        />
      </div>
    </div>
  );
}
