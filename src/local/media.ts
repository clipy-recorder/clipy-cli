/**
 * The few ffmpeg operations the pipeline needs: duration, one frame at a time,
 * and bringing an imported file into `recording.mp4`. ffmpeg is the only
 * external program the local edition relies on.
 */
import { spawn } from "node:child_process";
import { copyFile, rename, rm, stat } from "node:fs/promises";
import { extname } from "node:path";

/** Width cap for extracted frames: enough to read UI text, small enough for an agent's context. */
export const FRAME_MAX_WIDTH = 1280;

export interface FfmpegRun {
  code: number | null;
  stderr: string;
}

export function runFfmpeg(ffmpeg: string, args: string[], signal?: AbortSignal): Promise<FfmpegRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Keep the tail only; ffmpeg can be chatty on long files.
      stderr = (stderr + chunk).slice(-64_000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error(`ffmpeg was not found (${ffmpeg}). Install ffmpeg and try again; clipy doctor shows what is missing.`));
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop()?.trim() ?? "";
}

function parseClock(h: string, m: string, s: string): number {
  return Math.round((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000);
}

/** Duration in ms from ffmpeg's own header read, falling back to a full decode. */
export async function probeDurationMs(ffmpeg: string, file: string, signal?: AbortSignal): Promise<number> {
  const header = await runFfmpeg(ffmpeg, ["-hide_banner", "-i", file], signal);
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(header.stderr);
  if (match) return parseClock(match[1], match[2], match[3]);
  if (/Invalid data found|No such file|does not contain any stream/i.test(header.stderr)) {
    throw new Error(`ffmpeg cannot read ${file}: ${lastLine(header.stderr)}`);
  }
  // Fragmented or streamed files can lack a header duration: decode and read the last timestamp.
  const decode = await runFfmpeg(ffmpeg, ["-hide_banner", "-nostats", "-progress", "pipe:2", "-i", file, "-f", "null", "-"], signal);
  const times = [...decode.stderr.matchAll(/out_time_ms=(\d+)/g)];
  if (times.length > 0) return Math.round(Number(times[times.length - 1][1]) / 1000);
  throw new Error(`ffmpeg could not tell how long ${file} is: ${lastLine(decode.stderr)}`);
}

/**
 * Whether the file has an audio stream, read from ffmpeg's header dump. A
 * headless browser capture or a silent screen capture has none, and there is
 * nothing to transcribe then.
 */
export async function hasAudioStream(ffmpeg: string, file: string, signal?: AbortSignal): Promise<boolean> {
  const header = await runFfmpeg(ffmpeg, ["-hide_banner", "-i", file], signal);
  return /Stream #\d+:\d+[^\n]*: Audio:/.test(header.stderr);
}

async function nonEmpty(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/**
 * One JPEG at `atMs`, scaled to at most 1280 wide. The last frame of a file
 * sits a little before its duration, so a request that lands past it steps
 * back. Returns the time actually used, or an error message.
 */
export async function extractFrame(
  ffmpeg: string,
  video: string,
  atMs: number,
  output: string,
  signal?: AbortSignal,
): Promise<{ ok: true; frameTimeMs: number } | { ok: false; error: string }> {
  let lastError = "no frame decoded";
  for (const stepBack of [0, 100, 500, 1000]) {
    const t = Math.max(0, atMs - stepBack);
    await rm(output, { force: true });
    const run = await runFfmpeg(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-ss", (t / 1000).toFixed(3),
        "-i", video,
        "-frames:v", "1",
        "-vf", `scale='min(${FRAME_MAX_WIDTH},iw)':-2`,
        "-q:v", "3",
        output,
      ],
      signal,
    );
    if (run.code === 0 && (await nonEmpty(output))) return { ok: true, frameTimeMs: t };
    if (run.stderr.trim()) lastError = lastLine(run.stderr);
    if (t === 0) break;
  }
  await rm(output, { force: true });
  return { ok: false, error: lastError };
}

/**
 * Puts the video at `target` (always `recording.mp4`). An MP4 is copied, or
 * moved when the caller owns it; anything else is remuxed without re-encoding
 * when the codecs allow it, and re-encoded to H.264/AAC when they do not.
 */
export async function placeVideo(
  ffmpeg: string,
  source: string,
  target: string,
  options: { move?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  if (source === target) return;
  // Everything is written to a temporary name and renamed into place only once
  // it is complete, and the source is removed only after that. A failure or a
  // cancel part-way never leaves a partial `target` that looks like the take,
  // and never costs the source.
  const partial = `${target}.tmp`;
  const finish = async () => {
    await rename(partial, target);
    if (options.move) await rm(source, { force: true });
  };
  try {
    const ext = extname(source).toLowerCase();
    if (ext === ".mp4" || ext === ".m4v") {
      if (options.move) {
        try {
          await rename(source, target);
          return;
        } catch {
          // Different volume: fall through to a copy.
        }
      }
      await copyFile(source, partial);
      await finish();
      return;
    }
    const remux = await runFfmpeg(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", partial],
      options.signal,
    );
    options.signal?.throwIfAborted();
    if (remux.code === 0 && (await nonEmpty(partial))) {
      await finish();
      return;
    }
    const encode = await runFfmpeg(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y", "-i", source,
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-f", "mp4", partial,
      ],
      options.signal,
    );
    options.signal?.throwIfAborted();
    if (encode.code !== 0 || !(await nonEmpty(partial))) {
      throw new Error(`ffmpeg could not convert ${source} to MP4: ${lastLine(encode.stderr)}`);
    }
    await finish();
  } finally {
    await rm(partial, { force: true });
  }
}
