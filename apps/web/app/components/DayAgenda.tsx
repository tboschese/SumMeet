"use client";

// The home agenda: live meetings grouped by day, newest first (Granola-style). Shows a
// few days by default and reveals older ones on demand; when a day is picked in the
// calendar above, it narrows to just that day. Each row links to the meeting and keeps the
// list's per-row actions (move to folder, trash), so the agenda is a full replacement for
// the flat list in the default browse.

import Link from "next/link";
import { useMemo } from "react";
import type { CalendarMeeting, Folder } from "@/lib/api";
import { useI18n, useT, type TFunction } from "@/lib/i18n";
import { StatusBadge } from "./StatusBadge";

function localKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Relative, human day label: Today / Yesterday / a spelled-out date. */
function dayHeader(key: string, lang: string, t: TFunction): string {
  const [y, mo, da] = key.split("-").map(Number);
  const d = new Date(y!, mo!, da!);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return t("calendar.today");
  if (diff === -1) return t("agenda.yesterday");
  return new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long" }).format(d);
}

export function DayAgenda({
  meetings,
  folders,
  selectedDay,
  onClearDay,
  daysToShow,
  onShowMore,
  onTrash,
  onMoveToFolder,
}: {
  meetings: CalendarMeeting[] | null;
  folders: Folder[];
  selectedDay: string | null;
  onClearDay: () => void;
  daysToShow: number;
  onShowMore: () => void;
  onTrash: (id: string, title: string) => void;
  onMoveToFolder: (id: string, folderId: string | null) => void;
}) {
  const t = useT();
  const { lang } = useI18n();

  // Group by local day, newest day first, meetings within a day newest first.
  const groups = useMemo(() => {
    const map = new Map<string, CalendarMeeting[]>();
    for (const m of meetings ?? []) {
      const k = localKey(new Date(m.createdAt));
      const list = map.get(k);
      if (list) list.push(m);
      else map.set(k, [m]);
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([k, list]) => [k, list.sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))] as const);
  }, [meetings]);

  if (meetings === null) {
    return <p className="mt-4 text-sm text-ink-soft/50">{t("common.loading")}</p>;
  }

  if (groups.length === 0) {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-brand-light bg-white p-12 text-center">
        <p className="text-sm font-medium text-ink">{t("home.empty.title")}</p>
        <p className="mt-1 text-sm text-ink-soft/70">{t("home.empty.hint")}</p>
      </div>
    );
  }

  const visible = selectedDay
    ? groups.filter(([k]) => k === selectedDay)
    : groups.slice(0, daysToShow);
  const hasMore = !selectedDay && groups.length > daysToShow;

  return (
    <div className="mt-4 space-y-5">
      {selectedDay && (
        <button
          type="button"
          onClick={onClearDay}
          className="text-xs text-brand hover:text-brand-dark"
        >
          ← {t("agenda.allDays")}
        </button>
      )}

      {visible.map(([key, dayMeetings]) => (
        <section key={key}>
          <h3 className="mb-2 text-xs font-semibold capitalize text-ink-soft/70">
            {dayHeader(key, lang, t)}
            <span className="ml-1.5 font-normal text-ink-soft/40">({dayMeetings.length})</span>
          </h3>
          <ul className="divide-y divide-brand-light/40 overflow-hidden rounded-lg border border-brand-light/60 bg-white">
            {dayMeetings.map((m) => (
              <li key={m.id} className="flex items-center">
                <Link
                  href={`/meetings?id=${m.id}`}
                  className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-2.5 hover:bg-brand-tint/60"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{m.title}</p>
                    <p className="mt-0.5 text-xs text-ink-soft/60">
                      {new Date(m.createdAt).toLocaleTimeString(lang, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {m.hasNotes ? ` · ${t("calendar.notesTag")}` : ""}
                    </p>
                  </div>
                  <StatusBadge status={m.status} />
                </Link>
                <select
                  value={m.folderId ?? ""}
                  onChange={(e) => onMoveToFolder(m.id, e.target.value || null)}
                  title={t("home.folder.move")}
                  aria-label={t("home.folder.move")}
                  className="max-w-[7rem] shrink-0 truncate rounded-md border border-transparent bg-transparent py-1 text-xs text-ink-soft/60 hover:border-brand-light hover:text-brand"
                >
                  <option value="">{t("home.folder.none")}</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onTrash(m.id, m.title)}
                  title={t("home.deleteMeeting")}
                  className="px-3 py-3 text-neutral-300 hover:text-red-600"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {hasMore && (
        <button
          type="button"
          onClick={onShowMore}
          className="w-full rounded-lg border border-brand-light py-2 text-sm text-brand hover:bg-brand-tint"
        >
          {t("agenda.showMore")}
        </button>
      )}
    </div>
  );
}
