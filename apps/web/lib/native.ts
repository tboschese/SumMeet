// Bridge to the native desktop shell (SPEC A7).
//
// The same panel runs in a browser and inside the Tauri window. In the browser we
// capture a tab; in the native shell the OS gives us the whole system audio mix,
// so there's no tab picker and desktop meeting clients work too.
//
// `withGlobalTauri` exposes __TAURI__ on window, so the web app needs no npm
// dependency on Tauri and still builds/ships as a plain website.

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Tauri v2 exposes invoke at `__TAURI__.core.invoke`, but depending on version and
 * build it can also land at `__TAURI__.invoke`. Reading only the first shape means
 * the global is present, `isNativeShell()` says yes, and then every command throws
 * on `undefined.invoke` — which looks exactly like a dead Record button.
 */
function tauriInvoke(): InvokeFn | null {
  if (typeof window === "undefined") return null;
  const g = (window as unknown as {
    __TAURI__?: { core?: { invoke?: InvokeFn }; invoke?: InvokeFn };
  }).__TAURI__;
  return g?.core?.invoke ?? g?.invoke ?? null;
}

/** True when running inside the desktop app rather than a browser tab. */
export function isNativeShell(): boolean {
  return tauriInvoke() !== null;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const fn = tauriInvoke();
  if (!fn) throw new Error("not running in the desktop app");
  return fn<T>(cmd, args);
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
  /** Mic peak this window; near 1.0 means the input is clipping. */
  mic_peak: number;
  elapsed_secs: number;
  /** The recorder stopped reporting levels — it may have died. */
  stale: boolean;
}

/** An audio input the OS can capture from. */
export interface Microphone {
  id: string;
  name: string;
  default: boolean;
}

export const nativeRecorder = {
  start: (title: string, micDeviceId?: string) =>
    invoke<void>("start_recording", { title, micDeviceId: micDeviceId ?? null }),
  stop: () => invoke<string>("stop_recording"),
  isRecording: () => invoke<boolean>("is_recording"),
  /** Polled while recording, to prove on screen that both sources are alive. */
  status: () => invoke<CaptureStatus>("capture_status"),
  /** The input devices to offer in the picker; the default is flagged. */
  microphones: () => invoke<Microphone[]>("list_microphones"),
};
