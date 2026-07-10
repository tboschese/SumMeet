"use client";

// Meeting detail (SPEC §5): insights first, transcript last & collapsed.
// Action items / decisions link back to their transcript span via sourceQuote.

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MeetingInsights } from "@summeet/core/schemas";
import {
  DEFAULT_SECTIONS,
  sectionSpec,
  type SectionKey,
} from "@summeet/core/sections";
import {
  deleteMeeting,
  getMeeting,
  getSettings,
  isProcessing,
  reextractMeeting,
  renameMeeting,
  retryMeeting,
  type MeetingDetail,
} from "@/lib/api";
import { InsightSections, isMine } from "@/app/components/InsightSections";

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

const toolBtn =
  "rounded-md border border-brand-light px-3 py-1.5 text-sm text-brand hover:bg-brand-tint disabled:opacity-60";

/** Safe, sortable filename: "2026-07-09-weekly-product-sync.md". */
function markdownFilename(title: string, createdAt: string): string {
  const date = new Date(createdAt).toISOString().slice(0, 10);
  const slug =
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // strip accents
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "meeting";
  return `${date}-${slug}.md`;
}

/** Markdown mirrors the sections (and order) the user configured. */
function insightsToMarkdown(
  title: string,
  d: MeetingInsights,
  sections: SectionKey[],
): string {
  const out: string[] = [`# ${title}`, ""];
  const quote = (q: string | null) => (q ? [`  > ${q}`] : []);

  for (const key of sections) {
    const { label } = sectionSpec(key);
    switch (key) {
      case "tldr":
        if (d.tldr) out.push(`**TL;DR** ${d.tldr}`, "");
        break;
      case "executiveSummary":
        if (d.executiveSummary) out.push(`## ${label}`, d.executiveSummary, "");
        break;
      case "keyPoints":
        if (d.keyPoints.length)
          out.push(`## ${label}`, ...d.keyPoints.map((p) => `- ${p}`), "");
        break;
      case "myCommitments":
      case "actionItems": {
        const items =
          key === "myCommitments" ? d.actionItems.filter((a) => isMine(a.owner)) : d.actionItems;
        if (!items.length) break;
        out.push(`## ${label}`);
        for (const a of items) {
          const meta = [
            a.owner ? `owner: ${a.owner}` : null,
            a.dueDate ? `due: ${a.dueDate}` : null,
            a.priority ? `priority: ${a.priority}` : null,
          ].filter(Boolean);
          out.push(`- [ ] ${a.task}${meta.length ? ` _(${meta.join(", ")})_` : ""}`, ...quote(a.sourceQuote));
        }
        out.push("");
        break;
      }
      case "decisions":
        if (!d.decisions.length) break;
        out.push(`## ${label}`);
        for (const dec of d.decisions) {
          out.push(`- ${dec.decision}${dec.rationale ? ` — _${dec.rationale}_` : ""}`, ...quote(dec.sourceQuote));
        }
        out.push("");
        break;
      case "openQuestions":
        if (!d.openQuestions.length) break;
        out.push(`## ${label}`);
        for (const q of d.openQuestions) {
          out.push(`- ${q.question}${q.askedBy ? ` _(asked by ${q.askedBy})_` : ""}`, ...quote(q.sourceQuote));
        }
        out.push("");
        break;
      case "risks":
        if (!d.risks.length) break;
        out.push(`## ${label}`);
        for (const r of d.risks) {
          out.push(`- ${r.risk}${r.severity ? ` _(${r.severity})_` : ""}`, ...quote(r.sourceQuote));
        }
        out.push("");
        break;
      case "nextSteps":
        if (d.nextSteps.length)
          out.push(`## ${label}`, ...d.nextSteps.map((s, i) => `${i + 1}. ${s}`), "");
        break;
      case "metrics":
        if (d.metrics.length)
          out.push(`## ${label}`, ...d.metrics.map((m) => `- **${m.value}** — ${m.label}`), "");
        break;
      case "topics":
        if (d.topics.length)
          out.push(`## ${label}`, ...d.topics.map((t) => `- **${t.title}**: ${t.summary}`), "");
        break;
    }
  }
  return out.join("\n").trim();
}

