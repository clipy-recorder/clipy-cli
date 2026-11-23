// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/chunking.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * Pure planning and merging for chunked transcription: where to cut a long
 * recording (inside silences, so no word is split), and how to put the
 * pieces' segments back on one timeline. No I/O, so it is unit tested on its
 * own.
 *
 * Adapted from Clipy's hosted transcription worker, with one difference: the
 * hosted service falls back to a model with no length limit when no clean cut
 * exists, and the local edition has no such fallback, so the planner here
 * always returns a plan whose pieces fit the engine's hard limit, cutting
 * mid-audio when a stretch has no silence at all.
 */
import type { TranscriptSegment } from "./types.js";

export interface SilenceSpan {
  startSec: number;
  endSec: number;
}

const START_RE = /silence_start:\s*(-?[0-9.]+)/;
const END_RE = /silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/;

/**
 * Parse ffmpeg `silencedetect` stderr. A silence still open at the end of the
 * file is closed at `totalSec` when given.
 */
export function parseSilencedetectOutput(output: string, totalSec?: number): SilenceSpan[] {
  const spans: SilenceSpan[] = [];
  let open: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    const start = START_RE.exec(line);
    if (start) {
      open = Math.max(0, Number(start[1]));
      continue;
    }
    const end = END_RE.exec(line);
    if (!end) continue;
    const endSec = Number(end[1]);
    const startSec = open ?? endSec - Number(end[2]);
    open = null;
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) {
      spans.push({ startSec: Math.max(0, startSec), endSec });
    }
  }
  if (open !== null && totalSec !== undefined && totalSec > open) {
    spans.push({ startSec: open, endSec: totalSec });
  }
  return spans;
}

export interface ChunkPlanOptions {
  /** Preferred length of a piece. */
  targetSec: number;
  /** Hard limit on the audio handed to the engine, overlap included. */
  maxSec: number;
  /** Padding added on both sides of every cut, so a word at a seam is whole in one piece. */
  overlapSec: number;
  /** Never cut closer than this to the previous cut. */
  minSec: number;
}

export interface ChunkPlan {
  index: number;
  /** Audio handed to the engine: [extractStartSec, extractStartSec + extractDurSec). */
  extractStartSec: number;
  extractDurSec: number;
  /** The core this piece owns; a segment is kept only when its centre falls inside. */
  keepStartSec: number;
  keepEndSec: number;
  /** True when no silence was near and the piece was cut mid-audio. */
  hardCut: boolean;
}

/**
 * Plan pieces no longer than `maxSec`, cut at silence midpoints near
 * `targetSec`. A recording that fits in one piece is one piece. Every piece's
 * extract length is at most `maxSec`.
 */
export function planChunks(silences: SilenceSpan[], totalSec: number, opts: ChunkPlanOptions): ChunkPlan[] {
  const { targetSec, overlapSec, maxSec } = opts;
  if (!(totalSec > 0)) return [];
  if (totalSec <= maxSec) {
    return [{ index: 0, extractStartSec: 0, extractDurSec: totalSec, keepStartSec: -Infinity, keepEndSec: Infinity, hardCut: false }];
  }
  // An inner piece carries overlap on both sides, the first and last on one.
  const innerCore = maxSec - 2 * overlapSec;
  if (!(innerCore > 0)) throw new Error("chunk overlap leaves no room for audio");

  const mids = silences
    .filter((s) => s.endSec > s.startSec)
    .map((s) => (s.startSec + s.endSec) / 2)
    .filter((m) => m > 0 && m < totalSec)
    .sort((a, b) => a - b);

  const cuts: Array<{ at: number; hard: boolean }> = [];
  let pos = 0;
  for (;;) {
    const remaining = totalSec - pos;
    if (pos > 0 && remaining + overlapSec <= maxSec) break; // the rest is the last piece
    const coreLimit = pos === 0 ? maxSec - overlapSec : innerCore;
    const minSec = Math.min(opts.minSec, coreLimit / 2);
    const lo = pos + minSec;
    const hi = pos + coreLimit;
    const target = pos + Math.min(targetSec, coreLimit);
    let best: number | null = null;
    for (const m of mids) {
      if (m < lo || m > hi) continue;
      if (best === null || Math.abs(m - target) < Math.abs(best - target)) best = m;
    }
    const at = best ?? target;
    cuts.push({ at, hard: best === null });
    pos = at;
  }

  const bounds = [0, ...cuts.map((c) => c.at), totalSec];
  const plan: ChunkPlan[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const coreStart = bounds[i];
    const coreEnd = bounds[i + 1];
    const extractStartSec = Math.max(0, coreStart - overlapSec);
    const extractEndSec = Math.min(totalSec, coreEnd + overlapSec);
    plan.push({
      index: i,
      extractStartSec,
      extractDurSec: extractEndSec - extractStartSec,
      keepStartSec: i === 0 ? -Infinity : coreStart,
      keepEndSec: i === bounds.length - 2 ? Infinity : coreEnd,
      hardCut: (i > 0 && cuts[i - 1].hard) || (i < cuts.length && cuts[i].hard),
    });
  }
  return plan;
}

/** Seconds of [startSec, endSec) not covered by any silence. */
export function speechSecIn(silences: SilenceSpan[], startSec: number, endSec: number): number {
  let silent = 0;
  for (const s of silences) {
    const a = Math.max(startSec, s.startSec);
    const b = Math.min(endSec, s.endSec);
    if (b > a) silent += b - a;
  }
  return Math.max(0, endSec - startSec - silent);
}

