// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/capture/src/capture.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * startCapture: one ffmpeg process recording a display (or, on Linux, a
 * window) into a fragmented MP4, plus the pointer sidecar next to it.
 *
 * Stopping writes "q" to ffmpeg's stdin so the file finalizes; if ffmpeg does
 * not exit, SIGINT and then SIGKILL follow. Because the MP4 is fragmented
 * (moov first, a fragment per keyframe), even a killed ffmpeg leaves a
 * playable file up to its last fragment.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, statSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";
import { isWaylandSession, hasDevice, SCREEN_RECORDING_HINT } from "./check.js";
import { trackChild } from "./children.js";
import { xEnv } from "./xauth.js";
import { buildFfmpegArgs, pickH264Encoder, type AudioInput, type CapturePlan, type H264Encoder, type Rect, type VideoInput } from "./ffmpegArgs.js";
import { currentPlatform, ffmpegPath, ffprobePath, realRunner, sleep, type Runner } from "./proc.js";
import { samplesToEvents, startPointerSampler, type PointerSampler } from "./sidecar.js";
import {
  avfoundationScreens,
  linuxScreens,
  listAvfoundation,
  listDshowAudio,
  parseSourceId,
  parseWindowGeometry,
  primaryFirst,
  windowsScreens,
  type ScreenInfo,
} from "./sources.js";
import type { CaptureGeometry, CaptureOptions, CaptureResult, CaptureSession, Platform } from "./types.js";

/** How long ffmpeg may take to open its inputs (a macOS permission prompt counts). */
const START_TIMEOUT_MS = 20_000;
/** After it starts, how long to watch for an immediate failure. */
const SETTLE_MS = 600;

const BANNER = /Press \[q\] to stop/;

/**
 * Patterns ffmpeg prints when macOS has not granted Screen Recording or
 * Microphone. Without the Screen Recording grant, recent macOS lists no
 * "Capture screen" devices at all, so opening one by name fails as "Video
 * device not found".
 */
export function looksLikeMacPermissionError(stderr: string): boolean {
  if (/Video device not found[\s\S]*Capture screen \d/i.test(stderr)) return true;
  return /not (?:been )?(?:authorized|permitted)|Operation not permitted|Failed to create AV capture input device|Could not create (?:video|audio) capture|kTCC|privacy/i.test(stderr);
}

function tail(text: string, lines = 8): string {
  return text.trim().split(/\r?\n/).filter((l) => !/^\s*(?:Input|Output|Stream|Metadata|Duration|encoder|handler_name|vendor_id|major_brand|minor_version|compatible_brands|Side data|cpb:|Press \[q\])/.test(l)).slice(-lines).join("\n");
}

interface Launched {
  child: ChildProcess;
  startedAt: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
  stderr(): string;
}

