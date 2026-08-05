"use client";

// Ask your meetings (roadmap A12, in-app). Type a question — "list today's main tasks",
// "what's still open on Citrus" — and the LLM answers over your own decision records. The
// same MCP data, but inside the app; no external assistant needed.

import { useCallback, useState } from "react";
import { askMeetings } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { PageNav } from "@/app/components/PageNav";

const SUGGESTIONS = [
  "ask.suggest.tasks",
  "ask.suggest.decisions",
  "ask.suggest.week",
  "ask.suggest.followups",
] as const;

export default function AskPage() {
  const t = useT();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ meetings: number; provider?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback(async (q: string) => {
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const r = await askMeetings(query);
      setAnswer(r.answer);
      setMeta({ meetings: r.meetings, provider: r.provider });
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <PageNav current="ask" />
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{t("ask.title")}</h1>
        <p className="mt-1 text-sm text-ink-soft/70">{t("ask.tagline")}</p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
        className="flex gap-2"
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t("ask.placeholder")}
          autoFocus
          className="min-w-0 flex-1 rounded-md border border-brand-light px-3 py-2 text-sm text-ink placeholder:text-ink-soft/40 focus:border-brand focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading || !question.trim()}
          className="shrink-0 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
        >
          {loading ? t("ask.thinking") : t("ask.ask")}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setQuestion(t(key));
              void ask(t(key));
            }}
            className="rounded-full border border-brand-light px-2.5 py-1 text-xs text-brand hover:bg-brand-tint"
          >
            {t(key)}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-6 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {answer !== null && (
        <section className="mt-6">
          <div className="whitespace-pre-wrap rounded-lg border border-brand-light/60 bg-white p-4 text-sm leading-relaxed text-ink">
            {answer}
          </div>
          {meta && (
            <p className="mt-2 text-xs text-ink-soft/50">
              {t("ask.over", { count: meta.meetings })}
              {meta.provider ? ` · ${meta.provider}` : ""}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
