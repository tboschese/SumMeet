# CLAUDE.md — SumMeet

Operating manual for Claude Code in this repo. **Read this first, every session.** Full detail lives in `SPEC.md`; this file is the always-on summary + guardrails. When the two disagree, `SPEC.md` wins — flag the conflict.

## What this is

SumMeet turns a meeting recording into a **decision record**: TL;DR, executive summary, key points, action items, decisions, topics. Meetings are captured **in the browser** (Google Meet / Teams-web / Zoom-web), transcribed, then passed through an LLM that emits a **Zod-validated** Insight object. The extraction *is* the product — not the transcript. See `SPEC.md` §1–3.

## Stack (local-first, no cloud)

| Layer | Choice | Where |
|---|---|---|
| web | Next.js (App Router) + Tailwind | `localhost:3000` |
| api | Fastify + TS, **in-process worker** | `localhost:8080` |
| db | **SQLite** via Prisma | `./data/summeet.db` |
| storage | **local disk**, behind `StorageProvider` | `./data/audio/` |
| transcription | Groq `whisper-large-v3-turbo`, behind `TranscriptionProvider` | external API |
| extraction | Claude (Anthropic), behind an interface | external API |
| audio | ffmpeg (local CLI) | — |
| shared | Zod schemas, source of truth | `packages/core` |

Monorepo: pnpm workspaces — `packages/core`, `apps/api`, `apps/web`.

## Hard rules — do not violate

1. **Local-first. No external server.** Never add Cloudflare R2, hosted/remote Postgres, Neon, Redis, pg-boss, Docker, or deploy config. Storage = local disk, DB = SQLite, queue = in-process. If a task seems to need cloud infra, **stop and flag it** — don't add it.
2. **AI keys are server-side only.** The browser records and uploads to the local API; the **API** calls Groq/Anthropic. Never call an AI API from the browser or expose a key in client / Next public env.
3. **SQLite constraints (Prisma):** no `enum` (use `String` + the `MeetingStatus` Zod enum), no `Json` type and no `@db.Text` (store JSON as a TEXT `String`, `JSON.parse` + Zod-validate on read via helpers). Datasource provider is `sqlite`.
4. **The Insight contract is sacred.** All LLM output is parsed and validated against `MeetingInsightsSchema` with **one repair-retry**. Never persist unvalidated model JSON. Ground items in `sourceQuote`; `owner` / `dueDate` are nullable — **never fabricate them**.
5. **Capture correctness.** Record **tab audio + microphone, mixed**. Shipping capture without the mic loses the user's own voice — the #1 bug. Detect an empty tab-audio track ("forgot to share tab audio") and prompt the user. Drop the display video track. Use `MediaRecorder` with a timeslice.
6. **Keep the provider seams.** `StorageProvider`, `TranscriptionProvider`, and the LLM-behind-an-interface are what make local→cloud/private a one-file swap. Don't hardcode Groq or local-disk deep inside the pipeline.
7. **Fail soft in the worker.** A pipeline error sets the meeting `status = "FAILED"` with a human-readable `error`; it never crashes the worker or the process. Log and continue.

## Scope discipline

- Build **only the current session's scope** (see `SPEC.md` §11). Don't build ahead.
- **MVP non-goals — do NOT build now** (they're in `SPEC.md` Appendix A): speaker diarization, Chrome extension, native macOS / desktop-app capture, Slack / Notion / email integrations, streaming / real-time transcription, multiple transcription modes, auth, billing. If asked to touch any of these, say it's post-MVP and confirm before proceeding.

## Conventions

- TypeScript **strict** everywhere. Zod is the single source of truth for shapes (`packages/core/src/schemas.ts`), shared by web and api.
- Status flow: `UPLOADED → TRANSCRIBING → EXTRACTING → COMPLETED` (or `FAILED`).
- **Prove each layer in isolation** (a CLI or test) before wiring it into the pipeline.
- Small, focused commits per logical step. Prefer editing existing files over adding new ones; keep files single-purpose.
- No secrets in code or commits. `.env` and `./data/` are git-ignored.

## Commands (the repo should expose these root scripts)

- `pnpm dev` — run web + api concurrently
- `pnpm db:migrate` — Prisma migrate (dev)
- `pnpm db:studio` — inspect the SQLite DB
- `pnpm typecheck` / `pnpm lint`
- `pnpm transcribe <audio>` / `pnpm extract <transcript>` — isolated-session CLIs (added as they're built)

## How we work

Sessions 0–6 in `SPEC.md` §11, one at a time. Each has an isolated, testable **"done when."** End every session by running its acceptance check and reporting what changed — and stop there, don't roll into the next session.
