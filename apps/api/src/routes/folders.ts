import { FolderNameSchema } from "@summeet/core";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";

// Folders group meetings by recurring context. A meeting is in zero or one folder;
// deleting a folder detaches its meetings (onDelete: SetNull) rather than deleting them
// — they belong to the user, not the folder.
export function registerFolderRoutes(app: FastifyInstance): void {
  /** List folders with a live-meeting count each, for the sidebar. */
  app.get("/api/folders", async () => {
    const folders = await db.folder.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        createdAt: true,
        _count: { select: { meetings: { where: { deletedAt: null } } } },
      },
    });
    return folders.map(({ _count, ...f }) => ({ ...f, count: _count.meetings }));
  });

  app.post<{ Body: { name?: string } }>("/api/folders", async (request, reply) => {
    const parsed = FolderNameSchema.safeParse(request.body?.name);
    if (!parsed.success) return reply.code(400).send({ error: "invalid folder name" });
    const folder = await db.folder.create({ data: { name: parsed.data } });
    return reply.code(201).send(folder);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    "/api/folders/:id",
    async (request, reply) => {
      const parsed = FolderNameSchema.safeParse(request.body?.name);
      if (!parsed.success) return reply.code(400).send({ error: "invalid folder name" });
      const folder = await db.folder.findUnique({ where: { id: request.params.id } });
      if (!folder) return reply.code(404).send({ error: "folder not found" });
      const updated = await db.folder.update({
        where: { id: folder.id },
        data: { name: parsed.data },
      });
      return updated;
    },
  );

  /** Delete a folder. Its meetings survive, unfiled (SetNull). */
  app.delete<{ Params: { id: string } }>(
    "/api/folders/:id",
    async (request, reply) => {
      const folder = await db.folder.findUnique({ where: { id: request.params.id } });
      if (!folder) return reply.code(404).send({ error: "folder not found" });
      await db.folder.delete({ where: { id: folder.id } });
      return { ok: true };
    },
  );

  /** Move a meeting into a folder, or out of one (folderId: null). */
  app.patch<{ Params: { id: string }; Body: { folderId?: string | null } }>(
    "/api/meetings/:id/folder",
    async (request, reply) => {
      const meeting = await db.meeting.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!meeting) return reply.code(404).send({ error: "meeting not found" });

      const folderId = request.body?.folderId ?? null;
      if (folderId !== null) {
        const folder = await db.folder.findUnique({ where: { id: folderId } });
        if (!folder) return reply.code(404).send({ error: "folder not found" });
      }
      await db.meeting.update({ where: { id: meeting.id }, data: { folderId } });
      return { ok: true };
    },
  );
}
