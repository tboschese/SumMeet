"use client";

// The floating recorder widget — a small always-on-top button the desktop app shows, and
// surfaces itself when a meeting is detected (suggesting you record). Idle it's just a
// round button; recording it expands to show the two live channel meters; and it takes
// notes that attach to the meeting and show alongside the transcript.

import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { getSettings, saveMeetingNotes } from "@/lib/api";
import { isNativeShell, nativeRecorder, widgetWindow, type CaptureStatus } from "@/lib/native";

// Window sizes per state (logical px); the chromeless window *is* the layout.
const SIZE = {
  button: { w: 150, h: 44 },
  suggest: { w: 250, h: 48 },
  bar: { w: 330, h: 64 },
  barWarn: { w: 330, h: 94 }, // room for the "on speakers" echo warning
  notes: { w: 330, h: 220 },
};

/** The SumMeet app mark (matches the Dock icon): a warm squircle with a cream bubble and
 * the terracotta insight bars. Decorative — `pointer-events-none` so the mousedown falls
 * through to the drag region behind it, and grabbing the icon moves the window too. */
function AppMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width="22"
      height="22"
      className={`pointer-events-none shrink-0 ${className}`}
      aria-hidden
    >
      <defs>
        <linearGradient id="sm-mark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFD29C" />
          <stop offset="1" stopColor="#F0855A" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="url(#sm-mark)" />
      <rect x="8.5" y="7.5" width="15" height="13" rx="3.5" fill="#FFF9F0" />
      <path d="M11.5 18.5 l-1 4.2 l4.6 -3 z" fill="#FFF9F0" />
      <g fill="#C85C30">
        <rect x="11.8" y="13.5" width="2.2" height="4.5" rx="1.1" />
        <rect x="15.1" y="11.5" width="2.2" height="6.5" rx="1.1" />
        <rect x="18.4" y="9.5" width="2.2" height="8.5" rx="1.1" />
      </g>
    </svg>
  );
}

/** A small red record indicator with a soft pulse — reads as "ready to record". */
function RecordDot() {
  return (
    <span className="relative flex h-2.5 w-2.5 items-center justify-center">
      <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-red-500/40" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-red-600" />
    </span>
  );
}

function CloseX({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      title="Close"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-soft/40 hover:bg-black/5 hover:text-ink-soft"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
        <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  );
}

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
      // Echo cancellation is a user setting (default on); fall back to on if unreadable.
      const aec = await getSettings()
        .then((s) => s.echoCancellation)
        .catch(() => true);
      await nativeRecorder.start(`Recording ${new Date().toLocaleString()}`, undefined, aec);
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
  // Output on the built-in speakers → the mic is capturing the meeting audio as echo.
  const onSpeakers = Boolean(recording && status?.on_speakers);

  // Drive the window size from the state (taller when the echo warning shows).
  useEffect(() => {
    const s = recording
      ? notesOpen
        ? SIZE.notes
        : onSpeakers
          ? SIZE.barWarn
          : SIZE.bar
      : suggest
        ? SIZE.suggest
        : SIZE.button;
    void widgetWindow.resize(s.w, s.h);
  }, [recording, notesOpen, suggest, onSpeakers]);

  // Drag the window explicitly: data-tauri-drag-region doesn't fire for this chromeless
  // webview, so start the OS move on mousedown — but never when the press lands on a
  // control, or its click would turn into a drag.
  const onDrag = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, textarea, select, input, a")) return;
    e.preventDefault();
    void widgetWindow.startDrag();
  }, []);

  // Idle, no meeting detected: a compact pill — the app mark, a small Record button, close.
  // The whole pill is a drag region (data-tauri-drag-region on <main>); decorative bits are
  // pointer-events-none so the mousedown falls through to it and you can drag from anywhere
  // but the buttons.
  if (!recording && !suggest) {
    return (
      <main
        data-tauri-drag-region
        onMouseDown={onDrag}
        className="flex h-screen w-screen cursor-grab select-none items-center gap-1.5 rounded-full border border-black/10 bg-white/90 pl-2 pr-1.5 shadow-xl ring-1 ring-black/5 backdrop-blur-xl active:cursor-grabbing"
      >
        <AppMark />
        <button
          type="button"
          onClick={start}
          className="flex h-8 flex-1 cursor-pointer items-center gap-2 rounded-full px-2.5 text-sm font-medium text-ink transition-colors hover:bg-brand-tint"
          title="Record"
        >
          <RecordDot />
          Record
        </button>
        <CloseX onClose={() => widgetWindow.hide()} />
      </main>
    );
  }

  // Meeting detected, not yet recording: suggest starting.
  if (!recording && suggest) {
    return (
      <main
        data-tauri-drag-region
        onMouseDown={onDrag}
        className="flex h-screen w-screen cursor-grab select-none items-center gap-1.5 rounded-full border border-black/10 bg-white/90 pl-2 pr-1.5 shadow-xl ring-1 ring-black/5 backdrop-blur-xl active:cursor-grabbing"
      >
        <AppMark />
        <span className="pointer-events-none min-w-0 flex-1 truncate text-xs font-medium text-ink">
          Meeting detected
        </span>
        <button
          type="button"
          onClick={start}
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-red-600 px-2.5 text-xs font-medium text-white shadow-sm hover:bg-red-700"
        >
          <span className="h-2 w-2 rounded-full bg-white" />
          Record
        </button>
        <CloseX onClose={() => widgetWindow.hide()} />
      </main>
    );
  }

  // Recording: controls + live meters, with a notes area. The header row is the drag
  // region (main is column-flex with the textarea below, which must stay interactive).
  return (
    <main className="flex h-screen w-screen select-none flex-col rounded-3xl border border-black/10 bg-white/90 shadow-xl ring-1 ring-black/5 backdrop-blur-xl">
      <div
        data-tauri-drag-region
        onMouseDown={onDrag}
        className="flex cursor-grab items-center gap-2 py-2 pl-2.5 pr-2 active:cursor-grabbing"
      >
        <AppMark />
        <button
          type="button"
          onClick={stop}
          disabled={mode === "uploading"}
          className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-ink px-3 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-60"
          title="Stop"
        >
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-white" />
          {mode === "uploading" ? "…" : clock(status?.elapsed_secs ?? 0)}
        </button>

        <div className="pointer-events-none flex min-w-0 flex-1 flex-col gap-1">
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

      {onSpeakers && (
        <div className="pointer-events-none mx-2 mb-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-800">
          <span aria-hidden>🔊</span>
          <span>On speakers — the mic is picking up the meeting audio. Use headphones for a clean recording.</span>
        </div>
      )}

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
