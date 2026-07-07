import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load the single repo-root .env regardless of the process's cwd.
// (apps/api/src -> repo root is three levels up.)
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env") });
