import "./env.js"; // load repo-root .env before anything reads process.env
import Fastify from "fastify";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => {
    return { ok: true };
  });

  return app;
}

async function main() {
  const app = buildServer();
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
