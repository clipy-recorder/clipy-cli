// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/providers/common.ts by cli/scripts/sync-local.mjs. Do not edit here.
import { readFile } from "node:fs/promises";
import { BYTES_PER_SECOND, detectSilences, measureMeanVolume, readWavSlice, silenceThresholds, throwIfAborted, type WavInfo } from "../audio.js";
import { mergePieces, planChunks, speechSecIn, trimToSpeech, type ChunkPlan, type RelativeSegment, type SilenceSpan } from "../chunking.js";
import type { TranscriptGap, TranscriptSegment } from "../types.js";

/** What every engine is handed: the extracted 16 kHz mono WAV and a way to find its silences. */
export interface AudioInput {
  wavPath: string;
  info: WavInfo;
  /** Silence spans (pauses to cut at, and to trim segment edges), computed once on first use. */
  silences: () => Promise<SilenceSpan[]>;
  /**
   * Spans quiet enough that no speech can be in them, a much stricter test
   * than `silences`. A piece is skipped only when these cover it. Absent:
   * nothing is skipped.
   */
  noSpeech?: () => Promise<SilenceSpan[]>;
  /** Whether the recording as a whole is quiet (see silenceThresholds). Absent: not quiet. */
  quiet?: () => Promise<boolean>;
  signal?: AbortSignal;
  /** 0..1 over the transcription stage. */
  onProgress?: (fraction: number) => void;
}

/**
 * The AudioInput for an extracted WAV. Both silence lists are computed at
 * most once, with thresholds that follow the recording's own loudness, so
 * quiet speech is not taken for silence.
 */
export function audioInputFor(wavPath: string, info: WavInfo, signal?: AbortSignal, onProgress?: (fraction: number) => void): AudioInput {
  type Levels = ReturnType<typeof silenceThresholds>;
  let levels: Promise<Levels> | null = null;
  const thresholds = () => (levels ??= measureMeanVolume(wavPath, signal).then(silenceThresholds));
  const at = (pick: (t: Levels) => number) => {
    let spans: Promise<SilenceSpan[]> | null = null;
    return () =>
      (spans ??= thresholds()
        .then((t) => detectSilences(wavPath, signal, info.durationSec, pick(t)))
        .then((list) => list.map((x) => ({ startSec: x.startSec, endSec: Math.min(x.endSec, info.durationSec) }))));
  };
  return {
    wavPath,
    info,
    signal,
    silences: at((t) => t.splitDb),
    noSpeech: at((t) => t.skipDb),
    quiet: () => thresholds().then((t) => t.quiet),
    onProgress,
  };
}

export interface EngineOutput {
  segments: TranscriptSegment[];
  engine: string;
  language?: string;
  gaps: TranscriptGap[];
}

export interface PieceOutput {
  segments: RelativeSegment[];
  language?: string;
}

export interface ChunkLimits {
  targetSec: number;
  maxSec: number;
}

/** Longest WAV (header included) that fits in `maxBytes`. */
export function maxSecForBytes(maxBytes: number): number {
  return Math.floor((maxBytes - 44) / BYTES_PER_SECOND);
}

/** A piece with less speech than this (outside `noSpeech` spans) is not sent. */
export const MIN_SPEECH_SEC = 0.3;

export const NO_SPEECH_GAP_REASON = "no speech detected";

/**
 * Of a multi-piece plan, the pieces with no speech, which are not sent.
 *
 * - "strict" (Parakeet, which says nothing over noise): only pieces that the
 *   strict `noSpeech` spans cover.
 * - "invents" (Whisper and the hosted providers, which turn fan noise into
 *   "Thank you."): also pieces the ordinary `silences` cover, unless the
 *   recording is quiet, where those spans could hide speech.
 *
 * A recording that is one piece is always transcribed.
 */
export async function piecesWithoutSpeech(input: AudioInput, plan: ChunkPlan[], engine: "strict" | "invents"): Promise<Set<number>> {
  if (plan.length <= 1) return new Set();
  let spans: SilenceSpan[] | null = null;
  if (engine === "invents" && !(await input.quiet?.())) spans = await input.silences();
  else if (input.noSpeech) spans = await input.noSpeech();
  if (!spans) return new Set();
  const quiet = spans;
  return new Set(
    plan.filter((p) => speechSecIn(quiet, p.extractStartSec, p.extractStartSec + p.extractDurSec) < MIN_SPEECH_SEC).map((p) => p.index),
  );
}

/** The part of the timeline a piece owns, as a gap. */
export function pieceGap(p: ChunkPlan, reason: string): TranscriptGap {
  const start = Math.max(p.keepStartSec, p.extractStartSec);
  const end = Math.min(p.keepEndSec, p.extractStartSec + p.extractDurSec);
  return { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), reason };
}

/**
 * Send the audio to a provider in pieces small enough for its upload limit,
 * cut in silences, one piece at a time, and merge the results. A piece with
 * no speech at all is not sent and is reported as a gap.
 */
export async function runInPieces(
  input: AudioInput,
  limits: ChunkLimits,
  run: (wav: Buffer, durSec: number) => Promise<PieceOutput>,
): Promise<{ segments: TranscriptSegment[]; language?: string; gaps: TranscriptGap[] }> {
  const total = input.info.durationSec;
  const silences = total > limits.maxSec ? await input.silences() : [];
  const plan = planChunks(silences, total, { targetSec: limits.targetSec, maxSec: limits.maxSec, overlapSec: 0, minSec: Math.min(15, limits.targetSec / 2) });
  const skip = await piecesWithoutSpeech(input, plan, "invents");
  const pieces: Array<{ plan: (typeof plan)[number]; segments: RelativeSegment[] }> = [];
  const gaps: TranscriptGap[] = [];
  let language: string | undefined;
  for (const [i, p] of plan.entries()) {
    throwIfAborted(input.signal);
    if (skip.has(p.index)) {
      gaps.push(pieceGap(p, NO_SPEECH_GAP_REASON));
      input.onProgress?.((i + 1) / plan.length);
      continue;
    }
    const wav =
      plan.length === 1 ? await readFile(input.wavPath) : await readWavSlice(input.wavPath, input.info, p.extractStartSec, p.extractDurSec);
    const out = await run(wav, p.extractDurSec);
    language ??= out.language;
    pieces.push({ plan: p, segments: out.segments });
    input.onProgress?.((i + 1) / plan.length);
  }
  return { segments: mergePieces(pieces), language, gaps };
}

/** A provider that only returned plain text: one segment over the speech in the piece. */
export function wholePieceSegment(text: string, durSec: number, silences: SilenceSpan[] = []): RelativeSegment[] {
  const t = text.trim();
  if (!t) return [];
  const span = trimToSpeech(silences, 0, durSec);
  return [{ start: span.startSec, end: Math.max(span.endSec, span.startSec), text: t }];
}

export function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
