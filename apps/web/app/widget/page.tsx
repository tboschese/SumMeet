"use client";

// The floating recorder widget — a small always-on-top button the desktop app shows, and
// surfaces itself when a meeting is detected (suggesting you record). Idle it's just a
// round button; recording it expands to show the two live channel meters; and it takes
// notes that attach to the meeting and show alongside the transcript.

import { useCallback, useEffect, useRef, useState } from "react";
import { saveMeetingNotes } from "@/lib/api";
import { isNativeShell, nativeRecorder, widgetWindow, type CaptureStatus } from "@/lib/native";

// Window sizes per state (logical px); the chromeless window *is* the layout.
const SIZE = {
  button: { w: 64, h: 64 },
  suggest: { w: 240, h: 64 },
  bar: { w: 320, h: 64 },
  notes: { w: 320, h: 220 },
};

function width(rms: number): number {
  if (rms <= 0) return 0;
  return Math.min(100, Math.max(0, ((20 * Math.log10(rms) + 60) / 50) * 100));
}
function clock(sec: number): string {
  return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, "0")}`;
}

export default function WidgetPage() {
  const [mode, setMode] = useState<"idle" | "recording" | "uploading">("idle");
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [suggest, setSuggest] = useState(false); // a meeting was detected
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

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
    // The app flags a detected meeting on the widget's URL (#suggest) when it surfaces it.
    setSuggest(window.location.hash.includes("suggest"));
    const onHash = () => setSuggest(window.location.hash.includes("suggest"));
    window.addEventListener("hashchange", onHash);
    return () => {
      if (poll.current) clearInterval(poll.current);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  const start = useCallback(async () => {
    setSuggest(false);
    try {
      await nativeRecorder.start(`Recording ${new Date().toLocaleString()}`);
      setMode("recording");
    } catch {
      setMode("idle");
    }
  }, []);

  const stop = useCallback(async () => {
    setMode("uploading");
    try {
      const meetingId = await nativeRecorder.stop();
      const typed = notes.trim();
      if (meetingId && typed) await saveMeetingNotes(meetingId, typed).catch(() => {});
      setNotes("");
      setNotesOpen(false);
    } catch {
      /* the recording is safe */
    } finally {
      setMode("idle");
    }
  }, [notes]);

  const recording = mode === "recording" || status?.recording;

  // Drive the window size from the state.
  useEffect(() => {
    const s = recording ? (notesOpen ? SIZE.notes : SIZE.bar) : suggest ? SIZE.suggest : SIZE.button;
    void widgetWindow.resize(s.w, s.h);
  }, [recording, notesOpen, suggest]);

  // Idle, no meeting detected: just the round record button.
  if (!recording && !suggest) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-transparent">
        <button
          type="button"
          onClick={start}
          title="Record"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-red-600 text-white shadow-lg hover:bg-red-700"
          data-tauri-drag-region
        >
          <span className="h-4 w-4 rounded-full bg-white" />
        </button>
      </main>
    );
  }

  // Meeting detected, not yet recording: suggest starting.
  if (!recording && suggest) {
    return (
      <main className="flex h-screen w-screen items-center gap-2 rounded-2xl bg-white/95 px-3 shadow-lg" data-tauri-drag-region>
        <button
          type="button"
          onClick={start}
          className="flex h-9 shrink-0 items-center gap-2 rounded-full bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700"
        >
          <span className="h-2.5 w-2.5 rounded-full bg-white" />
          Record
        </button>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-soft/80">Meeting detected</span>
        <button
          type="button"
          onClick={() => widgetWindow.hide()}
          className="shrink-0 px-1 text-ink-soft/40 hover:text-ink-soft"
          title="Dismiss"
        >
          ✕
        </button>
      </main>
    );
  }

  // Recording: controls + live meters, with a notes area.
  return (
    <main className="flex h-screen w-screen flex-col rounded-2xl bg-white/95 shadow-lg">
      <div className="flex items-center gap-2 px-3 py-2" data-tauri-drag-region>
        <button
          type="button"
          onClick={stop}
          disabled={mode === "uploading"}
          className="flex h-9 shrink-0 items-center gap-2 rounded-full bg-ink px-3 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-60"
          title="Stop"
        >
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-white" />
          {mode === "uploading" ? "…" : clock(status?.elapsed_secs ?? 0)}
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Bar level={status?.system ?? 0} />
          <Bar level={status?.mic ?? 0} clipping={(status?.mic_peak ?? 0) >= 0.98} />
        </div>

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

function Bar({ level, clipping }: { level: number; clipping?: boolean }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-brand-tint">
      <div
        className={`h-full rounded-full transition-[width] duration-100 ${clipping ? "bg-amber-500" : "bg-brand"}`}
        style={{ width: `${clipping ? 100 : width(level)}%` }}
      />
    </div>
  );
}
