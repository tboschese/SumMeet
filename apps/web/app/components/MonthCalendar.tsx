"use client";

// A month calendar for the home page: each day shows how many meetings you recorded
// that day, with a dot for the ones you took your own notes in. Click a day to list its
// meetings. The grid window is fetched as instants and bucketed by *local* date, so a
// late-night meeting lands on the day you actually had it, not a UTC-shifted one.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { listCalendar, type CalendarMeeting } from "@/lib/api";
import { useI18n, useT } from "@/lib/i18n";

/** Local-date key: year-monthIndex-day (never touches UTC). */
function localKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function firstOfThisMonth(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), 1);
}

export function MonthCalendar() {
  const t = useT();
  const { lang } = useI18n();
  const [cursor, setCursor] = useState(firstOfThisMonth);
  const [meetings, setMeetings] = useState<CalendarMeeting[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // A 6-week (42-cell) grid starting on the Sunday on or before the 1st.
  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [cursor]);

  useEffect(() => {
    const from = cells[0]!;
    const to = new Date(cells[41]!);
    to.setDate(to.getDate() + 1); // exclusive end of the last visible day
    setMeetings(null);
    setSelected(null);
    listCalendar(from.toISOString(), to.toISOString())
      .then((r) => setMeetings(r.meetings))
      .catch(() => setMeetings([]));
  }, [cells]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarMeeting[]>();
    for (const m of meetings ?? []) {
      const k = localKey(new Date(m.createdAt));
      const list = map.get(k);
      if (list) list.push(m);
      else map.set(k, [m]);
    }
    return map;
  }, [meetings]);

  const monthLabel = new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" }).format(cursor);
  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(lang, { weekday: "short" });
    // 2023-01-01 was a Sunday — a stable anchor for a Sunday-first week.
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i)));
  }, [lang]);

  const todayKey = localKey(new Date());
  const monthIdx = cursor.getMonth();
  const selectedMeetings = selected ? byDay.get(selected) ?? [] : [];
  const selectedDate = selected
    ? (() => {
        const [y, mo, da] = selected.split("-").map(Number);
        return new Date(y!, mo!, da!);
      })()
    : null;

  const navBtn =
    "rounded-md border border-brand-light px-2 py-1 text-sm text-brand hover:bg-brand-tint";

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold capitalize text-ink">{monthLabel}</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title={t("calendar.prev")}
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
            className={navBtn}
          >
            ‹
          </button>
          <button type="button" onClick={() => setCursor(firstOfThisMonth())} className={navBtn}>
            {t("calendar.today")}
          </button>
          <button
            type="button"
            title={t("calendar.next")}
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
            className={navBtn}
          >
            ›
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-ink-soft/50">
        {weekdays.map((w, i) => (
          <div key={i} className="py-1 capitalize">
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          const k = localKey(d);
          const dayMeetings = byDay.get(k) ?? [];
          const has = dayMeetings.length > 0;
          const inMonth = d.getMonth() === monthIdx;
          const isToday = k === todayKey;
          const isSelected = k === selected;
          const hasNotes = dayMeetings.some((m) => m.hasNotes);
          return (
            <button
              key={i}
              type="button"
              disabled={!has}
              onClick={() => setSelected(isSelected ? null : k)}
              className={`flex aspect-square flex-col items-center justify-center rounded-md border p-1 text-xs transition-colors ${
                isSelected
                  ? "border-brand bg-brand text-white"
                  : has
                    ? "border-brand-light bg-white hover:bg-brand-tint"
                    : "cursor-default border-transparent"
              } ${!inMonth ? "opacity-40" : ""}`}
            >
              <span
                className={`${
                  isToday && !isSelected
                    ? "flex h-5 w-5 items-center justify-center rounded-full bg-brand font-medium text-white"
                    : has
                      ? "font-medium"
                      : "text-ink-soft/50"
                }`}
              >
                {d.getDate()}
              </span>
              {has && (
                <span className="mt-0.5 flex items-center gap-0.5">
                  <span className={`text-[10px] ${isSelected ? "text-white/90" : "text-brand"}`}>
                    {dayMeetings.length}
                  </span>
                  {hasNotes && (
                    <span
                      title={t("calendar.hasNotes")}
                      className={`h-1 w-1 rounded-full ${isSelected ? "bg-white" : "bg-amber-400"}`}
                    />
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selected && selectedDate && (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-semibold capitalize text-ink-soft/70">
            {new Intl.DateTimeFormat(lang, {
              weekday: "long",
              day: "numeric",
              month: "long",
            }).format(selectedDate)}
          </h3>
          <ul className="space-y-2">
            {selectedMeetings.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/meetings?id=${m.id}`}
                  className="block rounded-lg border border-brand-light/60 bg-white px-3 py-2 hover:bg-brand-tint/60"
                >
                  <p className="truncate text-sm text-ink">{m.title}</p>
                  <p className="mt-0.5 text-xs text-ink-soft/60">
                    {new Date(m.createdAt).toLocaleTimeString(lang, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {m.hasNotes ? ` · ${t("calendar.notesTag")}` : ""}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
