/**
 * Local mode for the official CLI: `--local` on record, session, proof and
 * context import, plus `clipy local setup|status` and `clipy models`.
 *
 * With --local nothing is uploaded and no Clipy account is needed. Instead of
 * "upload, then the server transcribes and picks moments", the CLI runs the
 * local pipeline (pipeline.ts): transcribe on this machine or with the user's
 * own key, pick moments with rules (plus the user's model provider when one
 * is set), extract frames with ffmpeg and write an AREC 1.4 folder. The last
 * line printed is the absolute path of recording.arec (a JSON object with
 * --json).
 *
 * Everything here takes its dependencies (`LocalEnv`) as an argument, so the
 * tests drive it with fakes and never touch a screen, a model or the network.
 */
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { shareLine } from "./arec.js";
import { hasAudioStream } from "./media.js";
import { processRecording, type NarrationNote, type ProcessOptions, type ProcessResult, type StatusUpdate } from "./pipeline.js";
import type {
  Deps,
  LocalConfig,
  LocalModel,
  ModelProvider,
  StoredConfigPatch,
  StoredModel,
  StoredTranscription,
  TranscriptionConfig,
  VirtualDisplay,
} from "./ports.js";
import {
  ensureSpeechEngine,
  realSpeechEngine,
  SPEECH_ENGINE_INSTALL_COMMAND,
  SPEECH_ENGINE_PACKAGE,
  SPEECH_ENGINE_SIZE,
  SPEECH_ENGINE_VERSION,
  SpeechEngineRequiredError,
  type SpeechEngine,
  type SpeechEngineStatus,
} from "./speechEngine.js";

export { SpeechEngineRequiredError } from "./speechEngine.js";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const MODEL_PROVIDERS = ["openrouter", "openai", "gemini", "groq", "ollama", "lmstudio", "custom", "none"] as const;
export const TRANSCRIBERS = [
  "local-english",
  "local-multilingual",
  "openai",
  "groq",
  "deepgram",
  "assemblyai",
  "elevenlabs",
  "gemini",
  "none",
] as const;
export const LOCAL_MODELS: readonly LocalModel[] = ["english-fast", "multilingual"];
/** Model presets that need no key, so `setup` can check them before saving. */
const KEYLESS_PRESETS: ReadonlySet<string> = new Set(["ollama", "lmstudio", "custom"]);

// ---- Terminal and environment ---------------------------------------------

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  /**
   * Resolves when the user asks to stop a recording: Enter, Ctrl-C, SIGTERM or
   * SIGHUP, the end of a stdin that is not a terminal (only when there is no
   * `maxMs`), or after `maxMs`.
   */
  waitForStop(maxMs?: number): Promise<"user" | "max">;
  /** Calls `onInterrupt` on Ctrl-C, SIGTERM or SIGHUP while long work runs; returns a disposer. */
  onInterrupt(onInterrupt: () => void): () => void;
  /** Whether stdin is a terminal. Absent means yes, so no warning about a closed stdin. */
  stdinIsTTY?: boolean;
  /** A yes/no question on the terminal (Enter means yes). Absent when stdin or stderr is not a terminal. */
  confirm?(question: string): Promise<boolean>;
}

/** Signals that stop a recording (or cancel the work after it) instead of killing the CLI mid-capture. */
export const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Reads one answer from the terminal; Ctrl-C or a closed stdin counts as no. */
function askTerminal(question: string): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    const done = (yes: boolean) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolveAnswer(yes);
    };
    rl.on("SIGINT", () => {
      process.stderr.write("\n");
      done(false);
    });
    rl.on("close", () => done(false));
    rl.question(question, (answer) => done(/^(y|yes)?$/i.test(answer.trim())));
  });
}

export function processIo(): Io {
  const canAsk = process.stdin.isTTY === true && process.stderr.isTTY === true;
  return {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    stdinIsTTY: process.stdin.isTTY === true,
    ...(canAsk ? { confirm: askTerminal } : {}),
    waitForStop(maxMs) {
      return new Promise((resolveStop) => {
        const stdin = process.stdin;
        // A pipe or file on stdin that closes (an agent's shell ending, say)
        // leaves nobody to press Enter: stop then instead of recording
        // forever. With --max the take ends on its own, so stdin is ignored.
        const stopOnEnd = maxMs === undefined && stdin.isTTY !== true;
        let timer: NodeJS.Timeout | undefined;
        const done = (why: "user" | "max") => {
          if (timer) clearTimeout(timer);
          for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
          stdin.off("data", onData);
          stdin.off("end", onEnd);
          stdin.pause();
          resolveStop(why);
        };
        const onSignal = () => done("user");
        const onEnd = () => done("user");
        const onData = (chunk: Buffer | string) => {
          if (String(chunk).includes("\n") || String(chunk).includes("\r")) done("user");
        };
        for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
        stdin.on("data", onData);
        if (stopOnEnd) {
          if (stdin.readableEnded) {
            done("user");
            return;
          }
          stdin.on("end", onEnd);
        }
        stdin.resume();
        if (maxMs !== undefined) timer = setTimeout(() => done("max"), maxMs);
      });
    },
    onInterrupt(onInterrupt) {
      const handler = () => onInterrupt();
      for (const sig of STOP_SIGNALS) process.on(sig, handler);
      return () => {
        for (const sig of STOP_SIGNALS) process.off(sig, handler);
      };
    },
  };
}

export interface LocalEnv {
  deps: () => Deps;
  io: Io;
  now: () => Date;
  /** Home folder for the default output folder; os.homedir() when absent. */
  home?: string;
  /** The CLI version, for the AREC's Compiler line. */
  version: string;
  /**
   * The on-device speech engine, downloaded on first use. Absent (test
   * fakes) means a take never checks for it.
   */
  speech?: SpeechEngine;
  /** --yes: accept the speech engine download without asking. */
  assumeYes?: boolean;
}

