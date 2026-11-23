// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/capture/src/virtualDisplay.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * A private X display (Xvfb) on Linux: something only the agent draws on, so
 * the user's own screen, pointer and keyboard are never involved.
 *
 * Xvfb listens on no TCP port and, when `xauth` is installed, starts with
 * access control on: a random cookie in an Xauthority file only this user can
 * read. Processes of this user are then also allowed by name (localuser), so
 * `DISPLAY=:N <app>` keeps working for the user who started it; other users on
 * the machine cannot connect. Without `xauth` it starts as before, open to
 * local clients, and says so in `warnings`.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { atExit, trackChild } from "./children.js";
import { even } from "./ffmpegArgs.js";
import { findExecutable, sleep } from "./proc.js";
import { ALLOW_LOCAL_USER_SCRIPT, forgetXAuthority, OPEN_DISPLAY_SCRIPT, registerXAuthority } from "./xauth.js";

export interface VirtualDisplay {
  /** The X display name, e.g. ":91". */
  display: string;
  /** Xvfb's process id. */
  pid: number | undefined;
  /** The Xauthority file clients need, or null when the display has no access control. */
  xauthority: string | null;
  /** Things the caller may want to tell the user (no access control, apps need XAUTHORITY). */
  warnings: string[];
  /** `base` (default process.env) with DISPLAY and XAUTHORITY set for this display, for apps launched on it. */
  env(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Stops Xvfb and removes the Xauthority file. Safe to call more than once. */
  stop(): Promise<void>;
}

export function validateDisplaySize(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 240 || width > 7680 || height > 4320) {
    throw new Error(`virtual display size must be between 320x240 and 7680x4320 (got ${width}x${height})`);
  }
  return { width: even(width), height: even(height) };
}

function freeDisplayNumber(): number {
  for (let n = 90; n < 200; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error("no free X display number between :90 and :199");
}

function gone(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminate(child: ChildProcess, graceMs = 3000): Promise<void> {
  if (gone(child)) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(timer);
}

/** A folder only this user can open, holding an Xauthority file with a fresh cookie for `display`. */
function writeAuthority(xauthPath: string, display: string): { dir: string; file: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "clipy-xvfb-"));
  const file = join(dir, "Xauthority");
  try {
    execFileSync(xauthPath, ["-q", "-f", file, "add", display, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")], {
      stdio: "ignore",
      timeout: 5000,
    });
    return existsSync(file) ? { dir, file } : (rmSync(dir, { recursive: true, force: true }), null);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

/**
 * Let every process of this user connect without the cookie, so
 * `DISPLAY=:N <app>` works for them. Best effort, and checked: true only when
 * a client without the cookie really connects (some X servers ignore the
 * grant).
 */
function allowThisUser(display: string, xauthority: string, dir: string): boolean {
  const env = { ...process.env, DISPLAY: display, XAUTHORITY: xauthority };
  const python = findExecutable("python3", "linux");
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    return false;
  }
  const run = (cmd: string, args: string[], runEnv: NodeJS.ProcessEnv) => {
    try {
      execFileSync(cmd, args, { env: runEnv, stdio: "ignore", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  };
  const xhost = findExecutable("xhost", "linux");
  const granted =
    (xhost !== null && run(xhost, [`+si:localuser:${user}`], env)) ||
    (python !== null && run(python, ["-c", ALLOW_LOCAL_USER_SCRIPT, user], env));
  if (!granted) return false;
  // Without the cookie: an Xauthority path that does not exist.
  return python === null || run(python, ["-c", OPEN_DISPLAY_SCRIPT], { ...process.env, DISPLAY: display, XAUTHORITY: join(dir, "none") });
}

export async function startVirtualDisplay(opts: { width?: number; height?: number } = {}): Promise<VirtualDisplay> {
  if (process.platform !== "linux") throw new Error("a virtual display needs Linux with Xvfb");
  const xvfbPath = findExecutable("Xvfb", "linux");
  if (!xvfbPath) throw new Error("a virtual display needs Xvfb (Debian/Ubuntu: `sudo apt install xvfb`, Fedora: `sudo dnf install xorg-x11-server-Xvfb`)");
  const size = validateDisplaySize(opts.width ?? 1280, opts.height ?? 720);
  const xauthPath = findExecutable("xauth", "linux");

  // Two starts can race for the same free number; Xvfb then exits at once
  // and the next number is tried.
  for (let attempt = 0; attempt < 5; attempt++) {
    const n = freeDisplayNumber() + attempt;
    const display = `:${n}`;
    const warnings: string[] = [];
    const auth = xauthPath ? writeAuthority(xauthPath, display) : null;
    if (!auth) {
      warnings.push(
        xauthPath
          ? "xauth could not write a cookie, so the virtual display has no access control: other local users can connect to it"
          : "xauth is not installed (Debian/Ubuntu: `sudo apt install xauth`), so the virtual display has no access control: other local users can connect to it",
      );
    }
    const removeAuthNow = () => {
      if (auth) rmSync(auth.dir, { recursive: true, force: true });
    };
    // If the process exits without stop(), the cookie still goes.
    const cancelExitCleanup = atExit(removeAuthNow);
    const removeAuth = () => {
      cancelExitCleanup();
      removeAuthNow();
    };
    const args = [display, "-screen", "0", `${size.width}x${size.height}x24`, "-nolisten", "tcp", ...(auth ? ["-auth", auth.file] : [])];
    const xvfb = trackChild(spawn(xvfbPath, args, { stdio: "ignore" }));
    let spawnError: Error | null = null;
    xvfb.on("error", (err) => {
      spawnError = err;
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !gone(xvfb) && !spawnError && !existsSync(`/tmp/.X11-unix/X${n}`)) await sleep(50);
    if (spawnError) {
      removeAuth();
      throw new Error(`Xvfb could not start: ${(spawnError as Error).message}`);
    }
    if (gone(xvfb) || !existsSync(`/tmp/.X11-unix/X${n}`)) {
      await terminate(xvfb);
      removeAuth();
      continue;
    }
    // The socket appears just before the server accepts connections.
    await sleep(150);
    if (auth) {
      registerXAuthority(display, auth.file);
      if (!allowThisUser(display, auth.file, auth.dir)) {
        warnings.push(`apps launched on ${display} need XAUTHORITY=${auth.file} as well as DISPLAY=${display}`);
      }
    }
    let stopped: Promise<void> | null = null;
    return {
      display,
      pid: xvfb.pid,
      xauthority: auth?.file ?? null,
      warnings,
      env: (base = process.env) => ({ ...base, DISPLAY: display, ...(auth ? { XAUTHORITY: auth.file } : {}) }),
      stop() {
        stopped ??= terminate(xvfb).finally(() => {
          forgetXAuthority(display);
          removeAuth();
        });
        return stopped;
      },
    };
  }
  throw new Error("Xvfb did not start");
}
