import {
  AUTO_DETECT,
  isKnownLanguage,
  MATCH_MEETING,
  SettingsUpdateSchema,
} from "@summeet/core";
import type { FastifyInstance } from "fastify";
import { getLocalStatus } from "../local-status.js";
import { getSettingsView, saveSettings } from "../settings.js";

/** "auto"/"match" sentinels, or a language we actually offer. */
function validate(
  transcriptionLanguage: string,
  outputLanguage: string,
): string | null {
  if (transcriptionLanguage !== AUTO_DETECT && !isKnownLanguage(transcriptionLanguage)) {
    return `unsupported transcription language: ${transcriptionLanguage}`;
  }
  if (outputLanguage !== MATCH_MEETING && !isKnownLanguage(outputLanguage)) {
    return `unsupported output language: ${outputLanguage}`;
  }
  return null;
}

export function registerSettingsRoutes(app: FastifyInstance): void {
  // Returns hasGroqApiKey, never the key itself.
  app.get("/api/settings", async () => getSettingsView());

  // Is the free/offline engine actually installed and ready?
  app.get("/api/settings/local-status", async () => getLocalStatus());

  app.put("/api/settings", async (request, reply) => {
    const parsed = SettingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid settings payload" });
    }
    const { transcriptionLanguage, outputLanguage } = parsed.data;
    const problem = validate(transcriptionLanguage, outputLanguage);
    if (problem) return reply.code(400).send({ error: problem });

    // groqApiKey is write-only: omitted = unchanged, "" = cleared.
    return saveSettings(parsed.data);
  });
}
