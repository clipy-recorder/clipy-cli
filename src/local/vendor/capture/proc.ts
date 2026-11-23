// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/capture/src/proc.ts by cli/scripts/sync-local.mjs. Do not edit here.
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Platform } from "./types.js";

export function currentPlatform(): Platform {
  const p = process.platform;
  if (p === "darwin" || p === "win32" || p === "linux") return p;
  throw new Error(`@clipy/capture supports macOS, Windows and Linux, not ${p}`);
}

/** What a command returned; `status` is null when it could not run at all. */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<RunResult>;

export const realRunner: Runner = (cmd, args, env = process.env) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env, encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (error as NodeJS.ErrnoException & { code?: unknown }).code : 0;
        // A non-zero exit still has output worth parsing (ffmpeg -list_devices
        // always exits 1); only a spawn failure means the command is missing.
        const status = typeof code === "number" ? code : error ? (typeof code === "string" ? null : 1) : 0;
        resolve({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

/** Look a program up on PATH (and PATHEXT on Windows) without spawning it. */
export function findExecutable(name: string, platform: Platform = currentPlatform(), env: NodeJS.ProcessEnv = process.env): string | null {
  if (name.includes("/") || (platform === "win32" && name.includes("\\"))) return isExecutable(name, platform) ? name : null;
  const path = env.PATH ?? env.Path ?? "";
  const sep = platform === "win32" ? ";" : delimiter;
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + (platform === "win32" && !name.toLowerCase().endsWith(ext.toLowerCase()) ? ext : ""));
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

function isExecutable(path: string, platform: Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** ffmpeg, honouring CLIPY_FFMPEG. */
export function ffmpegPath(platform: Platform = currentPlatform(), env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLIPY_FFMPEG) return findExecutable(env.CLIPY_FFMPEG, platform, env);
  return findExecutable("ffmpeg", platform, env);
}

/** ffprobe, honouring CLIPY_FFPROBE, else next to ffmpeg, else on PATH. */
export function ffprobePath(platform: Platform = currentPlatform(), env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLIPY_FFPROBE) return findExecutable(env.CLIPY_FFPROBE, platform, env);
  const ffmpeg = ffmpegPath(platform, env);
  if (ffmpeg) {
    const sibling = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_m, ext: string | undefined) => `ffprobe${ext ?? ""}`);
    if (sibling !== ffmpeg && findExecutable(sibling, platform, env)) return sibling;
  }
  return findExecutable("ffprobe", platform, env);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
