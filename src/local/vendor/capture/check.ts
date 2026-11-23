// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/capture/src/check.ts by cli/scripts/sync-local.mjs. Do not edit here.
import { pickH264Encoder } from "./ffmpegArgs.js";
import { currentPlatform, ffmpegPath, ffprobePath, findExecutable, realRunner, type Runner } from "./proc.js";
import { avfoundationScreens, parseAvfoundationDevices } from "./sources.js";
import type { CaptureCheck, Platform } from "./types.js";

export const SCREEN_RECORDING_HINT =
  "macOS: allow your terminal app in System Settings > Privacy & Security > Screen Recording " +
  "(and Microphone for --microphone), then quit and reopen the terminal.";

const INSTALL_FFMPEG: Record<Platform, string> = {
  darwin: "Install ffmpeg: `brew install ffmpeg`.",
  win32: "Install ffmpeg 6 or newer: `winget install Gyan.FFmpeg` (or download from ffmpeg.org) and make sure ffmpeg.exe is on PATH.",
  linux: "Install ffmpeg: `sudo apt install ffmpeg` (Debian/Ubuntu) or `sudo dnf install ffmpeg` (Fedora).",
};

/** True when the session is Wayland, where x11grab sees only XWayland. */
export function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
  return env.XDG_SESSION_TYPE === "wayland" || !!env.WAYLAND_DISPLAY;
}

/** Whether `ffmpeg -devices` lists a device (input side). */
export function hasDevice(devicesText: string, name: string): boolean {
  return new RegExp(`^\\s*D\\S*\\s+${name}\\b`, "m").test(devicesText);
}

/** Whether `ffmpeg -filters` lists a filter. */
export function hasFilter(filtersText: string, name: string): boolean {
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(filtersText);
}

export interface CheckOptions {
  run?: Runner;
  env?: NodeJS.ProcessEnv;
}

export async function checkCapture(platform: Platform = currentPlatform(), opts: CheckOptions = {}): Promise<CaptureCheck> {
  const run = opts.run ?? realRunner;
  const env = opts.env ?? process.env;
  const problems: string[] = [];
  const hints: string[] = [];
  const ffmpeg = ffmpegPath(platform, env);
  if (!ffmpeg) {
    return { ok: false, ffmpeg: null, problems: ["ffmpeg was not found on PATH"], hints: [INSTALL_FFMPEG[platform]] };
  }
  const devices = await run(ffmpeg, ["-hide_banner", "-devices"], env);
  if (devices.status === null) {
    return { ok: false, ffmpeg, problems: [`ffmpeg at ${ffmpeg} could not be run`], hints: [INSTALL_FFMPEG[platform]] };
  }
  const devicesText = devices.stdout + devices.stderr;
  const encoders = await run(ffmpeg, ["-hide_banner", "-encoders"], env);
  if (!pickH264Encoder(encoders.stdout + encoders.stderr, platform)) {
    problems.push("this ffmpeg has no H.264 encoder (libx264)");
    hints.push(INSTALL_FFMPEG[platform]);
  }
  if (!ffprobePath(platform, env)) hints.push("ffprobe was not found; durations will come from the wall clock (it ships with ffmpeg).");

  if (platform === "linux") {
    if (!hasDevice(devicesText, "x11grab")) {
      problems.push("this ffmpeg was built without x11grab, so it cannot record an X display");
      hints.push(INSTALL_FFMPEG.linux);
    }
    const xvfb = !!findExecutable("Xvfb", platform, env);
    if (!env.DISPLAY) {
      if (isWaylandSession(env)) {
        problems.push(
          "this is a Wayland session without XWayland (DISPLAY is unset): ffmpeg cannot read a Wayland screen without the desktop portal",
        );
        hints.push("Log in to an X11 session, or enable XWayland, to record your screen.");
      } else {
        problems.push("no X display: DISPLAY is unset");
      }
      hints.push(
        xvfb
          ? "A private virtual display (Xvfb) still works for agent runs."
          : "Install Xvfb (`sudo apt install xvfb`) to record a private virtual display instead.",
      );
    } else if (isWaylandSession(env)) {
      hints.push("Wayland session: only X11 apps running under XWayland appear; native Wayland windows record as black.");
    }
    if (!hasDevice(devicesText, "pulse") && !hasDevice(devicesText, "alsa")) hints.push("this ffmpeg has neither pulse nor alsa input, so the microphone cannot be recorded");
    if (!findExecutable("python3", platform, env)) hints.push("install python3 to record pointer positions and clicks next to the video");
  } else if (platform === "darwin") {
    if (!hasDevice(devicesText, "avfoundation")) {
      problems.push("this ffmpeg was built without avfoundation, so it cannot record the screen");
      hints.push(INSTALL_FFMPEG.darwin);
    } else {
      const list = await run(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], env);
      if (avfoundationScreens(parseAvfoundationDevices(list.stderr + list.stdout)).length === 0) {
        problems.push("ffmpeg lists no screens to capture");
      }
    }
    hints.push(SCREEN_RECORDING_HINT);
  } else {
    const filters = await run(ffmpeg, ["-hide_banner", "-filters"], env);
    const ddagrab = hasFilter(filters.stdout + filters.stderr, "ddagrab");
    const gdigrab = hasDevice(devicesText, "gdigrab");
    if (!ddagrab && !gdigrab) {
      problems.push("this ffmpeg has neither ddagrab nor gdigrab, so it cannot record the screen");
      hints.push(INSTALL_FFMPEG.win32);
    } else if (!ddagrab) {
      hints.push("this ffmpeg has no ddagrab (FFmpeg 6+ with Direct3D 11); recording uses the slower gdigrab");
    }
    if (!hasDevice(devicesText, "dshow")) hints.push("this ffmpeg has no dshow input, so the microphone cannot be recorded");
    if (!findExecutable("powershell.exe", platform, env) && !findExecutable("pwsh.exe", platform, env)) {
      hints.push("PowerShell was not found; recordings will have no pointer positions");
    }
  }
  return { ok: problems.length === 0, ffmpeg, problems, hints };
}
