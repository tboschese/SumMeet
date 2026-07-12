"use client";

// Same reason as ConfirmDialog: window.prompt() does not exist in the desktop webview,
// so Rename was as silently broken as Delete.

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

export function PromptDialog({
  open,
  title,
  initialValue = "",
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  initialValue?: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    // Select the existing text: renaming usually means replacing, not appending.
    requestAnimationFrame(() => inputRef.current?.select());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, initialValue, onCancel]);

  if (!open) return null;

  const submit = () => {
    const next = value.trim();
    if (next) onConfirm(next);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      onClick={onCancel}
      role="presentation"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="w-full max-w-sm rounded-xl border border-brand-light/60 bg-white p-5 shadow-xl"
      >
        <label className="block text-base font-semibold text-ink" htmlFor="prompt-input">
          {title}
        </label>
        <input
          id="prompt-input"
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-3 w-full rounded-md border border-brand-light px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-brand-light px-3 py-1.5 text-sm text-ink-soft hover:bg-brand-tint"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={!value.trim()}
            className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
