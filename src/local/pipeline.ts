/**
 * Turns one recording into a local AREC folder, the same layout the Mac app's
 * local mode writes:
 *
 *   recording.mp4          the video (moved or copied in)
 *   recording.cursor.json  interaction sidecar, when there is one
 *   transcript.json        timestamped segments
 *   moments.json           the planned moments
 *   frames/<ms>.jpg        one screenshot per moment, named by timestamp_ms
 *   frames.json            frame index
 *   metadata.json          what ran, how long, where it came from
 *   status.json            transcribing | selecting | extracting | ready | failed
 *   recording.arec         the document an agent reads
 *
 * This is what `clipy record|session|proof|context import --local` run in
 * place of an upload. Nothing here talks to Clipy. The only network traffic is
 * what a configured transcription or model provider does.
 *
 * Notes, marks and proof captions arrive as `narration`: they are added to the
 * transcript (labelled as narration) and each one also gets a key moment and
 * a frame, so an agent sees what the driver pointed out.
 */
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  describePlannerError,
  planMoments,
  type LocalMoment,
  type LocalMomentInput,
  type ModelProvider,
} from "./vendor/moments/index.js";
import { renderLocalArec, type ArecFrame, type ArecInput, type ArecState } from "./arec.js";
import { extractFrame, hasAudioStream, placeVideo, probeDurationMs } from "./media.js";
import type {
  CaptureGeometry,
  Deps,
  LocalConfig,
  TranscribeResult,
  TranscriptSegment,
  TranscriptionConfig,
} from "./ports.js";

export type Stage = "transcribing" | "selecting" | "extracting" | "ready" | "failed";

export interface StatusUpdate {
  stage: Stage;
  message: string;
}

/**
 * A sidecar event. Capture backends write the `InteractionEvent` subset; the
 * Mac sidecar (and the regression fixture) also carry key codes, scroll deltas
 * and annotation flips, which the rules use for Flare and pen detection.
 */
export interface SidecarEvent {
  kind: "move" | "down" | "up" | "scroll" | "key_down" | "key_up" | "annotation";
  time_ms: number;
  x?: number;
  y?: number;
  button?: number;
  key_code?: number;
  delta_x?: number;
  delta_y?: number;
  active?: boolean;
}

/**
 * A note, mark or caption on the recording clock. It becomes a transcript
 * segment (labelled narration) and a key moment with a frame.
 */
export interface NarrationNote {
  startMs: number;
  endMs?: number;
  text: string;
  /** Where to take the frame; defaults to startMs. */
  frameAtMs?: number;
}

export interface ClickElement {
  time_ms: number;
  role: string | null;
  label: string | null;
}

export interface ProcessOptions {
  /** Output folder; created when missing. */
  dir: string;
  /** The recorded or imported video. Placed at `<dir>/recording.mp4`. */
  videoPath: string;
  /** Move the video in rather than copy it (a capture the CLI just made). */
  moveVideo?: boolean;
  /** null or omitted: no sidecar was captured (an imported file). */
  interactions?: readonly SidecarEvent[] | null;
  clickElements?: readonly ClickElement[];
  geometry?: CaptureGeometry | null;
  /** Probed with ffmpeg when omitted. */
  durationMs?: number;
  deps: Pick<Deps, "transcribe">;
  config: Pick<LocalConfig, "model" | "transcription">;
  /** A transcript the user supplied (import --transcript); skips transcription. */
  transcript?: { segments: TranscriptSegment[]; label: string } | null;
  /** Notes, marks and captions; see NarrationNote. */
  narration?: readonly NarrationNote[];
  title?: string;
  description?: string;
  expectedResult?: string;
  recordingKind?: string;
  /** Written into the AREC's Compiler line and metadata.json. */
  compiler?: string;
  origin?: ArecInput["origin"];
  /** Warnings from the capture backend, stated as capture gaps. */
  captureWarnings?: readonly string[];
  ffmpegPath?: string;
  signal?: AbortSignal;
  onStatus?: (update: StatusUpdate) => void;
  now?: () => Date;
}

export interface ProcessResult {
  dir: string;
  arecPath: string;
  durationMs: number;
  planner: "rules" | "rules+model";
  /** Set when a configured model failed and rules ran alone. */
  modelFallback: string | null;
  moments: number;
  frames: number;
  transcriptSegments: number;
  transcriptEngine: string;
  warnings: string[];
}

