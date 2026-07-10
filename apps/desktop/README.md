# SumMeet desktop (macOS)

A native window around the existing web panel, plus the two things a browser
can't do: capture the **system audio** and run the backend for you.

## Why a shell, not a rewrite

The UI already exists, is translated, and ships as a website. Rewriting it per
platform would triple the maintenance for a purely cosmetic gain. The native
layer adds capture and packaging — that's where the value is.

Tauri over Electron: the system webview instead of a bundled Chromium (~26 MB
binary, ~115 MB resident). Native audio capture needs platform code either way,
so Electron buys nothing here.

## What the shell does

- **Starts the backend if it isn't running.** Opening the app is enough; no
  `pnpm dev` in another terminal. If a dev server is *already* up it is reused and
  left running on quit — we only stop what we started.
- **Records via the OS.** Record drives the Swift recorder (`apps/macos/recorder`),
  which captures system audio → left, microphone → right, and uploads directly,
  declaring `summeet-stereo-v1` so the pipeline may attribute speakers.

## Running it (development)

```bash
apps/macos/recorder/build.sh          # the Swift recorder must exist first
cd apps/desktop/src-tauri && cargo run
```

macOS will ask for **Screen Recording** and **Microphone** the first time.

```bash
cargo test                 # path resolution, PATH, port probing
cargo test -- --ignored    # spawns the recorder and uploads (needs the API + permissions)
```

## Process handling, and why it's fussy

`pnpm dev` is a tree (`concurrently` → `next` + `tsx`). Three lessons are encoded
in the code:

1. **Kill the group, not the parent.** The child is put in its own process group
   (`setsid`), and we signal the group. Otherwise orphans keep holding :3000/:8080.
2. **A signal handler is required.** Quitting through the UI raises a Tauri event,
   but a `SIGTERM` does not — the tree would survive. `BACKEND_PGID` is read from
   an async-signal-safe handler that reaps the group.
3. **Stop the recorder with SIGINT, not SIGKILL.** It still has to flush its
   buffers, join the two channels and upload. Killing it loses the recording.

Also: a GUI app launched from Finder inherits a minimal `PATH` and would not find
`ffmpeg`. The shell puts the Homebrew paths back before spawning the recorder.

## Not done yet

The backend is started as `pnpm dev`, which means a release build still expects the
repo and Node. Shipping a real `.app` needs the API compiled to a sidecar binary and
the panel exported as static assets.
