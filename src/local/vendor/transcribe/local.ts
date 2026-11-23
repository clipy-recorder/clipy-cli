// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/local.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * On-device transcription with sherpa-onnx (k2-fsa's Node addon), run in a
 * child process (see localWorker.ts). Nothing leaves the machine.
 */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { throwIfAborted } from "./audio.js";
import {
  groupTokensIntoSegments,
  planChunks,
  tokensInCore,
  toTimeline,
  trimToSpeech,
  type ChunkPlan,
  type ChunkPlanOptions,
  type RelativeSegment,
  type SilenceSpan,
} from "./chunking.js";
import { formatBytes, LOCAL_MODELS, modelFilePaths, modelStatus } from "./models.js";
import { NO_SPEECH_GAP_REASON, pieceGap, piecesWithoutSpeech, type AudioInput, type EngineOutput } from "./providers/common.js";
import type { LocalModelId, TranscriptGap } from "./types.js";

/**
 * Piece sizes per model. Parakeet aborts on input much past 3 minutes, so a
 * piece is never longer than 180 s (about 130 s preferred, cut in a silence,
 * with 2.5 s of overlap so a word at a seam is whole in one piece). Whisper
 * reads at most 30 s, so pieces stay under 28 s with no overlap (it gives no
 * word times to de-duplicate with).
 */
export const LOCAL_CHUNKING: Record<LocalModelId, ChunkPlanOptions> = {
  "english-fast": { targetSec: 130, maxSec: 180, overlapSec: 2.5, minSec: 15 },
  multilingual: { targetSec: 24, maxSec: 28, overlapSec: 0, minSec: 5 },
};

/** Speech kept on each side of a trimmed piece. */
const TRIM_PAD_SEC = 0.5;

/** The piece with dead silence cut off both ends of the audio sent; the core it owns is unchanged. */
export function trimPieceToSpeech(p: ChunkPlan, quiet: SilenceSpan[]): ChunkPlan {
  const end = p.extractStartSec + p.extractDurSec;
  const speech = trimToSpeech(quiet, p.extractStartSec, end);
  if (!(speech.endSec > speech.startSec)) return p;
  const start = Math.max(p.extractStartSec, speech.startSec - TRIM_PAD_SEC);
  const stop = Math.min(end, speech.endSec + TRIM_PAD_SEC);
  return { ...p, extractStartSec: start, extractDurSec: stop - start };
}

export class ModelNotInstalledError extends Error {
  readonly model: LocalModelId;
  readonly sizeBytes: number;
  constructor(model: LocalModelId) {
    const spec = LOCAL_MODELS[model];
    super(
      `The "${spec.label}" model is not installed. It is a one-time ${formatBytes(spec.sizeBytes)} download: ` +
        `run "clipy models download ${model}" (or choose another transcription option).`,
    );
    this.name = "ModelNotInstalledError";
    this.model = model;
    this.sizeBytes = spec.sizeBytes;
  }
}

function recognizerConfig(model: LocalModelId, dir: string, threads: number): unknown {
  const p = modelFilePaths(model, dir);
  const common = { tokens: p["tokens.txt"], numThreads: threads, provider: "cpu", debug: 0 };
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig:
      model === "english-fast"
        ? { ...common, nemoCtc: { model: p["model.int8.onnx"] } }
        : { ...common, whisper: { encoder: p["encoder.int8.onnx"], decoder: p["decoder.int8.onnx"], language: "", task: "transcribe" } },
  };
}

function workerPath(): { path: string; execArgv: string[] } {
  const js = fileURLToPath(new URL("./localWorker.js", import.meta.url));
  if (existsSync(js)) return { path: js, execArgv: [] };
  // Running from source (tests): Node 22.18+ strips the type annotations itself.
  return { path: fileURLToPath(new URL("./localWorker.ts", import.meta.url)), execArgv: ["--no-warnings"] };
}

interface PieceAnswer {
  text: string;
  tokens: string[];
  timestamps: number[];
  lang?: string;
}

type WorkerMessage =
  | { type: "started"; index: number }
  | ({ type: "result"; index: number } & PieceAnswer)
  | { type: "error"; index: number; message: string }
  | { type: "fatal"; message: string }
  | { type: "done" };

interface Job {
  config: unknown;
  /** Absolute path of the sherpa-onnx-node entry file, or null to resolve it by name. */
  engine: string | null;
  wav: { path: string; dataOffset: number; dataBytes: number; sampleRate: number };
}

/**
 * Run the pieces in one child. Resolves with the pieces it did not get to
 * when the child died mid-way (the one it was on counts as failed).
 */