/** The planner accepts at most this many interaction events (the hosted limit). */
export const MOMENT_EVENT_BUDGET = 8000;
const INTERACTION_SELECTION = "bounded sample; full stream retained locally" as const;
const SIDECAR_KEYS = ["kind", "time_ms", "x", "y", "button", "key_code", "delta_x", "delta_y", "active"] as const;
const MANDATORY_KINDS = new Set(["down", "up", "key_down", "key_up", "annotation"]);

function strideSample<T>(items: readonly T[], budget: number): T[] {
  if (budget <= 0 || items.length === 0) return [];
  const stride = Math.max(1, Math.ceil(items.length / budget));
  const out: T[] = [];
  for (let i = 0; i < items.length && out.length < budget; i += stride) out.push(items[i]);
  return out;
}

function cleanEvent(event: SidecarEvent): SidecarEvent | null {
  if (!Number.isFinite(event.time_ms) || event.time_ms < 0) return null;
  const out: Record<string, unknown> = {};
  for (const key of SIDECAR_KEYS) {
    const value = (event as unknown as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out as unknown as SidecarEvent;
}

/**
 * The planner's interaction input, bounded like the Mac's `moment_input`: key,
 * annotation and button edges are gesture evidence and are kept in full;
 * scrolls and moves are strided into what is left of the 8000-event budget.
 */
export function momentInteractions(events: readonly SidecarEvent[], budget = MOMENT_EVENT_BUDGET): SidecarEvent[] {
  const clean = events.map(cleanEvent).filter((e): e is SidecarEvent => e !== null);
  const mandatory = clean.filter((e) => MANDATORY_KINDS.has(e.kind)).slice(0, budget);
  const remaining = budget - mandatory.length;
  const scrolls = clean.filter((e) => e.kind === "scroll");
  const moves = clean.filter((e) => e.kind === "move");
  const sampledScrolls = strideSample(scrolls, Math.min(Math.floor(remaining / 2), scrolls.length));
  const sampledMoves = strideSample(moves, remaining - sampledScrolls.length);
  return [...mandatory, ...sampledScrolls, ...sampledMoves].sort((a, b) => a.time_ms - b.time_ms);
}

function captureForPlanner(geometry: CaptureGeometry | null | undefined): LocalMomentInput["capture"] {
  if (!geometry) return undefined;
  const { x, y, width, height, output_width, output_height } = geometry;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  const capture: NonNullable<LocalMomentInput["capture"]> = { x, y, width, height };
  if (Number.isInteger(output_width) && (output_width ?? 0) > 0) capture.output_width = output_width;
  if (Number.isInteger(output_height) && (output_height ?? 0) > 0) capture.output_height = output_height;
  return capture;
}

/** The planner refuses a segment longer than this; longer ones are split, never cut. */
const MAX_SEGMENT_CHARS = 10_000;

/**
 * Splits one segment's text into pieces of at most MAX_SEGMENT_CHARS, at
 * whitespace where possible, sharing out its time span by character offset.
 * No text is dropped.
 */
function splitLongSegment(seg: TranscriptSegment): TranscriptSegment[] {
  const text = seg.text;
  if (text.length <= MAX_SEGMENT_CHARS) return [seg];
  const pieces: Array<{ text: string; from: number; to: number }> = [];
  let from = 0;
  while (from < text.length) {
    let to = Math.min(from + MAX_SEGMENT_CHARS, text.length);
    if (to < text.length) {
      const space = text.lastIndexOf(" ", to);
      if (space > from + MAX_SEGMENT_CHARS / 2) to = space;
    }
    const piece = text.slice(from, to).trim();
    if (piece) pieces.push({ text: piece, from, to });
    from = to;
  }
  const span = seg.endMs - seg.startMs;
  return pieces.map((p) => ({
    startMs: seg.startMs + Math.round((span * p.from) / text.length),
    endMs: seg.startMs + Math.round((span * p.to) / text.length),
    text: p.text,
  }));
}

/** Segments the planner accepts: inside the recording, start before end, none over its length limit. */
export function boundedSegments(segments: readonly TranscriptSegment[], durationMs: number): TranscriptSegment[] {
  return segments
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.text.trim())
    .flatMap((s) => {
      const startMs = Math.min(Math.max(0, Math.round(s.startMs)), durationMs);
      const endMs = Math.min(Math.max(startMs, Math.round(s.endMs)), durationMs);
      return splitLongSegment({ startMs, endMs, text: s.text });
    });
}

/** A planned moment, a narration moment, or an overview sample (which has no evidence source). */
export type PlannedFrameMoment = Omit<LocalMoment, "source"> & {
  source?: LocalMoment["source"] | "narration";
  overview?: true;
};

/** Label that keeps a note apart from recognized speech in the transcript. */
export const NARRATION_PREFIX = "Narration: ";

/** Notes as transcript segments: each runs until the next note, at most 5 s. */
export function narrationSegments(notes: readonly NarrationNote[], durationMs: number): TranscriptSegment[] {
  const sorted = notes
    .filter((n) => Number.isFinite(n.startMs) && n.text.trim())
    .map((n) => ({ ...n, startMs: Math.min(Math.max(0, Math.round(n.startMs)), durationMs) }))
    .sort((a, b) => a.startMs - b.startMs);
  return sorted.map((n, i) => {
    const next = sorted[i + 1]?.startMs ?? durationMs;
    const fallbackEnd = Math.max(n.startMs, Math.min(n.startMs + 5000, Math.max(next, n.startMs + 500), durationMs));
    const endMs = n.endMs !== undefined && Number.isFinite(n.endMs) ? Math.max(n.startMs, Math.min(Math.round(n.endMs), durationMs)) : fallbackEnd;
    return { startMs: n.startMs, endMs, text: `${NARRATION_PREFIX}${n.text.trim()}` };
  });
}

/** One moment per note, skipping any instant a planned moment already covers. */
export function narrationMoments(
  notes: readonly NarrationNote[],
  planned: readonly PlannedFrameMoment[],
  durationMs: number,
): PlannedFrameMoment[] {
  const taken = new Set(planned.map((m) => Math.round(m.timestamp_ms)));
  const out: PlannedFrameMoment[] = [];
  for (const n of notes) {
    if (!Number.isFinite(n.startMs) || !n.text.trim()) continue;
    const t = Math.min(Math.max(0, Math.round(n.startMs)), Math.max(0, durationMs - 1));
    if (taken.has(t)) continue;
    taken.add(t);
    const frameAt = Math.min(Math.max(0, Math.round(n.frameAtMs ?? t)), Math.max(0, durationMs - 1));
    const text = n.text.trim().replace(/\s+/g, " ");
    out.push({
      timestamp_ms: t,
      frame_at_ms: frameAt,
      reason: `Narration: ${text.length > 300 ? `${text.slice(0, 297)}...` : text}`,
      source: "narration",
    });
  }
  return out;
}

/** Start, middle and end samples for a plan that found nothing (the Mac's overview_moments). */
export function overviewMoments(durationMs: number): PlannedFrameMoment[] {
  if (durationMs <= 0) return [];
  const times = [...new Set([0, Math.floor(durationMs / 2), Math.max(0, durationMs - 250)])].sort((a, b) => a - b);
  return times.map((t) => ({
    timestamp_ms: t,
    frame_at_ms: t,
    reason: "Overview sample; not a selected key moment or a visual interpretation.",
    overview: true as const,
  }));
}

export function frameFileName(timestampMs: number): string {
  return `frames/${String(Math.round(timestampMs)).padStart(12, "0")}.jpg`;
}

function isLocalHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "a custom endpoint";
  }
}

