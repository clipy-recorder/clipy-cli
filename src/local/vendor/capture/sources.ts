// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/capture/src/sources.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * What can be recorded on each OS, from the tools that are already there:
 * ffmpeg itself everywhere, plus xrandr/xdpyinfo/xwininfo on Linux when
 * installed and PowerShell on Windows. Parsers are pure and unit tested.
 */
import { encodePowerShell, windowsScreensScript } from "./scripts.js";
import { currentPlatform, ffmpegPath, realRunner, type Runner } from "./proc.js";
import { xEnv } from "./xauth.js";
import type { CaptureSource, Platform } from "./types.js";
import type { Rect } from "./ffmpegArgs.js";

export interface ScreenInfo extends Rect {
  name: string;
  primary?: boolean;
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

/**
 * `xrandr --listmonitors` (or `--listactivemonitors`):
 * ` 0: +*eDP-1 1920/344x1080/194+0+0  eDP-1`. `*` marks the primary.
 */
export function parseXrandrMonitors(text: string): ScreenInfo[] {
  const out: ScreenInfo[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+):\s+([+*]*)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/.exec(line);
    if (!m) continue;
    out.push({
      name: m[3],
      primary: m[2].includes("*"),
      width: Number(m[4]),
      height: Number(m[5]),
      x: Number(m[6]),
      y: Number(m[7]),
    });
  }
  return out;
}

/** `xdpyinfo`: `  dimensions:    1280x720 pixels (339x191 millimeters)`. */
export function parseXdpyinfoSize(text: string): { width: number; height: number } | null {
  const m = /dimensions:\s+(\d+)x(\d+)\s+pixels/.exec(text);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** The X screen size from ffmpeg's own probe of the display, so a display
 *  can be recorded without any X11 utilities installed. */
export function parseProbedScreenSize(ffmpegStderr: string): { width: number; height: number } | null {
  const m = /Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(ffmpegStderr);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** `xprop -root _NET_CLIENT_LIST`: the managed top-level windows. */
export function parseClientList(text: string): number[] {
  const m = /_NET_CLIENT_LIST\(WINDOW\): window id # (.*)/.exec(text);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-f]+$/i.test(s))
    .map((s) => parseInt(s, 16));
}

/** `xwininfo -id <id>`: absolute geometry and whether it is on screen. */
export function parseWindowGeometry(text: string): (Rect & { viewable: boolean }) | null {
  const num = (label: string) => {
    const m = new RegExp(`${label}:\\s+(-?\\d+)`).exec(text);
    return m ? Number(m[1]) : null;
  };
  const x = num("Absolute upper-left X");
  const y = num("Absolute upper-left Y");
  const width = num("Width");
  const height = num("Height");
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height, viewable: /Map State:\s+IsViewable/.test(text) };
}

/** `xprop -id <id> _NET_WM_NAME WM_NAME WM_CLASS`: title and owning app. */
export function parseWindowProps(text: string): { title: string; app: string } {
  const quoted = (re: RegExp) => {
    const m = re.exec(text);
    return m ? m[1].replace(/\\"/g, '"') : "";
  };
  const title = quoted(/_NET_WM_NAME\([^)]*\) = "((?:[^"\\]|\\.)*)"/) || quoted(/WM_NAME\([^)]*\) = "((?:[^"\\]|\\.)*)"/);
  const cls = /WM_CLASS\([^)]*\) = "((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)"/.exec(text);
  return { title, app: cls ? cls[2] : "" };
}

/** The X display's monitors, or the whole screen as one display. */
export async function linuxScreens(xDisplay: string, run: Runner = realRunner, env: NodeJS.ProcessEnv = process.env): Promise<ScreenInfo[]> {
  const xenv = xEnv(env, xDisplay);
  const monitors = await run("xrandr", ["--listmonitors"], xenv);
  const screens = monitors.status === 0 ? parseXrandrMonitors(monitors.stdout) : [];
  if (screens.length > 0) return primaryFirst(screens);
  let size: { width: number; height: number } | null = null;
  const dpy = await run("xdpyinfo", [], xenv);
  if (dpy.status === 0) size = parseXdpyinfoSize(dpy.stdout);
  if (!size) {
    const ffmpeg = ffmpegPath("linux", env);
    if (ffmpeg) {
      const probe = await run(ffmpeg, ["-hide_banner", "-f", "x11grab", "-i", xDisplay, "-frames:v", "1", "-f", "null", "-"], xenv);
      size = parseProbedScreenSize(probe.stderr);
    }
  }
  return size ? [{ name: `screen ${xDisplay}`, x: 0, y: 0, primary: true, ...size }] : [];
}

