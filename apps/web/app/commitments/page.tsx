"use client";

// "My work" dashboard: every action item you own and every decision, pulled across
// all meetings from their active insight version. Read-only — it's the standing answer
// to "what did I agree to?" without opening each meeting or asking the assistant. Powered
// by the same cross-meeting aggregates as the MCP server (roadmap A12); no LLM call.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listCommitments,
  listDecisions,
  type Commitment,
  type DecisionRow,
} from "@/lib/api";
import { useT, type TFunction } from "@/lib/i18n";

type Bucket = "overdue" | "today" | "week" | "later" | "someday";
const BUCKET_ORDER: Bucket[] = ["overdue", "today", "week", "later", "someday"];

/** A due date is a real date, a vague phrase ("next Friday"), or nothing. Bucket the
 * parseable ones by urgency; everything else lands in "someday" but still shows its text. */
function bucketOf(due: string | null): Bucket {
  if (!due) return "someday";
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return "someday";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff <= 7) return "week";
  return "later";
}

/** Sort key inside a bucket: parseable dates ascending, then the rest. */
function dueSortKey(due: string | null): number {
  if (!due) return Number.POSITIVE_INFINITY;
  const t = new Date(due).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** Show a real date nicely; pass a vague phrase through unchanged. */
function formatDue(due: string): string {
  const d = new Date(due);
  return Number.isNaN(d.getTime())
    ? due
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const PRIORITY_CLS: Record<string, string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-neutral-100 text-neutral-600",
};

const BUCKET_CLS: Record<Bucket, string> = {
  overdue: "text-red-700",
  today: "text-brand",
  week: "text-ink",
  later: "text-ink-soft/70",
  someday: "text-ink-soft/50",
};

export default function CommitmentsPage() {
  const t = useT();
  const [tab, setTab] = useState<"commitments" | "decisions">("commitments");
  const [owner, setOwner] = useState<"you" | "all">("you");
  const [commitments, setCommitments] = useState<Commitment[] | null>(null);
  const [decisions, setDecisions] = useState<DecisionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCommitments = useCallback(async () => {
    setError(null);
    try {
      const { commitments } = await listCommitments(owner === "you" ? "you" : undefined);
      setCommitments(commitments);
    } catch {
      setError(t("work.loadFailed"));
    }
  }, [owner, t]);

  useEffect(() => {
    void loadCommitments();
  }, [loadCommitments]);

  useEffect(() => {
    if (tab === "decisions" && decisions === null) {
      listDecisions()
        .then((r) => setDecisions(r.decisions))
        .catch(() => setError(t("work.loadFailed")));
    }
  }, [tab, decisions, t]);

  // Group commitments into ordered buckets, sorted by urgency within each.
  const grouped = useMemo(() => {
    const map = new Map<Bucket, Commitment[]>();
    for (const c of commitments ?? []) {
      const b = bucketOf(c.dueDate);
      (map.get(b) ?? map.set(b, []).get(b)!).push(c);
    }
    for (const list of map.values()) {
      list.sort((a, b) => dueSortKey(a.dueDate) - dueSortKey(b.dueDate));
    }
    return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => [b, map.get(b)!] as const);
  }, [commitments]);

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{t("work.title")}</h1>
          <p className="mt-1 text-sm text-ink-soft/70">{t("work.subtitle")}</p>
        </div>
        <Link
          href="/"
          className="shrink-0 rounded-md border border-brand-light px-3 py-1.5 text-sm text-brand hover:bg-brand-tint"
        >
          {t("common.backToMeetings")}
        </Link>
      </header>

      {/* Tabs */}
      <div className="mb-5 flex items-center gap-1 border-b border-brand-light/60">
        {(["commitments", "decisions"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === key
                ? "border-brand text-brand"
                : "border-transparent text-ink-soft/60 hover:text-ink"
            }`}
          >
            {t(`work.tab.${key}`)}
            <span className="ml-1.5 text-xs text-ink-soft/40">
              {key === "commitments"
                ? commitments?.length ?? ""
                : decisions?.length ?? ""}
            </span>
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {tab === "commitments" && (
        <>
          {/* Owner filter: my own commitments (the default) or everyone's. */}
          <div className="mb-4 inline-flex rounded-md border border-brand-light p-0.5 text-xs">
            {(["you", "all"] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => {
                  setOwner(o);
                  setCommitments(null);
                }}
                className={`rounded px-2.5 py-1 ${
                  owner === o ? "bg-brand text-white" : "text-brand hover:bg-brand-tint"
                }`}
              >
                {t(o === "you" ? "work.owner.mine" : "work.owner.all")}
              </button>
            ))}
          </div>

          {commitments === null && !error && (
            <p className="text-sm text-ink-soft/60">{t("work.loading")}</p>
          )}
          {commitments?.length === 0 && (
            <p className="rounded-lg border border-brand-light/60 bg-brand-tint/30 px-4 py-6 text-center text-sm text-ink-soft/70">
              {t("work.empty.commitments")}
            </p>
          )}

          <div className="space-y-6">
            {grouped.map(([bucket, items]) => (
              <section key={bucket}>
                <h2
                  className={`mb-2 text-xs font-semibold uppercase tracking-wide ${BUCKET_CLS[bucket]}`}
                >
                  {t(`work.bucket.${bucket}`)}{" "}
                  <span className="font-normal text-ink-soft/40">({items.length})</span>
                </h2>
                <ul className="space-y-2">
                  {items.map((c, i) => (
                    <CommitmentCard key={`${c.meetingId}-${i}`} c={c} t={t} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}

      {tab === "decisions" && (
        <>
          {decisions === null && !error && (
            <p className="text-sm text-ink-soft/60">{t("work.loading")}</p>
          )}
          {decisions?.length === 0 && (
            <p className="rounded-lg border border-brand-light/60 bg-brand-tint/30 px-4 py-6 text-center text-sm text-ink-soft/70">
              {t("work.empty.decisions")}
            </p>
          )}
          <ul className="space-y-2">
            {decisions?.map((d, i) => (
              <DecisionCard key={`${d.meetingId}-${i}`} d={d} t={t} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function MeetingRef({
  id,
  title,
  date,
}: {
  id: string;
  title: string;
  date: string;
}) {
  return (
    <Link
      href={`/meetings?id=${id}`}
      className="truncate text-xs text-ink-soft/60 hover:text-brand"
      title={title}
    >
      {title} · {new Date(date).toLocaleDateString()}
    </Link>
  );
}

function CommitmentCard({ c, t }: { c: Commitment; t: TFunction }) {
  const [showQuote, setShowQuote] = useState(false);
  return (
    <li className="rounded-lg border border-brand-light/60 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-ink">{c.task}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          {c.priority && (
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${PRIORITY_CLS[c.priority]}`}>
              {t(`work.priority.${c.priority}`)}
            </span>
          )}
          {c.dueDate && (
            <span className="rounded bg-brand-tint px-1.5 py-0.5 text-[10px] text-brand">
              {t("work.due", { date: formatDue(c.dueDate) })}
            </span>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <MeetingRef id={c.meetingId} title={c.meetingTitle} date={c.meetingDate} />
        {c.sourceQuote && (
          <button
            type="button"
            onClick={() => setShowQuote((v) => !v)}
            className="shrink-0 text-[11px] text-ink-soft/50 hover:text-brand"
          >
            {t("work.quote")}
          </button>
        )}
      </div>
      {showQuote && c.sourceQuote && (
        <p className="mt-2 border-l-2 border-brand-light pl-2 text-xs italic text-ink-soft/70">
          &ldquo;{c.sourceQuote}&rdquo;
        </p>
      )}
    </li>
  );
}

function DecisionCard({ d, t }: { d: DecisionRow; t: TFunction }) {
  const [showQuote, setShowQuote] = useState(false);
  return (
    <li className="rounded-lg border border-brand-light/60 bg-white p-3">
      <p className="text-sm font-medium text-ink">{d.decision}</p>
      {d.rationale && (
        <p className="mt-1 text-xs text-ink-soft/70">
          <span className="text-ink-soft/40">{t("work.because")} </span>
          {d.rationale}
        </p>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <MeetingRef id={d.meetingId} title={d.meetingTitle} date={d.meetingDate} />
        {d.sourceQuote && (
          <button
            type="button"
            onClick={() => setShowQuote((v) => !v)}
            className="shrink-0 text-[11px] text-ink-soft/50 hover:text-brand"
          >
            {t("work.quote")}
          </button>
        )}
      </div>
      {showQuote && d.sourceQuote && (
        <p className="mt-2 border-l-2 border-brand-light pl-2 text-xs italic text-ink-soft/70">
          &ldquo;{d.sourceQuote}&rdquo;
        </p>
      )}
    </li>
  );
}
