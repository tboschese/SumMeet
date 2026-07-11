"use client";

// Live proof that both sources are alive, shown while the desktop app records.
//
// This exists because of how the capture bugs actually presented: the microphone
// was never acquired, and nothing said so until the transcript came back with the
// meeting's words attributed to the user. A recording you can't see is a recording
// you can't trust — the same reason the recorder also lights up the menu bar.

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { nativeRecorder, type CaptureStatus } from "@/lib/native";

/** A live channel always carries room tone; below this it isn't quiet, it's off. */
const DEAD_CHANNEL = 0.001;
/**
 * Loudest the mic reached. Below this it captured only faint speech — the real case
 * was a headset left dangling while output moved to the laptop, peaking at 0.077 where
 * a mic at the mouth reaches ~0.25. Normal speech clears this easily, so a speaker who
 * ever talked at a normal level never sees the warning.
 */
const WEAK_PEAK = 0.1;
/** Don't call a channel dead before it has had a moment to produce anything. */
const GRACE_MS = 4000;
/** Weak is a slower judgement than dead: give the user time to actually speak. */
const WEAK_GRACE_MS = 9000;
/** Below this the system isn't really playing, so it says nothing about echo. */
const SYSTEM_VOICED = 0.005;
/** Mic at this fraction of the system's level, while the system plays, is echo. */
const ECHO_RATIO = 0.5;
/** Echo is *sustained*: you talking over a quiet moment is not echo. */
const ECHO_SAMPLES = 24; // ~6 s at POLL_MS
const ECHO_SHARE = 0.7;
const POLL_MS = 250;

/** RMS is linear, hearing is not: a linear bar sits at zero through normal speech. */
function levelToWidth(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(100, Math.max(0, ((db + 60) / 50) * 100));
}

function Meter({ label, level, dead }: { label: string; level: number; dead: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-44 shrink-0 text-xs text-ink-soft/70">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-brand-tint">
        <div
          className={`h-full rounded-full transition-[width] duration-100 ${
            dead ? "bg-amber-500" : "bg-brand"
          }`}
          style={{ width: `${dead ? 100 : levelToWidth(level)}%` }}
        />
      </div>
    </div>
  );
}

export function CaptureMeters() {
  const t = useT();
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  // Peaks decay rather than reset, so a pause between sentences never reads as a
  // dead channel — only a channel that has produced nothing at all does.
  const peaks = useRef({ system: 0, mic: 0 });
  const startedAt = useRef(Date.now());
  // The last N samples taken while the system was actually playing: `true` when
  // the mic was loud at the same time. Speaking over a silent moment never lands
  // here, so a burst of your own voice can't be mistaken for echo.
  const echoWindow = useRef<boolean[]>([]);
  const [echoing, setEchoing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const next = await nativeRecorder.status();
        if (cancelled) return;
        peaks.current = {
          system: Math.max(peaks.current.system * 0.97, next.system),
          mic: Math.max(peaks.current.mic * 0.97, next.mic),
        };

        if (next.system > SYSTEM_VOICED) {
          const w = echoWindow.current;
          w.push(next.mic > next.system * ECHO_RATIO);
          if (w.length > ECHO_SAMPLES) w.shift();
          setEchoing(
            w.length >= ECHO_SAMPLES &&
              w.filter(Boolean).length / w.length > ECHO_SHARE,
          );
        }
        setStatus(next);
      } catch {
        // The recording ended between polls; the parent unmounts us.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!status?.recording) return null;

  const elapsed = Date.now() - startedAt.current;
  const settled = elapsed > GRACE_MS;
  const micDead = settled && peaks.current.mic < DEAD_CHANNEL;
  const systemDead = settled && peaks.current.system < DEAD_CHANNEL;
  // Present but faint: captured, just too quiet to transcribe well. Only after the
  // longer grace, so a speaker who simply hasn't started yet isn't nagged.
  const micWeak =
    !micDead &&
    elapsed > WEAK_GRACE_MS &&
    peaks.current.mic >= DEAD_CHANNEL &&
    peaks.current.mic < WEAK_PEAK;

  const warning = status.stale
    ? t("rec.meter.stale")
    : micDead
      ? t("rec.meter.micDead")
      : systemDead
        ? t("rec.meter.systemDead")
        : echoing
          ? t("rec.meter.echo")
          : micWeak
            ? t("rec.meter.micWeak")
            : null;

  return (
    <div className="mt-3 space-y-1.5">
      <Meter label={t("rec.meter.others")} level={status.system} dead={systemDead} />
      <Meter label={t("rec.meter.self")} level={status.mic} dead={micDead || micWeak} />
      {warning && (
        <p className="pt-1 text-xs text-amber-700">{warning}</p>
      )}
    </div>
  );
}