/** The real environment: vendored packages, loaded on first use. */
export async function realLocalEnv(version: string, options: { assumeYes?: boolean } = {}): Promise<LocalEnv> {
  const { realDeps } = await import("./deps.js");
  let cache: Deps | null = null;
  return {
    deps: () => (cache ??= realDeps()),
    io: processIo(),
    now: () => new Date(),
    version,
    speech: realSpeechEngine(),
    assumeYes: options.assumeYes === true,
  };
}

// ---- Output folder and results ---------------------------------------------

/** `~/clipy/recordings/YYYY-MM-DD-HHMMSS`, local time. */
export function defaultOutDir(now: Date, home = homedir()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return join(home, "clipy", "recordings", stamp);
}

/** `--out` as given, or a fresh default folder (a suffix keeps two takes in one second apart). */
export function resolveOutDir(out: string | undefined, env: Pick<LocalEnv, "now" | "home">): string {
  if (out && out.trim()) return resolve(out.trim());
  const base = defaultOutDir(env.now(), env.home ?? homedir());
  if (!existsSync(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/** Recordings are private: take folders are readable by their owner only. */
export const TAKE_DIR_MODE = 0o700;

/** What a local take writes into its folder, so `--force` can clear exactly that. */
const TAKE_FILES = ["frames", "transcript.json", "moments.json", "frames.json", "metadata.json", "status.json"];

function isTakeFile(name: string): boolean {
  const base = name.endsWith(".tmp") ? name.slice(0, -4) : name;
  return base.startsWith("recording.") || TAKE_FILES.includes(base);
}

/**
 * Claims the folder a take writes to, before anything is recorded:
 *
 * - no `--out`: a fresh dated folder, created here. Creating it is the claim,
 *   so two takes started in the same second get `<stamp>` and `<stamp>-2`.
 * - `--out` that is missing or empty: created (mode 0700) and used.
 * - `--out` holding files: refused with a UsageError, unless `force`, which
 *   clears the previous take's files (and only those) first.
 * - `claimed`: the folder was claimed earlier by this same take (a session
 *   claims it at start and writes it at stop), so it is used as it is.
 * - `inputs`: files the take reads (an imported video, proof frames). An
 *   `--out` that contains one is refused, with or without `force`, so
 *   clearing or writing the take can never replace its own input.
 */
export async function claimOutDir(
  out: string | undefined,
  env: Pick<LocalEnv, "now" | "home">,
  opts: { force?: boolean; claimed?: boolean; inputs?: readonly string[] } = {},
): Promise<string> {
  if (out && out.trim()) {
    const dir = resolve(out.trim());
    for (const input of opts.inputs ?? []) {
      if (isInside(realOrResolved(input), realOrResolved(dir))) {
        throw new UsageError(
          `--out ${dir} contains the input ${resolve(input)}. Choose an --out folder that does not hold the files being imported.`,
        );
      }
    }
    if (opts.claimed) {
      await mkdir(dir, { recursive: true, mode: TAKE_DIR_MODE });
      return dir;
    }
    let entries: string[] = [];
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) throw new UsageError(`--out ${dir} is a file, not a folder`);
      entries = await readdir(dir);
    } catch (error) {
      if (error instanceof UsageError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (entries.length > 0) {
      if (!opts.force) {
        throw new UsageError(
          `--out ${dir} is not empty. Choose a new or empty folder, or add --force to replace the take that is there.`,
        );
      }
      for (const name of entries) {
        if (isTakeFile(name)) await rm(join(dir, name), { recursive: true, force: true });
      }
    }
    await mkdir(dir, { recursive: true, mode: TAKE_DIR_MODE });
    return dir;
  }
  const base = defaultOutDir(env.now(), env.home ?? homedir());
  await mkdir(dirname(base), { recursive: true });
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    try {
      // Not recursive: if another take created this folder first, EEXIST moves on.
      await mkdir(candidate, { mode: TAKE_DIR_MODE });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** The real path when it exists (symlinks resolved), else the resolved path. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when `path` is `dir` itself or anything below it. */
function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Removes a claimed folder that is still empty (a take that failed before writing anything). */
export async function releaseOutDir(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length === 0) await rmdir(dir);
  } catch {
    // best-effort
  }
}

/** Everything a take needs that can fail, settled before anything is recorded. */
export interface PreparedTake {
  dir: string;
  config: LocalConfig;
  ffmpeg: string;
}

/**
 * The checks that used to fail only after a capture had finished, run first:
 * the config file and model provider (loadConfig resolves the provider and
 * throws when a key is missing), ffmpeg, and the output folder. A capture that
 * starts after this cannot be lost to any of them.
 */
export async function prepareLocalTake(
  opts: {
    out?: string;
    force?: boolean;
    claimed?: boolean;
    inputs?: readonly string[];
    /** The take can have speech to transcribe, so on-device transcription needs its engine. */
    speech?: boolean;
    /** A finished file the take reads: speech is needed only when it has an audio track. */
    speechFile?: string;
    json?: boolean;
  },
  env: LocalEnv,
): Promise<PreparedTake> {
  const config = env.deps().loadConfig();
  const ffmpeg = await ffmpegPath(env.deps);
  if (!ffmpeg) {
    throw new Error("ffmpeg was not found. Install ffmpeg (or set CLIPY_FFMPEG to its path) and try again; clipy local status shows what is missing.");
  }
  if (opts.speech) await ensureEngineForTake(config, env, { json: opts.json === true, ffmpeg, file: opts.speechFile });
  const dir = await claimOutDir(opts.out, env, { force: opts.force, claimed: opts.claimed, inputs: opts.inputs });
  return { dir, config, ffmpeg };
}

/**
 * On-device transcription with a downloaded model needs the speech engine:
 * asked for (or refused) here, before anything is recorded. Without the model
 * there is nothing to ask yet: the take records a transcript gap that says to
 * run clipy models download, as before.
 */
async function ensureEngineForTake(
  config: LocalConfig,
  env: LocalEnv,
  opts: { json: boolean; ffmpeg: string; file?: string },
): Promise<void> {
  if (!env.speech || config.transcription.kind !== "local") return;
  const model = config.transcription.model;
  try {
    if (!env.deps().modelStatus(model).installed) return;
  } catch {
    return;
  }
  if (env.speech.status().installed) return;
  // A file with no audio track is never transcribed (the pipeline records the
  // gap), so it must not cost a download or a refusal. A probe that fails
  // leaves the question to the take.
  if (opts.file && !(await hasAudioStream(opts.ffmpeg, opts.file).catch(() => true))) return;
  const json = opts.json;
  const controller = new AbortController();
  const dispose = env.io.onInterrupt(() => controller.abort(new Error("Cancelled")));
  try {
    await ensureSpeechEngine(env.speech, env.io, { json, assumeYes: env.assumeYes, signal: controller.signal });
  } finally {
    dispose();
  }
}

/**
 * A local take that failed after its capture finished. The capture is never
 * deleted: `keptPath` is where it is now, and the message says so.
 */
export class LocalTakeError extends Error {
  readonly keptPath: string | null;
  readonly reason: string;
  constructor(reason: string, keptPath: string | null) {
    super(keptPath ? `${reason}\nThe capture was kept at ${keptPath}` : reason);
    this.name = "LocalTakeError";
    this.reason = reason;
    this.keptPath = keptPath;
  }
}

/**
 * After a failed take: the capture is either already in the folder
 * (recording.mp4, placed before the failure) or still where the recorder left
 * it, in which case it is moved into the folder as recording.<ext>.
 */
export async function keepCapture(videoPath: string, dir: string, moved: boolean): Promise<string | null> {
  if (!moved) return null; // an imported or supplied file was never touched
  // The source still existing means placing it never finished (placeVideo
  // removes it only after recording.mp4 is complete), so the source is the
  // intact capture: keep it, whatever else is in the folder.
  if (!existsSync(videoPath)) {
    const placed = join(dir, "recording.mp4");
    return existsSync(placed) ? placed : null;
  }
  const target = join(dir, `recording${extname(videoPath) || ".mp4"}`);
  try {
    await mkdir(dir, { recursive: true, mode: TAKE_DIR_MODE });
    try {
      await rename(videoPath, target);
    } catch {
      await copyFile(videoPath, target);
      await rm(videoPath, { force: true });
    }
    return target;
  } catch {
    return videoPath;
  }
}

export function resultJson(result: ProcessResult, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    local: true,
    arec: result.arecPath,
    dir: result.dir,
    video: join(result.dir, "recording.mp4"),
    durationMs: result.durationMs,
    moments: result.moments,
    frames: result.frames,
    planner: result.planner,
    modelFallback: result.modelFallback,
    transcript: { engine: result.transcriptEngine, segments: result.transcriptSegments },
    warnings: result.warnings,
    ...extra,
  };
}

/** The end of every local take: the AREC path last on stdout, or one JSON object. */
export function printLocalResult(result: ProcessResult, json: boolean, io: Io, extra: Record<string, unknown> = {}): void {
  for (const warning of result.warnings) io.stderr(`Warning: ${warning}\n`);
  if (json) {
    io.stdout(`${JSON.stringify(resultJson(result, extra))}\n`);
    return;
  }
  io.stderr(
    `Done: ${result.frames} screenshot${result.frames === 1 ? "" : "s"}, ${result.transcriptSegments} transcript segment${
      result.transcriptSegments === 1 ? "" : "s"
    }. Nothing was uploaded. Give your AI agent the path below.\n${shareLine(join(result.dir, "recording.mp4"))}\n`,
  );
  io.stdout(`${result.arecPath}\n`);
}

/** A failed local command: one JSON object with --json, a message on stderr always. */
export function printLocalError(error: unknown, json: boolean, io: Io): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    const kept = error instanceof LocalTakeError && error.keptPath ? { error: error.reason, keptVideo: error.keptPath } : { error: message };
    const code =
      error instanceof SpeechEngineRequiredError
        ? { code: error.code, remediation: `run ${error.command} (downloads ${SPEECH_ENGINE_PACKAGE} ${SPEECH_ENGINE_VERSION} from npm, ${SPEECH_ENGINE_SIZE}), or re-run with --yes` }
        : {};
    io.stdout(`${JSON.stringify({ ok: false, local: true, ...kept, ...code })}\n`);
  }
  io.stderr(`clipy: ${message}\n`);
}

