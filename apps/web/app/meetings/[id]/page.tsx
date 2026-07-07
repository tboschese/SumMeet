"use client";

// Meeting detail (SPEC §5): insights first, transcript last & collapsed.
// Action items / decisions link back to their transcript span via sourceQuote.

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MeetingInsights } from "@summeet/core/schemas";
import {
  getMeeting,
  isProcessing,
  retryMeeting,
  type MeetingDetail,
} from "@/lib/api";

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Best-effort: find the transcript segment a verbatim sourceQuote came from. */
function findSegmentIndex(
  segments: { text: string }[],
  quote: string,
): number {
  const q = norm(quote);
  if (!q) return -1;
  const head = q.split(" ").slice(0, 6).join(" ");
  let best = -1;
  for (let i = 0; i < segments.length; i++) {
    const t = norm(segments[i]!.text);
    if (t.includes(head) || q.includes(t.split(" ").slice(0, 6).join(" "))) {
      return i;
    }
  }
  return best;
}

export default function MeetingDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDetail(await getMeeting(id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load meeting.");
    }
  }, [id]);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => {
      setDetail((cur) => {
        if (!cur || isProcessing(cur.meeting.status)) void refresh();
        return cur;
      });
    }, 3000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  // After the transcript opens, scroll to a pending segment.
  useEffect(() => {
    if (transcriptOpen && pendingScroll.current !== null) {
      const idx = pendingScroll.current;
      pendingScroll.current = null;
      requestAnimationFrame(() => {
        document
          .getElementById(`seg-${idx}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }, [transcriptOpen]);

  const scrollToQuote = useCallback(
    (quote: string | null) => {
      if (!quote || !detail?.transcript) return;
      const idx = findSegmentIndex(detail.transcript.segments, quote);
      if (idx < 0) return;
      setHighlight(idx);
      setTimeout(() => setHighlight(null), 2500);
      if (!transcriptOpen) {
        pendingScroll.current = idx;
        setTranscriptOpen(true);
      } else {
        document
          .getElementById(`seg-${idx}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },
    [detail, transcriptOpen],
  );

  const onRetry = useCallback(async () => {
    try {
      await retryMeeting(id);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed.");
    }
  }, [id, refresh]);

  if (error) {
    return (
      <Shell>
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      </Shell>
    );
  }
  if (!detail) {
    return (
      <Shell>
        <p className="text-sm text-neutral-400">Loading…</p>
      </Shell>
    );
  }

  const { meeting, transcript, insights } = detail;
  const processing = isProcessing(meeting.status);

  return (
    <Shell>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">{meeting.title}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {new Date(meeting.createdAt).toLocaleString()}
          {meeting.durationSec ? ` · ${Math.round(meeting.durationSec / 60)} min` : ""}
          {meeting.language ? ` · ${meeting.language}` : ""}
        </p>
      </header>

      {processing && (
        <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-6 text-center">
          <span className="inline-flex items-center gap-2 text-sm font-medium text-blue-700">
            <span className="h-2 w-2 animate-pulse rounded-full bg-blue-600" />
            {meeting.status === "TRANSCRIBING"
              ? "Transcribing audio…"
              : meeting.status === "EXTRACTING"
                ? "Extracting insights…"
                : "Queued…"}
          </span>
        </div>
      )}

      {meeting.status === "FAILED" && (
        <div className="rounded-lg border border-red-100 bg-red-50 p-4">
          <p className="text-sm font-medium text-red-800">Processing failed</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-red-700">
            {meeting.error ?? "Unknown error."}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )}

      {insights && <Insights data={insights.data} onQuote={scrollToQuote} />}

      {transcript && (
        <section className="mt-10">
          <button
            type="button"
            onClick={() => setTranscriptOpen((o) => !o)}
            className="text-sm font-medium text-neutral-700 hover:text-neutral-900"
          >
            {transcriptOpen ? "▾" : "▸"} Full transcript ({transcript.segments.length} segments)
          </button>
          {transcriptOpen && (
            <div className="mt-3 space-y-1 rounded-lg border border-neutral-200 bg-white p-4">
              {transcript.segments.map((seg, i) => (
                <p
                  key={i}
                  id={`seg-${i}`}
                  className={`rounded px-2 py-1 text-sm transition-colors ${
                    highlight === i ? "bg-yellow-100" : ""
                  }`}
                >
                  <span className="mr-2 font-mono text-xs text-neutral-400">
                    {formatTs(seg.start)}
                  </span>
                  {seg.text}
                </p>
              ))}
            </div>
          )}
        </section>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-800">
        ← All meetings
      </Link>
      <div className="mt-6">{children}</div>
    </main>
  );
}

function formatTs(sec: number): string {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function QuoteLink({
  quote,
  onQuote,
}: {
  quote: string | null;
  onQuote: (q: string | null) => void;
}) {
  if (!quote) return null;
  return (
    <button
      type="button"
      onClick={() => onQuote(quote)}
      className="mt-1 block text-left text-xs text-blue-600 hover:underline"
      title="Jump to this in the transcript"
    >
      “{quote.length > 90 ? `${quote.slice(0, 90)}…` : quote}”
    </button>
  );
}

const PRIORITY: Record<string, string> = {
  high: "bg-red-50 text-red-700",
  medium: "bg-amber-50 text-amber-700",
  low: "bg-neutral-100 text-neutral-600",
};

function Insights({
  data,
  onQuote,
}: {
  data: MeetingInsights;
  onQuote: (q: string | null) => void;
}) {
  return (
    <div className="space-y-10">
      <section>
        <p className="text-lg font-medium leading-relaxed text-neutral-900">
          {data.tldr}
        </p>
      </section>

      <Section title="Executive summary">
        <p className="text-sm leading-relaxed text-neutral-700">
          {data.executiveSummary}
        </p>
      </Section>

      {data.keyPoints.length > 0 && (
        <Section title="Key points">
          <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700">
            {data.keyPoints.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </Section>
      )}

      {data.actionItems.length > 0 && (
        <Section title="Action items">
          <ul className="space-y-3">
            {data.actionItems.map((a, i) => (
              <li key={i} className="rounded-lg border border-neutral-200 bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium text-neutral-900">{a.task}</p>
                  {a.priority && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                        PRIORITY[a.priority] ?? ""
                      }`}
                    >
                      {a.priority}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  {a.owner ? `Owner: ${a.owner}` : "Owner: —"}
                  {a.dueDate ? ` · Due: ${a.dueDate}` : ""}
                </p>
                <QuoteLink quote={a.sourceQuote} onQuote={onQuote} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {data.decisions.length > 0 && (
        <Section title="Decisions">
          <ul className="space-y-3">
            {data.decisions.map((d, i) => (
              <li key={i} className="rounded-lg border border-neutral-200 bg-white p-3">
                <p className="text-sm font-medium text-neutral-900">{d.decision}</p>
                {d.rationale && (
                  <p className="mt-1 text-xs text-neutral-500">Why: {d.rationale}</p>
                )}
                <QuoteLink quote={d.sourceQuote} onQuote={onQuote} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {data.topics.length > 0 && (
        <Section title="Topics">
          <ul className="space-y-2">
            {data.topics.map((t, i) => (
              <li key={i}>
                <p className="text-sm font-medium text-neutral-900">{t.title}</p>
                <p className="text-sm text-neutral-600">{t.summary}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        {title}
      </h2>
      {children}
    </section>
  );
}
