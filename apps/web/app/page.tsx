"use client";

// Meeting list (SPEC §5). Polls rows that are still processing; Record is the
// primary CTA, Upload secondary (both in RecordBar).

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteMeeting,
  isProcessing,
  listMeetings,
  type MeetingListItem,
} from "@/lib/api";
import { RecordBar } from "./components/RecordBar";
import { StatusBadge } from "./components/StatusBadge";

function formatDuration(sec: number | null): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function HomePage() {
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMeetings(await listMeetings());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the API.");
    }
  }, []);

  const onDelete = useCallback(
    async (id: string, title: string) => {
      if (!window.confirm(`Delete “${title}”? This can't be undone.`)) return;
      try {
        await deleteMeeting(id);
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Delete failed.");
      }
    },
    [refresh],
  );

  // Poll every 3s while any meeting is still processing.
  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => {
      setMeetings((cur) => {
        if (!cur || cur.some((m) => isProcessing(m.status))) void refresh();
        return cur;
      });
    }, 3000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Sum<span className="text-brand">Meet</span>
          </h1>
          <p className="mt-1 text-sm text-ink-soft/70">
            Your meetings, as decision records.
          </p>
        </div>
        <Link
          href="/settings"
          className="shrink-0 rounded-md border border-brand-light px-3 py-1.5 text-sm text-brand hover:bg-brand-tint"
        >
          Settings
        </Link>
      </header>

      <RecordBar onCreated={refresh} />

      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <section className="mt-8">
        {meetings === null && !error ? (
          <p className="text-sm text-neutral-400">Loading…</p>
        ) : meetings && meetings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-brand-light bg-white p-12 text-center">
            <p className="text-sm font-medium text-ink">No meetings yet</p>
            <p className="mt-1 text-sm text-ink-soft/70">
              Record or upload a meeting to see its insights here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 bg-white">
            {meetings?.map((m) => (
              <li key={m.id} className="flex items-center">
                <Link
                  href={`/meetings/${m.id}`}
                  className="flex min-w-0 flex-1 items-center justify-between gap-4 px-4 py-3 hover:bg-brand-tint/60"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      {m.title}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-soft/70">
                      {new Date(m.createdAt).toLocaleString()} ·{" "}
                      {formatDuration(m.durationSec)}
                    </p>
                  </div>
                  <StatusBadge status={m.status} />
                </Link>
                <button
                  type="button"
                  onClick={() => onDelete(m.id, m.title)}
                  title="Delete meeting"
                  className="px-3 py-3 text-neutral-300 hover:text-red-600"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-10 text-center text-xs text-ink-soft/50">
        Recording may require consent. Announce that you&apos;re recording and
        follow local laws and your organization&apos;s policy.
      </footer>
    </main>
  );
}
