import type { MeetingStatus } from "@summeet/core/schemas";

const MAP: Record<MeetingStatus, { label: string; className: string }> = {
  UPLOADED: { label: "Queued", className: "bg-neutral-100 text-neutral-600" },
  TRANSCRIBING: { label: "Transcribing", className: "bg-brand-tint text-brand" },
  EXTRACTING: { label: "Extracting", className: "bg-brand-tint text-brand" },
  COMPLETED: { label: "Ready", className: "bg-green-50 text-green-700" },
  FAILED: { label: "Failed", className: "bg-red-50 text-red-700" },
};

export function StatusBadge({ status }: { status: MeetingStatus }) {
  const { label, className } = MAP[status];
  const processing = status !== "COMPLETED" && status !== "FAILED";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      {processing && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {label}
    </span>
  );
}
