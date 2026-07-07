// SumMeet Recorder — MV3 service worker.
// Coordinates the flow: content/popup asks to record → we grab a tabCapture
// stream id for that tab → spin up an offscreen document (the only MV3 context
// that can run MediaRecorder/AudioContext) → tell it to mix tab audio + mic and
// upload to the local SumMeet API.
//
// IMPORTANT: the service worker is evicted after ~30s idle, so we CANNOT keep
// recording state in a module variable — it resets on wake, which used to make
// Stop a no-op (mic stayed live, timer never ended). State lives in
// chrome.storage.session, and Stop is driven by whether the offscreen document
// exists (the real source of truth), not by remembered state.

const OFFSCREEN_PATH = "offscreen.html";
const DEFAULT_API_BASE = "http://localhost:8080";
const EMPTY_STATE = { recording: false, tabId: null, startedAt: 0 };

async function getApiBase() {
  const { apiBase } = await chrome.storage.local.get("apiBase");
  return apiBase || DEFAULT_API_BASE;
}

async function getState() {
  const { recState } = await chrome.storage.session.get("recState");
  return recState || EMPTY_STATE;
}
async function setState(s) {
  await chrome.storage.session.set({ recState: s });
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

function notifyTab(tabId, message) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

async function startRecording(tabId, tabTitle) {
  if (await hasOffscreen()) throw new Error("Already recording another tab.");
  if (tabId == null) throw new Error("No tab to record.");

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  await setState({ recording: true, tabId, startedAt: Date.now() });
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "START",
    streamId,
    apiBase: await getApiBase(),
    tabTitle: tabTitle || "Meeting",
  });
}

async function stopRecording() {
  // Drive Stop off the offscreen doc, never off (possibly-reset) SW memory.
  if (await hasOffscreen()) {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP" });
  } else {
    await setState(EMPTY_STATE);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // ── Requests from content script / popup ──────────────────────────────
      if (msg.type === "START") {
        await startRecording(msg.tabId ?? sender.tab?.id, msg.tabTitle ?? sender.tab?.title);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "STOP") {
        await stopRecording();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "GET_STATE") {
        const st = await getState();
        // Reconcile stale state: "recording" with no offscreen doc is a lie.
        if (st.recording && !(await hasOffscreen())) {
          await setState(EMPTY_STATE);
          sendResponse(EMPTY_STATE);
        } else {
          sendResponse(st);
        }
        return;
      }

      // ── Events reported back by the offscreen document ────────────────────
      if (msg.from === "offscreen") {
        const st = await getState();
        if (msg.type === "REC_STARTED") {
          notifyTab(st.tabId, { from: "background", type: "STARTED", startedAt: st.startedAt });
        } else if (msg.type === "REC_UPLOADED") {
          notifyTab(st.tabId, { from: "background", type: "UPLOADED", id: msg.id });
          await setState(EMPTY_STATE);
          await closeOffscreen();
        } else if (msg.type === "REC_ERROR") {
          notifyTab(st.tabId, { from: "background", type: "ERROR", error: msg.error });
          await setState(EMPTY_STATE);
          await closeOffscreen();
        }
        sendResponse({ ok: true });
        return;
      }
    } catch (err) {
      await setState(EMPTY_STATE);
      await closeOffscreen();
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});
