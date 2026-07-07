# SumMeet

Turn a meeting recording into a **decision record** — TL;DR, executive summary,
key points, action items, decisions, and topics — extracted from browser-captured
meeting audio. Runs fully on your machine: local disk for recordings, SQLite for
data, an in-process worker. The only thing that leaves your machine is the audio
sent to the transcription/extraction APIs.

See [`SPEC.md`](./SPEC.md) for the full product & engineering spec and
[`CLAUDE.md`](./CLAUDE.md) for the build guardrails.

## Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 9 (`corepack enable pnpm`)
- **ffmpeg** on your `PATH` (`brew install ffmpeg`)

## Setup

```bash
pnpm install
cp .env.example .env      # then paste your GROQ_API_KEY
pnpm db:migrate           # creates ./data/summeet.db
```

### Environment

One key does everything — this build uses **Groq for both transcription and
extraction** (no Anthropic/Claude):

| Var | Required | What |
|---|---|---|
| `GROQ_API_KEY` | ✅ | Groq key — Whisper transcription **and** Llama extraction |
| `DATABASE_URL` | ✅ | SQLite path. Prisma resolves it relative to `apps/api/prisma/`, so the default `file:../../../data/summeet.db` lands at repo-root `./data/`. |
| `DATA_DIR` | — | Where audio is stored (default `./data`) |
| `NEXT_PUBLIC_API_BASE_URL` | — | API base for the web app (default `http://localhost:8080`) |
| `MAX_TRANSCRIBE_BYTES` / `CHUNK_WINDOW_SEC` / `CHUNK_OVERLAP_SEC` | — | Audio chunking tuning |

## Run

```bash
pnpm dev                  # web on :3000, api on :8080
```

- Web app: http://localhost:3000 — meeting list.
- API health: http://localhost:8080/health → `{ "ok": true }`.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Run web + api together |
| `pnpm db:migrate` | Prisma migrate (dev) |
| `pnpm db:studio` | Inspect the SQLite DB |
| `pnpm typecheck` | Typecheck all packages |
| `pnpm transcribe <audio>` | Transcribe an audio file via Groq Whisper (prints text + segments) |
| `pnpm extract <transcript.txt>` | Extract validated insights from a transcript via Groq Llama |

## Testing capture (isolated recorder)

The in-browser recorder (tab audio + mic, mixed) has a standalone harness at
**http://localhost:3000/record-test** — no upload, no API. To verify capture:

1. Open a Google Meet / Teams-web / Zoom-web call in another Chrome tab.
2. On `/record-test`, click **Record**, pick the meeting tab, and tick
   **“Share tab audio”** (if you forget, you'll be prompted — it's the #1 miss).
3. Talk, let others talk, click **Stop**, then play back / download the `.webm`.
4. You should hear **both** the other participants *and* your own voice. Try a
   long run (30+ min, tab backgrounded) to confirm nothing drops.

> Requires desktop Chrome or Edge. Tab-audio capture is cross-platform; whole
> system/screen audio is not (why desktop apps are out of MVP scope — use the
> web clients).

## Troubleshooting

- **`GROQ_API_KEY is not set`** — the server exits on boot without it. Paste a
  real key into `.env` (not the `...` placeholder).
- **`ffmpeg exited …` / job goes `Failed`** — ffmpeg isn't installed or the file
  isn't decodable audio. `brew install ffmpeg`; the failure reason shows on the
  meeting page with a **Retry** button.
- **Recording won't start / "didn't share tab audio"** — in the Chrome picker,
  choose the **meeting tab** and tick **Share tab audio**. Use desktop Chrome/Edge.
- **Web can't reach the API** — make sure `pnpm dev` started both; the API is on
  `:8080`. Override with `NEXT_PUBLIC_API_BASE_URL` if you moved it.

## Layout

Monorepo (pnpm workspaces):

- `packages/core` — shared Zod schemas (the Insight contract, source of truth).
- `apps/api` — Fastify API + Prisma (SQLite) + in-process worker.
- `apps/web` — Next.js (App Router) + Tailwind.
