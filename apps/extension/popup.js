// SumMeet Recorder — popup. Two jobs: let the user grant microphone permission
// once (to the extension origin, which the offscreen doc then inherits) and set
// the SumMeet API URL. No recording happens here.

const DEFAULT_API_BASE = "http://localhost:8080";
const api = document.getElementById("api");
const status = document.getElementById("status");

function setStatus(text, kind) {
  status.textContent = text || "";
  status.className = kind || "";
}

// Load saved API base.
chrome.storage.local.get("apiBase").then(({ apiBase }) => {
  api.value = apiBase || DEFAULT_API_BASE;
});

document.getElementById("save").addEventListener("click", async () => {
  const value = api.value.trim() || DEFAULT_API_BASE;
  await chrome.storage.local.set({ apiBase: value });
  setStatus("Saved.", "ok");
});

// Record/Stop from the popup — a reliable path: clicking the toolbar icon
// grants activeTab, which tabCapture needs. (The floating button works too, but
// falls back to this if the page gesture didn't grant capture rights.)
const recBtn = document.getElementById("rec");

async function refreshRecState() {
  const s = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  recBtn.textContent = s?.recording ? "■ Stop recording" : "● Record this tab";
  recBtn.style.background = s?.recording ? "#0E142E" : "#4F42E0";
}
refreshRecState();

recBtn.addEventListener("click", async () => {
  const s = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (s?.recording) {
    await chrome.runtime.sendMessage({ type: "STOP" });
    setStatus("Stopping & uploading…", "ok");
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return setStatus("No active tab.", "err");
    const res = await chrome.runtime.sendMessage({
      type: "START",
      tabId: tab.id,
      tabTitle: tab.title,
    });
    setStatus(res?.ok ? "Recording…" : res?.error || "Could not start.", res?.ok ? "ok" : "err");
  }
  setTimeout(refreshRecState, 400);
});

document.getElementById("mic").addEventListener("click", () => {
  // Open the grant flow in a real tab. A popup closes the instant the browser
  // permission prompt opens, which cancels the request ("denied") — a tab won't.
  chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
  window.close();
});
