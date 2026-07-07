# SumMeet Recorder — Chrome extension (roadmap A2)

A floating **Record** button on the Meet / Teams-web / Zoom-web page, so you
don't have to keep the SumMeet tab open or fiddle with the screen-share picker.
It captures the meeting tab's audio with **`chrome.tabCapture`** (no share
dialog), mixes in your mic, and uploads the `.webm` to your local SumMeet — the
**same `POST /api/meetings`** the web app uses, so everything downstream
(transcription → extraction → insights) is unchanged.

## How it's built (MV3)

- **`content.js`** — injects the floating Record button on the meeting page (UI only).
- **`background.js`** (service worker) — grabs a `tabCapture` stream id for the
  tab and drives an offscreen document; routes state back to the button.
- **`offscreen.js`** — the only MV3 context that can run `MediaRecorder` /
  `AudioContext`: mixes tab audio + mic, records with a 1s timeslice, uploads.
- **`popup.html/js`** — grant the mic once, set the SumMeet API URL, and a
  reliable Record/Stop fallback.

## Install (unpacked, for development)

1. Make sure SumMeet is running locally (`pnpm dev`) — the API on `:8080`.
2. Open **`chrome://extensions`**, turn on **Developer mode** (top right).
3. **Load unpacked** → select this `apps/extension` folder.
4. Click the SumMeet toolbar icon → **Enable microphone** (grant once; Chrome
   remembers it for the extension). Optionally set the API URL if it isn't the
   default `http://localhost:8080`.

## Use

1. Open a Google Meet / Teams-web / Zoom-web call.
2. Click the floating **● Record** button (bottom-right) — or the toolbar icon →
   **Record this tab**.
3. Talk. You can present your screen or switch tabs freely — capture continues.
4. Click **■ Stop**. The recording uploads and appears in the SumMeet web app,
   processing to insights.

## Notes & limits

- **`tabCapture` needs the tab to be "invoked."** If the floating button reports
  a permission error, use the toolbar popup's **Record this tab** once (clicking
  the icon grants `activeTab`), then the floating button works.
- Tab audio stays audible while recording (it's re-routed to your speakers).
- Cross-platform for anything in a Chrome tab; not for native desktop apps.
- Verified: manifest + file structure. Live capture (both voices audible, real
  call) is a manual check — same as the in-app recorder.
