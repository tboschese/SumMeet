import "./env.js"; // load repo-root .env before anything reads process.env
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { MAX_UPLOAD_BYTES } from "@summeet/core";
import Fastify from "fastify";
import { buildContext } from "./context.js";
import { registerMeetingRoutes } from "./routes/meetings.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { startWorker } from "./worker.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

export async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  // Basic rate limit: plenty for a single local user, a backstop against loops.
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES },
    throwFileSizeLimit: false, // truncate + flag instead of throwing → we return 413
  });

  app.get("/health", async () => ({ ok: true }));

  const ctx = buildContext();
  const queue = await startWorker(ctx, app.log);
  registerMeetingRoutes(app, ctx, queue);
  registerSettingsRoutes(app);

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
