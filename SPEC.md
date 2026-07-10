# SumMeet — Product & Engineering Spec

> **How to use this doc.** This is the build spec for the **MVP**. It's written to be fed to Claude Code and built session-by-session (see §11). The MVP captures meetings **in the browser** (Meet, plus the web clients of Teams/Zoom) — no file to hunt for, no native macOS app, no BlackHole. It runs **fully on your machine**: recordings saved as files on disk, SQLite for data, an in-process worker — **no external server, no cloud infra** (the only thing leaving your machine is the audio sent to the Groq/Anthropic APIs). Cloud storage, hosted DB, native desktop capture, and integrations are real but deliberately **out of scope for the MVP** — they live in Appendix A, and the code is structured (provider interfaces) so they're one-file swaps later. Read §3 first: the scoping decision is the most important thing here.

---

## 1. Product overview

**One-liner.** SumMeet turns a meeting recording into a decision record: what was decided, who owes what, and the parts worth remembering — without you replaying the call or taking notes live.

**Problem.** Meetings produce commitments and decisions that immediately evaporate. Existing tools either give you a wall of raw transcript (Otter, most Whisper wrappers) or lock the value behind hardware and heavy setup (Plaud, native meeting bots). The output is transcript-shaped, not decision-shaped.

**Wedge.** Compete on two axes the incumbents are weak on: **simplicity** (no bot to admit into the call, minimal setup) and **cost** (cheap, fast transcription + a controllable local/private path later). The product is not "transcription with a summary bolted on" — the extraction *is* the product.

**What SumMeet is:** a decision tool, an organizational memory, a meeting copilot.
**What it is not:** a transcription service. If a user's takeaway is "nice transcript," we've failed.

---

## 2. Users & jobs

**ICP (in priority order):** PMs, engineers/tech leads, executives, and independent consultants/freelancers — people who sit in decision-heavy meetings and are accountable for follow-through.

**Primary job-to-be-done:**
> "When a meeting ends, help me capture what was decided and what I committed to, so I don't have to replay the call or trust my memory."

**Supporting jobs:**
- Recall a decision from a past meeting weeks later ("what did we agree about X?").
- Hand a teammate who missed the call a 60-second catch-up.
- Turn my own commitments into a to-do list without transcribing them by hand.

---

## 3. Scope

### 3.1 MVP — the thin vertical slice

**One flow, end to end: record a meeting in the browser → get structured insights in the web app.**

The audio comes from a **browser tab recorder**, not a file upload — because nobody has meeting audio files lying around, and capture *is* the product's on-ramp. This works cross-platform (Mac/Windows) for any meeting that lives in a Chrome tab: **Google Meet, Teams web, Zoom web.** No native macOS app, no virtual audio driver.

The recorder just produces an audio blob — the exact same blob a file upload would have — so **everything downstream (transcription + extraction) is unchanged.** The capture is the input mechanism; the pipeline is the value, and extraction quality is the bar: if the insights aren't good enough that you'd rather read them than the raw transcript, nothing else matters.

MVP delivers:
- **In-browser capture:** a "Record" control that captures the meeting tab's audio (other participants) **plus your microphone** (you), mixed into one recording. Start/stop, elapsed timer, a live "capturing" indicator.
- Automatic transcription of meeting-length audio.
- Automatic extraction into a structured, validated **Insight** object (§6): TL;DR, executive summary, key points, action items, decisions, topics.
- A web UI to view the result and browse past meetings.

A plain file-upload path stays in as a secondary input (useful for testing and for audio recorded elsewhere), but the **recorder is the primary flow.**

### 3.2 Explicit non-goals for the MVP

These are **intentionally deferred** so Claude Code doesn't over-build:

- ❌ **Native desktop-app capture** (Teams/Zoom *desktop* apps on macOS via ScreenCaptureKit / BlackHole) — Appendix A, Phase A5. The MVP records browser tabs only. Desktop apps → use their web clients for now.
- ❌ **Chrome extension** — the MVP records from *within the web app* (open SumMeet in a tab, hit Record, pick the meeting tab). The extension (floating button on the Meet page, nicer UX) is the immediate fast-follow, Phase A2 — and it hits the same API, so it's additive, not a rewrite.
- ❌ **Real-time / streaming transcription** — record fully, then process (batch). Live transcription is later.
- ❌ **Speaker diarization** (who-said-what) — single transcript for MVP. This is the #1 fast-follow; see §13.1.
- ❌ **Integrations** (Slack / Notion / email) — Appendix A, Phase 5.
- ❌ **Multiple transcription modes** (fast / economic / private) — Groq only for MVP. The provider is abstracted (§7.4) so modes drop in later.
- ❌ **Billing / paywall / usage limits** — Appendix A, Phase A6.
- ⚠️ **Auth** — see §7.8. Recommended thin, but can be deferred to single-user for the very first build.

