// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/index.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * @clipy/transcribe: a recording's speech as timestamped segments.
 *
 * - `none`: no transcript; the result has one gap over the whole file.
 * - `local`: a downloaded model run on this machine (nothing leaves it).
 * - every other kind: the audio is sent to that provider with the user's key.
 *
 * Nothing here logs. Errors name the provider and HTTP status, never a key,
 * a response body or transcript text.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAudio, NoAudioTrackError, probeMedia, readWavInfo, throwIfAborted } from "./audio.js";
import { transcribeLocal } from "./local.js";
import { transcribeAssemblyAI } from "./providers/assemblyai.js";
import { audioInputFor, type AudioInput, type EngineOutput } from "./providers/common.js";
import { transcribeDeepgram } from "./providers/deepgram.js";
import { transcribeElevenLabs } from "./providers/elevenlabs.js";
import { transcribeGemini } from "./providers/gemini.js";
import { transcribeOpenAICompatible } from "./providers/openai.js";
import type { TranscribeOptions, TranscribeResult, TranscriptGap, TranscriptionConfig } from "./types.js";

export type {
  LocalModelId,
  TranscribeOptions,
  TranscribeProgress,
  TranscribeResult,
  TranscriptGap,
  TranscriptionConfig,
  TranscriptSegment,
} from "./types.js";
export { extractAudio, NoAudioTrackError } from "./audio.js";
export { defaultModelDir, downloadModel, LOCAL_MODELS, modelStatus, ChecksumError, DownloadTooLargeError, type LocalModel, type ModelFile } from "./models.js";
export { ModelNotInstalledError } from "./local.js";
export { ProviderError } from "./providers/http.js";

/** Transcribe a video or audio file. The audio is extracted to a temporary folder that is always removed. */
export async function transcribe(inputPath: string, config: TranscriptionConfig, options: TranscribeOptions = {}): Promise<TranscribeResult> {
  const { signal, onProgress } = options;
  throwIfAborted(signal);
  onProgress?.({ stage: "extract", fraction: 0 });
  // Nothing to extract: only the length is needed (and a video-only file has no audio to extract).
  if (config.kind === "none") {
    const totalMs = await durationMs(inputPath, signal);
    onProgress?.({ stage: "extract", fraction: 1 });
    return { segments: [], engine: "none", gaps: wholeFileGap(totalMs, "transcription off") };
  }
  const dir = await mkdtemp(join(tmpdir(), "clipy-transcribe-"));
  try {
    const wavPath = join(dir, "audio.wav");
    try {
      await extractAudio(inputPath, wavPath, signal);
    } catch (err) {
      if (!(err instanceof NoAudioTrackError)) throw err;
      const totalMs = await durationMs(inputPath, signal);
      onProgress?.({ stage: "extract", fraction: 1 });
      return { segments: [], engine: "none", gaps: wholeFileGap(totalMs, "no audio track") };
    }
    const info = await readWavInfo(wavPath);
    onProgress?.({ stage: "extract", fraction: 1 });

    const input = audioInputFor(wavPath, info, signal, (fraction) => onProgress?.({ stage: "transcribe", fraction }));
    input.onProgress?.(0);
    const out: EngineOutput = await runEngine(input, config, options);
    return { segments: out.segments, engine: out.engine, ...(out.language ? { language: out.language } : {}), gaps: out.gaps };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function durationMs(inputPath: string, signal?: AbortSignal): Promise<number> {
  const { durationSec } = await probeMedia(inputPath, signal);
  return durationSec !== null && durationSec > 0 ? Math.round(durationSec * 1000) : 0;
}

function wholeFileGap(totalMs: number, reason: string): TranscriptGap[] {
  return totalMs > 0 ? [{ startMs: 0, endMs: totalMs, reason }] : [];
}

function runEngine(input: AudioInput, config: Exclude<TranscriptionConfig, { kind: "none" }>, options: TranscribeOptions): Promise<EngineOutput> {
  switch (config.kind) {
    case "local":
      return transcribeLocal(input, config.model, options.modelDir, options.speechEngine);
    case "openai-compatible":
      return transcribeOpenAICompatible(input, config);
    case "deepgram":
      return transcribeDeepgram(input, config);
    case "assemblyai":
      return transcribeAssemblyAI(input, config);
    case "elevenlabs":
      return transcribeElevenLabs(input, config);
    case "gemini":
      return transcribeGemini(input, config);
    default: {
      const kind = (config as { kind?: unknown }).kind;
      throw new Error(`Unknown transcription kind "${String(kind)}"`);
    }
  }
}
