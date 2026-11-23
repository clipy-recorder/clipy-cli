// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/providers/gemini.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * Google Gemini `generateContent` with the audio inline, asked for JSON
 * segments. Gemini is a general model, not a speech recognizer, so its
 * timestamps are approximate; pieces are kept short to keep them close, and
 * every answer is validated before use.
 */
import { z } from "zod";
import { joinUrl, ProviderError, requestJson } from "./http.js";
import { runInPieces, type AudioInput, type EngineOutput } from "./common.js";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";

const PROMPT =
  "Transcribe all speech in this audio, verbatim, in the language spoken. " +
  'Answer with JSON only: {"language": "<ISO 639-1 code>", "segments": [{"start": <seconds>, "end": <seconds>, "text": "<words>"}]}. ' +
  "Times are seconds from the start of this audio. Make one segment per sentence or per pause, at most 15 seconds each, in order. " +
  'If there is no speech, answer {"segments": []}.';

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    language: { type: "STRING" },
    segments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { start: { type: "NUMBER" }, end: { type: "NUMBER" }, text: { type: "STRING" } },
        required: ["start", "end", "text"],
      },
    },
  },
  required: ["segments"],
};

/** Seconds as a number, or "SS", "MM:SS", "HH:MM:SS(.ms)" strings the model sometimes writes. */
const Seconds = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const parts = v.trim().replace(/s$/, "").split(":").map(Number);
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !Number.isFinite(p))) return v;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}, z.number().finite().nonnegative());

export const GeminiTranscript = z.object({
  language: z.string().optional(),
  segments: z.array(z.object({ start: Seconds, end: Seconds, text: z.string() })),
});

const Answer = z
  .object({
    candidates: z
      .array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() }).passthrough()).optional() }).passthrough().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

/** Pull the JSON object out of a reply, tolerating a ```json fence. */
function parseReply(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  return JSON.parse(body);
}

export async function transcribeGemini(
  input: AudioInput,
  config: { apiKey: string; model?: string; baseUrl?: string },
  limits: { maxSec?: number; targetSec?: number } = {},
): Promise<EngineOutput> {
  const provider = "gemini";
  const model = config.model || GEMINI_DEFAULT_MODEL;
  const url = joinUrl(config.baseUrl || GEMINI_BASE_URL, `models/${encodeURIComponent(model)}:generateContent`);
  // Inline requests are capped at 20 MB; 5 minutes of WAV is about 13 MB once base64 encoded.
  const maxSec = limits.maxSec ?? 300;
  const targetSec = limits.targetSec ?? 240;
  const { segments, language, gaps } = await runInPieces(input, { maxSec, targetSec }, async (wav, durSec) => {
    const body = {
      contents: [
        {
          role: "user",
          parts: [{ inline_data: { mime_type: "audio/wav", data: wav.toString("base64") } }, { text: PROMPT }],
        },
      ],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
    };
    const raw = await requestJson(
      provider,
      url,
      { method: "POST", headers: { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" }, body: JSON.stringify(body) },
      input.signal,
    );
    const answer = Answer.safeParse(raw);
    const text = answer.success ? (answer.data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("") : "";
    if (!text.trim()) throw new ProviderError(provider, 200, "the answer had no transcript");
    let json: unknown;
    try {
      json = parseReply(text);
    } catch {
      throw new ProviderError(provider, 200, "the answer was not valid JSON");
    }
    const parsed = GeminiTranscript.safeParse(json);
    if (!parsed.success) throw new ProviderError(provider, 200, "the answer did not match the transcript format");
    return {
      language: parsed.data.language || undefined,
      segments: parsed.data.segments
        .filter((s) => s.text.trim() && s.start <= durSec + 1)
        .map((s) => {
          const start = Math.min(s.start, durSec);
          return { start, end: Math.min(Math.max(s.end, start), durSec), text: s.text };
        }),
    };
  });
  return { segments, language, engine: `gemini:${model}`, gaps };
}
