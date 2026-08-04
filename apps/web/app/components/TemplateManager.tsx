"use client";

// Templates manager (Settings): named recipes of summary sections, per meeting
// type. Built-ins are read-only presets; the user duplicates one
// to make their own, edits its sections with the same SectionPicker, and picks
// which template is the default applied to new recordings.

import { useCallback, useEffect, useState } from "react";
import type { SectionKey } from "@summeet/core/sections";
import { DEFAULT_SECTIONS } from "@summeet/core/sections";
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  setDefaultTemplate,
  updateTemplate,
  type Template,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { SectionPicker } from "./SectionPicker";
import { ConfirmDialog } from "./ConfirmDialog";

export function TemplateManager() {
  const t = useT();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { templates } = await listTemplates();
    setTemplates(templates);
    setSelectedId((cur) =>
      cur && templates.some((x) => x.id === cur)
        ? cur
        : (templates.find((x) => x.isDefault) ?? templates[0])?.id ?? null,
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = templates.find((x) => x.id === selectedId) ?? null;

  // Debounced save of a custom template's sections while the user edits them.
  const onEditSections = useCallback(
    async (id: string, sections: SectionKey[]) => {
      setTemplates((cur) => cur.map((x) => (x.id === id ? { ...x, sections } : x)));
      await updateTemplate(id, { sections }).catch(() => {});
    },
    [],
  );

  const onRename = useCallback(async (id: string, name: string) => {
    setTemplates((cur) => cur.map((x) => (x.id === id ? { ...x, name } : x)));
    if (name.trim()) await updateTemplate(id, { name: name.trim() }).catch(() => {});
  }, []);

  const onSetDefault = useCallback(
    async (id: string) => {
      await setDefaultTemplate(id);
      await load();
    },
    [load],
  );

  const onNew = useCallback(async () => {
    const created = await createTemplate(t("settings.templates.newName"), DEFAULT_SECTIONS);
    await load();
    setSelectedId(created.id);
  }, [load, t]);

  const onDuplicate = useCallback(
    async (src: Template) => {
      const created = await createTemplate(
        `${src.name} ${t("settings.templates.copySuffix")}`,
        src.sections,
      );
      await load();
      setSelectedId(created.id);
    },
    [load, t],
  );

  const onDelete = useCallback(
    async (id: string) => {
      setConfirmDeleteId(null);
      await deleteTemplate(id).catch(() => {});
      await load();
    },
    [load],
  );

  return (
    <div className="space-y-4">
      {/* Template chips: click to view/edit; ★ marks the default. */}
      <div className="flex flex-wrap gap-1.5">
        {templates.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            onClick={() => setSelectedId(tpl.id)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              selectedId === tpl.id
                ? "border-brand bg-brand text-white"
                : "border-brand-light text-brand hover:bg-brand-tint"
            }`}
          >
            {tpl.isDefault && <span className="mr-1">★</span>}
            {tpl.name}
          </button>
        ))}
        <button
          type="button"
          onClick={onNew}
          className="rounded-full border border-dashed border-brand-light px-3 py-1 text-xs text-brand hover:bg-brand-tint"
        >
          + {t("settings.templates.new")}
        </button>
      </div>

      {selected && (
        <div className="space-y-3 rounded-lg border border-brand-light/60 bg-brand-tint/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {selected.builtin ? (
                <span className="truncate text-sm font-semibold text-ink">{selected.name}</span>
              ) : (
                <input
                  value={selected.name}
                  onChange={(e) => onRename(selected.id, e.target.value)}
                  aria-label={t("settings.templates.nameLabel")}
                  className="min-w-0 flex-1 rounded-md border border-brand-light bg-white px-2.5 py-1 text-sm font-semibold text-ink focus:border-brand focus:outline-none"
                />
              )}
              {selected.builtin && (
                <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-brand">
                  {t("settings.templates.builtin")}
                </span>
              )}
              {selected.isDefault && (
                <span className="rounded bg-brand px-1.5 py-0.5 text-[10px] text-white">
                  ★ {t("settings.templates.default")}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {!selected.isDefault && (
                <button
                  type="button"
                  onClick={() => onSetDefault(selected.id)}
                  className="rounded-md border border-brand-light px-2.5 py-1 text-xs text-brand hover:bg-white"
                >
                  {t("settings.templates.setDefault")}
                </button>
              )}
              {selected.builtin ? (
                <button
                  type="button"
                  onClick={() => onDuplicate(selected)}
                  className="rounded-md border border-brand-light px-2.5 py-1 text-xs text-brand hover:bg-white"
                >
                  {t("settings.templates.duplicate")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(selected.id)}
                  className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-ink-soft/70 hover:border-red-300 hover:bg-red-50 hover:text-red-700"
                >
                  {t("settings.templates.delete")}
                </button>
              )}
            </div>
          </div>

          {selected.builtin ? (
            <BuiltinSections sections={selected.sections} />
          ) : (
            <SectionPicker
              selected={selected.sections}
              onChange={(next) => onEditSections(selected.id, next)}
            />
          )}
          {selected.builtin && (
            <p className="text-xs text-ink-soft/50">{t("settings.templates.builtinNote")}</p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title={t("settings.templates.delete")}
        body={t("settings.templates.deleteConfirm")}
        confirmLabel={t("settings.templates.delete")}
        danger
        onConfirm={() => confirmDeleteId && onDelete(confirmDeleteId)}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}

/** Read-only view of a built-in's sections (no editing — duplicate to change). */
function BuiltinSections({ sections }: { sections: SectionKey[] }) {
  const t = useT();
  return (
    <ol className="flex flex-wrap gap-1.5">
      {sections.map((key, i) => (
        <li
          key={key}
          className="rounded-md border border-brand-light bg-white px-2.5 py-1 text-xs text-ink"
        >
          <span className="mr-1 font-semibold text-brand">{i + 1}</span>
          {t(`section.${key}`)}
        </li>
      ))}
    </ol>
  );
}
