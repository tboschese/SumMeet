import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import {
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  WHISPER_BIN,
  WHISPER_MODEL_PATH,
} from "./context.js";

export interface LocalStatus {
  whisper: {
    ready: boolean;
    binaryFound: boolean;
    modelFound: boolean;
    binary: string;
    modelPath: string;
  };
  ollama: {
    ready: boolean;
    serverUp: boolean;
    modelPulled: boolean;
    model: string;
    baseUrl: string;
    availableModels: string[];
  };
}

function binaryExists(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [bin]);
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function fileExists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/** Probe whether the free/offline engines are actually usable right now. */
export async function getLocalStatus(): Promise<LocalStatus> {
  const [binaryFound, modelFound] = await Promise.all([
    binaryExists(WHISPER_BIN),
    fileExists(WHISPER_MODEL_PATH),
  ]);

  let serverUp = false;
  let availableModels: string[] = [];
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      serverUp = true;
      const data = (await res.json()) as { models?: { name: string }[] };
      availableModels = (data.models ?? []).map((m) => m.name);
    }
  } catch {
    serverUp = false;
  }

  // Ollama tags come back as "llama3.1:8b"; accept a bare-name match too.
  const modelPulled = availableModels.some(
    (m) => m === OLLAMA_MODEL || m.split(":")[0] === OLLAMA_MODEL.split(":")[0],
  );

  return {
    whisper: {
      ready: binaryFound && modelFound,
      binaryFound,
      modelFound,
      binary: WHISPER_BIN,
      modelPath: WHISPER_MODEL_PATH,
    },
    ollama: {
      ready: serverUp && modelPulled,
      serverUp,
      modelPulled,
      model: OLLAMA_MODEL,
      baseUrl: OLLAMA_BASE_URL,
      availableModels,
    },
  };
}
