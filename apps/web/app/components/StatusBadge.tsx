"use client";

import type { MeetingStatus } from "@summeet/core/schemas";
import { useT } from "@/lib/i18n";

const CLASSES: Record<MeetingStatus, string> = {
  UPLOADED: "bg-neutral-100 text-neutral-600",
  TRANSCRIBING: "bg-brand-tint text-brand",
  // A resting state: transcript ready, insights not requested yet.
  TRANSCRIBED: "bg-amber-50 text-amber-700",
  EXTRACTING: "bg-brand-tint text-brand",
  COMPLETED: "bg-green-50 text-green-700",
  FAILED: "bg-red-50 text-red-700",
};

const SETTLED: MeetingStatus[] = ["TRANSCRIBED", "COMPLETED", "FAILED"];

export function StatusBadge({ status }: { status: MeetingStatus }) {
  const t = useT();
  const processing = !SETTLED.includes(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${CLASSES[status]}`}
    >
      {processing && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {t(`status.${status}`)}
    </span>
  );
}