const STAGE_TEXT: Record<StatusUpdate["stage"], string> = {
  transcribing: "Transcribing",
  selecting: "Selecting moments",
  extracting: "Extracting frames",
  ready: "Ready",
  failed: "Failed",
};

async function ffmpegPath(deps: () => Deps): Promise<string | undefined> {
  if (process.env.CLIPY_FFMPEG) return process.env.CLIPY_FFMPEG;
  try {
    return (await deps().checkCapture()).ffmpeg ?? undefined;
  } catch {
    return undefined;
  }
}

// ---- Running the pipeline ---------------------------------------------------

export interface LocalTakeRequest {
  /** The finished capture or the file being imported. */
  videoPath: string;
  /** Move the video into the folder (a capture the CLI owns) instead of copying it. */
  moveVideo?: boolean;
  /** --out; a dated folder under ~/clipy/recordings when absent. */
  out?: string;
  title?: string;
  description?: string;
  expectedResult?: string;
  recordingKind?: string;
  narration?: NarrationNote[];
  transcript?: ProcessOptions["transcript"];
  origin: NonNullable<ProcessOptions["origin"]>;
  interactions?: ProcessOptions["interactions"];
  geometry?: ProcessOptions["geometry"];
  durationMs?: number;
  captureWarnings?: string[];
  json: boolean;
  /** Progress lines on stderr (default: on unless --json). */
  quiet?: boolean;
  /**
   * Settled before the capture (prepareLocalTake): the folder, config and
   * ffmpeg. Without it they are settled here, which is fine for an import
   * (nothing is lost if they fail) but not for a capture.
   */
  prepared?: PreparedTake;
  /** --force: replace a previous take in a non-empty --out. */
  force?: boolean;
  /** The folder in `out` was already claimed by this take (a session claims it at start). */
  outClaimed?: boolean;
}

