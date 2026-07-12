import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where configuration comes from depends on how the API is running.
//
// Packaged inside the .app there is no repo: the server lives in Contents/Resources, so
// a repo-relative .env resolves to nothing and every key, model path and engine URL
// silently falls back to its default. The user's config belongs beside their data, in
// ~/Library/Application Support/SumMeet (DATA_DIR, handed to us by the shell).
//
// In a dev tree the repo-root .env is the one that matters. Load both — dotenv never
// overwrites what is already set, so the data dir wins where the two disagree, and
// neither file has to exist.
const dataDir = process.env.DATA_DIR;
if (dataDir) config({ path: path.join(dataDir, ".env") });

// Repo root, from this file's location (apps/api/src -> three levels up).
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env") });
