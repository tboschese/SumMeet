// Pure audio-input validation shared by the API (upload guard) and the web
// (pre-upload check). No Node/DOM deps so it's safe to import in the browser.

export const ACCEPTED_AUDIO_EXTENSIONS = [
  ".webm",
  ".m4a",
  ".mp3",
  ".wav",
  ".ogg",
  ".opus",
  ".aac",
  ".flac",
  ".mp4", // some recorders emit audio in an mp4 container
] as const;

// 500 MB — a long meeting, comfortably. Keep in sync with the server limit.
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

function hasAcceptedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Accept if the mimetype is audio/*, or webm/mp4 (browsers label recorded
 * audio blobs as video/webm), or the filename carries an accepted extension.
 */
export function isAcceptedAudio(filename: string, mimetype?: string): boolean {
  const mt = (mimetype ?? "").toLowerCase();
  if (mt.startsWith("audio/")) return true;
  if (mt === "video/webm" || mt === "video/mp4") return true;
  return hasAcceptedExtension(filename);
}

export const ACCEPTED_AUDIO_HINT = ACCEPTED_AUDIO_EXTENSIONS.join(", ");