function transcriptionWhere(config: TranscriptionConfig): string | null {
  switch (config.kind) {
    case "none":
    case "local":
      return null;
    case "openai-compatible":
      return isLocalHost(config.baseUrl) ? null : hostOf(config.baseUrl);
    default:
      return config.kind;
  }
}

/**
 * One sentence per destination, matching what the code actually sent. With no
 * provider nothing leaves; a model provider gets the transcript text, click
 * labels and a bounded sample of pointer and key events (plus the capture
 * area); a transcription provider gets the audio. The video and screenshots
 * never leave.
 */
export function dataBoundary(
  config: Pick<LocalConfig, "model" | "transcription">,
  used: { audioSent: boolean; modelCalled: boolean },
): string {
  const parts = ["Nothing is sent to Clipy. The video and screenshots stay on this machine."];
  const audioTo = used.audioSent ? transcriptionWhere(config.transcription) : null;
  parts.push(audioTo ? `The audio was sent to ${audioTo} for transcription.` : "The audio stays on this machine.");
  const provider = config.model;
  const modelRemote = used.modelCalled && provider !== null && !isLocalHost(provider.baseUrl);
  if (modelRemote && provider) {
    parts.push(
      `The transcript text, click labels, a bounded sample of pointer and key events, and the capture area were sent to ${hostOf(provider.baseUrl)} to select spoken references.`,
    );
  } else {
    if (used.modelCalled && provider) {
      parts.push("The transcript and a sample of the interactions were read by a model running on this machine to select spoken references.");
    }
    parts.push("The interaction evidence stays on this machine.");
  }
  if (!audioTo && !modelRemote) parts.push("Nothing left this machine.");
  return parts.join(" ");
}

