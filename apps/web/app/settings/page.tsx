"use client";

// Settings live server-side, so the Chrome extension picks them up too.
// Two independent choices: the language SPOKEN in the meeting (a hint that makes
// Whisper more accurate) and the language the INSIGHTS are written in — which
// may differ (e.g. a Portuguese meeting summarized in English).

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Settings } from "@summeet/core/schemas";
import { AUTO_DETECT, LANGUAGES, MATCH_MEETING } from "@summeet/core/languages";
import { getSettings, saveSettings } from "@/lib/api";

const selectCls =
  "w-full rounded-md border border-brand-light bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none";

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Could not load settings."),
      );
  }, []);

  const update = useCallback(
    async (next: Settings) => {
      setSettings(next);
      setStatus("saving");
      setError(null);
      try {
        await saveSettings(next);
        setStatus("saved");
        setTimeout(() => setStatus("idle"), 1500);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save.");
        setStatus("idle");
      }
    },
    [],
  );

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-6 py-12">
      <Link href="/" className="text-sm text-ink-soft/70 hover:text-brand">
        ← All meetings
      </Link>

      <header className="mb-8 mt-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Settings</h1>
        <p className="mt-1 text-sm text-ink-soft/70">
          Applies to new recordings and uploads — including the Chrome extension.
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {!settings ? (
        <p className="text-sm text-ink-soft/50">Loading…</p>
      ) : (
        <div className="space-y-6 rounded-lg border border-brand-light/60 bg-white p-6">
          <div>
            <label htmlFor="transcription" className="block text-sm font-medium text-ink">
              Spoken language (transcription)
            </label>
            <p className="mb-2 mt-0.5 text-xs text-ink-soft/70">
              Telling Whisper the language up front makes the transcript more
              accurate. Leave on auto-detect if your meetings vary.
            </p>
            <select
              id="transcription"
              className={selectCls}
              value={settings.transcriptionLanguage}
              onChange={(e) =>
                update({ ...settings, transcriptionLanguage: e.target.value })
              }
            >
              <option value={AUTO_DETECT}>Auto-detect</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="output" className="block text-sm font-medium text-ink">
              Insights language (summary, action items, decisions)
            </label>
            <p className="mb-2 mt-0.5 text-xs text-ink-soft/70">
              Can differ from the spoken language. Quotes always stay verbatim in
              the original language.
            </p>
            <select
              id="output"
              className={selectCls}
              value={settings.outputLanguage}
              onChange={(e) =>
                update({ ...settings, outputLanguage: e.target.value })
              }
            >
              <option value={MATCH_MEETING}>Same as the meeting</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          <p className="text-xs text-ink-soft/60">
            {status === "saving" && "Saving…"}
            {status === "saved" && <span className="text-brand">Saved ✓</span>}
            {status === "idle" &&
              "Changes save automatically. Existing meetings keep their insights — use Re-extract to redo one."}
          </p>
        </div>
      )}
    </main>
  );
}
