// Browser-side client for the local API. The API base is not a secret (no AI
// keys ever touch the client — SPEC §7.2); only the API calls Groq.
// Import from the schemas subpath only — never the barrel, which pulls in
// server-only modules (ffmpeg/child_process, fs storage, fetch providers).
import type {
  MeetingInsights,
  MeetingStatus,
  SettingsUpdate,
  SettingsView,
  TranscriptSegment,
} from "@summeet/core/schemas";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

export interface MeetingListItem {
  id: string;
  title: string;
  status: MeetingStatus;
  durationSec: number | null;
  createdAt: string;
  deletedAt: string | null;
  folderId: string | null;
}

/** A page of meetings, plus what the pager needs to render itself. */
export interface MeetingList {
  meetings: MeetingListItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export interface MeetingFilters {
  page?: number;
  pageSize?: number;
  /** Free-text match on the title. */
  q?: string;
  status?: MeetingStatus;
  /** The trash is its own view — deleted meetings never appear among live ones. */
  trash?: boolean;
  /** Restrict to one folder; "none" is the unfiled bucket. */
  folderId?: string;
}

export interface MeetingDetail {
  meeting: {
    id: string;
    title: string;
    status: MeetingStatus;
    durationSec: number | null;
    language: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
    notes: string;
  };
  transcript: {
    fullText: string;
    segments: TranscriptSegment[];
    provider: string;
  } | null;
  insights: { id: string; data: MeetingInsights; provider: string } | null;
  /** The user's notes expanded from the transcript; null until run. */
  enhancedNotes: EnhancedNotes | null;
  /** Every extraction kept, newest first, so the UI can roll back. */
  insightVersions: InsightVersion[];
}

export interface EnhancedNote {
  note: string;
  detail: string;
  sourceQuote: string | null;
}
export interface EnhancedNotes {
  notes: EnhancedNote[];
}

export interface InsightVersion {
  id: string;
  provider: string;
  active: boolean;
  createdAt: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export function listMeetings(filters: MeetingFilters = {}): Promise<MeetingList> {
  const params = new URLSearchParams();
  if (filters.page) params.set("page", String(filters.page));
  if (filters.pageSize) params.set("pageSize", String(filters.pageSize));
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.trash) params.set("trash", "true");
  if (filters.folderId) params.set("folderId", filters.folderId);
  const query = params.toString();
  return fetch(`${API_BASE}/api/meetings${query ? `?${query}` : ""}`, {
    cache: "no-store",
  }).then(json<MeetingList>);
}

/** Move to the trash. Recoverable — `deleteMeetingForever` is the one that isn't. */
export function trashMeeting(id: string): Promise<{ ok: true }> {
  return fetch(`${API_BASE}/api/meetings/${id}`, { method: "DELETE" }).then(
    json<{ ok: true }>,
  );
}

export function restoreMeeting(id: string): Promise<{ ok: true }> {
  return fetch(`${API_BASE}/api/meetings/${id}/restore`, { method: "POST" }).then(
    json<{ ok: true }>,
  );
}

export function deleteMeetingForever(id: string): Promise<{ ok: true }> {
  return fetch(`${API_BASE}/api/meetings/${id}?permanent=true`, {
    method: "DELETE",
  }).then(json<{ ok: true }>);
}

export function emptyTrash(): Promise<{ ok: true; purged: number }> {
  return fetch(`${API_BASE}/api/meetings/trash/empty`, { method: "POST" }).then(
    json<{ ok: true; purged: number }>,
  );
}

export function trashCount(): Promise<{ count: number }> {
  return fetch(`${API_BASE}/api/meetings/trash/count`, { cache: "no-store" }).then(
    json<{ count: number }>,
  );
}

export interface Folder {
  id: string;
  name: string;
  createdAt: string;
  /** Live meetings in it. */
  count: number;
}

export function listFolders(): Promise<Folder[]> {
  return fetch(`${API_BASE}/api/folders`, { cache: "no-store" }).then(json<Folder[]>);
}

export function createFolder(name: string): Promise<Folder> {
  return fetch(`${API_BASE}/api/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(json<Folder>);
}

export function renameFolder(id: string, name: string): Promise<Folder> {
  return fetch(`${API_BASE}/api/folders/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(json<Folder>);
}

export function deleteFolder(id: string): Promise<{ ok: true }> {
  return fetch(`${API_BASE}/api/folders/${id}`, { method: "DELETE" }).then(
    json<{ ok: true }>,
  );
}

/** Move into a folder, or out of one with folderId: null. */
export function moveMeetingToFolder(
  id: string,
  folderId: string | null,
): Promise<{ ok: true }> {
  return fetch(`${API_BASE}/api/meetings/${id}/folder`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folderId }),
  }).then(json<{ ok: true }>);
}