function engineLabel(result: TranscribeResult): string {
  return result.engine;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, path);
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error("Processing cancelled");
}

export async function processRecording(options: ProcessOptions): Promise<ProcessResult> {
  const dir = resolve(options.dir);
  const ffmpeg = options.ffmpegPath ?? process.env.CLIPY_FFMPEG ?? "ffmpeg";
  const signal = options.signal;
  const now = options.now ?? (() => new Date());
  const created = now();
  const recordingId = basename(dir);
  const video = join(dir, "recording.mp4");
  const arecPath = join(dir, "recording.arec");
  const warnings: string[] = [];
  const checkAbort = () => {
    if (signal?.aborted) throw abortError(signal);
  };

  await mkdir(join(dir, "frames"), { recursive: true });

  const interactions = options.interactions ? options.interactions.map(cleanEvent).filter((e): e is SidecarEvent => e !== null) : null;
  const clickElements = (options.clickElements ?? []).slice(0, 2000).map((e) => ({
    time_ms: e.time_ms,
    role: e.role == null ? null : String(e.role).slice(0, 256),
    label: e.label == null ? null : String(e.label).slice(0, 4000),
  }));

  // Shared, growing state the document is rendered from at every checkpoint.
  const doc: ArecInput = {
    title: options.title ?? "Local recording",
    ...(options.description ? { description: options.description } : {}),
    ...(options.expectedResult ? { expectedResult: options.expectedResult } : {}),
    ...(options.recordingKind ? { recordingKind: options.recordingKind } : {}),
    ...(options.compiler ? { compiler: options.compiler } : {}),
    recordingId,
    state: "preparing",
    statusText: "Preparing: video saved; transcript and frames are being added. Re-read this same file for updates.",
    createdAt: created.toISOString(),
    durationMs: options.durationMs ?? 0,
    origin: options.origin ?? { kind: "capture" },
    transcript: { ready: false, segments: [], engineLabel: "pending", gaps: [] },
    interactions: interactions
      ? { captured: true, eventCount: interactions.length, clicks: interactions.filter((e) => e.kind === "down").map(({ time_ms, x, y, button }) => ({ time_ms, x, y, button })) }
      : { captured: false },
    planner: null,
    frames: [],
    dataBoundary: dataBoundary(options.config, { audioSent: false, modelCalled: false }),
    captureGaps: [...(options.captureWarnings ?? [])],
  };
  const metadata: Record<string, unknown> = {
    recording_id: recordingId,
    edition: "clipy-cli",
    mode: "local",
    compiler: options.compiler ?? "clipy --local",
    ...(options.recordingKind ? { recordingKind: options.recordingKind } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.expectedResult ? { expectedResult: options.expectedResult } : {}),
    mediaType: "video/mp4",
    title: doc.title,
    createdAt: doc.createdAt,
    createdAtMs: created.getTime(),
    origin: doc.origin,
    capture: options.geometry ?? null,
  };

  const writeArec = async () => {
    const temp = `${arecPath}.tmp`;
    await writeFile(temp, renderLocalArec(doc));
    await rename(temp, arecPath);
  };
  const setStatus = async (stage: Stage, message: string) => {
    await writeJson(join(dir, "status.json"), { stage, message, updatedAtMs: now().getTime(), arecPath });
    options.onStatus?.({ stage, message });
  };
  const finishDoc = (state: ArecState, statusText: string) => {
    doc.state = state;
    doc.statusText = statusText;
  };

  try {
    // 1. The video, the sidecar, and a preparing document an agent can already open.
    await placeVideo(ffmpeg, resolve(options.videoPath), video, { move: options.moveVideo, signal });
    checkAbort();
    const durationMs = Math.max(1, Math.round(options.durationMs && options.durationMs > 0 ? options.durationMs : await probeDurationMs(ffmpeg, video, signal)));
    doc.durationMs = durationMs;
    metadata.duration_ms = durationMs;
    if (interactions) {
      await writeJson(join(dir, "recording.cursor.json"), {
        version: 1,
        capture: options.geometry ?? null,
        events: interactions,
        click_elements: clickElements,
      });
    }
    await writeJson(join(dir, "metadata.json"), metadata);
    await writeArec();

    // 2. Transcript.
    const narration = options.narration ?? [];
    await setStatus("transcribing", options.transcript ? "Reading the supplied transcript" : "Transcribing");
    let transcribed = false;
    // Set before the request goes out: a provider that received the audio and
    // then failed, or a take cancelled mid-request, must still disclose it.
    let audioSent = false;
    let transcriptOut: { engine: string; language?: string; segments: TranscriptSegment[]; gaps: Array<{ startMs: number; endMs: number; reason: string }> };
    let transcriptionFailed: string | null = null;
    if (options.transcript) {
      transcriptOut = { engine: options.transcript.label, segments: options.transcript.segments, gaps: [] };
    } else if (options.config.transcription.kind === "none") {
      transcriptOut = { engine: "none (transcription is turned off)", segments: [], gaps: [] };
      doc.transcript.gaps.push("Transcription is turned off, so there is no spoken transcript. Run clipy local setup --transcribe to turn it on.");
    } else if (!(await hasAudioStream(ffmpeg, video, signal))) {
      transcriptOut = { engine: "none (the recording has no audio track)", segments: [], gaps: [] };
      doc.transcript.noAudio = true;
      doc.transcript.gaps.push("The recording has no audio track, so there is no spoken transcript.");
    } else {
      if (transcriptionWhere(options.config.transcription)) {
        audioSent = true;
        doc.dataBoundary = dataBoundary(options.config, { audioSent, modelCalled: false });
        await writeArec();
      }
      try {
        const result = await options.deps.transcribe(video, options.config.transcription, { signal });
        transcribed = true;
        transcriptOut = { engine: engineLabel(result), language: result.language, segments: result.segments, gaps: result.gaps };
      } catch (error) {
        checkAbort();
        transcriptionFailed = error instanceof Error ? error.message : String(error);
        transcriptOut = { engine: "failed", segments: [], gaps: [] };
        doc.transcript.gaps.push(`Transcription failed (${transcriptionFailed}). There is no transcript; this is not evidence that nothing was said.`);
        warnings.push(`Transcription failed: ${transcriptionFailed}`);
      }
    }
    checkAbort();
    const spoken = boundedSegments(transcriptOut.segments, durationMs);
    const noteSegments = boundedSegments(narrationSegments(narration, durationMs), durationMs);
    const segments = [...spoken, ...noteSegments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    if (noteSegments.length > 0) {
      transcriptOut.engine = spoken.length > 0 || transcribed ? `${transcriptOut.engine} plus narration notes` : "narration notes";
    }
    for (const gap of transcriptOut.gaps) {
      doc.transcript.gaps.push(`Transcript gap from ${gap.startMs} to ${gap.endMs} ms: ${gap.reason}`);
    }
    doc.transcript = { ...doc.transcript, ready: true, segments, engineLabel: transcriptOut.engine, language: transcriptOut.language };
    doc.dataBoundary = dataBoundary(options.config, { audioSent, modelCalled: false });
    await writeJson(join(dir, "transcript.json"), {
      through_ms: durationMs,
      engine: transcriptOut.engine,
      ...(transcriptOut.language ? { language: transcriptOut.language } : {}),
      segments,
      gaps: transcriptOut.gaps,
    });
    metadata.transcription = { engine: transcriptOut.engine, language: transcriptOut.language ?? null, failed: transcriptionFailed };
    doc.statusText = "Preparing: transcript saved; moments and frames are being added. Re-read this same file for updates.";
    await writeArec();

    // 3. Moments: rules always, spoken references with the user's provider.
    await setStatus("selecting", "Selecting moments");
    const input: LocalMomentInput = {
      schemaVersion: 2,
      durationMs,
      transcript: segments,
      interactions: momentInteractions(interactions ?? []) as LocalMomentInput["interactions"],
      clickElements,
      interactionSelection: INTERACTION_SELECTION,
      ...(captureForPlanner(options.geometry) ? { capture: captureForPlanner(options.geometry) } : {}),
    };
    const provider: ModelProvider | null = options.config.model ?? null;
    let planner: "rules" | "rules+model" = "rules";
    let modelFallback: string | null = null;
    let planned: LocalMoment[];
    // The planner only calls the model when there is a transcript. Disclose it
    // before the request, so a failure or cancel mid-request still says so.
    const modelCalled = provider !== null && segments.length > 0;
    if (modelCalled) {
      doc.dataBoundary = dataBoundary(options.config, { audioSent, modelCalled });
      await writeArec();
    }
    try {
      const { plan, planner: used } = await planMoments(input, { provider, signal });
      planner = used;
      planned = "schemaVersion" in plan ? plan.moments : [];
    } catch (error) {
      checkAbort();
      if (!provider) throw error;
      // A provider outage never costs the take: rules alone still frame every gesture.
      const kind = String(describePlannerError(error).kind ?? "error");
      modelFallback = kind;
      warnings.push(`The model provider failed (${kind}); moments come from rules only.`);
      const { plan } = await planMoments(input, { provider: null, signal });
      planned = "schemaVersion" in plan ? plan.moments : [];
    }
    checkAbort();
    doc.dataBoundary = dataBoundary(options.config, { audioSent, modelCalled });
    const modelName = provider ? `${provider.model} at ${hostOf(provider.baseUrl)}` : null;
    doc.planner =
      planner === "rules+model"
        ? { label: `rules on this machine plus ${modelName} for spoken references` }
        : modelFallback
          ? {
              label: "rules on this machine (Flare highlights, pen drawings, clicks, pointer rests)",
              note: `The model provider (${modelName}) failed (${modelFallback}), so moments come from rules only and spoken references were not selected. Run the import again to retry.`,
            }
          : {
              label: "rules on this machine (Flare highlights, pen drawings, clicks, pointer rests)",
              note: "Spoken references were not selected: no model provider is configured. Run clipy local setup --model-provider to add one.",
            };
    metadata.planner = { used: planner, model: modelName, fallback: modelFallback };

    const fromNotes = narrationMoments(narration, planned, durationMs);
    const selected: PlannedFrameMoment[] = [...planned, ...fromNotes].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    const moments: PlannedFrameMoment[] = selected.length > 0 ? selected : overviewMoments(durationMs);
    await writeJson(join(dir, "moments.json"), moments);

    // 4. Frames.
    await setStatus("extracting", "Extracting frames");
    const frames: ArecFrame[] = [];
    const frameGaps: string[] = [];
    let firstError: string | null = null;
    for (const m of moments) {
      checkAbort();
      const file = frameFileName(m.timestamp_ms);
      const result = await extractFrame(ffmpeg, video, Math.min(m.frame_at_ms, durationMs - 1), join(dir, file), signal);
      if (!result.ok) {
        firstError ??= result.error;
        frameGaps.push(`No screenshot for the moment at ${m.timestamp_ms} ms (frame ${m.frame_at_ms} ms): ${result.error}. Inspect recording.mp4 there.`);
        continue;
      }
      frames.push({
        timestampMs: m.timestamp_ms,
        frameAtMs: m.frame_at_ms,
        frameTimeMs: result.frameTimeMs,
        file,
        reason: m.reason,
        ...(m.source ? { source: m.source } : {}),
        ...(m.overview ? { overview: true } : {}),
        ...(m.x != null && m.y != null ? { x: m.x, y: m.y } : {}),
      });
    }
    if (moments.length > 0 && frames.length === 0) {
      throw new Error(`No frame could be extracted from recording.mp4: ${firstError}`);
    }
    doc.frames = frames;
    doc.captureGaps.push(...frameGaps);
    await writeJson(
      join(dir, "frames.json"),
      frames.map((f) => ({ timestampMs: f.timestampMs, frameAtMs: f.frameAtMs, frameTimeMs: f.frameTimeMs, reason: f.reason, frame: f.file, source: f.source, overview: f.overview, x: f.x, y: f.y })),
    );

    // 5. Done.
    if (transcriptionFailed) {
      finishDoc("partial", "Partial: transcription failed; moments and frames are complete. See Capture gaps.");
    } else {
      finishDoc("complete", "Complete");
    }
    await writeJson(join(dir, "metadata.json"), metadata);
    await writeArec();
    await setStatus("ready", "Ready");

    return {
      dir,
      arecPath,
      durationMs,
      planner,
      modelFallback,
      moments: moments.length,
      frames: frames.length,
      transcriptSegments: segments.length,
      transcriptEngine: transcriptOut.engine,
      warnings: [...warnings, ...frameGaps],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishDoc("failed", `Failed: ${message}`);
    try {
      await writeArec();
      await setStatus("failed", message);
    } catch {
      // The original error is what matters.
    }
    throw error;
  }
}

/** For `open`: the AREC path of a finished folder, or null. */
export async function arecPathOf(dir: string): Promise<string | null> {
  const path = join(resolve(dir), "recording.arec");
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}
