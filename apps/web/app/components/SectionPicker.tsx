"use client";

// Locked-down summary composer (SPEC A5): tick the sections you want and drag
// them into order. No free text, so the Insight contract can't be prompted out
// of shape.
//
// Drag-and-drop uses the native HTML5 API — no dnd library. It doesn't work with
// a keyboard or on touch, so the ↑↓ buttons stay as the accessible path rather
// than decoration.

import { useCallback, useState } from "react";
import { SECTIONS, type SectionKey } from "@summeet/core/sections";
import { useT } from "@/lib/i18n";

export function SectionPicker({
  selected,
  onChange,
}: {
  selected: SectionKey[];
  onChange: (next: SectionKey[]) => void;
}) {
  const t = useT();
  const unselected = SECTIONS.filter((s) => !selected.includes(s.key));

  // `draggable` is only enabled while the grip is held, so text stays selectable
  // and the ↑↓ / ✕ buttons still take clicks.
  const [gripHeld, setGripHeld] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const reorder = useCallback(
    (from: number, to: number) => {
      if (from === to || to < 0 || to >= selected.length) return;
      const next = [...selected];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      onChange(next);
    },
    [selected, onChange],
  );

  const endDrag = useCallback(() => {
    setDragIndex(null);
    setOverIndex(null);
    setGripHeld(false);
  }, []);

  return (
    <div className="space-y-3">
      <ol className="space-y-2" onDragLeave={() => setOverIndex(null)}>
        {selected.map((key, i) => {
          const spec = SECTIONS.find((s) => s.key === key)!;
          const isDragging = dragIndex === i;
          const isTarget = overIndex === i && dragIndex !== null && dragIndex !== i;

          return (
            <li
              key={key}
              draggable={gripHeld}
              onDragStart={(e) => {
                setDragIndex(i);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", key); // Firefox needs a payload
              }}
              onDragOver={(e) => {
                e.preventDefault(); // required to allow a drop
                e.dataTransfer.dropEffect = "move";
                setOverIndex(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) reorder(dragIndex, i);
                endDrag();
              }}
              onDragEnd={endDrag}
              className={`flex select-none items-start gap-2 rounded-md border bg-brand-tint/40 p-2.5 transition-all ${
                isDragging ? "opacity-40" : ""
              } ${
                isTarget
                  ? "border-brand ring-2 ring-brand/30"
                  : "border-brand-light"
              }`}
            >
              <span
                onMouseDown={() => setGripHeld(true)}
                onMouseUp={() => setGripHeld(false)}
                title={t("settings.sections.dragTitle")}
                className="mt-0.5 cursor-grab px-0.5 text-sm leading-none text-brand/50 hover:text-brand active:cursor-grabbing"
              >
                ⠿
              </span>
              <span className="mt-0.5 w-4 text-center text-xs font-semibold text-brand">
                {i + 1}
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">
                  {t(`section.${spec.key}`)}
                  {spec.derivedFrom && (
                    <span className="ml-2 rounded bg-white px-1.5 py-0.5 text-[10px] font-normal text-brand">
                      {t("settings.sections.derived")}
                    </span>
                  )}
                </p>
                <p className="text-xs text-ink-soft/70">{t(`section.hint.${spec.key}`)}</p>
              </div>

              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => reorder(i, i - 1)}
                  disabled={i === 0}
                  title={t("settings.sections.moveUp")}
                  className="rounded px-1 py-0.5 text-xs text-brand hover:bg-white disabled:opacity-25"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => reorder(i, i + 1)}
                  disabled={i === selected.length - 1}
                  title={t("settings.sections.moveDown")}
                  className="rounded px-1 py-0.5 text-xs text-brand hover:bg-white disabled:opacity-25"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => onChange(selected.filter((k) => k !== key))}
                  disabled={selected.length === 1}
                  title={selected.length === 1 ? t("settings.sections.keepOne") : t("settings.sections.remove")}
                  className="rounded px-1.5 py-0.5 text-sm text-ink-soft/50 hover:text-red-600 disabled:opacity-25"
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      {unselected.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-soft/70">{t("settings.sections.add")}</p>
          <div className="flex flex-wrap gap-1.5">
            {unselected.map((spec) => (
              <button
                key={spec.key}
                type="button"
                onClick={() => onChange([...selected, spec.key])}
                title={t(`section.hint.${spec.key}`)}
                className="rounded-md border border-brand-light px-2.5 py-1 text-xs text-brand hover:bg-brand-tint"
              >
                + {t(`section.${spec.key}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-ink-soft/50">{t("settings.sections.dragHint")}</p>
    </div>
  );
}