export function getMeeting(id: string): Promise<MeetingDetail> {
  return fetch(`${API_BASE}/api/meetings/${id}`, { cache: "no-store" }).then(
    json<MeetingDetail>,
  );
}

type CreateResult = { id: string; status: MeetingStatus };

/**
 * `channelLayout` tells the server this audio really is left=others / right=you.
 * Only pass it for recordings our recorder made — never for user file uploads.
 */
export function createMeeting(
  audio: Blob,
  title?: string,
  filename = "recording.webm",
  channelLayout?: string,
): Promise<CreateResult> {
  const form = new FormData();
  form.append("audio", audio, filename);
  if (title) form.append("title", title);
  if (channelLayout) form.append("channelLayout", channelLayout);
  return fetch(`${API_BASE}/api/meetings`, { method: "POST", body: form }).then(
    json<CreateResult>,
  );
}

export function retryMeeting(id: string): Promise<CreateResult> {
  return fetch(`${API_BASE}/api/meetings/${id}/retry`, { method: "POST" }).then(
    json<CreateResult>,
  );
}

export interface AskResult {
  answer: string;
  meetings: number;
  provider?: string;
}

/** Ask a natural-language question of your meetings; the API retrieves + the LLM answers. */
export function askMeetings(question: string): Promise<AskResult> {
  return fetch(`${API_BASE}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  }).then(json<AskResult>);
}

export function enhanceNotes(id: string): Promise<{ ok: true; enhancedNotes: EnhancedNotes }> {
  return fetch(`${API_BASE}/api/meetings/${id}/enhance-notes`, { method: "POST" }).then(
    json<{ ok: true; enhancedNotes: EnhancedNotes }>,
  );
}

export function saveMeetingNotes(id: string, notes: string): Promise<{ ok: true }> {
  return fetch(`${API_BASE}/api/meetings/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notes }),
  }).then(json<{ ok: true }>);
}

export function renameMeeting(id: string, title: string): Promise<{ ok: true }> {
  return fetch(`${API_BASE}/api/meetings/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  }).then(json<{ ok: true }>);
}

export function activateInsightVersion(
  meetingId: string,
  versionId: string,
): Promise<{ ok: true }> {
  return fetch(
    `${API_BASE}/api/meetings/${meetingId}/insights/${versionId}/activate`,
    { method: "POST" },
  ).then(json<{ ok: true }>);
}

export function reextractMeeting(id: string): Promise<{ ok: true }> {
  return fetch(`${API_BASE}/api/meetings/${id}/reextract`, {
    method: "POST",
  }).then(json<{ ok: true }>);
}

/** Queue extraction for every meeting resting at TRANSCRIBED. */
export function extractPending(): Promise<{ queued: number }> {
  return fetch(`${API_BASE}/api/meetings/extract-pending`, {
    method: "POST",
  }).then(json<{ queued: number }>);
}

// ── Settings (stored server-side, so every client inherits them) ─────────────
// The API never returns the API key, only whether one is configured.
export function getSettings(): Promise<SettingsView> {
  return fetch(`${API_BASE}/api/settings`, { cache: "no-store" }).then(
    json<SettingsView>,
  );
}

export function saveSettings(settings: SettingsUpdate): Promise<SettingsView> {
  return fetch(`${API_BASE}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  }).then(json<SettingsView>);
}

/** Strip the read-only flag before sending an update back. */
export function toUpdate(v: SettingsView): SettingsUpdate {
  const { hasGroqApiKey: _ignored, ...rest } = v;
  return rest;
}

export interface LocalStatus {
  whisper: {
    ready: boolean;
    binaryFound: boolean;
    modelFound: boolean;
    binary: string;
    modelPath: string;
  };
  ollama: {
    ready: boolean;
    serverUp: boolean;
    modelPulled: boolean;
    model: string;
    baseUrl: string;
    availableModels: string[];
  };
}

/** Whether the free/offline engines are installed and reachable. */
export function getLocalStatus(): Promise<LocalStatus> {
  return fetch(`${API_BASE}/api/settings/local-status`, {
    cache: "no-store",
  }).then(json<LocalStatus>);
}

export const PROCESSING_STATUSES: MeetingStatus[] = [
  "UPLOADED",
  "TRANSCRIBING",
  "EXTRACTING",
];

export function isProcessing(status: MeetingStatus): boolean {
  return PROCESSING_STATUSES.includes(status);
}