async function linuxWindows(xDisplay: string, run: Runner, env: NodeJS.ProcessEnv): Promise<CaptureSource[]> {
  const xenv = xEnv(env, xDisplay);
  const list = await run("xprop", ["-root", "_NET_CLIENT_LIST"], xenv);
  if (list.status !== 0) return [];
  const out: CaptureSource[] = [];
  for (const id of parseClientList(list.stdout)) {
    const hex = `0x${id.toString(16)}`;
    const info = await run("xwininfo", ["-id", hex], xenv);
    const g = info.status === 0 ? parseWindowGeometry(info.stdout) : null;
    if (!g || !g.viewable || g.width < 32 || g.height < 32) continue;
    const props = parseWindowProps((await run("xprop", ["-id", hex, "_NET_WM_NAME", "WM_NAME", "WM_CLASS"], xenv)).stdout);
    if (!props.title && !props.app) continue;
    const name = props.app && props.title ? `${props.app}: ${props.title}` : props.title || props.app;
    out.push({ id: `window:${hex}`, kind: "window", name, width: g.width, height: g.height });
  }
  return out;
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

export interface AvfoundationDevices {
  video: { index: number; name: string }[];
  audio: { index: number; name: string }[];
}

/** `ffmpeg -f avfoundation -list_devices true -i ""` (stderr). */
export function parseAvfoundationDevices(text: string): AvfoundationDevices {
  const out: AvfoundationDevices = { video: [], audio: [] };
  let section: "video" | "audio" | null = null;
  for (const line of text.split("\n")) {
    if (/AVFoundation video devices/i.test(line)) section = "video";
    else if (/AVFoundation audio devices/i.test(line)) section = "audio";
    else if (section) {
      const m = /\]\s*\[(\d+)\]\s+(.+?)\s*$/.exec(line);
      if (m) out[section].push({ index: Number(m[1]), name: m[2] });
    }
  }
  return out;
}

/** The "Capture screen N" devices, in screen order. */
export function avfoundationScreens(devices: AvfoundationDevices): { index: number; name: string; screen: number }[] {
  return devices.video
    .map((d) => ({ ...d, m: /^Capture screen (\d+)$/i.exec(d.name) }))
    .filter((d) => d.m)
    .map((d) => ({ index: d.index, name: d.name, screen: Number(d.m![1]) }))
    .sort((a, b) => a.screen - b.screen);
}

export async function listAvfoundation(run: Runner = realRunner, env: NodeJS.ProcessEnv = process.env): Promise<AvfoundationDevices | null> {
  const ffmpeg = ffmpegPath("darwin", env);
  if (!ffmpeg) return null;
  const r = await run(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], env);
  if (r.status === null) return null;
  return parseAvfoundationDevices(r.stderr + r.stdout);
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/** `ffmpeg -f dshow -list_devices true -i dummy` (stderr), old and new formats. */
export function parseDshowAudioDevices(text: string): string[] {
  const out: string[] = [];
  let legacyAudio = false;
  for (const line of text.split("\n")) {
    if (/DirectShow audio devices/i.test(line)) legacyAudio = true;
    else if (/DirectShow video devices/i.test(line)) legacyAudio = false;
    if (/Alternative name/i.test(line)) continue;
    const tagged = /\]\s+"(.+)"\s+\((audio|video|none)\)\s*$/.exec(line);
    if (tagged) {
      if (tagged[2] === "audio") out.push(tagged[1]);
      continue;
    }
    const legacy = /\]\s+"(.+)"\s*$/.exec(line);
    if (legacy && legacyAudio) out.push(legacy[1]);
  }
  return out;
}