class StartError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Spawn ffmpeg and wait until it is recording (or has failed). */
async function launch(ffmpeg: string, args: string[], env: NodeJS.ProcessEnv): Promise<Launched> {
  const child = trackChild(spawn(ffmpeg, args, { env, stdio: ["pipe", "ignore", "pipe"], windowsHide: true }));
  let stderr = "";
  let bannerAt: number | null = null;
  let onBanner: () => void = () => {};
  const banner = new Promise<void>((r) => {
    onBanner = r;
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 32_768) stderr = stderr.slice(-16_384);
    if (bannerAt === null && BANNER.test(stderr)) {
      bannerAt = Date.now();
      onBanner();
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((r) => {
    child.on("exit", (code, signal) => r({ code, signal, at: Date.now() }));
    child.on("error", () => r({ code: null, signal: null, at: Date.now() }));
  });
  // ffmpeg reads "q" from stdin; a broken pipe after it exits is harmless.
  child.stdin!.on("error", () => {});

  // A cleared timer, not sleep(): a pending 20 s sleep would keep the process
  // alive that long after a short recording has finished.
  let startTimer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((r) => {
    startTimer = setTimeout(() => r("timeout"), START_TIMEOUT_MS);
  });
  const first = await Promise.race([banner.then(() => "banner" as const), exited.then(() => "exit" as const), timeout]);
  clearTimeout(startTimer);
  if (first === "exit") throw new StartError("ffmpeg stopped before recording started", stderr);
  if (first === "timeout") {
    child.kill("SIGKILL");
    throw new StartError(`ffmpeg did not start recording within ${START_TIMEOUT_MS / 1000} s`, stderr);
  }
  const settled = await Promise.race([exited.then(() => "exit" as const), sleep(SETTLE_MS).then(() => "ok" as const)]);
  if (settled === "exit") throw new StartError("ffmpeg stopped right after it started", stderr);
  return { child, startedAt: bannerAt ?? Date.now(), exited, stderr: () => stderr };
}

/** Ask ffmpeg to finish its file ("q"), then insist. */
async function stopFfmpeg(l: Launched, graceMs = 5000): Promise<void> {
  if (l.child.exitCode !== null || l.child.signalCode !== null) return;
  try {
    l.child.stdin!.write("q");
    l.child.stdin!.end();
  } catch {
    // stdin already closed
  }
  const int = setTimeout(() => l.child.kill("SIGINT"), graceMs);
  const kill = setTimeout(() => l.child.kill("SIGKILL"), graceMs * 2);
  await l.exited;
  clearTimeout(int);
  clearTimeout(kill);
}

export interface ProbeInfo {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
}

export function parseProbeJson(json: string): ProbeInfo {
  try {
    const data = JSON.parse(json) as { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[] };
    const video = data.streams?.find((s) => s.codec_type === "video");
    const seconds = data.format?.duration !== undefined ? Number(data.format.duration) : NaN;
    return {
      durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      codec: video?.codec_name ?? null,
    };
  } catch {
    return { durationMs: null, width: null, height: null, codec: null };
  }
}

export async function probe(path: string, run: Runner = realRunner, env: NodeJS.ProcessEnv = process.env): Promise<ProbeInfo | null> {
  const ffprobe = ffprobePath(currentPlatform(), env);
  if (!ffprobe) return null;
  // file: keeps a name such as take2:final.mp4 from being read as a protocol.
  const input = `file:${resolve(path)}`;
  const r = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", input], env);
  return r.status === 0 ? parseProbeJson(r.stdout) : null;
}

const encoderCache = new Map<string, { encoder: H264Encoder | null; devices: string }>();

async function ffmpegFeatures(ffmpeg: string, platform: Platform, env: NodeJS.ProcessEnv): Promise<{ encoder: H264Encoder | null; devices: string }> {
  const cached = encoderCache.get(ffmpeg);
  if (cached) return cached;
  const [encoders, devices] = await Promise.all([
    realRunner(ffmpeg, ["-hide_banner", "-encoders"], env),
    realRunner(ffmpeg, ["-hide_banner", "-devices"], env),
  ]);
  const features = { encoder: pickH264Encoder(encoders.stdout + encoders.stderr, platform), devices: devices.stdout + devices.stderr };
  encoderCache.set(ffmpeg, features);
  return features;
}

interface Resolved {
  plans: { plan: CapturePlan; label: string }[];
  geometry: Rect | null;
  warnings: string[];
  windowCapture: boolean;
}

async function resolveLinux(options: CaptureOptions, base: Omit<CapturePlan, "video" | "audio">, devices: string, sampler: PointerSampler, env: NodeJS.ProcessEnv): Promise<Resolved> {
  const warnings: string[] = [];
  const xDisplay = options.xDisplay ?? env.DISPLAY;
  if (!xDisplay) {
    throw new Error(
      isWaylandSession(env)
        ? "this is a Wayland session without XWayland (DISPLAY is unset): ffmpeg cannot record it. Log in to an X11 session, enable XWayland, or record a virtual display."
        : "no X display to record: DISPLAY is unset. Pass xDisplay or start a virtual display.",
    );
  }
  if (isWaylandSession(env) && !options.xDisplay) warnings.push("Wayland session: native Wayland windows record as black; only XWayland apps appear.");
  const source = parseSourceId(options.source);
  let video: VideoInput;
  let geometry: Rect | null = null;
  if (source.kind === "window") {
    video = { backend: "x11grab", xDisplay, windowId: source.id };
    const info = await realRunner("xwininfo", ["-id", `0x${source.id.toString(16)}`], xEnv(env, xDisplay));
    const g = info.status === 0 ? parseWindowGeometry(info.stdout) : null;
    if (g) geometry = { x: g.x, y: g.y, width: g.width, height: g.height };
    else warnings.push("window geometry is unknown (install x11-utils for xwininfo), so pointer positions cannot be placed on the video");
  } else {
    const screens = await linuxScreens(xDisplay, realRunner, env);
    if (source.index >= Math.max(1, screens.length)) {
      throw new Error(`display:${source.index} does not exist on ${xDisplay} (${screens.length || 1} display${screens.length === 1 ? "" : "s"})`);
    }
    const screen = screens[source.index];
    // A single display that is the whole X screen records without a crop.
    const whole = screens.length <= 1 && screen && screen.x === 0 && screen.y === 0;
    video = { backend: "x11grab", xDisplay, rect: whole || !screen ? undefined : screen };
    geometry = screen ? { x: screen.x, y: screen.y, width: screen.width, height: screen.height } : null;
    if (!geometry) {
      await sampler.ready;
      const s = sampler.screens()[0];
      if (s) geometry = { x: 0, y: 0, width: s.width, height: s.height };
    }
  }
  let audio: AudioInput | undefined;
  if (options.microphone) {
    const device = typeof options.microphone === "string" ? options.microphone : "default";
    if (hasDevice(devices, "pulse")) audio = { backend: "pulse", device };
    else if (hasDevice(devices, "alsa")) audio = { backend: "alsa", device };
    else warnings.push("this ffmpeg has neither pulse nor alsa input; recording without the microphone");
  }
  return { plans: [{ plan: { ...base, video, audio }, label: "x11grab" }], geometry, warnings, windowCapture: source.kind === "window" };
}

async function resolveMac(options: CaptureOptions, base: Omit<CapturePlan, "video" | "audio">, sampler: PointerSampler, env: NodeJS.ProcessEnv): Promise<Resolved> {
  const warnings: string[] = [];
  const source = parseSourceId(options.source);
  if (source.kind === "window") throw new Error("macOS capture records whole displays only; pick a display:N source");
  const devices = await listAvfoundation(realRunner, env);
  const screens = devices ? avfoundationScreens(devices) : [];
  let device: string;
  if (screens.length > 0) {
    const screen = screens[source.index];
    if (!screen) throw new Error(`display:${source.index} does not exist (${screens.length} screen${screens.length === 1 ? "" : "s"})`);
    device = String(screen.index);
  } else {
    device = `Capture screen ${source.index}`;
    warnings.push("ffmpeg listed no screens; trying the screen by name. " + SCREEN_RECORDING_HINT);
  }
  let audio: AudioInput | undefined;
  if (options.microphone) {
    if (typeof options.microphone === "string") {
      const want = options.microphone.toLowerCase();
      const match = devices?.audio.find((d) => d.name.toLowerCase() === want) ?? devices?.audio.find((d) => d.name.toLowerCase().includes(want));
      if (match) audio = { backend: "avfoundation", device: String(match.index) };
      else if (/^\d+$/.test(options.microphone)) audio = { backend: "avfoundation", device: options.microphone };
      else {
        const names = devices?.audio.map((d) => `"${d.name}"`).join(", ") || "none listed";
        throw new Error(`no microphone named "${options.microphone}" (available: ${names})`);
      }
    } else {
      audio = { backend: "avfoundation", device: "default" };
    }
  }
  await sampler.ready;
  const s = sampler.screens()[source.index];
  const geometry = s ? { x: s.x, y: s.y, width: s.width, height: s.height } : null;
  return { plans: [{ plan: { ...base, video: { backend: "avfoundation", device }, audio }, label: "avfoundation" }], geometry, warnings, windowCapture: false };
}

async function resolveWindows(options: CaptureOptions, base: Omit<CapturePlan, "video" | "audio">, devices: string, sampler: PointerSampler, env: NodeJS.ProcessEnv): Promise<Resolved> {
  const warnings: string[] = [];
  const source = parseSourceId(options.source);
  if (source.kind === "window") throw new Error("Windows capture records whole displays only; pick a display:N source");
  await sampler.ready;
  let screens: ScreenInfo[] = primaryFirst(sampler.screens());
  if (screens.length === 0) screens = await windowsScreens(realRunner, env);
  if (screens.length > 0 && !screens[source.index]) {
    throw new Error(`display:${source.index} does not exist (${screens.length} display${screens.length === 1 ? "" : "s"})`);
  }
  const screen = screens[source.index] ?? null;
  let audio: AudioInput | undefined;
  if (options.microphone) {
    if (!hasDevice(devices, "dshow")) {
      warnings.push("this ffmpeg has no dshow input; recording without the microphone");
    } else {
      const names = await listDshowAudio(realRunner, env);
      if (typeof options.microphone === "string") {
        const want = options.microphone.toLowerCase();
        const match = names.find((n) => n.toLowerCase() === want) ?? names.find((n) => n.toLowerCase().includes(want));
        if (!match) throw new Error(`no microphone named "${options.microphone}" (available: ${names.map((n) => `"${n}"`).join(", ") || "none listed"})`);
        audio = { backend: "dshow", device: match };
      } else if (names[0]) {
        audio = { backend: "dshow", device: names[0] };
      } else {
        warnings.push("no microphone was found; recording without it");
      }
    }
  }
  const geometry = screen ? { x: screen.x, y: screen.y, width: screen.width, height: screen.height } : null;
  return {
    plans: [
      { plan: { ...base, video: { backend: "ddagrab", outputIndex: source.index }, audio }, label: "ddagrab" },
      { plan: { ...base, video: { backend: "gdigrab", rect: screen ?? undefined }, audio }, label: "gdigrab" },
    ],
    geometry,
    warnings,
    windowCapture: false,
  };
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * After a capture that never started: remove the output only if this capture
 * wrote it (absent before, or changed since). A file the user already had
 * there and ffmpeg never opened is left alone.
 */
export function removeFailedOutput(path: string, before: Stats | null): void {
  const after = statOrNull(path);
  if (!after) return;
  if (before && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino) return;
  rmSync(path, { force: true });
}

export interface StartOptionsInternal {
  env?: NodeJS.ProcessEnv;
}

export async function startCapture(options: CaptureOptions, internal: StartOptionsInternal = {}): Promise<CaptureSession> {
  const platform = currentPlatform();
  const env = internal.env ?? process.env;
  const ffmpeg = ffmpegPath(platform, env);
  if (!ffmpeg) throw new Error("ffmpeg was not found on PATH (run checkCapture for install steps)");
  const fps = options.fps ?? 30;
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error(`fps must be between 1 and 120 (got ${fps})`);
  if (options.maxSeconds !== undefined && !(options.maxSeconds > 0)) throw new Error("maxSeconds must be positive");
  const outPath = resolve(options.outPath);
  mkdirSync(dirname(outPath), { recursive: true });

  const features = await ffmpegFeatures(ffmpeg, platform, env);
  if (!features.encoder) throw new Error("this ffmpeg has no H.264 encoder (libx264); run checkCapture for install steps");
  const base = { fps, encoder: features.encoder, maxSeconds: options.maxSeconds, output: outPath };

  const xDisplay = options.xDisplay ?? env.DISPLAY;
  const sampler = startPointerSampler(platform, { xDisplay, env });
  let resolved: Resolved;
  try {
    resolved =
      platform === "linux"
        ? await resolveLinux(options, base, features.devices, sampler, env)
        : platform === "darwin"
          ? await resolveMac(options, base, sampler, env)
          : await resolveWindows(options, base, features.devices, sampler, env);
    await sampler.ready;
  } catch (err) {
    await sampler.stop();
    throw err;
  }

  const warnings = [...resolved.warnings];
  const existingOutput = statOrNull(outPath);
  let launched: Launched | null = null;
  let lastError: StartError | null = null;
  for (const { plan, label } of resolved.plans) {
    try {
      launched = await launch(ffmpeg, buildFfmpegArgs(plan), platform === "linux" ? xEnv(env, xDisplay) : env);
      if (lastError) warnings.push(`${resolved.plans[0].label} could not start, recorded with ${label} instead: ${tail(lastError.stderr, 2)}`);
      break;
    } catch (err) {
      if (!(err instanceof StartError)) throw err;
      lastError = err;
    }
  }
  if (!launched) {
    await sampler.stop();
    removeFailedOutput(outPath, existingOutput);
    const detail = tail(lastError?.stderr ?? "");
    const hint = platform === "darwin" && looksLikeMacPermissionError(lastError?.stderr ?? "") ? `\n${SCREEN_RECORDING_HINT}` : "";
    throw new Error(`${lastError?.message ?? "ffmpeg did not start"}${detail ? `:\n${detail}` : ""}${hint}`);
  }

  const l = launched;
  let stopRequestedAt: number | null = null;
  let finished: Promise<CaptureResult> | null = null;
  let aborted: Promise<void> | null = null;
  const ended = l.exited.then(() => undefined);

  const finish = async (): Promise<CaptureResult> => {
    if (stopRequestedAt === null) stopRequestedAt = Date.now();
    await stopFfmpeg(l);
    const exit = await l.exited;
    const { samples, warnings: sidecarWarnings } = await sampler.stop();
    warnings.push(...sidecarWarnings);
    let size = 0;
    try {
      size = statSync(outPath).size;
    } catch {
      // handled below
    }
    if (size === 0) throw new Error(`ffmpeg wrote no video${tail(l.stderr()) ? `:\n${tail(l.stderr())}` : ""}`);
    const selfStopped = exit.at < stopRequestedAt;
    if (selfStopped) {
      const hitLimit = options.maxSeconds !== undefined && exit.at - l.startedAt >= options.maxSeconds * 1000 - 1500 && exit.code === 0;
      if (!hitLimit) {
        warnings.push(
          resolved.windowCapture
            ? "the window changed size or closed, so the recording stopped early"
            : `ffmpeg stopped early (exit ${exit.code ?? exit.signal}): ${tail(l.stderr(), 3)}`,
        );
      }
    } else if (exit.code !== 0 && exit.code !== 255) {
      warnings.push(`ffmpeg exited with ${exit.code ?? exit.signal}; the file was kept up to its last complete fragment`);
    }
    const info = await probe(outPath, realRunner, env);
    const endedAt = Math.min(exit.at, stopRequestedAt);
    let durationMs = info?.durationMs ?? null;
    if (durationMs === null) {
      durationMs = Math.max(0, endedAt - l.startedAt);
      warnings.push("ffprobe was unavailable; the duration comes from the wall clock");
    }
    const interactions = samplesToEvents(samples, l.startedAt, l.startedAt + durationMs);
    let geometry: CaptureGeometry | null = resolved.geometry ? { ...resolved.geometry } : null;
    if (!geometry && platform !== "darwin" && info?.width && info.height) {
      geometry = { x: 0, y: 0, width: info.width, height: info.height };
    }
    if (geometry && info?.width && info.height) {
      geometry.output_width = info.width;
      geometry.output_height = info.height;
    }
    return { path: outPath, durationMs, interactions, geometry, warnings };
  };

  return {
    startedAt: l.startedAt,
    ended,
    // Both are idempotent: a second stop() returns the first one's result,
    // a second abort() waits for the first. stop() after abort() rejects
    // (there is no file any more); abort() after stop() leaves the finished
    // file alone and only waits for stop() to settle.
    stop() {
      if (aborted) return aborted.then(() => Promise.reject(new Error("the capture was aborted")));
      finished ??= finish();
      return finished;
    },
    abort() {
      if (finished) return finished.then(() => undefined, () => undefined);
      aborted ??= (async () => {
        if (stopRequestedAt === null) stopRequestedAt = Date.now();
        if (l.child.exitCode === null && l.child.signalCode === null) {
          l.child.kill("SIGKILL");
          await l.exited;
        }
        await sampler.stop();
        rmSync(outPath, { force: true });
      })();
      return aborted;
    },
  };
}
