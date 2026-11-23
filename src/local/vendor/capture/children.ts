// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/capture/src/children.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * Child processes this package starts (ffmpeg, the pointer helper, Xvfb), so
 * none outlives the Node process that started it.
 *
 * Every long-lived child is registered here. When the process exits normally
 * (the event loop drains, or `process.exit` is called, including from a
 * caller's own SIGINT or SIGTERM handler), any child still running is sent a
 * signal synchronously. SIGTERM lets ffmpeg close its file and Xvfb remove its
 * lock; neither needs this process to stay alive to finish.
 *
 * The package installs no signal handlers: the application owns SIGINT and
 * SIGTERM. A process killed outright (SIGKILL) runs no exit handlers at all.
 */
import type { ChildProcess } from "node:child_process";

const live = new Map<ChildProcess, NodeJS.Signals>();
const cleanups = new Set<() => void>();
let hooked = false;

function gone(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function hook(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => {
    stopAllChildren();
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // best effort at exit
      }
    }
    cleanups.clear();
  });
}

/** Keep track of `child` until it exits. `signal` is what process exit sends it. */
export function trackChild<T extends ChildProcess>(child: T, signal: NodeJS.Signals = "SIGTERM"): T {
  if (gone(child)) return child;
  live.set(child, signal);
  const forget = () => live.delete(child);
  child.once("exit", forget);
  child.once("error", forget);
  hook();
  return child;
}

/**
 * Run `fn` (synchronous) when the process exits, unless the returned function
 * is called first. For temporary files that belong to a tracked child.
 */
export function atExit(fn: () => void): () => void {
  cleanups.add(fn);
  hook();
  return () => cleanups.delete(fn);
}

/**
 * Signal every tracked child that is still running. Synchronous, so it is
 * safe in an `exit` handler; an application can also call it from its own
 * signal handler before exiting.
 */
export function stopAllChildren(): void {
  for (const [child, signal] of live) {
    if (!gone(child)) {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  }
  live.clear();
}

/** How many tracked children are still running (for tests). */
export function runningChildren(): number {
  let n = 0;
  for (const child of live.keys()) if (!gone(child)) n++;
  return n;
}
