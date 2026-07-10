"use client";

// Settings live server-side, so the Chrome extension picks them up too.
// Two axes: which ENGINE runs each stage (cloud Groq vs free/offline local),
// and which LANGUAGE is used for the transcript and for the insights.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { SettingsView } from "@summeet/core/schemas";
import { AUTO_DETECT, LANGUAGES, MATCH_MEETING } from "@summeet/core/languages";
import {
  getLocalStatus,
  getSettings,
  saveSettings,
  toUpdate,
  type LocalStatus,
} from "@/lib/api";
import { SectionPicker } from "@/app/components/SectionPicker";
import { UI_LANGUAGES, useI18n, useT } from "@/lib/i18n";

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
  const t = useT();
  if (!status) return null;
  const { whisper, ollama } = status;
  if (whisper.ready && ollama.ready) {
    return (
      <p className="rounded-md bg-brand-tint px-3 py-2 text-xs text-brand">
        {t("settings.local.ready", { model: ollama.model })}
      </p>
    );
  }
  const missing: string[] = [];
  if (!whisper.binaryFound) missing.push(t("settings.local.needWhisperBin"));
  if (!whisper.modelFound) missing.push(t("settings.local.needWhisperModel", { path: whisper.modelPath }));
  if (!ollama.serverUp) missing.push(t("settings.local.needOllama"));
  else if (!ollama.modelPulled) missing.push(t("settings.local.needModel", { model: ollama.model }));

  return (
    <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
      {t("settings.local.missing", { list: missing.join(", ") })}
    </p>
  );
}