---

## 4. Core user flow (MVP)

1. User is in a meeting (Meet, or Teams/Zoom web) in one Chrome tab, with SumMeet open in another.
2. Clicks **Record** in SumMeet. The browser's share-picker appears; user selects the **meeting tab** and enables **"share tab audio."** SumMeet also requests the **microphone**.
3. SumMeet mixes tab audio (others) + mic (user) and records. A timer + "capturing" indicator show it's live. User can keep the SumMeet tab in the background.
4. User clicks **Stop**. The recording is uploaded; a meeting row appears with status `Processing`.
5. Backend transcribes, then extracts insights (async). Frontend polls.
6. Status flips to `Ready`. User opens the meeting.
7. Meeting detail shows: **TL;DR**, **Summary**, **Action items**, **Decisions**, **Topics**, and the **full transcript**. Each action item / decision links back to the transcript span it came from.

> **Secondary path:** an **Upload** button accepts an existing audio file (`.webm`, `.m4a`, `.mp3`, `.wav`) — for testing and for audio captured elsewhere. Same pipeline from step 4 on.

---

## 5. Product surface (MVP screens)

| Screen | Purpose | Key elements |
|---|---|---|
| **Meeting list** (`/`) | Home + history | Rows: title, date, duration, status badge (`Recording` / `Processing` / `Ready` / `Failed`). Polls rows still processing. Primary **Record** CTA + secondary **Upload**. |
| **Recorder** (modal / bar) | Capture in-browser | **Record/Stop**, elapsed timer, live "capturing" indicator, mic on/off toggle, and a pre-flight hint ("share the meeting tab + enable *tab audio*"). Shows a warning if tab audio wasn't shared (common user miss). Optional title field. |
| **Upload** (secondary) | Get external audio in | File picker + drag-drop, optional title, upload progress, accepted-format hint. |
| **Meeting detail** (`/meetings/[id]`) | Consume value | Header (title, date, duration). Sections: TL;DR, Executive summary, Key points, Action items (task / owner / due / priority), Decisions (decision / rationale), Topics, and a collapsible full transcript. `sourceQuote` on items scrolls to that span in the transcript. `Failed` state shows the reason + a Retry button. |

Design intent: **Notion-like calm.** Insights first, transcript last and collapsed. The transcript is evidence, not the headline.

---

## 6. The Insight contract (output schema)

This is the heart of the product. The extraction model must return **exactly** this shape, validated with Zod. Ground every extracted item in a `sourceQuote` — it cuts hallucination and lets the UI link back to evidence.

```typescript
// packages/core/src/schemas.ts
import { z } from "zod";

export const ActionItemSchema = z.object({
  task: z.string(),                                      // the commitment, imperative voice
  owner: z.string().nullable(),                          // person/role if inferable from context, else null
  dueDate: z.string().nullable(),                        // ISO date OR natural-language deadline ("next Friday"), else null
  priority: z.enum(["high", "medium", "low"]).nullable(),
  sourceQuote: z.string().nullable(),                    // verbatim transcript span this was derived from
});

export const DecisionSchema = z.object({
  decision: z.string(),                                  // what was decided, stated plainly
  rationale: z.string().nullable(),                      // why, if stated
  sourceQuote: z.string().nullable(),
});

export const TopicSchema = z.object({
  title: z.string(),                                     // short label
  summary: z.string(),                                   // 1–2 sentences
});

export const MeetingInsightsSchema = z.object({
  tldr: z.string(),                                      // one to two sentences, the "if you read nothing else"
  executiveSummary: z.string(),                          // one paragraph
  keyPoints: z.array(z.string()),                        // 3–7 bullets
  actionItems: z.array(ActionItemSchema),
  decisions: z.array(DecisionSchema),
  topics: z.array(TopicSchema),
  language: z.string(),                                  // detected, ISO 639-1 (e.g. "pt", "en")
});

export type MeetingInsights = z.infer<typeof MeetingInsightsSchema>;
```

**Quality rules for the extraction prompt (encode these):**
- Action items are *commitments someone made*, not every task mentioned. If nobody owned it, `owner` is null — don't invent one.
- Decisions are *choices the group settled on*, not options discussed. Discussion without resolution is a topic, not a decision.
- Never fabricate `owner`, `dueDate`, or `sourceQuote`. Null is a valid, expected answer.
- Match the meeting's language for all free-text fields; set `language` accordingly.
- Return **only** the JSON object, no prose, no markdown fences.

