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
cp .env.example .env
pnpm db:migrate           # creates ./data/summeet.db
```

Then either paste a **Groq API key** on the app's Settings page (cloud engine),
or install the **free local engine** and run fully offline — see below. No key
is needed to boot.

### Environment

This build uses **Groq** for the cloud engine (no Anthropic/Claude) and
**whisper.cpp + Ollama** for the local one.

| Var | Required | What |
|---|---|---|
| `GROQ_API_KEY` | — | Groq key for the cloud engine. Optional: set it in **Settings** instead (a desktop/mobile user has no `.env`), or use the local engine. |
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

## Local / private mode (free, offline)

You can run the whole pipeline on your machine — **no API keys, no cost, nothing
leaves the laptop**. Pick the engine per stage on the **Settings** page (you can
even mix: transcribe locally, extract in the cloud).

| Stage | Cloud | Local |
|---|---|---|
| Transcription | Groq Whisper (fast) | **whisper.cpp** (Metal-accelerated) |
| Insights | Groq Llama 3.3 70B | **Ollama** (`qwen2.5:7b`) |

Setup:

```bash
brew install whisper-cpp ollama
ollama serve &            # background daemon
ollama pull qwen2.5:7b    # extraction model — measured at parity with Groq 70B

# Whisper model → ./data/models/
mkdir -p data/models && curl -L -o data/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

Then open **Settings** and switch each engine to *Local*. The page tells you
exactly what's still missing (binary, model, or the Ollama daemon), and picking
a local engine that isn't installed fails the job with a readable reason rather
than crashing. Override paths/models via the `WHISPER_*` / `OLLAMA_*` vars in
`.env` (see `.env.example`).

**Measured** on the reference sample (M2 Pro, see SPEC §13.7): local
`whisper large-v3-turbo` beats Groq on accuracy (18.6% vs 19.6% WER, ~10×
realtime), and `qwen2.5:7b` + a glossary matches Groq Llama 3.3 70B on every
metric we score — 26× slower, but free and offline. Avoid `llama3.2:3b`: it
emits no `sourceQuote` at all, and the evidence link is the product.

### Glossary — the cheap quality win

On **Settings**, fill the **Glossary** with people, product and jargon names.
It's fed to Whisper as an initial prompt (so names stop being guessed) and into
the extraction prompt (so they're spelled right). Correcting a spelling is
allowed; inventing a person is still forbidden.

### Measuring engine quality

```bash
pnpm eval:engines <audio> <ground-truth-transcript.txt>
EVAL_USE_GLOSSARY=1 pnpm eval:engines <audio> <truth.txt>   # A/B the glossary
```

Scores what actually matters (SPEC §13.7): transcription **WER** and whether
proper nouns survive; extraction **fabricated owners** (a name absent from the
transcript) and **non-verbatim quotes**. Extraction is scored on the clean
transcript so the LLM is judged independently of transcription errors.

## Troubleshooting

- **`No Groq API key configured`** — a cloud-engine job failed because no key is
  set. Add one on the **Settings** page (or in `.env`), or switch that stage to
  the local engine. The server boots fine without a key.
- **`ffmpeg exited …` / job goes `Failed`** — ffmpeg isn't installed or the file
  isn't decodable audio. `brew install ffmpeg`; the failure reason shows on the
  meeting page with a **Retry** button.
- **Recording won't start / "didn't share tab audio"** — in the Chrome picker,
  choose the **meeting tab** and tick **Share tab audio**. Use desktop Chrome/Edge.
- **Web can't reach the API** — make sure `pnpm dev` started both; the API is on
  `:8080`. Override with `NEXT_PUBLIC_API_BASE_URL` if you moved it.

## Who said what (roadmap A1)

Recordings are stored as **stereo**: left channel = the meeting tab (everyone
else), right channel = your microphone. The pipeline reads the speaker off the
channel energy, so the transcript is labelled **You** / **Others** and action
items get `owner: "You"` for what *you* committed to — with **no diarization
model, no API key and no extra call**.

Limits: it separates you from everyone else, not the other participants from each
other. File uploads (mono) carry no speaker data and stay unlabelled.

## Chrome extension (roadmap A2)

A floating **Record** button right on the Meet/Teams/Zoom page — no separate
SumMeet tab, no screen-share picker (uses `chrome.tabCapture`). It uploads to
the same local API. See [`apps/extension/README.md`](apps/extension/README.md)
to load it unpacked.

## Layout

Monorepo (pnpm workspaces):

- `packages/core` — shared Zod schemas (the Insight contract, source of truth).
- `apps/api` — Fastify API + Prisma (SQLite) + in-process worker.
- `apps/web` — Next.js (App Router) + Tailwind.
- `apps/extension` — MV3 Chrome extension (plain JS, load unpacked).
