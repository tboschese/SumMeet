import {
  AUTO_DETECT,
  isKnownLanguage,
  MATCH_MEETING,
  SettingsSchema,
} from "@summeet/core";
import type { FastifyInstance } from "fastify";
import { getSettings, saveSettings } from "../settings.js";

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
  app.get("/api/settings", async () => getSettings());

  app.put("/api/settings", async (request, reply) => {
    const parsed = SettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid settings payload" });
    }
    const { transcriptionLanguage, outputLanguage } = parsed.data;
    const problem = validate(transcriptionLanguage, outputLanguage);
    if (problem) return reply.code(400).send({ error: problem });

    return saveSettings(parsed.data);
  });
}