---

## 7. Technical architecture

### 7.1 Shape

```
   browser recorder ─┐
   (tab audio + mic) │
        or           ├─upload─▶ ┌──────────────┐
   file upload  ─────┘          │  API (Fastify)│ ──▶ Local disk  (./data/audio/*.webm)
                                │  on localhost │ ──▶ SQLite       (./data/summeet.db)
                                │              │ ──▶ in-process worker (async)
                                └──────┬───────┘
                                       │
                                ┌──────▼───────┐   1. preprocess audio (ffmpeg, local)
                                │  Worker      │   2. transcribe (Groq Whisper) ── external API
                                │  (in-process)│   3. extract insights (LLM)   ── external API
                                └──────┬───────┘   4. persist + status
                                       │
   web (Next.js) ◀── poll ─────────────┘

   Nothing external except the AI API calls (Groq / Anthropic). Storage + DB + queue
   all live on your machine. The AI calls disappear too once you add local Whisper /
   Ollama (Appendix A, Phase A3 — "private mode").
```

### 7.1a Browser capture (the on-ramp) — client-side only

All of this runs in the Next.js frontend. It produces an audio blob and POSTs it to the same `/api/meetings` endpoint. No server involvement in capture.

**The two audio sources, mixed:**
- **Tab audio (other participants):** `getDisplayMedia({ video: true, audio: true })`. The user picks the meeting tab and checks "share tab audio." You must request `video: true` to get the picker, then discard the video track and keep only the audio track. This captures what the tab plays — i.e. everyone *except* the user.
- **Microphone (the user):** `getUserMedia({ audio: true })`. The user's own voice never comes back through the tab, so **without the mic you'd record everyone but the user.** This is the single most common capture bug — don't ship without it.

**Mixing + recording (Web Audio API):**
```typescript
const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
const mic     = await navigator.mediaDevices.getUserMedia({ audio: true });

const ctx  = new AudioContext();
const dest = ctx.createMediaStreamDestination();
ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(dest);
ctx.createMediaStreamSource(mic).connect(dest);

const recorder = new MediaRecorder(dest.stream, { mimeType: "audio/webm" });
const chunks: Blob[] = [];
recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
recorder.onstop = () => uploadBlob(new Blob(chunks, { type: "audio/webm" }));
recorder.start(1000); // timeslice, so nothing is lost if the tab is backgrounded
// stop the display video track immediately — we only wanted audio
display.getVideoTracks().forEach((t) => t.stop());
```

**Constraints to encode in the UI:**
- If the user shares a tab but forgets "share tab audio," `display.getAudioTracks()` is empty → detect it and prompt to restart the share. Handle this explicitly; it's the #1 support issue.
- Cross-platform because this is **tab** audio, not system audio. (Whole-screen/system audio capture via `getDisplayMedia` is unsupported on macOS — hence desktop apps are out of MVP scope.)
- Long recordings: `MediaRecorder` with a `timeslice` (e.g. 1000 ms) streams chunks so a 60-min call doesn't sit as one giant in-memory blob and survives the tab being backgrounded.

### 7.2 Stack & rationale

| Concern | Choice | Why |
|---|---|---|
| Frontend | **Next.js (App Router) + Tailwind** | Your stated pick; fast to build, great with Claude Code. |
| Capture | **`getDisplayMedia` + `getUserMedia` + Web Audio + `MediaRecorder`** | All native browser APIs, zero deps. Tab audio + mic mixed client-side (§7.1a). Cross-platform for anything in a Chrome tab. |
| Backend API | **Fastify + TypeScript** | Your stated pick. Standalone so *every future client (web recorder, Chrome extension, eventual macOS app) shares one API* — this is why it's not just Next.js route handlers. |
| DB | **SQLite + Prisma** | Local file, **no DB server to run**. Prisma migrations. Swaps to Postgres later by changing the provider. *(SQLite specifics in §8.)* |
| Job queue | **In-process worker** (in-memory queue + startup recovery sweep) | No pg-boss, no Redis, no Postgres. Single-user local = you don't need a durable distributed queue; one meeting at a time is plenty. Swaps to pg-boss/BullMQ when you deploy. |
| Storage | **Local filesystem** (`./data/audio/`) | Recordings saved as files on disk. Behind a `StorageProvider` interface (§7.7) so R2/S3 drops in later with one class. |
| Transcription | **Groq `whisper-large-v3-turbo`** | Fast, cheap, good. Behind an interface (§7.4) so local Whisper drops in for "private mode." |
| Extraction LLM | **Claude (Anthropic API), abstracted** | Strong structured output; you're already in the ecosystem. Swappable — see §13.3. |
| Validation | **Zod** | Single source of truth for the Insight contract, shared frontend↔backend. |
| Monorepo | **pnpm workspaces** | Share schemas + services cleanly between `web` and `api`. |

