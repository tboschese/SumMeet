"use client";

// Settings live server-side, so the Chrome extension picks them up too.
// Two axes: which ENGINE runs each stage (cloud Groq vs free/offline local),
// and which LANGUAGE is used for the transcript and for the insights.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Settings } from "@summeet/core/schemas";
import { AUTO_DETECT, LANGUAGES, MATCH_MEETING } from "@summeet/core/languages";
import {
  getLocalStatus,
  getSettings,
  saveSettings,
  type LocalStatus,
} from "@/lib/api";

const selectCls =
  "w-full rounded-md border border-brand-light bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-ink">{label}</label>
      <p className="mb-2 mt-0.5 text-xs text-ink-soft/70">{hint}</p>
      {children}
    </div>
  );
}

/** Tells the user exactly what's missing before they pick the local engine. */
function LocalHint({ status }: { status: LocalStatus | null }) {
  if (!status) return null;
  const { whisper, ollama } = status;
  if (whisper.ready && ollama.ready) {
    return (
      <p className="rounded-md bg-brand-tint px-3 py-2 text-xs text-brand">
        Local engine ready — whisper.cpp + {ollama.model}. Nothing leaves your machine.
      </p>
    );
  }
  const missing: string[] = [];
  if (!whisper.binaryFound) missing.push("`brew install whisper-cpp`");
  if (!whisper.modelFound) missing.push(`a Whisper model at ${whisper.modelPath}`);
  if (!ollama.serverUp) missing.push("Ollama running (`brew install ollama && ollama serve`)");
  else if (!ollama.modelPulled) missing.push(`\`ollama pull ${ollama.model}\``);

  return (
    <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
      Local engine not ready yet. Missing: {missing.join(", ")}.
    </p>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Could not load settings."),
      );
    getLocalStatus().then(setLocal).catch(() => setLocal(null));
  }, []);

  const update = useCallback(async (next: Settings) => {
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
  }, []);

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
        <div className="space-y-8">
          {/* ── Engines ─────────────────────────────────────────────────── */}
          <section className="space-y-5 rounded-lg border border-brand-light/60 bg-white p-6">
            <div>
              <h2 className="text-sm font-semibold text-ink">Processing engine</h2>
              <p className="mt-0.5 text-xs text-ink-soft/70">
                <strong>Cloud</strong> is fast and cheap but sends audio/transcript
                to Groq. <strong>Local</strong> is free and fully offline
                (whisper.cpp + Ollama) — slower, but nothing leaves your machine.
                You can mix them.
              </p>
            </div>

            <LocalHint status={local} />

            <Field
              label="Transcription engine"
              hint="Turns the recording into text."
            >
              <select
                className={selectCls}
                value={settings.transcriptionEngine}
                onChange={(e) =>
                  update({
                    ...settings,
                    transcriptionEngine: e.target.value as Settings["transcriptionEngine"],
                  })
                }
              >
                <option value="cloud">Cloud — Groq Whisper (fast)</option>
                <option value="local">
                  Local — whisper.cpp (free, offline)
                  {local && !local.whisper.ready ? " — not installed" : ""}
                </option>
              </select>
            </Field>

            <Field
              label="Insights engine"
              hint="Turns the transcript into the decision record."
            >
              <select
                className={selectCls}
                value={settings.extractionEngine}
                onChange={(e) =>
                  update({
                    ...settings,
                    extractionEngine: e.target.value as Settings["extractionEngine"],
                  })
                }
              >
                <option value="cloud">Cloud — Groq Llama 3.3 70B (fast)</option>
                <option value="local">
                  Local — Ollama (free, offline)
                  {local && !local.ollama.ready ? " — not installed" : ""}
                </option>
              </select>
            </Field>
          </section>

          {/* ── Languages ───────────────────────────────────────────────── */}
          <section className="space-y-5 rounded-lg border border-brand-light/60 bg-white p-6">
            <h2 className="text-sm font-semibold text-ink">Language</h2>

            <Field
              label="Spoken language (transcription)"
              hint="Telling Whisper the language up front makes the transcript more accurate. Leave on auto-detect if your meetings vary."
            >
              <select
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
            </Field>

            <Field
              label="Insights language (summary, action items, decisions)"
              hint="Can differ from the spoken language. Quotes always stay verbatim in the original language."
            >
              <select
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
            </Field>
          </section>

          {/* ── Glossary ────────────────────────────────────────────────── */}
          <section className="space-y-3 rounded-lg border border-brand-light/60 bg-white p-6">
            <div>
              <h2 className="text-sm font-semibold text-ink">Glossary</h2>
              <p className="mt-0.5 text-xs text-ink-soft/70">
                People, product and jargon names. Whisper is conditioned on these
                so it stops guessing at names, and the extractor spells them
                right. The single biggest quality win for the local engine.
              </p>
            </div>
            <textarea
              rows={4}
              className="w-full rounded-md border border-brand-light bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
              placeholder={"Sarah, James, Priya, SumMeet, Kubernetes, ARR, Q3 roadmap"}
              value={settings.glossary}
              onBlur={(e) => update({ ...settings, glossary: e.target.value })}
              onChange={(e) =>
                setSettings({ ...settings, glossary: e.target.value })
              }
            />
            <p className="text-xs text-ink-soft/60">
              Comma- or line-separated. Saved when you click away.
            </p>
          </section>

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
