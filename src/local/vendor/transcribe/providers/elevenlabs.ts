// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/providers/elevenlabs.ts by cli/scripts/sync-local.mjs. Do not edit here.
/** ElevenLabs Scribe `/v1/speech-to-text`: word timestamps grouped into segments. */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { joinUrl, ProviderError, requestJson } from "./http.js";
import { groupWordsIntoSegments, toTimeline } from "../chunking.js";
import type { AudioInput, EngineOutput } from "./common.js";

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
export const ELEVENLABS_DEFAULT_MODEL = "scribe_v2";

const Answer = z
  .object({
    language_code: z.string().nullish(),
    text: z.string().optional(),
    words: z
      .array(z.object({ text: z.string(), start: z.number().nullish(), end: z.number().nullish(), type: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

export async function transcribeElevenLabs(
  input: AudioInput,
  config: { apiKey: string; model?: string; baseUrl?: string },
): Promise<EngineOutput> {
  const provider = "elevenlabs";
  const model = config.model || ELEVENLABS_DEFAULT_MODEL;
  const audio = await readFile(input.wavPath);
  const form = new FormData();
  form.append("model_id", model);
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "audio.wav");
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "false");
  const raw = await requestJson(
    provider,
    joinUrl(config.baseUrl || ELEVENLABS_BASE_URL, "v1/speech-to-text"),
    { method: "POST", headers: { "xi-api-key": config.apiKey }, body: form },
    input.signal,
  );
  const parsed = Answer.safeParse(raw);
  if (!parsed.success) throw new ProviderError(provider, 200, "unexpected answer shape");
  // Words come with "spacing" entries between them; keep only words, times in seconds.
  const words = (parsed.data.words ?? [])
    .filter((w) => (w.type ?? "word") === "word" && typeof w.start === "number" && typeof w.end === "number")
    .map((w) => ({ start: w.start as number, end: w.end as number, text: w.text }));
  input.onProgress?.(1);
  return {
    segments: toTimeline(groupWordsIntoSegments(words)),
    language: parsed.data.language_code ?? undefined,
    engine: `elevenlabs:${model}`,
    gaps: [],
  };
}
