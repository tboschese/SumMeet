import { BUILTIN_TEMPLATES, SectionSchema, TemplateNameSchema } from "@summeet/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";

// Named section presets per meeting type. Built-ins are seeded on
// first read and can't be deleted; the user can add their own and pick which is the
// default (applied to new recordings).

const SectionsSchema = z.array(SectionSchema).min(1);

/** Seed the built-ins the first time, marking the first one default. Idempotent. */
async function ensureSeeded(): Promise<void> {
  if ((await db.template.count()) > 0) return;
  await db.$transaction(
    BUILTIN_TEMPLATES.map((t, i) =>
      db.template.create({
        data: {
          name: t.name,
          sections: JSON.stringify(t.sections),
          builtin: true,
          isDefault: i === 0,
        },
      }),
    ),
  );
}

function shape(t: {
  id: string;
  name: string;
  sections: string;
  isDefault: boolean;
  builtin: boolean;
}) {
  let sections: unknown = [];
  try {
    sections = SectionsSchema.parse(JSON.parse(t.sections));
  } catch {
    sections = [];
  }
  return { id: t.id, name: t.name, sections, isDefault: t.isDefault, builtin: t.builtin };
}

export function registerTemplateRoutes(app: FastifyInstance): void {
  app.get("/api/templates", async () => {
    await ensureSeeded();
    const templates = await db.template.findMany({ orderBy: [{ builtin: "desc" }, { name: "asc" }] });
    return { templates: templates.map(shape) };
  });

  app.post<{ Body: { name?: string; sections?: unknown } }>(
    "/api/templates",
    async (request, reply) => {
      const name = TemplateNameSchema.safeParse(request.body?.name);
      const sections = SectionsSchema.safeParse(request.body?.sections);
      if (!name.success) return reply.code(400).send({ error: "invalid template name" });
      if (!sections.success) return reply.code(400).send({ error: "pick at least one section" });
      const created = await db.template.create({
        data: { name: name.data, sections: JSON.stringify(sections.data) },
      });
      return reply.code(201).send(shape(created));
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; sections?: unknown } }>(
    "/api/templates/:id",
    async (request, reply) => {
      const existing = await db.template.findUnique({ where: { id: request.params.id } });
      if (!existing) return reply.code(404).send({ error: "template not found" });

      const data: { name?: string; sections?: string } = {};
      if (request.body?.name !== undefined) {
        const name = TemplateNameSchema.safeParse(request.body.name);
        if (!name.success) return reply.code(400).send({ error: "invalid template name" });
        data.name = name.data;
      }
      if (request.body?.sections !== undefined) {
        const sections = SectionsSchema.safeParse(request.body.sections);
        if (!sections.success) return reply.code(400).send({ error: "pick at least one section" });
        data.sections = JSON.stringify(sections.data);
      }
      const updated = await db.template.update({ where: { id: existing.id }, data });
      return shape(updated);
    },
  );

  /** Make a template the default. Exactly one is default at a time. */
  app.post<{ Params: { id: string } }>("/api/templates/:id/default", async (request, reply) => {
    const t = await db.template.findUnique({ where: { id: request.params.id } });
    if (!t) return reply.code(404).send({ error: "template not found" });
    await db.$transaction([
      db.template.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
      db.template.update({ where: { id: t.id }, data: { isDefault: true } }),
    ]);
    return { ok: true };
  });

  /** Delete a user template. Built-ins stay; if the default goes, the first built-in
   * becomes default so there's always exactly one. */
  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    const t = await db.template.findUnique({ where: { id: request.params.id } });
    if (!t) return reply.code(404).send({ error: "template not found" });
    if (t.builtin) return reply.code(400).send({ error: "built-in templates can't be deleted" });
    await db.template.delete({ where: { id: t.id } });
    if (t.isDefault) {
      const fallback = await db.template.findFirst({ orderBy: { builtin: "desc" } });
      if (fallback) {
        await db.template.update({ where: { id: fallback.id }, data: { isDefault: true } });
      }
    }
    return { ok: true };
  });
}

/** The sections of the default template, for new meetings. Empty if none set up yet. */
export async function defaultTemplateSections(): Promise<string[]> {
  await ensureSeeded();
  const def = await db.template.findFirst({ where: { isDefault: true } });
  if (!def) return [];
  try {
    return SectionsSchema.parse(JSON.parse(def.sections));
  } catch {
    return [];
  }
}