/** The `S <json>` line PowerShell prints for Screen.AllScreens. */
export function parseScreensLine(text: string): ScreenInfo[] {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("S ")) continue;
    try {
      const raw: unknown = JSON.parse(line.slice(2));
      const list = Array.isArray(raw) ? raw : [raw];
      return list
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s, i) => ({
          name: typeof s.name === "string" && s.name ? s.name : `Display ${i + 1}`,
          primary: s.primary === true,
          x: Number(s.x) || 0,
          y: Number(s.y) || 0,
          width: Number(s.width) || 0,
          height: Number(s.height) || 0,
        }))
        .filter((s) => s.width > 0 && s.height > 0);
    } catch {
      return [];
    }
  }
  return [];
}

export async function windowsScreens(run: Runner = realRunner, env: NodeJS.ProcessEnv = process.env): Promise<ScreenInfo[]> {
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(windowsScreensScript())], env);
  return r.status === 0 ? primaryFirst(parseScreensLine(r.stdout)) : [];
}

/** The main display first, so display:0 is always the main one. */
export function primaryFirst(screens: ScreenInfo[]): ScreenInfo[] {
  const i = screens.findIndex((s) => s.primary);
  return i > 0 ? [screens[i], ...screens.filter((_, j) => j !== i)] : screens;
}

export async function listDshowAudio(run: Runner = realRunner, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const ffmpeg = ffmpegPath("win32", env);
  if (!ffmpeg) return [];
  const r = await run(ffmpeg, ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"], env);
  return parseDshowAudioDevices(r.stderr + r.stdout);
}

// ---------------------------------------------------------------------------
// Source ids
// ---------------------------------------------------------------------------

export type ParsedSource = { kind: "display"; index: number } | { kind: "window"; id: number };

/** "display:0" / "0" / "window:0x1a00003". */
export function parseSourceId(id: string | undefined): ParsedSource {
  if (id === undefined || id === "" || id === "main") return { kind: "display", index: 0 };
  const display = /^(?:display:)?(\d+)$/.exec(id);
  if (display) return { kind: "display", index: Number(display[1]) };
  const window = /^window:(0x[0-9a-f]+|\d+)$/i.exec(id);
  if (window) return { kind: "window", id: window[1].startsWith("0x") || window[1].startsWith("0X") ? parseInt(window[1], 16) : Number(window[1]) };
  throw new Error(`unknown capture source "${id}" (expected display:N or window:0x...)`);
}

export interface ListOptions {
  /** Linux: the X display to list. Default $DISPLAY. */
  xDisplay?: string;
  /** For tests. */
  run?: Runner;
  env?: NodeJS.ProcessEnv;
}

export async function listSources(platform: Platform = currentPlatform(), opts: ListOptions = {}): Promise<CaptureSource[]> {
  const run = opts.run ?? realRunner;
  const env = opts.env ?? process.env;
  if (platform === "linux") {
    const xDisplay = opts.xDisplay ?? env.DISPLAY;
    if (!xDisplay) return [];
    const screens = await linuxScreens(xDisplay, run, env);
    const displays: CaptureSource[] = screens.map((s, i) => ({
      id: `display:${i}`,
      kind: "display",
      name: s.primary && screens.length > 1 ? `${s.name} (main)` : s.name,
      width: s.width,
      height: s.height,
    }));
    return [...displays, ...(await linuxWindows(xDisplay, run, env))];
  }
  if (platform === "darwin") {
    const devices = await listAvfoundation(run, env);
    if (!devices) return [];
    return avfoundationScreens(devices).map((d, i) => ({
      id: `display:${i}`,
      kind: "display",
      name: i === 0 ? `${d.name} (main)` : d.name,
    }));
  }
  const screens = await windowsScreens(run, env);
  if (screens.length === 0) return [{ id: "display:0", kind: "display", name: "Display 1 (main)" }];
  return screens.map((s, i) => ({
    id: `display:${i}`,
    kind: "display",
    name: s.primary ? `${s.name} (main)` : s.name,
    width: s.width,
    height: s.height,
  }));
}