/**
 * Runs the local pipeline on a finished video and returns the result (printing
 * is up to the caller). A failure throws a LocalTakeError that says where the
 * capture was kept: a capture is never deleted because processing failed.
 */
export async function runLocalTake(req: LocalTakeRequest, env: LocalEnv): Promise<ProcessResult> {
  let prepared = req.prepared;
  if (!prepared) {
    try {
      // An import reads its video in place; a capture's video is a temp file moved in.
      const inputs = req.moveVideo ? [] : [req.videoPath];
      // A session's folder was claimed, and the engine settled, at `session start`.
      const speech = !req.transcript && !req.outClaimed;
      prepared = await prepareLocalTake(
        { out: req.out, force: req.force, claimed: req.outClaimed, inputs, speech, speechFile: req.videoPath, json: req.json },
        env,
      );
    } catch (error) {
      if (error instanceof UsageError || !req.moveVideo) throw error;
      // A capture that reached here unprepared must still survive.
      const kept = existsSync(req.videoPath) ? req.videoPath : null;
      throw new LocalTakeError(error instanceof Error ? error.message : String(error), kept);
    }
  }
  const { dir, config, ffmpeg } = prepared;
  const quiet = req.quiet ?? req.json;
  const onStatus = (s: StatusUpdate) => {
    if (!quiet && s.stage !== "ready" && s.stage !== "failed") env.io.stderr(`${STAGE_TEXT[s.stage]}...\n`);
  };
  const controller = new AbortController();
  const dispose = env.io.onInterrupt(() => controller.abort(new Error("Cancelled")));
  try {
    return await processRecording({
      dir,
      videoPath: req.videoPath,
      moveVideo: req.moveVideo,
      interactions: req.interactions ?? null,
      geometry: req.geometry,
      durationMs: req.durationMs,
      captureWarnings: req.captureWarnings,
      deps: env.deps(),
      config,
      transcript: req.transcript ?? null,
      narration: req.narration ?? [],
      title: req.title,
      description: req.description,
      expectedResult: req.expectedResult,
      recordingKind: req.recordingKind,
      compiler: `clipy ${env.version} --local`,
      origin: req.origin,
      ffmpegPath: ffmpeg,
      signal: controller.signal,
      onStatus,
      now: env.now,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LocalTakeError(reason, await keepCapture(req.videoPath, dir, req.moveVideo === true));
  } finally {
    dispose();
  }
}

// ---- clipy record --local (screen capture with @clipy/capture) -------------

export interface CaptureRecordOptions {
  /** A source id from `clipy sources --local`; default: the main display. */
  source?: string;
  maxSeconds?: number;
  mic: boolean;
  /** Linux: record a private Xvfb display of width x height. */
  virtualDisplay?: { width: number; height: number };
  out?: string;
  /** --force: replace a previous take in a non-empty --out. */
  force?: boolean;
  title?: string;
  description?: string;
  expectedResult?: string;
  recordingKind?: string;
  narration?: NarrationNote[];
  json: boolean;
}

/**
 * Records the screen with the vendored capture package until Enter, Ctrl-C or
 * --max, then builds the AREC. Returns the exit code.
 */
export async function localCaptureRecord(opts: CaptureRecordOptions, env: LocalEnv): Promise<number> {
  const { io } = env;
  let display: VirtualDisplay | null = null;
  let prepared: PreparedTake;
  // Config, provider, ffmpeg and --out are checked before anything is
  // recorded, so a mistake there never costs a take.
  try {
    // Only the microphone gives this recorder an audio track.
    prepared = await prepareLocalTake({ out: opts.out, force: opts.force, speech: opts.mic, json: opts.json }, env);
  } catch (error) {
    printLocalError(error, opts.json, io);
    return error instanceof UsageError ? 2 : 1;
  }
  const { dir } = prepared;
  let recording = false;
  // A signal while Xvfb or the capture is starting must not kill the CLI
  // (that would skip the capture package's cleanup): note it, and stop as
  // soon as the capture is up.
  let stopEarly = false;
  let releaseEarly: (() => void) | null = io.onInterrupt(() => {
    stopEarly = true;
  });
  try {
    if (opts.virtualDisplay) {
      display = await env.deps().startVirtualDisplay(opts.virtualDisplay);
      const auth = display.xauthority ? ` XAUTHORITY=${display.xauthority}` : "";
      io.stderr(
        `Virtual display ${display.display}: launch apps there with DISPLAY=${display.display}${auth}. It closes when the recording ends.\n`,
      );
      for (const warning of display.warnings ?? []) io.stderr(`Warning: ${warning}\n`);
    }
    const session = await env.deps().startCapture({
      source: opts.source,
      outPath: join(dir, "recording.mp4"),
      maxSeconds: opts.maxSeconds,
      microphone: opts.mic,
      xDisplay: display?.display,
    });
    recording = true;
    releaseEarly();
    releaseEarly = null;
    io.stderr(
      `Recording${opts.maxSeconds ? ` (stops after ${opts.maxSeconds} s)` : ""}. Press Enter or Ctrl-C to stop. Nothing is uploaded.\n`,
    );
    if (opts.maxSeconds === undefined && io.stdinIsTTY === false) {
      io.stderr(
        "Warning: stdin is not a terminal and there is no --max, so the recording stops when stdin closes or on Ctrl-C, SIGTERM or SIGHUP. Add --max <sec> to bound it.\n",
      );
    }
    if (!stopEarly) await io.waitForStop(opts.maxSeconds !== undefined ? opts.maxSeconds * 1000 : undefined);
    io.stderr("Stopping...\n");
    // A second Ctrl-C or SIGTERM while the capture is being finalized must not
    // kill the CLI and strand ffmpeg or the virtual display.
    const holdSignals = io.onInterrupt(() => io.stderr("Still stopping; the take is being finalized.\n"));
    let captured: Awaited<ReturnType<typeof session.stop>>;
    try {
      captured = await session.stop();
      for (const warning of captured.warnings) io.stderr(`Warning: ${warning}\n`);
      await display?.stop();
      display = null;
    } finally {
      holdSignals();
    }
    const result = await runLocalTake(
      {
        videoPath: captured.path,
        moveVideo: true,
        prepared,
        title: opts.title ?? "Screen recording",
        description: opts.description,
        expectedResult: opts.expectedResult,
        recordingKind: opts.recordingKind,
        narration: opts.narration,
        interactions: captured.interactions,
        geometry: captured.geometry,
        durationMs: captured.durationMs,
        captureWarnings: captured.warnings,
        origin: { kind: "capture", ...(opts.source ? { sourceName: opts.source } : opts.virtualDisplay ? { sourceName: "a virtual display" } : {}) },
        json: opts.json,
      },
      env,
    );
    printLocalResult(result, opts.json, io, { source: { kind: "screen", ...(opts.source ? { id: opts.source } : {}) } });
    return 0;
  } catch (error) {
    const video = join(dir, "recording.mp4");
    if (recording && !(error instanceof LocalTakeError) && existsSync(video)) {
      // The capture failed to stop cleanly; whatever it wrote stays.
      printLocalError(new LocalTakeError(error instanceof Error ? error.message : String(error), video), opts.json, io);
    } else {
      printLocalError(error, opts.json, io);
    }
    return 1;
  } finally {
    releaseEarly?.();
    await display?.stop().catch(() => undefined);
    // Belt and braces: nothing the capture package started outlives the take.
    try {
      env.deps().stopAllChildren?.();
    } catch {
      // best-effort
    }
    if (!recording) await releaseOutDir(dir);
  }
}

/** `clipy sources --local`: what the capture package can record here. */
export async function localSources(json: boolean, env: LocalEnv): Promise<number> {
  try {
    const sources = await env.deps().listSources();
    if (json) env.io.stdout(`${JSON.stringify({ ok: true, local: true, sources })}\n`);
    else if (sources.length === 0) env.io.stdout("No sources found. Run clipy local status.\n");
    else {
      for (const s of sources) {
        env.io.stdout(`${s.id}\t${s.kind}\t${s.name}${s.width && s.height ? `\t${s.width}x${s.height}` : ""}\n`);
      }
    }
    return 0;
  } catch (error) {
    printLocalError(error, json, env.io);
    return 1;
  }
}

// ---- clipy local setup -------------------------------------------------------

export interface SetupFlags {
  modelProvider?: string;
  modelKey?: string;
  model?: string;
  baseUrl?: string;
  transcribe?: string;
  transcribeKey?: string;
}

/** Throws a UsageError for a combination `clipy local setup` cannot save. */
export function validateSetupFlags(flags: SetupFlags): void {
  const provider = flags.modelProvider;
  if (provider !== undefined && !MODEL_PROVIDERS.includes(provider as (typeof MODEL_PROVIDERS)[number])) {
    throw new UsageError(`Unknown model provider ${provider}. Choose one of: ${MODEL_PROVIDERS.join(", ")}.`);
  }
  if (provider === "custom" && (!flags.baseUrl || !flags.model)) {
    throw new UsageError("--model-provider custom needs --base-url and --model");
  }
  if (provider === undefined && (flags.modelKey || flags.model || flags.baseUrl)) {
    throw new UsageError("--model-key, --model and --base-url go with --model-provider");
  }
  const transcribe = flags.transcribe;
  if (transcribe !== undefined && !TRANSCRIBERS.includes(transcribe as (typeof TRANSCRIBERS)[number])) {
    throw new UsageError(`Unknown transcription engine ${transcribe}. Choose one of: ${TRANSCRIBERS.join(", ")}.`);
  }
  if (transcribe === undefined && flags.transcribeKey) throw new UsageError("--transcribe-key goes with --transcribe");
  if (transcribe && !["local-english", "local-multilingual", "none"].includes(transcribe) && !flags.transcribeKey) {
    throw new UsageError(
      `--transcribe ${transcribe} needs --transcribe-key (use --transcribe-key - to read it from stdin), or leave the file alone and set CLIPY_TRANSCRIBE=${transcribe} and CLIPY_TRANSCRIBE_API_KEY in your environment`,
    );
  }
}

/** Shown when a key was typed on the command line, where shell history and `ps` can see it. */
export const LITERAL_KEY_NOTE =
  "Note: a key typed on the command line can stay in your shell history and show up in the process list. " +
  "Next time set CLIPY_MODEL_API_KEY or CLIPY_TRANSCRIBE_API_KEY in your environment, or pass - to read the key from stdin.";

/**
 * Resolves `--model-key -` and `--transcribe-key -`: the key is read from
 * stdin (one line, trimmed) so it never appears in argv. `literal` lists the
 * flags that carried a key on the command line, for LITERAL_KEY_NOTE.
 */
export async function resolveKeyFlags(
  flags: { modelKey?: string; transcribeKey?: string },
  readStdin: () => Promise<string>,
): Promise<{ modelKey?: string; transcribeKey?: string; literal: string[] }> {
  if (flags.modelKey === "-" && flags.transcribeKey === "-") {
    throw new UsageError("only one of --model-key and --transcribe-key can read stdin; set the other with CLIPY_MODEL_API_KEY or CLIPY_TRANSCRIBE_API_KEY");
  }
  const out: { modelKey?: string; transcribeKey?: string; literal: string[] } = { literal: [] };
  for (const [field, flag] of [["modelKey", "--model-key"], ["transcribeKey", "--transcribe-key"]] as const) {
    const value = flags[field];
    if (value === undefined) continue;
    if (value === "-") {
      const key = (await readStdin()).split(/\r?\n/)[0]?.trim() ?? "";
      if (!key) throw new UsageError(`${flag} - reads the key from stdin, but stdin was empty`);
      out[field] = key;
    } else {
      out[field] = value;
      if (value.trim()) out.literal.push(flag);
    }
  }
  return out;
}

/** The first line of stdin (a pipe, a file, or typed input ended with Enter). */
export function readStdinLine(stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let text = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.off("end", finish);
      stdin.off("error", onError);
      stdin.pause();
      resolveLine(text);
    };
    const onData = (chunk: Buffer | string) => {
      text += String(chunk);
      if (/[\r\n]/.test(text)) finish();
    };
    const onError = (error: Error) => {
      stdin.off("data", onData);
      stdin.off("end", finish);
      reject(error);
    };
    if (stdin.readableEnded) {
      resolveLine("");
      return;
    }
    stdin.on("data", onData);
    stdin.on("end", finish);
    stdin.on("error", onError);
    stdin.resume();
  });
}