function runChild(
  job: Job,
  pieces: ChunkPlan[],
  signal: AbortSignal | undefined,
  onAnswer: (index: number, answer: PieceAnswer | null) => void,
): Promise<{ remaining: ChunkPlan[] }> {
  return new Promise((resolve, reject) => {
    const { path, execArgv } = workerPath();
    const child: ChildProcess = fork(path, [], { execArgv, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
    const answered = new Set<number>();
    let current: number | null = null;
    let fatal: string | null = null;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      const err = new Error("Transcription was cancelled");
      err.name = "AbortError";
      finish(() => reject(err));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("message", (m: WorkerMessage) => {
      if (m.type === "started") current = m.index;
      else if (m.type === "result") {
        answered.add(m.index);
        current = null;
        onAnswer(m.index, { text: m.text, tokens: m.tokens, timestamps: m.timestamps, lang: m.lang });
      } else if (m.type === "error") {
        answered.add(m.index);
        current = null;
        onAnswer(m.index, null);
      } else if (m.type === "fatal") fatal = m.message;
    });
    child.on("error", (err) => finish(() => reject(new Error(`the local speech engine could not start: ${err.message}`))));
    child.on("exit", () => {
      if (fatal) return finish(() => reject(new Error(`Local transcription failed: ${fatal}`)));
      if (current !== null && !answered.has(current)) {
        answered.add(current);
        onAnswer(current, null);
      }
      finish(() => resolve({ remaining: pieces.filter((p) => !answered.has(p.index)) }));
    });
    child.send({ type: "run", recognizerConfig: job.config, engine: job.engine, wav: job.wav, pieces: pieces.map((p) => ({ index: p.index, startSec: p.extractStartSec, durSec: p.extractDurSec })) });
  });
}

/** The engine to load: the host's copy when it names one, else one this package can resolve. */
function resolveEngine(speechEngine: string | undefined): string | null | false {
  if (speechEngine) return existsSync(speechEngine) ? speechEngine : false;
  try {
    createRequire(import.meta.url).resolve("sherpa-onnx-node");
    return null;
  } catch {
    return false;
  }
}

export async function transcribeLocal(
  input: AudioInput,
  model: LocalModelId,
  modelDir?: string,
  speechEngine?: string,
): Promise<EngineOutput> {
  const status = modelStatus(model, modelDir);
  if (!status.installed) throw new ModelNotInstalledError(model);
  const engine = resolveEngine(speechEngine);
  if (engine === false) {
    throw new Error(
      "Local transcription needs the speech engine (sherpa-onnx-node), which is not installed: " +
        "run clipy speech install, or choose a transcription key (clipy local setup --transcribe openai --transcribe-key -).",
    );
  }
  throwIfAborted(input.signal);

  const total = input.info.durationSec;
  const opts = LOCAL_CHUNKING[model];
  const silences = await input.silences();
  const plan = planChunks(silences, total, opts);
  // A piece with no speech is not run (Whisper invents words in silence), and says so as a gap.
  const noSpeech = await piecesWithoutSpeech(input, plan, model === "english-fast" ? "strict" : "invents");
  // Parakeet loses speech in a piece that is mostly dead silence (it normalises
  // over the whole piece), so each piece is trimmed to its speech first.
  const quiet = input.noSpeech ? await input.noSpeech() : [];
  const withSpeech = plan.filter((p) => !noSpeech.has(p.index)).map((p) => trimPieceToSpeech(p, quiet));

  const threads = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
  const job: Job = {
    config: recognizerConfig(model, status.dir, threads),
    engine,
    wav: { path: input.wavPath, dataOffset: input.info.dataOffset, dataBytes: input.info.dataBytes, sampleRate: input.info.sampleRate },
  };
  const answers = new Map<number, PieceAnswer | null>();
  const skipped = plan.length - withSpeech.length;
  const onAnswer = (index: number, a: PieceAnswer | null) => {
    answers.set(index, a);
    input.onProgress?.((answers.size + skipped) / Math.max(1, plan.length));
  };

  let queue = withSpeech;
  let restarts = 0;
  while (queue.length > 0) {
    const { remaining } = await runChild(job, queue, input.signal, onAnswer);
    if (remaining.length === queue.length) restarts++;
    if (restarts > 2) {
      for (const p of remaining) answers.set(p.index, null);
      break;
    }
    queue = remaining;
  }

  // Token-level merge for models with token times (Parakeet), so a sentence
  // running across a cut is kept once; one segment per piece otherwise (Whisper).
  const timed: Array<{ token: string; t: number }> = [];
  const wholePieces: RelativeSegment[] = [];
  const gaps: TranscriptGap[] = plan.filter((p) => noSpeech.has(p.index)).map((p) => pieceGap(p, NO_SPEECH_GAP_REASON));
  const langs = new Map<string, number>();
  let succeeded = 0;
  for (const p of withSpeech) {
    const a = answers.get(p.index);
    if (!a) {
      gaps.push(pieceGap(p, "the local model could not transcribe this part"));
      continue;
    }
    succeeded++;
    if (a.lang) langs.set(a.lang, (langs.get(a.lang) ?? 0) + 1);
    if (a.tokens.length > 0 && a.timestamps.length === a.tokens.length) {
      timed.push(...tokensInCore(p, a.tokens, a.timestamps));
    } else {
      // Whisper gives no token times: one segment over the speech in the piece.
      const text = a.text.trim();
      const span = trimToSpeech(silences, p.extractStartSec, p.extractStartSec + p.extractDurSec);
      if (text) wholePieces.push({ start: span.startSec, end: span.endSec, text });
    }
  }
  timed.sort((x, y) => x.t - y.t);
  const segments = toTimeline([
    ...groupTokensIntoSegments(
      timed.map((x) => x.token),
      timed.map((x) => x.t),
    ),
    ...wholePieces,
  ]);
  if (withSpeech.length > 0 && succeeded === 0) {
    throw new Error("Local transcription failed on every part of this recording.");
  }
  gaps.sort((a, b) => a.startMs - b.startMs);
  input.onProgress?.(1);

  let language: string | undefined = model === "english-fast" ? "en" : undefined;
  if (model === "multilingual" && langs.size > 0) language = [...langs.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { segments, engine: `local:${model}`, language, gaps };
}
