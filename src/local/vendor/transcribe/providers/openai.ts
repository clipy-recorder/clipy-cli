// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/providers/openai.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * Any OpenAI-compatible `/audio/transcriptions` endpoint: OpenAI (`whisper-1`),
 * Groq (`whisper-large-v3-turbo`, `whisper-large-v3`), or a self-hosted server
 * speaking the same API. Segment timestamps need `response_format=verbose_json`,
 * which OpenAI's `gpt-4o-*-transcribe` models do not offer; they would come
 * back as one segment per piece.
 */
import { z } from "zod";
import { joinUrl, ProviderError, requestJson } from "./http.js";
import { maxSecForBytes, runInPieces, wholePieceSegment, type AudioInput, type EngineOutput } from "./common.js";

/** OpenAI rejects uploads over 25 MB; stay under it with room for the form. */
export const OPENAI_MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

const VerboseJson = z.object({
  text: z.string().optional(),
  language: z.string().optional(),
  segments: z
    .array(z.object({ start: z.number(), end: z.number(), text: z.string() }).passthrough())
    .nullish(),
});

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export async function transcribeOpenAICompatible(
  input: AudioInput,
  config: OpenAICompatibleConfig,
  limits: { maxUploadBytes?: number } = {},
): Promise<EngineOutput> {
  const provider = "openai-compatible";
  const maxSec = maxSecForBytes(limits.maxUploadBytes ?? OPENAI_MAX_UPLOAD_BYTES);
  const url = joinUrl(config.baseUrl, "audio/transcriptions");
  const { segments, language, gaps } = await runInPieces(input, { maxSec, targetSec: Math.min(600, Math.floor(maxSec * 0.8)) }, async (wav, durSec) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("model", config.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    const headers: Record<string, string> = {};
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const raw = await requestJson(provider, url, { method: "POST", headers, body: form }, input.signal);
    const parsed = VerboseJson.safeParse(raw);
    if (!parsed.success) throw new ProviderError(provider, 200, "unexpected answer shape");
    const segs = parsed.data.segments;
    return {
      language: parsed.data.language,
      segments:
        segs && segs.length > 0
          ? segs.map((s) => ({ start: s.start, end: s.end, text: s.text }))
          : wholePieceSegment(parsed.data.text ?? "", durSec),
    };
  });
  return { segments, language, engine: `openai-compatible:${config.model}`, gaps };
}
