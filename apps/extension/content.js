// SumMeet Recorder — content script. Injects a draggable floating Record button
// onto the meeting page (Meet / Teams-web / Zoom-web) so you never leave the
// call. The button talks to the service worker, which drives tabCapture + the
// offscreen recorder. No capture happens here — this is just UI.

(() => {
  if (window.__summeetInjected) return;
  window.__summeetInjected = true;

  const el = document.createElement("div");
  el.id = "summeet-widget";
  el.innerHTML = `
    <div id="summeet-bar">
      <span id="summeet-grip" title="Drag to move">⠿</span>
      <button id="summeet-btn" type="button" title="Record this meeting with SumMeet">
        <span id="summeet-dot"></span>
        <span id="summeet-label">Record</span>
        <span id="summeet-time"></span>
      </button>
    </div>
    <div id="summeet-msg"></div>
  `;
  document.documentElement.appendChild(el);

  const btn = el.querySelector("#summeet-btn");
  const grip = el.querySelector("#summeet-grip");
  const label = el.querySelector("#summeet-label");
  const time = el.querySelector("#summeet-time");
  const msg = el.querySelector("#summeet-msg");

  let recording = false;
  let startedAt = 0;
  let ticker = null;

  // ── Position (draggable + persisted) ──────────────────────────────────────
  function applyPos(pos) {
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  }
  chrome.storage.local.get("widgetPos").then(({ widgetPos }) => {
    if (widgetPos) applyPos(widgetPos);
  });

  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const onMove = (ev) => {
      const left = Math.max(0, Math.min(ev.clientX - offX, window.innerWidth - el.offsetWidth));
      const top = Math.max(0, Math.min(ev.clientY - offY, window.innerHeight - el.offsetHeight));
      applyPos({ left, top });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      chrome.storage.local.set({
        widgetPos: { left: parseInt(el.style.left, 10), top: parseInt(el.style.top, 10) },
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // ── UI helpers ────────────────────────────────────────────────────────────
  function fmt(totalSec) {
    const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const s = String(totalSec % 60).padStart(2, "0");
    return `${m}:${s}`;
  }
  function setMessage(text, kind) {
    msg.textContent = text || "";
    msg.className = kind || "";
  }
  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      time.textContent = fmt(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
  }
  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = null;
  }
  function render() {
    el.classList.toggle("recording", recording);
    label.textContent = recording ? "Stop" : "Record";
    if (recording) startTicker();
    else {
      stopTicker();
      time.textContent = "";
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  btn.addEventListener("click", async () => {
    setMessage("");
    if (!recording) {
      btn.disabled = true;
      const res = await chrome.runtime.sendMessage({ type: "START", tabTitle: document.title });
      btn.disabled = false;
      if (!res?.ok) setMessage(res?.error || "Could not start recording.", "error");
      // "recording" flips when the offscreen doc confirms STARTED
    } else {
      btn.disabled = true;
      await chrome.runtime.sendMessage({ type: "STOP" });
      btn.disabled = false;
      setMessage("Uploading…", "info");
    }
  });

  // Events pushed from the service worker (mirroring the offscreen recorder).
  chrome.runtime.onMessage.addListener((m) => {
    if (m.from !== "background") return;
    if (m.type === "STARTED") {
      recording = true;
      startedAt = m.startedAt || Date.now();
      setMessage("Recording — you can present or switch tabs freely.", "info");
      render();
    } else if (m.type === "UPLOADED") {
      recording = false;
      setMessage("Sent to SumMeet ✓ Processing there now.", "ok");
      render();
    } else if (m.type === "ERROR") {
      recording = false;
      setMessage(m.error || "Something went wrong.", "error");
      render();
    }
  });

  // Recover UI state if the page reloads mid-recording.
  chrome.runtime.sendMessage({ type: "GET_STATE" }).then((s) => {
    if (s?.recording) {
      recording = true;
      startedAt = s.startedAt || Date.now();
      render();
    }
  });
})();
