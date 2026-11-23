// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/providers/assemblyai.ts by cli/scripts/sync-local.mjs. Do not edit here.
/** AssemblyAI: upload the audio, start a transcript job, poll until it finishes. */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { joinUrl, ProviderError, requestJson, sleep } from "./http.js";
import { groupWordsIntoSegments, toTimeline } from "../chunking.js";
import type { AudioInput, EngineOutput } from "./common.js";

export const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com";

const Upload = z.object({ upload_url: z.string() });
const Job = z
  .object({
    id: z.string(),
    status: z.string(),
    language_code: z.string().nullish(),
    words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() }).passthrough()).nullish(),
    utterances: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() }).passthrough()).nullish(),
  })
  .passthrough();

export interface AssemblyAILimits {
  pollIntervalMs?: number;
  /** Give up after this long; long recordings take a while to process. */
  timeoutMs?: number;
}

export async function transcribeAssemblyAI(
  input: AudioInput,
  config: { apiKey: string; model?: string; baseUrl?: string },
  limits: AssemblyAILimits = {},
): Promise<EngineOutput> {
  const provider = "assemblyai";
  const base = config.baseUrl || ASSEMBLYAI_BASE_URL;
  const auth = { authorization: config.apiKey };
  const pollMs = limits.pollIntervalMs ?? 3000;
  const timeoutMs = limits.timeoutMs ?? 60 * 60 * 1000;

  const audio = await readFile(input.wavPath);
  const up = Upload.safeParse(
    await requestJson(
      provider,
      joinUrl(base, "v2/upload"),
      { method: "POST", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: new Uint8Array(audio) },
      input.signal,
    ),
  );
  if (!up.success) throw new ProviderError(provider, 200, "upload answer had no upload_url");
  input.onProgress?.(0.2);

  const body: Record<string, unknown> = { audio_url: up.data.upload_url, language_detection: true };
  if (config.model) body.speech_models = [config.model];
  const created = Job.safeParse(
    await requestJson(
      provider,
      joinUrl(base, "v2/transcript"),
      { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) },
      input.signal,
    ),
  );
  if (!created.success) throw new ProviderError(provider, 200, "unexpected answer shape");

  const started = Date.now();
  let job = created.data;
  while (job.status !== "completed") {
    if (job.status === "error") throw new ProviderError(provider, undefined, "the provider reported an error for this audio");
    if (Date.now() - started > timeoutMs) throw new ProviderError(provider, undefined, "timed out waiting for the transcript");
    await sleep(pollMs, input.signal);
    const next = Job.safeParse(
      await requestJson(provider, joinUrl(base, `v2/transcript/${encodeURIComponent(job.id)}`), { headers: auth }, input.signal),
    );
    if (!next.success) throw new ProviderError(provider, 200, "unexpected answer shape");
    job = next.data;
    input.onProgress?.(Math.min(0.95, 0.2 + (Date.now() - started) / Math.max(60_000, input.info.durationSec * 300)));
  }

  // Times are milliseconds.
  const segments =
    job.utterances && job.utterances.length > 0
      ? job.utterances.map((u) => ({ start: u.start / 1000, end: u.end / 1000, text: u.text }))
      : groupWordsIntoSegments((job.words ?? []).map((w) => ({ start: w.start / 1000, end: w.end / 1000, text: w.text })));
  input.onProgress?.(1);
  return {
    segments: toTimeline(segments),
    language: job.language_code ?? undefined,
    engine: `assemblyai${config.model ? `:${config.model}` : ""}`,
    gaps: [],
  };
}
