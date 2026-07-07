// SumMeet Recorder — offscreen document. The only place in MV3 that can run
// getUserMedia + Web Audio + MediaRecorder. Receives a tabCapture stream id,
// mixes tab audio (participants) with the mic (you), records a single .webm,
// and uploads it to the local SumMeet API — the same POST /api/meetings the
// web app uses, so the whole downstream pipeline is unchanged.

let recorder;
let chunks = [];
let audioCtx;
let activeStreams = [];
let apiBase = "http://localhost:8080";
let tabTitle = "Meeting";

function reportError(message) {
  chrome.runtime.sendMessage({ from: "offscreen", type: "REC_ERROR", error: message });
  cleanup();
}

function cleanup() {
  try {
    for (const s of activeStreams) for (const t of s.getTracks()) t.stop();
    if (audioCtx && audioCtx.state !== "closed") audioCtx.close();
  } catch {
    /* ignore */
  }
  recorder = undefined;
  chunks = [];
  audioCtx = undefined;
  activeStreams = [];
}

function pickMimeType() {
  for (const t of ["audio/webm;codecs=opus", "audio/webm"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "audio/webm";
}

async function start(streamId) {
  try {
    // Tab audio (participants) via the tabCapture stream id.
    const tab = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
      },
      video: false,
    });

    // Microphone (you). Requires the extension origin to already hold mic
    // permission — granted once via the popup's "Enable microphone" button.
    let mic;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Clean up the tab stream and tell the user how to fix it.
      for (const t of tab.getTracks()) t.stop();
      reportError(
        "Microphone permission is off. Open the SumMeet popup and click “Enable microphone”, then record again.",
      );
      return;
    }

    activeStreams = [tab, mic];
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();

    const tabSrc = audioCtx.createMediaStreamSource(tab);
    tabSrc.connect(dest); // into the recording
    tabSrc.connect(audioCtx.destination); // keep it audible (tabCapture would mute it)
    audioCtx.createMediaStreamSource(mic).connect(dest);

    const mimeType = pickMimeType();
    chunks = [];
    recorder = new MediaRecorder(dest.stream, { mimeType });
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: mimeType });
      cleanup();
      await upload(blob);
    };
    recorder.onerror = () => reportError("Recording error.");

    recorder.start(1000); // timeslice → nothing lost if the tab is backgrounded
    chrome.runtime.sendMessage({ from: "offscreen", type: "REC_STARTED" });
  } catch (err) {
    reportError(err?.message || "Could not start capture.");
  }
}

function stop() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

async function upload(blob) {
  try {
    const form = new FormData();
    const title = `${tabTitle} — ${new Date().toLocaleString()}`;
    form.append("audio", blob, "recording.webm");
    form.append("title", title);
    const res = await fetch(`${apiBase}/api/meetings`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    const data = await res.json();
    chrome.runtime.sendMessage({ from: "offscreen", type: "REC_UPLOADED", id: data.id });
  } catch (err) {
    chrome.runtime.sendMessage({
      from: "offscreen",
      type: "REC_ERROR",
      error: err?.message || "Upload failed. Is SumMeet running on localhost:8080?",
    });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "START") {
    apiBase = msg.apiBase || apiBase;
    tabTitle = msg.tabTitle || tabTitle;
    void start(msg.streamId);
  } else if (msg.type === "STOP") {
    stop();
  }
});