> **Local-first, no external server (for now).** Storage, database, and job queue all run on your machine — no cloud infra to provision. Two local processes (`web` + `api` on localhost), started by one `pnpm dev`. The only things that leave your machine are the audio/transcript sent to the AI APIs; the `StorageProvider` (§7.7) and `TranscriptionProvider` (§7.4) interfaces are exactly what make "local now → cloud/private later" a one-file swap, not a rewrite.

### 7.3 The pipeline (worker, step by step)

1. Load meeting; read audio from local disk (`./data/audio/{id}.webm`).
2. **Preprocess** (ffmpeg): transcode to 16 kHz mono, compress (Opus or low-bitrate MP3). If the result exceeds the transcription file limit (~25 MB), **chunk** into ≤~10-minute windows with a few seconds of overlap.
3. **Transcribe** each chunk via Groq; stitch segments back together, **offsetting timestamps per chunk**.
4. Persist `Transcript` (full text + segments). Set status `EXTRACTING`.
5. **Extract**: send the full transcript to the LLM → parse → **validate against `MeetingInsightsSchema`** → on invalid, one repair retry (feed the validation error back) → persist `Insights`.
6. Set status `COMPLETED`. On any failure, set `FAILED` and store the reason.

### 7.4 Transcription abstraction

```typescript
// packages/core/src/transcription/index.ts
export interface TranscriptionProvider {
  transcribe(audio: Buffer, opts: { language?: string }): Promise<{
    text: string;
    segments: { start: number; end: number; text: string }[];
    language: string;
  }>;
}
// MVP impl: GroqWhisperProvider. Later: LocalWhisperProvider (faster-whisper) for private mode.
```

### 7.5 Audio handling — the gnarly detail

Real meetings run 45–90 min and blow past API file limits. Don't skip this:
- **Compress first:** `ffmpeg -i in.m4a -ac 1 -ar 16000 -c:a libopus -b:a 24k out.opus` (mono, 16 kHz — Whisper's native rate — is plenty for speech and shrinks files massively).
- **Chunk if still too big:** fixed ~10-min windows with ~5 s overlap; drop duplicated overlap text on stitch, and **add the chunk's start offset to every segment timestamp** so the timeline stays correct.
- A 60-min meeting transcript is ~8–12k words — comfortably inside a modern LLM context window, so extraction runs in one pass.

### 7.6 Extraction

Single LLM call with the transcript + a system prompt encoding §6's quality rules, requesting the exact JSON. Parse, validate with Zod, repair-retry once on failure. Store the raw model output alongside the parsed result for debugging.

### 7.7 Storage (local filesystem, behind an interface)

Recordings are saved to disk under a git-ignored `./data/audio/` directory. Store only the **key** (relative path) in the DB, never an absolute path or URL.

```typescript
// packages/core/src/storage/index.ts
export interface StorageProvider {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
// MVP impl: LocalStorageProvider → writes to `${DATA_DIR}/audio/{key}`.
// Later: R2StorageProvider (same interface, S3 SDK) — one class, no other changes.
```

Key format: `{meetingId}.webm`. For audio playback in the UI, the API serves the file via `GET /api/meetings/:id/audio` (streams from disk) — optional for MVP.

### 7.8 Auth (decision point)

- **Local single-user (recommended for now):** skip auth entirely, `Meeting.userId` nullable (already is). You're the only user on your own machine — no reason to build auth yet.
- **When you deploy / go multi-user:** add **Auth.js** (email magic link) and scope meetings per user.

Given "local, no external server," start with no auth.

---

## 8. Data model (Prisma + SQLite)

SQLite has two constraints that shape the schema: **no native enums** and **no separate JSON type** in Prisma. So `status` is a `String` (values enforced by a Zod enum in app code), and JSON blobs are stored as `String` (TEXT) holding serialized JSON, parsed on read with the matching Zod schema. No `@db.Text` (SQLite `String` is already TEXT).

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")   // "file:./data/summeet.db"
}

model User {
  id        String    @id @default(cuid())
  email     String    @unique
  name      String?
  meetings  Meeting[]
  createdAt DateTime  @default(now())
}

