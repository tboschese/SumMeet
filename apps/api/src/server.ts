import "./env.js"; // load repo-root .env before anything reads process.env
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { buildContext } from "./context.js";
import { registerMeetingRoutes } from "./routes/meetings.js";
import { startWorker } from "./worker.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

// 500 MB ceiling for uploads — a long meeting recording, comfortably.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });

  app.get("/health", async () => ({ ok: true }));

  const ctx = buildContext();
  const queue = await startWorker(ctx, app.log);
  registerMeetingRoutes(app, ctx, queue);

  return app;
}

async function main() {
  let app;
  try {
    app = await buildServer();
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    if (app) app.log.error(err);
    else console.error(err);
    process.exit(1);
  }
}

main();
