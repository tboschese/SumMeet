// Bridge to the native desktop shell (SPEC A7).
//
// The same panel runs in a browser and inside the Tauri window. In the browser we
// capture a tab; in the native shell the OS gives us the whole system audio mix,
// so there's no tab picker and desktop meeting clients work too.
//
// `withGlobalTauri` exposes __TAURI__ on window, so the web app needs no npm
// dependency on Tauri and still builds/ships as a plain website.

interface TauriGlobal {
  core: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
}

function tauri(): TauriGlobal | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

/** True when running inside the desktop app rather than a browser tab. */
export function isNativeShell(): boolean {
  return tauri() !== null;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = tauri();
  if (!t) throw new Error("not running in the desktop app");
  return t.core.invoke<T>(cmd, args);
}

/**
 * The native recorder writes the declared stereo layout and uploads by itself,
 * so `stop` resolves with the meeting id the server assigned — nothing to POST
 * from here.
 */
/** Live view of both channels while recording. RMS, linear, 0..~1. */
export interface CaptureStatus {
  recording: boolean;
  system: number;
  mic: number;
  elapsed_secs: number;
  /** The recorder stopped reporting levels — it may have died. */
  stale: boolean;
}

export const nativeRecorder = {
  start: (title: string) => invoke<void>("start_recording", { title }),
  stop: () => invoke<string>("stop_recording"),
  isRecording: () => invoke<boolean>("is_recording"),
  /** Polled while recording, to prove on screen that both sources are alive. */
  status: () => invoke<CaptureStatus>("capture_status"),
};
