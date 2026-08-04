"use client";

// Meeting list (SPEC §5). Polls rows that are still processing; Record is the
// primary CTA, Upload secondary (both in RecordBar).
//
// The history grows without bound, so the list is a page with search and a status
// filter. Deleting moves to the trash: a meeting's audio is discarded once transcribed,
// so the insights and transcript are all that is left of it, and a hard delete cannot be
// taken back.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MeetingStatus } from "@summeet/core/schemas";
import {
  createFolder,
  deleteFolder,
  deleteMeetingForever,
  emptyTrash,
  extractPending,
  isProcessing,
  listFolders,
  listMeetings,
  moveMeetingToFolder,
  renameFolder,
  restoreMeeting,
  trashMeeting,
  type Folder,
  type MeetingList,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { PromptDialog } from "./components/PromptDialog";
import { RecordBar } from "./components/RecordBar";
import { StatusBadge } from "./components/StatusBadge";

const PAGE_SIZE = 15;
const STATUSES: MeetingStatus[] = [
  "UPLOADED",
  "TRANSCRIBING",
  "TRANSCRIBED",
  "EXTRACTING",
  "COMPLETED",
  "FAILED",
];

function formatDuration(sec: number | null): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function HomePage() {
  const t = useT();
  const [list, setList] = useState<MeetingList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [trashView, setTrashView] = useState(false);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<MeetingStatus | "">("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  // "" = all, "none" = unfiled, otherwise a folder id.
  const [folder, setFolder] = useState<string>("");
  const [folders, setFolders] = useState<Folder[]>([]);

  const loadFolders = useCallback(async () => {
    try {
      setFolders(await listFolders());
    } catch {
      // The folder bar just stays empty; the meeting list is unaffected.
    }
  }, []);
  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  // Debounce the search: typing shouldn't fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(id);
  }, [search]);

  const refresh = useCallback(async () => {
    try {
      setList(
        await listMeetings({
          page,
          pageSize: PAGE_SIZE,
          q: query || undefined,
          status: status || undefined,
          folderId: !trashView && folder ? folder : undefined,
          trash: trashView,
        }),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("home.apiUnreachable"));
    }
  }, [page, query, status, folder, trashView, t]);

  const meetings = list?.meetings ?? null;
  const [summarizing, setSummarizing] = useState(false);
  const pendingCount = meetings?.filter((m) => m.status === "TRANSCRIBED").length ?? 0;

  const onSummarizeAll = useCallback(async () => {
    setSummarizing(true);
    try {
      await extractPending();
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("home.summarizeFailed"));
    } finally {
      setSummarizing(false);
    }
  }, [refresh, t]);

  // Deleting is a click, so it gets an undo rather than a confirmation: the meeting is
  // in the trash, not gone, and asking twice for a reversible act is friction.
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onTrash = useCallback(
    async (id: string, title: string) => {
      try {
        await trashMeeting(id);
        setUndo({ id, title });
        if (undoTimer.current) clearTimeout(undoTimer.current);
        undoTimer.current = setTimeout(() => setUndo(null), 8000);
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : t("home.deleteFailed"));
      }
    },
    [refresh, t],
  );

  const onRestore = useCallback(
    async (id: string) => {
      try {
        await restoreMeeting(id);
        setUndo(null);
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : t("home.restoreFailed"));
      }
    },
    [refresh, t],
  );

  // Purging is the irreversible one, so it asks — with our own dialog, because the
  // desktop webview has no window.confirm and silently answered "no".
  const [purging, setPurging] = useState<{ id: string; title: string } | null>(null);
  const [emptying, setEmptying] = useState(false);

  const onPurge = useCallback(async () => {
    if (!purging) return;
    const { id } = purging;
    setPurging(null);
    try {
      await deleteMeetingForever(id);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("home.deleteFailed"));
    }
  }, [purging, refresh, t]);

  const onEmptyTrash = useCallback(async () => {
    setEmptying(false);
    try {
      await emptyTrash();
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("home.deleteFailed"));
    }
  }, [refresh, t]);

  // Folder create/rename/delete, all through the in-app dialogs.
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<Folder | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null);

  const onCreateFolder = useCallback(
    async (name: string) => {
      setCreatingFolder(false);
      try {
        const created = await createFolder(name);
        await loadFolders();
        setFolder(created.id);
        setPage(1);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("home.folderFailed"));
      }
    },
    [loadFolders, t],
  );

  const onRenameFolder = useCallback(
    async (name: string) => {
      if (!renamingFolder) return;
      const { id } = renamingFolder;
      setRenamingFolder(null);
      try {
        await renameFolder(id, name);
        await loadFolders();
      } catch (e) {
        setError(e instanceof Error ? e.message : t("home.folderFailed"));
      }
    },
    [renamingFolder, loadFolders, t],
  );

  const onDeleteFolder = useCallback(async () => {
    if (!deletingFolder) return;
    const { id } = deletingFolder;
    setDeletingFolder(null);
    try {
      await deleteFolder(id);
      if (folder === id) setFolder("");
      await loadFolders();
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("home.folderFailed"));
    }
  }, [deletingFolder, folder, loadFolders, refresh, t]);

  // Moving a meeting also refreshes the counts, so the folder bar stays honest.
  const onMoveToFolder = useCallback(
    async (id: string, folderId: string | null) => {
      try {
        await moveMeetingToFolder(id, folderId);
        await loadFolders();
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : t("home.folderFailed"));
      }
    },
    [loadFolders, refresh, t],
  );

  // Poll every 3s while any meeting is still processing.
  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => {
      setList((cur) => {
        if (!cur || cur.meetings.some((m) => isProcessing(m.status))) void refresh();
        return cur;
      });
    }, 3000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  const filtering = Boolean(query || status);

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Sum<span className="text-brand">Meet</span>
          </h1>
          <p className="mt-1 text-sm text-ink-soft/70">{t("home.tagline")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/ask"
            className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark"
          >
            {t("ask.link")}
          </Link>
          <Link
            href="/settings"
            className="rounded-md border border-brand-light px-3 py-1.5 text-sm text-brand hover:bg-brand-tint"
          >
            {t("common.settings")}
          </Link>
        </div>
      </header>

      {!trashView && <RecordBar onCreated={refresh} />}

      {pendingCount > 0 && !trashView && (
        <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-amber-100 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-900">
            {t(pendingCount === 1 ? "home.pending.one" : "home.pending.many", {
              count: pendingCount,
            })}
          </p>
          <button
            type="button"
            onClick={onSummarizeAll}
            disabled={summarizing}
            className="shrink-0 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
          >
            {summarizing ? t("home.queuing") : t("home.summarizeAll", { count: pendingCount })}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {undo && (
        <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-brand-light bg-brand-tint px-4 py-2.5">
          <p className="min-w-0 truncate text-sm text-ink">
            {t("home.trashed", { title: undo.title })}
          </p>
          <button
            type="button"
            onClick={() => onRestore(undo.id)}
            className="shrink-0 text-sm font-medium text-brand hover:text-brand-dark"
          >
            {t("home.undo")}
          </button>
        </div>
      )}

      {/* Search + filters */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("home.searchPlaceholder")}
          className="min-w-0 flex-1 rounded-md border border-brand-light px-3 py-1.5 text-sm text-ink placeholder:text-ink-soft/40 focus:border-brand focus:outline-none"
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as MeetingStatus | "");
            setPage(1);
          }}
          className="rounded-md border border-brand-light bg-white px-2 py-1.5 text-sm text-ink"
        >
          <option value="">{t("home.filter.allStatuses")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            setTrashView((v) => !v);
            setPage(1);
          }}
          className={`rounded-md border px-3 py-1.5 text-sm ${
            trashView
              ? "border-brand bg-brand text-white"
              : "border-brand-light text-brand hover:bg-brand-tint"
          }`}
        >
          {trashView ? t("home.backToMeetings") : t("home.trash")}
        </button>
      </div>

      {/* Folder filter — chips, since the layout is a single centered column. */}
      {!trashView && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <FolderChip label={t("home.folder.all")} active={folder === ""} onClick={() => { setFolder(""); setPage(1); }} />
          {folders.map((f) => (
            <FolderChip
              key={f.id}
              label={f.name}
              count={f.count}
              active={folder === f.id}
              onClick={() => { setFolder(f.id); setPage(1); }}
            />
          ))}
          <FolderChip
            label={t("home.folder.unfiled")}
            active={folder === "none"}
            onClick={() => { setFolder("none"); setPage(1); }}
          />
          <button
            type="button"
            onClick={() => setCreatingFolder(true)}
            className="rounded-full border border-dashed border-brand-light px-2.5 py-1 text-xs text-brand hover:bg-brand-tint"
          >
            {t("home.folder.new")}
          </button>
          {folder && folder !== "none" && (
            <span className="ml-1 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setRenamingFolder(folders.find((f) => f.id === folder) ?? null)}
                className="text-xs text-ink-soft/60 hover:text-brand"
              >
                {t("home.folder.rename")}
              </button>
              <button
                type="button"
                onClick={() => setDeletingFolder(folders.find((f) => f.id === folder) ?? null)}
                className="text-xs text-ink-soft/60 hover:text-red-600"
              >
                {t("home.folder.delete")}
              </button>
            </span>
          )}
        </div>
      )}

      <section className="mt-4">
        {meetings === null && !error ? (
          <p className="text-sm text-ink-soft/50">{t("common.loading")}</p>
        ) : meetings && meetings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-brand-light bg-white p-12 text-center">
            <p className="text-sm font-medium text-ink">
              {trashView
                ? t("home.trashEmpty")
                : filtering
                  ? t("home.noMatches")
                  : t("home.empty.title")}
            </p>
            {!trashView && !filtering && (
              <p className="mt-1 text-sm text-ink-soft/70">{t("home.empty.hint")}</p>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 bg-white">
            {meetings?.map((m) => (
              <li key={m.id} className="flex items-center">
                {trashView ? (
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-4 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-soft">{m.title}</p>
                      <p className="mt-0.5 text-xs text-ink-soft/60">
                        {m.deletedAt
                          ? t("home.deletedOn", {
                              date: new Date(m.deletedAt).toLocaleString(),
                            })
                          : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onRestore(m.id)}
                        className="rounded-md border border-brand-light px-2.5 py-1 text-xs text-brand hover:bg-brand-tint"
                      >
                        {t("home.restore")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPurging({ id: m.id, title: m.title })}
                        className="rounded-md border border-neutral-200 px-2.5 py-1 text-xs text-ink-soft hover:border-red-300 hover:bg-red-50 hover:text-red-700"
                      >
                        {t("home.deleteForever")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <Link
                      href={`/meetings?id=${m.id}`}
                      className="flex min-w-0 flex-1 items-center justify-between gap-4 px-4 py-3 hover:bg-brand-tint/60"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">{m.title}</p>
                        <p className="mt-0.5 text-xs text-ink-soft/70">
                          {new Date(m.createdAt).toLocaleString()} ·{" "}
                          {formatDuration(m.durationSec)}
                        </p>
                      </div>
                      <StatusBadge status={m.status} />
                    </Link>
                    <select
                      value={m.folderId ?? ""}
                      onChange={(e) => onMoveToFolder(m.id, e.target.value || null)}
                      title={t("home.folder.move")}
                      aria-label={t("home.folder.move")}
                      className="max-w-[8rem] shrink-0 truncate rounded-md border border-transparent bg-transparent py-1 text-xs text-ink-soft/60 hover:border-brand-light hover:text-brand"
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
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Pager: only when there is more than one page. */}
        {list && list.pages > 1 && (
          <nav className="mt-4 flex items-center justify-between gap-4">
            <p className="text-xs text-ink-soft/60">
              {t("home.pageOf", { page: list.page, pages: list.pages, total: list.total })}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={list.page <= 1}
                className="rounded-md border border-brand-light px-3 py-1 text-sm text-brand hover:bg-brand-tint disabled:opacity-40"
              >
                {t("home.prev")}
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(list.pages, p + 1))}
                disabled={list.page >= list.pages}
                className="rounded-md border border-brand-light px-3 py-1 text-sm text-brand hover:bg-brand-tint disabled:opacity-40"
              >
                {t("home.next")}
              </button>
            </div>
          </nav>
        )}

        {trashView && meetings && meetings.length > 0 && (
          <div className="mt-4 text-right">
            <button
              type="button"
              onClick={() => setEmptying(true)}
              className="text-sm text-ink-soft/70 hover:text-red-700"
            >
              {t("home.emptyTrash")}
            </button>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={purging !== null}
        title={t("home.deleteForever")}
        body={t("home.purgeWarning", { title: purging?.title ?? "" })}
        confirmLabel={t("home.deleteForever")}
        danger
        onConfirm={onPurge}
        onCancel={() => setPurging(null)}
      />

      <ConfirmDialog
        open={emptying}
        title={t("home.emptyTrash")}
        body={t("home.emptyTrashWarning")}
        confirmLabel={t("home.emptyTrash")}
        danger
        onConfirm={onEmptyTrash}
        onCancel={() => setEmptying(false)}
      />

      <PromptDialog
        open={creatingFolder}
        title={t("home.folder.newTitle")}
        confirmLabel={t("home.folder.create")}
        onConfirm={onCreateFolder}
        onCancel={() => setCreatingFolder(false)}
      />

      <PromptDialog
        open={renamingFolder !== null}
        title={t("home.folder.renameTitle")}
        initialValue={renamingFolder?.name ?? ""}
        confirmLabel={t("home.folder.rename")}
        onConfirm={onRenameFolder}
        onCancel={() => setRenamingFolder(null)}
      />

      <ConfirmDialog
        open={deletingFolder !== null}
        title={t("home.folder.delete")}
        body={t("home.folder.deleteWarning", { name: deletingFolder?.name ?? "" })}
        confirmLabel={t("home.folder.delete")}
        danger
        onConfirm={onDeleteFolder}
        onCancel={() => setDeletingFolder(null)}
      />

      <footer className="mt-10 text-center text-xs text-ink-soft/50">
        {t("home.consent")}
      </footer>
    </main>
  );
}

function FolderChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs ${
        active
          ? "border-brand bg-brand text-white"
          : "border-brand-light text-brand hover:bg-brand-tint"
      }`}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className={active ? "ml-1 opacity-80" : "ml-1 text-ink-soft/50"}>{count}</span>
      )}
    </button>
  );
}
