"use client";

// An in-app confirmation, because window.confirm() does not exist in the desktop
// webview: it returns false and the action silently never happens — which is exactly
// how Delete came to look broken. Nothing destructive may depend on a browser dialog.

import { useEffect, useRef } from "react";
import { useT } from "@/lib/i18n";

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Escape cancels, and the confirm button takes focus — a dialog you can't dismiss
  // with the keyboard is a trap.
  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-brand-light/60 bg-white p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {body && <p className="mt-2 text-sm text-ink-soft/80">{body}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-brand-light px-3 py-1.5 text-sm text-ink-soft hover:bg-brand-tint"
          >
            {t("common.cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-white ${
              danger ? "bg-red-600 hover:bg-red-700" : "bg-brand hover:bg-brand-dark"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
