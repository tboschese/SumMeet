// Runs in a normal extension tab (not the popup, which closes when the browser
// permission prompt appears — the cause of the "denied" you hit). A tab stays
// open through the prompt, so getUserMedia can actually resolve and the grant
// sticks to the extension origin (the offscreen doc then reuses it).

const status = document.getElementById("status");

function setStatus(text, kind) {
  status.textContent = text;
  status.className = kind || "";
}

document.getElementById("grant").addEventListener("click", async () => {
  setStatus("Requesting… allow it in the prompt.");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop(); // only needed the grant
    setStatus("Microphone enabled ✓ You can close this tab and record.", "ok");
  } catch (err) {
    const name = err?.name || "";
    if (name === "NotAllowedError") {
      setStatus(
        "Denied. Click the camera/lock icon in the address bar → allow the microphone, or check your OS microphone settings, then retry.",
        "err",
      );
    } else if (name === "NotFoundError") {
      setStatus("No microphone found on this device.", "err");
    } else {
      setStatus(`Could not access the microphone (${name || "unknown"}).`, "err");
    }
  }
});