/** Shrink [startSec, endSec) past silences touching either edge. */
export function trimToSpeech(silences: SilenceSpan[], startSec: number, endSec: number): { startSec: number; endSec: number } {
  let a = startSec;
  let b = endSec;
  for (const s of silences) {
    if (s.startSec <= a && s.endSec > a) a = Math.min(s.endSec, b);
    if (s.startSec < b && s.endSec >= b) b = Math.max(s.startSec, a);
  }
  return { startSec: a, endSec: b };
}

/** Segments of one piece, in seconds relative to that piece's audio. */
export interface RelativeSegment {
  start: number;
  end: number;
  text: string;
}

export interface PieceResult {
  plan: ChunkPlan;
  segments: RelativeSegment[];
}

/**
 * Put every piece's segments on the recording's timeline, keep each segment
 * only from the piece whose core holds its centre (so overlap is never
 * transcribed twice), then sort and nudge so segments never overlap.
 */
export function mergePieces(pieces: PieceResult[]): TranscriptSegment[] {
  const kept: Array<{ start: number; end: number; text: string }> = [];
  for (const { plan, segments } of pieces) {
    for (const s of segments) {
      const start = s.start + plan.extractStartSec;
      const end = Math.max(s.end, s.start) + plan.extractStartSec;
      const centre = (start + end) / 2;
      if (centre < plan.keepStartSec || centre >= plan.keepEndSec) continue;
      const text = s.text.trim();
      if (text) kept.push({ start, end, text });
    }
  }
  kept.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: TranscriptSegment[] = [];
  for (const s of kept) {
    const prev = out[out.length - 1];
    let startMs = Math.round(s.start * 1000);
    if (prev && startMs < prev.endMs) startMs = prev.endMs;
    const endMs = Math.max(Math.round(s.end * 1000), startMs);
    out.push({ startMs, endMs, text: s.text });
  }
  return out;
}

/** Split into a new segment after a pause this long, or once a segment runs this long. */
export const SEGMENT_GAP_SEC = 0.8;
export const SEGMENT_MAX_SEC = 18;
/** The recognizer reports when a token starts; a word ends a short tail after its last token. */
const TOKEN_TAIL_SEC = 0.4;

/**
 * Group sub-word tokens (with their start times) into segments, the way the
 * hosted service does: a long pause or a long run starts a new segment.
 * Punctuation never starts a segment (CTC models often emit the full stop
 * after the pause that follows it), and a long run is only split where a new
 * word begins.
 */
export function groupTokensIntoSegments(tokens: string[], timestamps: number[]): RelativeSegment[] {
  const segs: RelativeSegment[] = [];
  let cur: string[] = [];
  let segStart = timestamps[0] ?? 0;
  let prev = segStart;
  const flush = () => {
    const text = cur.join("").replace(/\s+/g, " ").trim();
    if (text) segs.push({ start: segStart, end: Math.max(prev + TOKEN_TAIL_SEC, segStart), text });
    cur = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const t = typeof timestamps[i] === "number" && Number.isFinite(timestamps[i]) ? timestamps[i] : prev;
    if (cur.length > 0 && !/[\p{L}\p{N}]/u.test(token)) {
      cur.push(token);
      continue;
    }
    const startsWord = /^\s/.test(token);
    if (cur.length > 0 && (t - prev > SEGMENT_GAP_SEC || (startsWord && t - segStart > SEGMENT_MAX_SEC))) {
      flush();
    }
    if (cur.length === 0) segStart = t;
    cur.push(token);
    prev = t;
  }
  flush();
  // The tail must not run into the next segment.
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i].end > segs[i + 1].start) segs[i].end = Math.max(segs[i].start, segs[i + 1].start);
  }
  return segs;
}

/**
 * The tokens a piece owns, on the recording's timeline: those whose start
 * falls in the piece's core. Merging at token level (rather than segment
 * level) means a sentence that runs across a cut is never kept twice.
 */
export function tokensInCore(plan: ChunkPlan, tokens: string[], timestamps: number[]): Array<{ token: string; t: number }> {
  const out: Array<{ token: string; t: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const rel = timestamps[i];
    if (typeof rel !== "number" || !Number.isFinite(rel)) continue;
    const t = rel + plan.extractStartSec;
    if (t < plan.keepStartSec || t >= plan.keepEndSec) continue;
    out.push({ token: tokens[i], t });
  }
  return out;
}

/** Segments that are already on the recording's timeline (seconds) as sorted, non-overlapping ms segments. */
export function toTimeline(segments: RelativeSegment[]): TranscriptSegment[] {
  return mergePieces([
    { plan: { index: 0, extractStartSec: 0, extractDurSec: Infinity, keepStartSec: -Infinity, keepEndSec: Infinity, hardCut: false }, segments },
  ]);
}

export interface TimedWord {
  /** Seconds. */
  start: number;
  end: number;
  text: string;
}

const SENTENCE_END = /[.!?。！？]["')\]]*$/;

/**
 * Group words into readable segments: break at a sentence end once a segment
 * has a few seconds in it, at a long pause, or once it runs too long.
 */
export function groupWordsIntoSegments(words: TimedWord[], joiner = " "): RelativeSegment[] {
  const segs: RelativeSegment[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const text = cur
      .map((w) => w.text.trim())
      .filter(Boolean)
      .join(joiner)
      .replace(/\s+([,.!?;:])/g, "$1")
      .trim();
    if (text) segs.push({ start: cur[0].start, end: Math.max(cur[cur.length - 1].end, cur[0].start), text });
    cur = [];
  };
  for (const w of words) {
    if (!w.text.trim()) continue;
    const last = cur[cur.length - 1];
    if (last && (w.start - last.end > SEGMENT_GAP_SEC || w.end - cur[0].start > SEGMENT_MAX_SEC)) flush();
    cur.push(w);
    if (SENTENCE_END.test(w.text.trim()) && w.end - cur[0].start >= 3) flush();
  }
  flush();
  return segs;
}
