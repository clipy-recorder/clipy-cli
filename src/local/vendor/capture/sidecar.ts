// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/capture/src/sidecar.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * The pointer sidecar: where the pointer was and when a button went down or
 * up while recording, so the moment rules have something to anchor on.
 *
 * Each OS gets a tiny helper that uses only what ships with it, polls the
 * pointer every ~50 ms and prints one line per sample:
 *
 *   P <epoch ms> <x> <y> <buttons>     buttons: 1 left, 2 right, 4 middle
 *   S <json>                           the screens, once, at start
 *   E <message>                        the helper cannot work here
 *
 * - Linux: python3 with ctypes over libX11 (XQueryPointer). No Xlib module,
 *   xdotool or xinput needed. Coordinates are X screen pixels.
 * - macOS: osascript JXA reading NSEvent.mouseLocation and
 *   pressedMouseButtons. Coordinates are global points, top-left origin.
 * - Windows: PowerShell calling GetCursorPos and GetAsyncKeyState from a
 *   DPI-aware process. Coordinates are virtual-desktop pixels.
 *
 * Polling sees a button state, not the button event itself, so a click
 * shorter than one interval can be missed. Scroll and keys are not sampled.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { trackChild } from "./children.js";
import { xEnv } from "./xauth.js";
import { createInterface } from "node:readline";
import { findExecutable } from "./proc.js";
import { encodePowerShell, LINUX_POINTER_SCRIPT, MAC_POINTER_SCRIPT, windowsPointerScript } from "./scripts.js";
import { parseScreensLine, type ScreenInfo } from "./sources.js";
import type { InteractionEvent, Platform } from "./types.js";

export const SAMPLE_INTERVAL_MS = 50;

export interface PointerSample {
  /** Epoch ms. */
  t: number;
  x: number;
  y: number;
  /** 1 left, 2 right, 4 middle. */
  buttons: number;
}

// ---------------------------------------------------------------------------
// Parsing and conversion (pure)
// ---------------------------------------------------------------------------

export function parseSampleLine(line: string): PointerSample | null {
  const m = /^P (\d+) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (\d+)\s*$/.exec(line);
  if (!m) return null;
  return { t: Number(m[1]), x: Math.round(Number(m[2])), y: Math.round(Number(m[3])), buttons: Number(m[4]) & 7 };
}

const BUTTONS: [bit: number, button: number][] = [
  [1, 1],
  [2, 2],
  [4, 3],
];

/**
 * Turn polled samples into interaction events on the recording clock.
 *
 * - Times are ms since `startedAt`; samples after `endedAt` are dropped.
 * - A move is emitted only when the position changes. The position held when
 *   recording starts is emitted once at time 0.
 * - A button that goes down during the recording emits `down`, and `up` when
 *   it is released. A button already held at start emits nothing until it is
 *   pressed again, so every `up` has its `down`.
 */