/** Maps `setup --transcribe` to the transcription entry saved in the config file. */
export function transcriptionFor(choice: string, key?: string): StoredTranscription {
  switch (choice) {
    case "local-english":
      return { kind: "local", model: "english-fast" };
    case "local-multilingual":
      return { kind: "local", model: "multilingual" };
    case "openai":
    case "groq":
    case "deepgram":
    case "assemblyai":
    case "elevenlabs":
    case "gemini":
      return { kind: choice, apiKey: key ?? "" };
    default:
      return { kind: "none" };
  }
}

/** Maps `setup --model-provider` and its flags to the model entry saved in the config file. */
export function storedModelFor(preset: string, flags: { key?: string; model?: string; baseUrl?: string }): StoredModel | null {
  if (preset === "none") return null;
  return {
    preset,
    ...(flags.key ? { apiKey: flags.key } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.baseUrl ? { baseUrl: flags.baseUrl } : {}),
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "a custom URL";
  }
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function describeTranscription(config: TranscriptionConfig): string {
  switch (config.kind) {
    case "none":
      return "off";
    case "local":
      return `local model ${config.model} (on this machine, the audio never leaves it)`;
    case "openai-compatible":
      return `${config.model} at ${safeHost(config.baseUrl)}${config.apiKey ? ", key set" : ", no key"}${
        isLocalUrl(config.baseUrl) ? " (on this machine)" : " (the audio is sent there)"
      }`;
    default:
      return `${config.kind}${config.model ? ` (${config.model})` : ""}${config.apiKey ? ", key set" : ", no key"} (the audio is sent there)`;
  }
}

export function describeProvider(provider: ModelProvider | null, preset: string | null): string {
  if (!provider) return "rules only, no model provider (nothing leaves this machine)";
  return `${preset ?? "custom"}: ${provider.model} at ${safeHost(provider.baseUrl)}${provider.apiKey ? ", key set" : ""}${
    isLocalUrl(provider.baseUrl) ? " (on this machine)" : " (the transcript is sent there)"
  }`;
}

/** `clipy local setup`: saves the provider and transcription choices. Never prints a key. */
export function cmdLocalSetup(flags: SetupFlags, json: boolean, env: LocalEnv): number {
  const { io } = env;
  try {
    validateSetupFlags(flags);
    const deps = env.deps();
    const patch: StoredConfigPatch = {};
    const preset = flags.modelProvider;
    if (preset) {
      const f = { key: flags.modelKey, model: flags.model, baseUrl: flags.baseUrl };
      // Check what can be checked before saving. A hosted preset given no key may
      // still get one from CLIPY_MODEL_API_KEY, which loadConfig resolves below.
      if (preset !== "none" && (f.key || KEYLESS_PRESETS.has(preset))) {
        deps.presetProvider(preset, f.key, f.model, f.baseUrl);
      }
      patch.model = storedModelFor(preset, f);
    }
    if (flags.transcribe) patch.transcription = transcriptionFor(flags.transcribe, flags.transcribeKey);

    const changed = Object.keys(patch).length > 0;
    if (changed) deps.saveConfig(patch);
    const config = deps.loadConfig();
    const report = {
      ok: true,
      local: true,
      saved: changed,
      configPath: deps.configPath(),
      momentSelection: describeProvider(config.model, config.modelPreset),
      transcription: describeTranscription(config.transcription),
    };
    if (json) {
      io.stdout(`${JSON.stringify(report)}\n`);
      return 0;
    }
    if (changed) io.stdout(`Saved to ${report.configPath}.\n`);
    io.stdout(`Moment selection: ${report.momentSelection}\n`);
    io.stdout(`Transcription: ${report.transcription}\n`);
    if (!changed) io.stderr("Nothing changed. Run clipy local setup --help for the options.\n");
    return 0;
  } catch (error) {
    printLocalError(error, json, io);
    return error instanceof UsageError ? 2 : 1;
  }
}

// ---- clipy models ------------------------------------------------------------

export function parseModelsArgs(positionals: readonly string[]): { action: "list" } | { action: "download"; model: LocalModel } {
  if ((positionals[0] === "list" || positionals[0] === undefined) && positionals.length <= 1) return { action: "list" };
  if (positionals[0] === "download" && positionals.length === 2) {
    if (!LOCAL_MODELS.includes(positionals[1] as LocalModel)) {
      throw new UsageError(`Unknown model ${positionals[1]}. Choose english-fast or multilingual.`);
    }
    return { action: "download", model: positionals[1] as LocalModel };
  }
  throw new UsageError("usage: clipy models list, or clipy models download <english-fast|multilingual>");
}

/** Model licences, used when the vendored model table does not carry them. */
export const MODEL_LICENSES: Record<LocalModel, { license: string; attribution: string }> = {
  "english-fast": {
    license: "CC-BY-4.0",
    attribution: "NVIDIA Parakeet TDT-CTC 110M, licensed CC-BY-4.0",
  },
  multilingual: {
    license: "MIT",
    attribution: "OpenAI Whisper base, MIT licence",
  },
};

export const MODEL_RUNTIME_NOTE = "Both models run with sherpa-onnx (Apache-2.0).";

function mb(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** `clipy models list|download`: the on-device speech models local mode can use. */
export async function cmdModels(positionals: readonly string[], json: boolean, env: LocalEnv): Promise<number> {
  const { io } = env;
  try {
    const parsed = parseModelsArgs(positionals);
    const deps = env.deps();
    if (parsed.action === "list") {
      const models = LOCAL_MODELS.map((model) => {
        const info = deps.modelInfo(model);
        return {
          model,
          ...info,
          license: info.license ?? MODEL_LICENSES[model].license,
          attribution: info.attribution ?? MODEL_LICENSES[model].attribution,
          ...deps.modelStatus(model),
        };
      });
      if (json) {
        io.stdout(`${JSON.stringify({ ok: true, models, runtime: "sherpa-onnx (Apache-2.0)" })}\n`);
        return 0;
      }
      for (const m of models) {
        io.stdout(`${m.model}\t${m.installed ? "installed" : `not downloaded (${mb(m.sizeBytes)})`}\t${m.label}\t${m.license}\t${m.dir}\n`);
      }
      io.stderr(`${MODEL_RUNTIME_NOTE}\n`);
      return 0;
    }
    const { model } = parsed;
    let last = -1;
    // Ctrl-C or SIGTERM aborts the download, and the partial files are removed.
    const controller = new AbortController();
    const dispose = io.onInterrupt(() => controller.abort(new Error("Download cancelled")));
    let dir: string;
    try {
      dir = await deps.downloadModel(model, {
        signal: controller.signal,
        onProgress: (fraction) => {
          const pct = Math.floor(fraction * 100);
          if (pct >= last + 5 || pct === 100) {
            last = pct;
            if (!json) io.stderr(`Downloading ${model}: ${pct}%\n`);
          }
        },
      });
    } finally {
      dispose();
    }
    const speechEngine = await offerSpeechEngine(json, env);
    if (json) io.stdout(`${JSON.stringify({ ok: true, model, dir, ...(speechEngine ? { speechEngine } : {}) })}\n`);
    else io.stdout(`${dir}\n`);
    return 0;
  } catch (error) {
    printLocalError(error, json, io);
    return error instanceof UsageError ? 2 : 1;
  }
}

/**
 * After a model download, the engine that runs it: installed when accepted
 * (a yes at the prompt, --yes or the env var), otherwise a note. Never fails
 * the download. Returns what `--json` reports, or null when nothing changed.
 */
async function offerSpeechEngine(json: boolean, env: LocalEnv): Promise<Record<string, unknown> | null> {
  if (!env.speech) return null;
  const status = env.speech.status();
  if (status.installed) return null;
  const note = { installed: false, dir: status.dir, install: SPEECH_ENGINE_INSTALL_COMMAND };
  try {
    const controller = new AbortController();
    const dispose = env.io.onInterrupt(() => controller.abort(new Error("Cancelled")));
    try {
      await ensureSpeechEngine(env.speech, env.io, { json, assumeYes: env.assumeYes, signal: controller.signal });
    } finally {
      dispose();
    }
    return { installed: true, dir: status.dir };
  } catch (error) {
    if (!(error instanceof SpeechEngineRequiredError)) {
      env.io.stderr(`Warning: the speech engine was not installed: ${error instanceof Error ? error.message : String(error)}\n`);
    } else if (!json) {
      env.io.stderr(`The model runs with the speech engine (${SPEECH_ENGINE_SIZE}), which is not installed yet: run ${SPEECH_ENGINE_INSTALL_COMMAND}, or answer yes when a take asks.\n`);
    }
    return note;
  }
}

// ---- clipy speech -------------------------------------------------------------

/** `clipy speech status|install`: the on-device speech engine. Running install is the consent. */
export async function cmdSpeech(positionals: readonly string[], json: boolean, env: LocalEnv): Promise<number> {
  const { io } = env;
  try {
    const action = positionals[0] ?? "status";
    if (positionals.length > 1 || (action !== "status" && action !== "install")) {
      throw new UsageError("usage: clipy speech status, or clipy speech install");
    }
    const speech = env.speech ?? realSpeechEngine();
    let status = speech.status();
    let installedNow = false;
    if (action === "install" && !status.installed) {
      if (!json) io.stderr(`Downloading the speech engine (${SPEECH_ENGINE_PACKAGE} ${SPEECH_ENGINE_VERSION}, ${SPEECH_ENGINE_SIZE}) into ${status.dir}...\n`);
      const controller = new AbortController();
      const dispose = io.onInterrupt(() => controller.abort(new Error("Cancelled")));
      try {
        status = await speech.install({ signal: controller.signal });
      } finally {
        dispose();
      }
      installedNow = true;
    }
    if (json) {
      io.stdout(`${JSON.stringify({ ok: true, ...speechReport(status), ...(action === "install" ? { installedNow } : {}) })}\n`);
      return 0;
    }
    if (status.installed) {
      io.stdout(`${status.entry}\n`);
      io.stderr(`Speech engine ${installedNow ? "installed" : "ready"}: ${SPEECH_ENGINE_PACKAGE} ${status.source === "alongside" ? "(installed alongside the CLI)" : status.version}.\n`);
    } else {
      io.stdout(`not installed (${status.dir})\n`);
      io.stderr(`Run ${SPEECH_ENGINE_INSTALL_COMMAND} to download it (${SPEECH_ENGINE_SIZE}). A local take that needs it asks first.\n`);
    }
    return 0;
  } catch (error) {
    printLocalError(error, json, io);
    return error instanceof UsageError ? 2 : 1;
  }
}

function speechReport(status: SpeechEngineStatus) {
  return {
    installed: status.installed,
    package: SPEECH_ENGINE_PACKAGE,
    version: SPEECH_ENGINE_VERSION,
    source: status.source,
    entry: status.entry,
    dir: status.dir,
    ...(status.installed ? {} : { install: SPEECH_ENGINE_INSTALL_COMMAND }),
  };
}

// ---- clipy local status and doctor ------------------------------------------

export const SPEECH_ENGINE_HINT =
  `run ${SPEECH_ENGINE_INSTALL_COMMAND} (${SPEECH_ENGINE_SIZE}; a local take that needs it asks first), or transcribe with your own key: set CLIPY_TRANSCRIBE=openai and CLIPY_TRANSCRIBE_API_KEY, or run clipy local setup --transcribe openai --transcribe-key - and paste the key`;

export interface LocalCheck {
  name: string;
  status: "pass" | "warn" | "info";
  detail: string;
  hint?: string;
  data?: Record<string, unknown>;
}

/**
 * What local mode can do on this machine. Never a failure: local mode is
 * optional, and an install that only uses the hosted product is healthy.
 */
export async function localChecks(env: LocalEnv, speechEngine?: SpeechEngineStatus): Promise<LocalCheck[]> {
  const checks: LocalCheck[] = [];
  let deps: Deps;
  try {
    deps = env.deps();
  } catch (error) {
    return [{ name: "local mode", status: "warn", detail: `unavailable: ${error instanceof Error ? error.message : String(error)}` }];
  }

  let transcription: TranscriptionConfig | null = null;
  try {
    const config = deps.loadConfig();
    transcription = config.transcription;
    checks.push({
      name: "local config",
      status: "pass",
      detail: `moments: ${describeProvider(config.model, config.modelPreset)} · transcription: ${describeTranscription(config.transcription)}`,
      data: {
        path: deps.configPath(),
        exists: existsSync(deps.configPath()),
        modelPreset: config.modelPreset,
        transcription: config.transcription.kind,
      },
    });
  } catch (error) {
    checks.push({
      name: "local config",
      status: "warn",
      detail: error instanceof Error ? error.message : String(error),
      hint: "fix or remove the file, or run clipy local setup",
      data: { path: safeConfigPath(deps) },
    });
  }

  const models: Record<string, unknown> = {};
  for (const model of LOCAL_MODELS) {
    try {
      models[model] = deps.modelStatus(model);
    } catch (error) {
      models[model] = { installed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const wanted = transcription?.kind === "local" ? transcription.model : null;
  const wantedInstalled = wanted ? (models[wanted] as { installed?: boolean }).installed === true : true;
  const installed = LOCAL_MODELS.filter((m) => (models[m] as { installed?: boolean }).installed);
  checks.push({
    name: "local models",
    status: wantedInstalled ? (installed.length > 0 ? "pass" : "info") : "warn",
    detail: installed.length > 0 ? `installed: ${installed.join(", ")}` : "no speech model downloaded",
    ...(wantedInstalled ? {} : { hint: `local transcription uses ${wanted}: clipy models download ${wanted}` }),
    data: models,
  });

  let engine: SpeechEngineStatus | null = speechEngine ?? null;
  try {
    engine ??= (env.speech ?? realSpeechEngine()).status();
  } catch {
    engine = null;
  }
  const ready = engine?.installed === true;
  // Not an error: the engine is downloaded, after asking, the first time a take needs it.
  checks.push({
    name: "local speech",
    status: ready ? "pass" : "info",
    detail: ready
      ? `speech engine ready (${SPEECH_ENGINE_PACKAGE} ${engine?.source === "alongside" ? "installed alongside the CLI" : SPEECH_ENGINE_VERSION})`
      : "speech engine not installed (downloaded on first use, after asking)",
    ...(ready ? {} : { hint: SPEECH_ENGINE_HINT }),
    data: {
      sherpaOnnxNode: ready,
      installed: ready,
      version: SPEECH_ENGINE_VERSION,
      source: engine?.source ?? null,
      dir: engine?.dir ?? null,
      ...(ready ? {} : { install: SPEECH_ENGINE_INSTALL_COMMAND }),
    },
  });

  try {
    const capture = await deps.checkCapture();
    checks.push({
      name: "local capture",
      status: capture.ok ? "pass" : "warn",
      detail: capture.ok
        ? `ready (ffmpeg at ${capture.ffmpeg})`
        : `not ready: ${capture.problems.join("; ") || "unknown problem"}`,
      ...(capture.hints.length ? { hint: capture.hints.join("; ") } : {}),
      data: { ok: capture.ok, ffmpeg: capture.ffmpeg, problems: capture.problems },
    });
  } catch (error) {
    checks.push({ name: "local capture", status: "warn", detail: error instanceof Error ? error.message : String(error) });
  }
  return checks;
}

function safeConfigPath(deps: Deps): string | null {
  try {
    return deps.configPath();
  } catch {
    return null;
  }
}

/** `clipy local status`: config, provider, transcription, models and capture, in one view. */
export async function cmdLocalStatus(json: boolean, env: LocalEnv, speechEngine?: SpeechEngineStatus): Promise<number> {
  const { io } = env;
  const checks = await localChecks(env, speechEngine);
  if (json) {
    io.stdout(`${JSON.stringify({ ok: true, local: true, checks })}\n`);
    return 0;
  }
  io.stdout("Local mode: record and build an AREC on this machine. No Clipy account, nothing uploaded.\n");
  for (const check of checks) {
    io.stdout(`${check.status.toUpperCase().padEnd(4)}  ${check.name.padEnd(14)}  ${check.detail}\n`);
    if (check.hint) io.stdout(`      ${check.hint}\n`);
  }
  const config = checks.find((c) => c.name === "local config");
  const path = (config?.data as { path?: string } | undefined)?.path;
  if (path) io.stdout(`config file: ${path}\n`);
  return 0;
}
