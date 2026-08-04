"use client";

// A small dropdown of the user's templates. Used on the meeting detail page to
// re-run the summary with a different recipe, and on the record bar to pick the
// shape before recording. Loads templates lazily on first open.

import { useCallback, useEffect, useRef, useState } from "react";
import { listTemplates, type Template } from "@/lib/api";

export function TemplateMenu({
  label,
  title,
  className,
  disabled,
  onPick,
}: {
  label: string;
  title?: string;
  className?: string;
  disabled?: boolean;
  onPick: (template: Template) => void;
}) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && templates === null) {
      listTemplates()
        .then((r) => setTemplates(r.templates))
        .catch(() => setTemplates([]));
    }
  }, [open, templates]);

  // Click-away and Escape close the menu.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = useCallback(
    (tpl: Template) => {
      setOpen(false);
      onPick(tpl);
    },
    [onPick],
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={className}
      >
        {label} <span className="ml-0.5 text-[10px] opacity-70">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-72 w-52 overflow-auto rounded-lg border border-brand-light bg-white py-1 shadow-lg">
          {templates === null ? (
            <div className="px-3 py-2 text-xs text-ink-soft/60">…</div>
          ) : (
            templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => pick(tpl)}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm text-ink hover:bg-brand-tint"
              >
                {tpl.isDefault && <span className="text-brand">★</span>}
                <span className="truncate">{tpl.name}</span>
                <span className="ml-auto shrink-0 text-[10px] text-ink-soft/50">
                  {tpl.sections.length}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
