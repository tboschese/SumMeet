"use client";

// A compact month calendar for the top of the home page (Granola-style): an at-a-glance
// map of which days have meetings, with a dot for the ones you took notes in. It's
// *controlled* — the parent owns the data and the selected day — and renders no list of
// its own; the day-grouped agenda below does that. Buckets by local date so a late-night
// meeting sits on the day you had it, not a UTC-shifted one.

import { useMemo, useState } from "react";
import type { CalendarMeeting } from "@/lib/api";
import { useI18n, useT } from "@/lib/i18n";

function localKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function firstOfThisMonth(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), 1);
}

export function MiniCalendar({
  meetings,
  selected,
  onSelect,
}: {
  meetings: CalendarMeeting[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const t = useT();
  const { lang } = useI18n();
  const [cursor, setCursor] = useState(firstOfThisMonth);

  const byDay = useMemo(() => {
    const map = new Map<string, { count: number; hasNotes: boolean }>();
    for (const m of meetings) {
      const k = localKey(new Date(m.createdAt));
      const cur = map.get(k) ?? { count: 0, hasNotes: false };
      cur.count += 1;
      cur.hasNotes = cur.hasNotes || m.hasNotes;
      map.set(k, cur);
    }
    return map;
  }, [meetings]);

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

  const monthLabel = new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" }).format(cursor);
  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(lang, { weekday: "narrow" });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i)));
  }, [lang]);

  const todayKey = localKey(new Date());
  const monthIdx = cursor.getMonth();
  const navBtn = "rounded px-1.5 py-0.5 text-brand hover:bg-brand-tint";

  return (
    <div className="mt-6 rounded-lg border border-brand-light/60 bg-white p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <h2 className="text-xs font-semibold capitalize text-ink">{monthLabel}</h2>
        <div className="flex items-center gap-0.5 text-sm">
          <button type="button" title={t("calendar.prev")} onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))} className={navBtn}>
            ‹
          </button>
          <button type="button" onClick={() => setCursor(firstOfThisMonth())} className="rounded px-1.5 py-0.5 text-[11px] text-brand hover:bg-brand-tint">
            {t("calendar.today")}
          </button>
          <button type="button" title={t("calendar.next")} onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))} className={navBtn}>
            ›
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 text-center text-[10px] font-medium text-ink-soft/40">
        {weekdays.map((w, i) => (
          <div key={i} className="py-0.5 uppercase">
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d, i) => {
          const k = localKey(d);
          const day = byDay.get(k);
          const has = !!day;
          const inMonth = d.getMonth() === monthIdx;
          const isToday = k === todayKey;
          const isSelected = k === selected;
          return (
            <button
              key={i}
              type="button"
              disabled={!has}
              onClick={() => onSelect(k)}
              title={has ? `${day!.count}` : undefined}
              className={`relative flex h-8 flex-col items-center justify-center rounded text-xs transition-colors ${
                isSelected
                  ? "bg-brand font-medium text-white"
                  : has
                    ? "font-medium text-ink hover:bg-brand-tint"
                    : "cursor-default text-ink-soft/40"
              } ${!inMonth ? "opacity-40" : ""} ${
                isToday && !isSelected ? "ring-1 ring-inset ring-brand/40" : ""
              }`}
            >
              {d.getDate()}
              {has && (
                <span
                  className={`absolute bottom-1 h-1 w-1 rounded-full ${
                    isSelected ? "bg-white" : day!.hasNotes ? "bg-amber-400" : "bg-brand"
                  }`}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