model Meeting {
  id          String      @id @default(cuid())
  userId      String?
  user        User?       @relation(fields: [userId], references: [id])
  title       String
  status      String      @default("UPLOADED")  // MeetingStatus (Zod enum, §8.1)
  audioKey    String?     // storage key, e.g. "{id}.webm"
  durationSec Int?
  language    String?
  error       String?     // failure reason when status = FAILED
  transcript  Transcript?
  insights    Insights?
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt
}

model Transcript {
  id        String   @id @default(cuid())
  meetingId String   @unique
  meeting   Meeting  @relation(fields: [meetingId], references: [id], onDelete: Cascade)
  fullText  String
  segments  String   // JSON: [{ start, end, text }]  (+ speaker later)
  provider  String   // e.g. "groq:whisper-large-v3-turbo"
  createdAt DateTime @default(now())
}

model Insights {
  id        String   @id @default(cuid())
  meetingId String   @unique
  meeting   Meeting  @relation(fields: [meetingId], references: [id], onDelete: Cascade)
  data      String   // JSON conforming to MeetingInsightsSchema
  rawOutput String?  // raw LLM output for debugging
  provider  String   // e.g. "anthropic:claude-..."
  createdAt DateTime @default(now())
}
```

### 8.1 Status as a Zod enum (source of truth)

```typescript
// packages/core/src/schemas.ts
export const MeetingStatus = z.enum([
  "UPLOADED", "TRANSCRIBING", "TRANSCRIBED", "EXTRACTING", "COMPLETED", "FAILED",
]);
export type MeetingStatus = z.infer<typeof MeetingStatus>;
```

**`TRANSCRIBED` is a resting state, not a failure.** With `autoExtract` off the
pipeline stops once the transcript is persisted (and the audio is discarded), and
insights are generated on demand via `POST /api/meetings/:id/reextract`. This
decouples a cheap, always-on local Whisper from the expensive stage: the LLM —
cloud or a heavy local model — runs only when the user asks, and they decide per
meeting whether that transcript leaves the machine.

Always `JSON.parse` + Zod-validate `segments` and `data` on read, and `JSON.stringify` on write. Wrap this in tiny helpers so the app never touches raw strings. Migrating to Postgres later means: change the provider, restore the real `enum`, and switch these fields to `Json` — a mechanical change.

---

## 9. API (MVP)

| Method | Route | Body / params | Returns |
|---|---|---|---|
| `POST` | `/api/meetings` | multipart: `audio` (recorded `.webm` blob **or** uploaded file), `title?` | `{ id, status }` — stores audio, creates row, enqueues job. Same endpoint for both inputs. |
| `GET` | `/api/meetings` | — | `[{ id, title, status, durationSec, createdAt }]` |
| `GET` | `/api/meetings/:id` | — | `{ meeting, transcript, insights }` (transcript/insights null until ready) |
| `GET` | `/api/meetings/:id/audio` | — | streams the recording from local disk (for in-app playback; optional for MVP) |
| `POST` | `/api/meetings/:id/retry` | — | re-enqueues a `FAILED` meeting |
| `GET` | `/health` | — | `{ ok: true }` |

**Internal:** after `POST /api/meetings` saves the file + row, it pushes the id onto the in-process queue; the worker (same Node process) picks it up and runs the pipeline. Not an HTTP endpoint. On server start, sweep for meetings stuck in `UPLOADED`/`TRANSCRIBING`/`EXTRACTING` and re-enqueue them (crash recovery).

Notes: the upload writes the audio straight to local disk via the `StorageProvider`. Direct multipart upload to the local API is exactly right here — no presigned-URL / cloud complexity while everything's on your machine.

---

## 10. Repo structure

```
summeet/
├── package.json                 # pnpm workspace root
├── pnpm-workspace.yaml
├── .env.example
├── data/                        # git-ignored — lives on your machine
│   ├── summeet.db               #   SQLite database
│   └── audio/                   #   recordings ({meetingId}.webm)
├── packages/
│   └── core/                    # shared source of truth
│       ├── src/
│       │   ├── schemas.ts       # Zod: MeetingInsights, MeetingStatus, ActionItem, ...
│       │   ├── types.ts
│       │   ├── storage/         # StorageProvider + LocalStorageProvider
│       │   ├── transcription/   # TranscriptionProvider + GroqWhisperProvider
│       │   ├── extraction/      # prompt + LLM client + parse/validate/repair
│       │   └── audio/           # ffmpeg preprocess + chunking + stitch
│       └── package.json
└── apps/
    ├── api/                     # Fastify (API + in-process worker) + Prisma
    │   ├── prisma/schema.prisma
    │   ├── src/
    │   │   ├── server.ts        # Fastify app + routes + starts worker + recovery sweep
    │   │   ├── routes/meetings.ts
    │   │   ├── queue.ts         # in-memory queue (enqueue + process loop)
    │   │   ├── worker.ts        # consumes queue → runs pipeline
    │   │   ├── pipeline.ts      # preprocess → transcribe → extract → persist
    │   │   └── db.ts            # Prisma client
    │   └── package.json
    └── web/                     # Next.js App Router
        ├── app/
        │   ├── page.tsx                 # meeting list
        │   ├── meetings/[id]/page.tsx   # meeting detail
        │   └── components/…
        └── package.json