export default function SettingsPage() {
  const t = useT();
  const { setLang } = useI18n();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((e) =>
        setError(e instanceof Error ? e.message : t("settings.loadFailed")),
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
      setError(e instanceof Error ? e.message : t("settings.saveFailed"));
      setStatus("idle");
    }
  }, [t]);

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
        setError(e instanceof Error ? e.message : t("settings.key.saveFailed"));
        setStatus("idle");
      }
    },
    [settings, t],
  );

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-6 py-12">
      <Link href="/" className="text-sm text-ink-soft/70 hover:text-brand">
        {t("common.backToMeetings")}
      </Link>

      <header className="mb-8 mt-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{t("settings.title")}</h1>
        <p className="mt-1 text-sm text-ink-soft/70">{t("settings.subtitle")}</p>
      </header>

      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {!settings ? (
        <p className="text-sm text-ink-soft/50">{t("common.loading")}</p>
      ) : (
        <div className="space-y-8">
          {/* ── Interface language ─────────────────────────────────────── */}
          <section className="space-y-3 rounded-lg border border-brand-light/60 bg-white p-6">
            <div>
              <h2 className="text-sm font-semibold text-ink">{t("settings.ui.title")}</h2>
              <p className="mt-0.5 text-xs text-ink-soft/70">{t("settings.ui.hint")}</p>
            </div>
            <select
              className={selectCls}
              value={settings.uiLanguage}
              onChange={(e) => {
                const next = e.target.value as SettingsView["uiLanguage"];
                setLang(next); // switch immediately, then persist
                void update({ ...settings, uiLanguage: next });
              }}
            >
              {UI_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </section>

          {/* ── Engines ─────────────────────────────────────────────────── */}
          <section className="space-y-5 rounded-lg border border-brand-light/60 bg-white p-6">
            <div>
              <h2 className="text-sm font-semibold text-ink">{t("settings.engine.title")}</h2>
              <p className="mt-0.5 text-xs text-ink-soft/70">{t("settings.engine.hint")}</p>
            </div>

            <LocalHint status={local} />

            <Field
              label={t("settings.engine.transcription")}
              hint={t("settings.engine.transcriptionHint")}
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
                <option value="cloud">{t("settings.engine.cloudTranscription")}</option>
                <option value="local">
                  {t("settings.engine.localTranscription")}
                  {local && !local.whisper.ready ? t("settings.engine.notInstalled") : ""}
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
                <span className="block text-sm font-medium text-ink">{t("settings.autoExtract.label")}</span>
                <span className="mt-0.5 block text-xs text-ink-soft/70">{t("settings.autoExtract.hint")}</span>
              </span>
            </label>

            <Field
              label={t("settings.engine.extraction")}
              hint={t("settings.engine.extractionHint")}
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
                <option value="cloud">{t("settings.engine.cloudExtraction")}</option>
                <option value="local">
                  {t("settings.engine.localExtraction")}
                  {local && !local.ollama.ready ? t("settings.engine.notInstalled") : ""}
                </option>
              </select>
            </Field>
          </section>

          {/* ── Languages ───────────────────────────────────────────────── */}
          <section className="space-y-5 rounded-lg border border-brand-light/60 bg-white p-6">
            <h2 className="text-sm font-semibold text-ink">{t("settings.lang.title")}</h2>

            <Field
              label={t("settings.lang.spoken")}
              hint={t("settings.lang.spokenHint")}
            >
              <select
                className={selectCls}
                value={settings.transcriptionLanguage}
                onChange={(e) =>
                  update({ ...settings, transcriptionLanguage: e.target.value })
                }
              >
                <option value={AUTO_DETECT}>{t("settings.lang.autoDetect")}</option>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label={t("settings.lang.insights")}
              hint={t("settings.lang.insightsHint")}
            >
              <select
                className={selectCls}
                value={settings.outputLanguage}
                onChange={(e) =>
                  update({ ...settings, outputLanguage: e.target.value })
                }
              >
                <option value={MATCH_MEETING}>{t("settings.lang.sameAsMeeting")}</option>
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
              <h2 className="text-sm font-semibold text-ink">{t("settings.sections.title")}</h2>
              <p className="mt-0.5 text-xs text-ink-soft/70">{t("settings.sections.hint")}</p>
            </div>
            <SectionPicker
              selected={settings.summarySections}
              onChange={(next) => update({ ...settings, summarySections: next })}
            />
          </section>

          {/* ── Cloud API key ───────────────────────────────────────────── */}
          <section className="space-y-3 rounded-lg border border-brand-light/60 bg-white p-6">
            <div>
              <h2 className="text-sm font-semibold text-ink">{t("settings.key.title")}</h2>
              <p className="mt-0.5 text-xs text-ink-soft/70">{t("settings.key.hint")}</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                className="flex-1 rounded-md border border-brand-light bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
                placeholder={settings.hasGroqApiKey ? t("settings.key.configured") : "gsk_…"}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <button
                type="button"
                disabled={!keyInput.trim()}
                onClick={() => saveKey(keyInput.trim())}
                className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
              >
                {t("settings.key.save")}
              </button>
              {settings.hasGroqApiKey && (
                <button
                  type="button"
                  onClick={() => saveKey("")}
                  className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-ink-soft hover:border-red-300 hover:text-red-700"
                >
                  {t("settings.key.remove")}
                </button>
              )}
            </div>
            <p className="text-xs text-ink-soft/60">
              {settings.hasGroqApiKey ? t("settings.key.present") : t("settings.key.absent")}
            </p>
          </section>

          {/* ── Glossary ────────────────────────────────────────────────── */}
          <section className="space-y-3 rounded-lg border border-brand-light/60 bg-white p-6">
            <div>
              <h2 className="text-sm font-semibold text-ink">{t("settings.glossary.title")}</h2>
              <p className="mt-0.5 text-xs text-ink-soft/70">{t("settings.glossary.hint")}</p>
            </div>
            <textarea
              rows={4}
              className="w-full rounded-md border border-brand-light bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
              placeholder={t("settings.glossary.placeholder")}
              value={settings.glossary}
              onBlur={(e) => update({ ...settings, glossary: e.target.value })}
              onChange={(e) =>
                setSettings({ ...settings, glossary: e.target.value })
              }
            />
            <p className="text-xs text-ink-soft/60">{t("settings.glossary.foot")}</p>
          </section>

          <p className="text-xs text-ink-soft/60">
            {status === "saving" && t("common.saving")}
            {status === "saved" && <span className="text-brand">{t("common.saved")}</span>}
            {status === "idle" && t("settings.autosave")}
          </p>
        </div>
      )}
    </main>
  );
}
