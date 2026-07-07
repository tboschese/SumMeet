import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root, independent of cwd (apps/api/src -> three levels up).
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");

// DATA_DIR from env (SPEC Appendix B), resolved to an absolute path against the
// repo root when relative, so it points at the same ./data no matter the cwd.
const rawDataDir = process.env.DATA_DIR ?? "./data";
export const DATA_DIR = path.isAbsolute(rawDataDir)
  ? rawDataDir
  : path.resolve(REPO_ROOT, rawDataDir);

// Recordings live under ./data/audio/ (SPEC §7.7).
export const AUDIO_DIR = path.join(DATA_DIR, "audio");
