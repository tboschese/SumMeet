// SumMeet Recorder — MV3 service worker.
// Coordinates the flow: content/popup asks to record → we grab a tabCapture
// stream id for that tab → spin up an offscreen document (the only MV3 context
// that can run MediaRecorder/AudioContext) → tell it to mix tab audio + mic and
// upload to the local SumMeet API. All messaging is routed by `from`/`target`.

const OFFSCREEN_PATH = "offscreen.html";
const DEFAULT_API_BASE = "http://localhost:8080";

// Source of truth for whether a recording is in flight.
let state = { recording: false, tabId: null, startedAt: 0 };

async function getApiBase() {
  const { apiBase } = await chrome.storage.local.get("apiBase");
  return apiBase || DEFAULT_API_BASE;
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Mix meeting tab audio with the microphone and record it.",
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

// Notify the recording tab's content script so its floating button can update.
function notifyTab(message) {
  if (state.tabId != null) {
    chrome.tabs.sendMessage(state.tabId, message).catch(() => {});
  }
}

async function startRecording(tabId, tabTitle) {
  if (state.recording) throw new Error("Already recording another tab.");
  if (tabId == null) throw new Error("No tab to record.");

  // Must be obtained per-capture; the stream id is consumed by the offscreen doc.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "START",
    streamId,
    apiBase: await getApiBase(),
    tabTitle: tabTitle || "Meeting",
  });
  state = { recording: true, tabId, startedAt: Date.now() };
}

async function stopRecording() {
  if (!state.recording) return;
  await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // ── Requests from content script / popup ──────────────────────────────
      if (msg.type === "START") {
        const tabId = msg.tabId ?? sender.tab?.id;
        const tabTitle = msg.tabTitle ?? sender.tab?.title;
        await startRecording(tabId, tabTitle);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "STOP") {
        await stopRecording();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "GET_STATE") {
        sendResponse({
          recording: state.recording,
          tabId: state.tabId,
          startedAt: state.startedAt,
        });
        return;
      }

      // ── Events reported back by the offscreen document ────────────────────
      if (msg.from === "offscreen") {
        if (msg.type === "REC_STARTED") {
          notifyTab({ from: "background", type: "STARTED", startedAt: state.startedAt });
        } else if (msg.type === "REC_UPLOADED") {
          notifyTab({ from: "background", type: "UPLOADED", id: msg.id });
          state = { recording: false, tabId: null, startedAt: 0 };
          await closeOffscreen();
        } else if (msg.type === "REC_ERROR") {
          notifyTab({ from: "background", type: "ERROR", error: msg.error });
          state = { recording: false, tabId: null, startedAt: 0 };
          await closeOffscreen();
        }
        sendResponse({ ok: true });
        return;
      }
    } catch (err) {
      state = { recording: false, tabId: null, startedAt: 0 };
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});