export function samplesToEvents(samples: readonly PointerSample[], startedAt: number, endedAt?: number): InteractionEvent[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const events: InteractionEvent[] = [];
  let last: { x: number; y: number } | null = null;
  let buttons: number | null = null;
  const down = new Set<number>();
  let preStart: PointerSample | null = null;
  for (const s of sorted) {
    if (s.t < startedAt) {
      preStart = s;
      continue;
    }
    if (endedAt !== undefined && s.t > endedAt) break;
    if (buttons === null) {
      if (preStart) {
        last = { x: preStart.x, y: preStart.y };
        events.push({ kind: "move", time_ms: 0, x: preStart.x, y: preStart.y });
        buttons = preStart.buttons;
      } else {
        buttons = s.buttons;
      }
    }
    const time = Math.round(s.t - startedAt);
    if (!last || last.x !== s.x || last.y !== s.y) {
      events.push({ kind: "move", time_ms: time, x: s.x, y: s.y });
      last = { x: s.x, y: s.y };
    }
    for (const [bit, button] of BUTTONS) {
      const was = (buttons & bit) !== 0;
      const is = (s.buttons & bit) !== 0;
      if (!was && is) {
        events.push({ kind: "down", time_ms: time, x: s.x, y: s.y, button });
        down.add(button);
      } else if (was && !is && down.has(button)) {
        events.push({ kind: "up", time_ms: time, x: s.x, y: s.y, button });
        down.delete(button);
      }
    }
    buttons = s.buttons;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Running a helper
// ---------------------------------------------------------------------------

export interface PointerSampler {
  /** Screens the helper reported (empty until it prints them). */
  screens(): ScreenInfo[];
  /** Resolves once the helper printed its first line, or failed, or 3 s passed. */
  ready: Promise<void>;
  stop(): Promise<{ samples: PointerSample[]; warnings: string[] }>;
}

export interface SamplerOptions {
  xDisplay?: string;
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
}

function helperCommand(platform: Platform, intervalMs: number, env: NodeJS.ProcessEnv): { cmd: string; args: string[] } | { missing: string } {
  const seconds = (intervalMs / 1000).toFixed(3);
  if (platform === "linux") {
    const python = findExecutable("python3", platform, env);
    if (!python) return { missing: "pointer positions need python3 on Linux; recording without them" };
    return { cmd: python, args: ["-c", LINUX_POINTER_SCRIPT, seconds] };
  }
  if (platform === "darwin") {
    const osascript = findExecutable("osascript", platform, env) ?? "/usr/bin/osascript";
    return { cmd: osascript, args: ["-l", "JavaScript", "-e", MAC_POINTER_SCRIPT, seconds] };
  }
  const powershell = findExecutable("powershell.exe", platform, env) ?? findExecutable("pwsh.exe", platform, env);
  if (!powershell) return { missing: "pointer positions need PowerShell on Windows; recording without them" };
  return {
    cmd: powershell,
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(windowsPointerScript(intervalMs))],
  };
}

export function startPointerSampler(platform: Platform, opts: SamplerOptions = {}): PointerSampler {
  const base = { ...(opts.env ?? process.env) };
  const env = platform === "linux" ? xEnv(base, opts.xDisplay) : base;
  const intervalMs = opts.intervalMs ?? SAMPLE_INTERVAL_MS;
  const samples: PointerSample[] = [];
  const warnings: string[] = [];
  let screens: ScreenInfo[] = [];
  const command = helperCommand(platform, intervalMs, env);
  if ("missing" in command) {
    warnings.push(command.missing);
    return { screens: () => screens, ready: Promise.resolve(), stop: async () => ({ samples, warnings }) };
  }

  let child: ChildProcess | null = null;
  let errorLine: string | null = null;
  let stderr = "";
  let markReady: () => void = () => {};
  const ready = new Promise<void>((r) => {
    markReady = r;
  });
  const readyTimer = setTimeout(() => markReady(), 3000);
  const exited = new Promise<void>((resolve) => {
    try {
      child = trackChild(spawn(command.cmd, command.args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
    } catch (err) {
      errorLine = (err as Error).message;
      resolve();
      return;
    }
    const c = child as ChildProcess;
    c.on("error", (err) => {
      errorLine ??= err.message;
      resolve();
    });
    c.on("exit", () => resolve());
    c.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    createInterface({ input: c.stdout! }).on("line", (line) => {
      markReady();
      const sample = parseSampleLine(line);
      if (sample) samples.push(sample);
      else if (line.startsWith("S ")) screens = parseScreensLine(line);
      else if (line.startsWith("E ")) errorLine ??= line.slice(2).trim();
    });
  });
  void exited.then(() => markReady());

  let stopped: Promise<{ samples: PointerSample[]; warnings: string[] }> | null = null;
  const stop = async () => {
    clearTimeout(readyTimer);
    const c = child as ChildProcess | null;
    if (c && c.exitCode === null && c.signalCode === null) {
      c.kill();
      const killTimer = setTimeout(() => c.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(killTimer);
    } else {
      await exited;
    }
    if (samples.length === 0) {
      const why = errorLine ?? stderr.trim().split("\n").pop() ?? "the helper printed nothing";
      warnings.push(`no pointer positions were recorded (${why || "the helper printed nothing"})`);
    }
    return { samples, warnings };
  };

  return {
    screens: () => screens,
    ready,
    stop() {
      stopped ??= stop();
      return stopped;
    },
  };
}
