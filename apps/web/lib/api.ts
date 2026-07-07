// Browser-side client for the local API. The API base is not a secret (no AI
// keys ever touch the client — SPEC §7.2); only the API calls Groq.
// Import from the schemas subpath only — never the barrel, which pulls in
// server-only modules (ffmpeg/child_process, fs storage, fetch providers).
import type {
  MeetingInsights,
  MeetingStatus,
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
  };
  transcript: {
    fullText: string;
    segments: TranscriptSegment[];
    provider: string;
  } | null;
  insights: { data: MeetingInsights; provider: string } | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export function listMeetings(): Promise<MeetingListItem[]> {
  return fetch(`${API_BASE}/api/meetings`, { cache: "no-store" }).then(
    json<MeetingListItem[]>,
  );
}

export function getMeeting(id: string): Promise<MeetingDetail> {
  return fetch(`${API_BASE}/api/meetings/${id}`, { cache: "no-store" }).then(
    json<MeetingDetail>,
  );
}

type CreateResult = { id: string; status: MeetingStatus };

export function createMeeting(
  audio: Blob,
  title?: string,
  filename = "recording.webm",
): Promise<CreateResult> {
  const form = new FormData();
  form.append("audio", audio, filename);
  if (title) form.append("title", title);
  return fetch(`${API_BASE}/api/meetings`, { method: "POST", body: form }).then(
    json<CreateResult>,
  );
}

export function retryMeeting(id: string): Promise<CreateResult> {
  return fetch(`${API_BASE}/api/meetings/${id}/retry`, { method: "POST" }).then(
    json<CreateResult>,
  );
}

export function deleteMeeting(id: string): Promise<{ ok: true }> {
  return fetch(`${API_BASE}/api/meetings/${id}`, { method: "DELETE" }).then(
    json<{ ok: true }>,
  );
}

export const PROCESSING_STATUSES: MeetingStatus[] = [
  "UPLOADED",
  "TRANSCRIBING",
  "EXTRACTING",
];

export function isProcessing(status: MeetingStatus): boolean {
  return PROCESSING_STATUSES.includes(status);
}
