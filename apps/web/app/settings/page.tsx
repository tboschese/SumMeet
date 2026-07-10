"use client";

// Settings live server-side, so the Chrome extension picks them up too.
// Two axes: which ENGINE runs each stage (cloud Groq vs free/offline local),
// and which LANGUAGE is used for the transcript and for the insights.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { SettingsView } from "@summeet/core/schemas";
import { AUTO_DETECT, LANGUAGES, MATCH_MEETING } from "@summeet/core/languages";
import { SECTIONS, type SectionKey } from "@summeet/core/sections";
import {
  getLocalStatus,
  getSettings,
  saveSettings,
  toUpdate,
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


/**
 * Locked-down summary composer (SPEC A5): tick the sections you want and order
 * them. No free text, so the Insight contract can't be prompted out of shape.
 * Selected sections are listed first, in their order, with move controls.
 */
function SectionPicker({
  selected,
  onChange,
}: {
  selected: SectionKey[];
  onChange: (next: SectionKey[]) => void;
}) {
  const unselected = SECTIONS.filter((s) => !selected.includes(s.key));

  const move = (index: number, delta: number) => {
    const next = [...selected];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {selected.map((key, i) => {
          const spec = SECTIONS.find((s) => s.key === key)!;
          return (
            <li
              key={key}
              className="flex items-start gap-2 rounded-md border border-brand-light bg-brand-tint/40 p-2.5"
            >
              <span className="mt-0.5 w-5 text-center text-xs font-semibold text-brand">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">
                  {spec.label}
                  {spec.derivedFrom && (
                    <span className="ml-2 rounded bg-white px-1.5 py-0.5 text-[10px] font-normal text-brand">
                      free — derived
                    </span>
                  )}
                </p>
                <p className="text-xs text-ink-soft/70">{spec.hint}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  className="rounded px-1.5 py-0.5 text-sm text-brand hover:bg-white disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === selected.length - 1}
                  title="Move down"
                  className="rounded px-1.5 py-0.5 text-sm text-brand hover:bg-white disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => onChange(selected.filter((k) => k !== key))}
                  disabled={selected.length === 1}
                  title={selected.length === 1 ? "Keep at least one section" : "Remove"}
                  className="rounded px-1.5 py-0.5 text-sm text-ink-soft/60 hover:text-red-600 disabled:opacity-30"
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      {unselected.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-soft/70">Add a section</p>
          <div className="flex flex-wrap gap-1.5">
            {unselected.map((spec) => (
              <button
                key={spec.key}
                type="button"
                onClick={() => onChange([...selected, spec.key])}
                title={spec.hint}
                className="rounded-md border border-brand-light px-2.5 py-1 text-xs text-brand hover:bg-brand-tint"
              >
                + {spec.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [keyInput, setKeyInput] = useState("");
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

  // Omits groqApiKey, so ordinary edits never touch the stored key.
  const update = useCallback(async (next: SettingsView) => {
    setSettings(next);
    setStatus("saving");
    setError(null);
    try {
      setSettings(await saveSettings(toUpdate(next)));
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
      setStatus("idle");
    }
  }, []);

  /** Write-only: send a value to set it, "" to clear it. */
  const saveKey = useCallback(
    async (value: string) => {
      if (!settings) return;
      setStatus("saving");
      setError(null);
      try {
        setSettings(await saveSettings({ ...toUpdate(settings), groqApiKey: value }));
        setKeyInput("");
        setStatus("saved");
        setTimeout(() => setStatus("idle"), 1500);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save the key.");
        setStatus("idle");
      }
    },
    [settings],
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
                    transcriptionEngine: e.target.value as SettingsView["transcriptionEngine"],
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

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-brand-light/60 p-3">
              <input
                type="checkbox"
                checked={settings.autoExtract}
                onChange={(e) =>
                  update({ ...settings, autoExtract: e.target.checked })
                }
                className="mt-0.5 h-4 w-4 accent-[#4F42E0]"
              />
              <span>
                <span className="block text-sm font-medium text-ink">
                  Generate insights automatically
                </span>
                <span className="mt-0.5 block text-xs text-ink-soft/70">
                  Off = stop after transcription and wait. A cheap local Whisper
                  can then run on every meeting, while the insights engine (cloud,
                  or a heavy local model) runs only when you ask — and you decide
                  per meeting whether that transcript goes to the cloud.
                </span>
              </span>
            </label>

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
                    extractionEngine: e.target.value as SettingsView["extractionEngine"],
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

          {/* ── Summary shape ───────────────────────────────────────────── */}
          <section className="space-y-3 rounded-lg border border-brand-light/60 bg-white p-6">
            <div>
              <h2 className="text-sm font-semibold text-ink">Summary sections</h2>
              <p className="mt-0.5 text-xs text-ink-soft/70">
                Pick what the decision record contains and in what order. Sections
                you leave out aren&apos;t generated at all, so a leaner summary is
                also a cheaper one.
              </p>
            </div>
            <SectionPicker
              selected={settings.summarySections}
              onChange={(next) => update({ ...settings, summarySections: next })}
            />
          </section>

          {/* ── Cloud API key ───────────────────────────────────────────── */}
          <section className="space-y-3 rounded-lg border border-brand-light/60 bg-white p-6">
            <div>
              <h2 className="text-sm font-semibold text-ink">Cloud API key (Groq)</h2>
              <p className="mt-0.5 text-xs text-ink-soft/70">
                Needed only for the cloud engine. Stored server-side and never
                sent back to the browser. Falls back to <code>GROQ_API_KEY</code>{" "}
                in <code>.env</code> when unset.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                className="flex-1 rounded-md border border-brand-light bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
                placeholder={settings.hasGroqApiKey ? "•••••••• (configured)" : "gsk_…"}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <button
                type="button"
                disabled={!keyInput.trim()}
                onClick={() => saveKey(keyInput.trim())}
                className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
              >
                Save key
              </button>
              {settings.hasGroqApiKey && (
                <button
                  type="button"
                  onClick={() => saveKey("")}
                  className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-ink-soft hover:border-red-300 hover:text-red-700"
                >
                  Remove
                </button>
              )}
            </div>
            <p className="text-xs text-ink-soft/60">
              {settings.hasGroqApiKey
                ? "A key is configured. Cloud engines are available."
                : "No key configured — cloud engines will fail. Use the local engine to run free and offline."}
            </p>
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
