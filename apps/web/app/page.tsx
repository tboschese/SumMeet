"use client";

// Meeting list (SPEC §5). Polls rows that are still processing; Record is the
// primary CTA, Upload secondary (both in RecordBar).

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { isProcessing, listMeetings, type MeetingListItem } from "@/lib/api";
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
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">SumMeet</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Your meetings, as decision records.
        </p>
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
          <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-12 text-center">
            <p className="text-sm font-medium text-neutral-700">No meetings yet</p>
            <p className="mt-1 text-sm text-neutral-500">
              Record or upload a meeting to see its insights here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 bg-white">
            {meetings?.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/meetings/${m.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-neutral-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-900">
                      {m.title}
                    </p>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {new Date(m.createdAt).toLocaleString()} ·{" "}
                      {formatDuration(m.durationSec)}
                    </p>
                  </div>
                  <StatusBadge status={m.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