export default function MeetingDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [sections, setSections] = useState<SectionKey[]>(DEFAULT_SECTIONS);
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

  // The summary's shape is a user setting (SPEC A5).
  useEffect(() => {
    getSettings()
      .then((s) => setSections(s.summarySections))
      .catch(() => setSections(DEFAULT_SECTIONS));
  }, []);

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

  const onDelete = useCallback(async () => {
    if (!window.confirm("Delete this meeting and its insights? This can't be undone.")) {
      return;
    }
    try {
      await deleteMeeting(id);
      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    }
  }, [id, router]);

  const onRename = useCallback(async () => {
    const next = window.prompt("Rename meeting", detail?.meeting.title ?? "");
    if (next == null || !next.trim()) return;
    try {
      await renameMeeting(id, next.trim());
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rename failed.");
    }
  }, [id, detail, refresh]);

  const [reextracting, setReextracting] = useState(false);
  const onReextract = useCallback(async () => {
    setReextracting(true);
    try {
      await reextractMeeting(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Re-extract failed.");
    } finally {
      setReextracting(false);
    }
  }, [id, refresh]);

  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    if (!detail?.insights) return;
    try {
      await navigator.clipboard.writeText(
        insightsToMarkdown(detail.meeting.title, detail.insights.data, sections),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy to clipboard.");
    }
  }, [detail, sections]);

  // Save insights as a .md file, so it can be filed into a folder / notes app.
  const onDownload = useCallback(() => {
    if (!detail?.insights) return;
    const md = insightsToMarkdown(detail.meeting.title, detail.insights.data, sections);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = markdownFilename(detail.meeting.title, detail.meeting.createdAt);
    a.click();
    URL.revokeObjectURL(url);
  }, [detail, sections]);

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
        <p className="text-sm text-ink-soft/50">Loading…</p>
      </Shell>
    );
  }

  const { meeting, transcript, insights } = detail;
  const processing = isProcessing(meeting.status);

  return (
    <Shell>
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{meeting.title}</h1>
          <p className="mt-1 text-sm text-ink-soft/70">
            {new Date(meeting.createdAt).toLocaleString()}
            {meeting.durationSec ? ` · ${Math.round(meeting.durationSec / 60)} min` : ""}
            {meeting.language ? ` · ${meeting.language}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={onRename} className={toolBtn}>
            Rename
          </button>
          {insights && (
            <>
              <button type="button" onClick={onCopy} className={toolBtn}>
                {copied ? "Copied ✓" : "Copy MD"}
              </button>
              <button
                type="button"
                onClick={onDownload}
                title="Download as .md to file it in a folder"
                className={toolBtn}
              >
                Save .md
              </button>
              <button
                type="button"
                onClick={onReextract}
                disabled={reextracting}
                className={toolBtn}
              >
                {reextracting ? "Re-extracting…" : "Re-extract"}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-ink-soft hover:border-red-300 hover:bg-red-50 hover:text-red-700"
          >
            Delete
          </button>
        </div>
      </header>

      {processing && (
        <div className="rounded-lg border border-brand-light bg-brand-tint px-4 py-6 text-center">
          <span className="inline-flex items-center gap-2 text-sm font-medium text-brand">
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand" />
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

      {/* Transcript exists, insights don't: the deliberate TRANSCRIBED state. */}
      {!insights && transcript && !processing && meeting.status !== "FAILED" && (
        <div className="rounded-lg border border-amber-100 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            Transcript ready — insights not generated yet
          </p>
          <p className="mt-1 text-xs text-amber-800">
            Auto-extract is off, so nothing was sent to the insights engine.
            Generate the decision record when you want; it uses the engine you
            picked in Settings.
          </p>
          <button
            type="button"
            onClick={onReextract}
            disabled={reextracting}
            className="mt-3 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
          >
            {reextracting ? "Generating…" : "Generate insights"}
          </button>
        </div>
      )}

      {insights && (
        <InsightSections
          data={insights.data}
          sections={sections}
          onQuote={scrollToQuote}
        />
      )}

      {transcript && (
        <section className="mt-10">
          <button
            type="button"
            onClick={() => setTranscriptOpen((o) => !o)}
            className="text-sm font-medium text-ink hover:text-brand"
          >
            {transcriptOpen ? "▾" : "▸"} Full transcript ({transcript.segments.length} segments)
          </button>
          {transcriptOpen && (
            <div className="mt-3 space-y-1 rounded-lg border border-brand-light/60 bg-white p-4">
              {transcript.segments.map((seg, i) => (
                <p
                  key={i}
                  id={`seg-${i}`}
                  className={`rounded px-2 py-1 text-sm transition-colors ${
                    highlight === i ? "bg-brand-light" : ""
                  }`}
                >
                  <span className="mr-2 font-mono text-xs text-ink-soft/50">
                    {formatTs(seg.start)}
                  </span>
                  {seg.speaker && (
                    <span
                      className={`mr-2 text-xs font-semibold ${
                        seg.speaker === "self" ? "text-brand" : "text-ink-soft/70"
                      }`}
                    >
                      {seg.speaker === "self" ? "You" : "Others"}
                    </span>
                  )}
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
      <Link href="/" className="text-sm text-ink-soft/70 hover:text-brand">
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