```

---

## 11. Build plan (Claude Code sessions)

Seven sessions. Each has an **isolated, testable outcome** — prove each layer (transcription, extraction, capture) on its own before wiring it up.

**Session 0 — Scaffold & schema**
- pnpm workspace; `packages/core`, `apps/api`, `apps/web`.
- Prisma schema (SQLite) + first migration — **no Docker, no DB server**, just `./data/summeet.db`.
- `/health` returns 200; web renders an empty meeting list.
- ✅ *Done when:* `pnpm dev` runs everything, DB migrates, `/health` responds.

**Session 1 — Transcription service (isolated)**
- `packages/core/transcription`: `TranscriptionProvider` + `GroqWhisperProvider`.
- `packages/core/audio`: ffmpeg preprocess + chunking + timestamp-offset stitch.
- CLI script: `pnpm transcribe sample.m4a` → prints text + segments JSON.
- ✅ *Done when:* a real ~10-min sample transcribes correctly, **and** a >25 MB file chunks and stitches with correct timestamps.

**Session 2 — Extraction service (isolated)**
- `schemas.ts` (Zod) + `extraction`: prompt + LLM call + parse + validate + one repair retry.
- CLI: `pnpm extract transcript.txt` → validated `MeetingInsights` JSON.
- ✅ *Done when:* a sample transcript yields valid insights, and deliberately malformed model output is caught and repaired.

**Session 3 — Pipeline + API**
- `LocalStorageProvider` (writes to `./data/audio/`), in-memory queue + worker, `pipeline.ts`.
- `POST /api/meetings` (multipart) → save file to disk + create row + enqueue; worker runs the pipeline with status transitions and error capture; `GET /api/meetings`, `GET /api/meetings/:id`, retry, startup recovery sweep.
- ✅ *Done when:* `curl` upload → poll → `COMPLETED` with transcript + insights persisted; a forced failure lands as `FAILED` with a reason.

**Session 4 — Browser recorder (isolated)**
- Client-only recorder module (§7.1a): `getDisplayMedia` (tab audio) + `getUserMedia` (mic) → Web Audio mix → `MediaRecorder` with timeslice → single `.webm` blob.
- Handle the "forgot to share tab audio" case (empty audio track → prompt). Timer + live indicator. Drop the display video track.
- Prove it in isolation first: a bare page with Record/Stop that downloads the resulting blob locally.
- ✅ *Done when:* recording a real Meet/Teams-web call produces a `.webm` where **both** the other participants and your own mic are audible, and long recordings (30+ min, tab backgrounded) don't drop audio.

**Session 5 — Web app (wire it together)**
- Meeting list with status badges that poll processing rows; **Record** as primary CTA (wires the Session-4 recorder to `POST /api/meetings`), **Upload** as secondary; meeting detail rendering all Insight sections + collapsible transcript, with `sourceQuote` scroll-to-span.
- ✅ *Done when:* record → stop → auto-upload → poll → read insights, entirely in the browser, no CLI.

**Session 6 — Hardening**
- Error / empty / loading states; `FAILED` UI + Retry; file type/size guards; mic/tab-audio permission-denied handling; basic rate limit; README + env docs; (optional) Auth.js.
- ✅ *Done when:* a denied permission or bad file is rejected gracefully, a failed job shows its reason and retries, and a fresh clone runs from the README alone.

---

## 12. Definition of done (MVP)

- [ ] **Record a real Meet/Teams-web call in the browser** — both other participants and your own mic captured — and get back TL;DR, summary, key points, action items, decisions, and topics.
- [ ] Upload path also works for externally-recorded audio.
- [ ] Long recordings (45+ min, tab backgrounded) capture and process correctly via chunked recording + compression + chunked transcription.
- [ ] "Forgot to share tab audio" is caught and the user is prompted, not left with a silent recording.
- [ ] Every Insight object validates against `MeetingInsightsSchema`; invalid model output is repaired, not crashed on.
- [ ] Action items/decisions link back to their transcript span.
- [ ] Meeting history persists and is browsable.
- [ ] Failures surface a human-readable reason and can be retried.
- [ ] A new dev can clone and run it from the README.
- [ ] **The gut check:** on 3–5 of *your own* real meetings, you'd rather read the insights than the transcript.

---

## 13. Key risks & open decisions

**13.1 Diarization — solved for self-vs-others, open for the rest.**
The recorder mixes two *physically separate* sources. Mixing them to mono threw
that away; writing them as stereo channels (left = tab, right = mic) recovers
"who spoke" for free — no model, no key, no extra API call. The pipeline votes
per 100 ms window on channel energy (an average would be dominated by whichever
voice was louder, not by who spoke most of the span) and requires a clear
majority, leaving genuinely overlapped spans unattributed.

Measured: with labels, the extractor assigned `owner: "You"` to a commitment it
had left `null` without them — same transcript, same call, same cost.

Known limits, in priority order:
1. **Only "you" vs "everyone else."** Telling the *other* participants apart
   still needs a real diarizer (pyannote self-hosted, or Deepgram/AssemblyAI —
   both raise cost or add a dependency).
2. **Segment granularity bounds accuracy.** A transcript segment that straddles a
   speaker change gets one label. Fine segmentation (whisper large) handles it;
   coarse segmentation (whisper base) can merge a whole exchange into one span.
3. **Speakerphone bleed.** Tab audio re-entering the mic makes both channels
   active; the dominance ratio tolerates this, and truly ambiguous windows
   abstain rather than guess.
4. **Mono audio carries no speaker data** — file uploads and pre-A1 recordings
   simply come back unlabelled (`speaker: null`), and the prompt drops the rule.

**13.2 Long-audio limits.** Whisper APIs cap file size (~25 MB). The §7.5 compress-and-chunk approach handles it, but watch chunk boundaries splitting sentences — hence the overlap windows and per-chunk timestamp offset.

**13.3 Extraction LLM provider.** Spec defaults to Claude behind an interface. Decide on quality with *your* meetings, not benchmarks: run the Session-2 CLI on 5 real transcripts and eyeball the action-item / decision quality. Keep the abstraction so swapping is one file.

**13.4 Cost at scale.** Groq turbo + a mid-tier LLM is cheap per meeting, but adds up at free-tier volume. The "economic / private" modes in your roadmap (local Whisper / Ollama) are the release valve — the transcription abstraction (§7.4) is what makes them a drop-in.

**13.5 System-audio capture on macOS — spiked, and it works.**
The SPEC said to spike ScreenCaptureKit before committing to Electron + BlackHole.
Done (`apps/macos/spike/`): ScreenCaptureKit (macOS 13+) hands us the system audio
mix directly — **no virtual audio driver, no kernel extension, nothing for the
user to install.**

| Scenario | RMS | |
|---|---|---|
| nothing playing (control) | 0.000000 | silence, as expected |
| `afplay` (headless process) | 0.000000 | **not captured** |
| QuickTime (app with a window) | 0.090360 | **captured** |

The capture filter is composed of **displays / on-screen windows**, so a process
with no window contributes no audio. Every real target has a window (Meet in a
browser, Zoom, Teams, Slack), so this doesn't constrain the product — but it does
mean the capture path can't be exercised from a headless CLI.

Two consequences:

1. **The Chrome extension is redundant** and has been removed. Native capture
   records browser *and* desktop meeting clients, with no tab picker.
2. **Permissions are per-bundle.** Screen Recording is granted to a code-signed
   `.app`, not to a bare binary (which would inherit the terminal's grant — fragile,
   and not something to ask a user for). The app must ship signed.

Windows still needs its own spike (**WASAPI loopback**) before its app is built.

---

## Appendix A — Refined product roadmap (post-MVP)

The original 8-phase plan, tightened and reordered. The MVP above = old Phases 0–1 + 4, done as one coherent slice.

| Phase | Theme | Core deliverable | Notes vs. original |
|---|---|---|---|
| **MVP** | Prove the core | **In-browser capture** → validated insights → web app | Merges backend + web + intelligence + browser capture. Extraction quality is the bar. |
| **A1** ✅ | Diarization (self vs others) | Speaker-attributed transcripts + owner-aware action items | **Shipped, at zero cost.** The recorder already captures two physically separate sources, so it writes them as stereo channels (left = tab/others, right = mic/you) and the pipeline reads the speaker off per-window channel energy — no model, no API key, no extra call. Answers the primary job ("what did *I* commit to?"). Distinguishing *between* the other participants still needs a real diarizer; see §13.1. |
| ~~**A2**~~ | ~~Chrome extension~~ | — | **Removed (2026-07).** It existed only to work around a browser limitation. Native system-audio capture (A7) records Meet, Zoom and Teams — browser *or* desktop client — with no extension and no tab picker, so the extension became redundant. Recoverable from git history. |
| **A3** ✅ | Processing engines | Cloud (Groq) / Local (whisper.cpp + Ollama) chosen per stage | **Shipped.** Free, fully offline "private mode" behind the provider seams; engines can be mixed. Quality of small local models is the open question (§13.7). |
| **A4** | Integrations | Slack + Notion + email delivery of insights | Original Phase 5. "Consume value without opening the app." |
| **A5** ✅ | Custom summary output | User picks which sections appear and in what order, from a fixed catalogue | **Shipped, and it *reduces* cost.** A section nobody asked for is neither described in the prompt nor generated, so fewer tokens in and out. Deliberately locked (no free-text prompt) so the Insight contract can't be talked out of shape; every field carries a Zod default, so omitted sections parse and older insights stay readable. Catalogue: TL;DR, executive summary, key points, **your commitments** (derived free from A1's `owner: "You"`), action items, decisions, **open questions**, **risks & blockers**, **next steps**, **numbers mentioned**, topics. |
| **A6** | Glossary / custom vocabulary | Upload domain terms, product & people names; bias both transcription and extraction | **New.** Biggest cheap win for the **local** engine, whose small models mangle names (observed: "Alright everyone" → "Aureccio Verione"). Feed the glossary to Whisper as an `initial_prompt` (whisper.cpp `--prompt`, Groq `prompt`) and into the extraction system prompt so owners/products are spelled right. Per-user, optionally per-meeting. |
| **A7** | Native apps — **the capture strategy** | **macOS + Windows desktop** and **Android mobile**; the web panel stays as the UI | **Promoted: capture now lives in the OS, not the browser.** Desktop apps wrap the existing web UI in a webview and add native system-audio capture + the bundled server, so there is one installable icon and no `pnpm dev`. macOS is validated (see §13.5). Mobile covers in-person meetings. Bundle a small on-device model so it works offline and free out of the box; cloud engines stay opt-in. See §13.8. |

### A0 — Cross-cutting principle: every client picks its engine

**Every version of SumMeet — web, Chrome extension, macOS/Windows desktop, Android —
must let the user choose, per stage, between local processing (free, offline,
bundled model) and online processing (an API key they supply). This is a
configuration, never a build-time decision.**

Consequences for the architecture:

- The `TranscriptionProvider` / `LlmProvider` seams (§7.4, §7.6) already make this
  a per-job resolution, not a boot-time one. Keep it that way.
- **API keys must be user-configurable at runtime** (entered in the app's settings
  and stored server/app-side), not only read from a `.env` at deploy. A desktop or
  mobile user has no `.env` to edit. They stay server/app-side — never shipped to
  a browser client (hard rule §7.2).
- Settings are stored **once, centrally**, so secondary clients (the extension
  today; desktop/mobile later) inherit them instead of each holding their own copy.
- A client with no key configured and no local model available must degrade with a
  readable error, not a crash — the pipeline is fail-soft (§7.3).
| **A8** | Accounts & billing | Auth, usage limits, free/Pro tiers | Original Phase 8 monetization. Free = limited minutes; Pro = more minutes + integrations + private mode. |
| **A9** | Refinement & GTM | Onboarding, retention, share-a-summary virality, content | Original Phases 7–8. Metrics: retention, meetings/user, time-to-value. |

---

## Appendix B — Environment variables

```bash
# Database (local SQLite file — no server)
DATABASE_URL="file:./data/summeet.db"

# Local storage
DATA_DIR="./data"                # audio saved under ./data/audio/

# Transcription (external API — audio leaves your machine for this call)
GROQ_API_KEY="..."

# Extraction LLM (external API)
ANTHROPIC_API_KEY="..."          # or your chosen provider's key

# API location (the web app calls this local server)
API_BASE_URL="http://localhost:8080"
```

The AI keys live only in the **API server's** env, never in the browser — the recorder uploads audio to your local API, which makes the AI calls. Requires **ffmpeg** installed locally. R2/Postgres/Auth env come back only if/when you deploy.
