// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/capture/src/index.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * @clipy/capture: record the screen with ffmpeg on macOS, Windows and Linux,
 * with a pointer and click sidecar where the OS allows it.
 *
 * - Linux: ffmpeg x11grab (a display, or one window by id), microphone via
 *   PulseAudio or ALSA, pointer via python3 + libX11. startVirtualDisplay
 *   gives an agent a private Xvfb display to record.
 * - macOS: ffmpeg avfoundation (displays), microphone as the avfoundation
 *   audio device, pointer via osascript JXA. Needs Screen Recording
 *   permission for the terminal.
 * - Windows: ffmpeg ddagrab (Desktop Duplication), falling back to gdigrab,
 *   microphone via dshow, pointer via PowerShell.
 *
 * Output is H.264 yuv420p in a fragmented MP4, so a crash still leaves a
 * playable file.
 */
import { checkCapture as check } from "./check.js";
import { listSources as list } from "./sources.js";
import type { CaptureCheck, CaptureSource, Platform } from "./types.js";

export type {
  CaptureCheck,
  CaptureGeometry,
  CaptureOptions,
  CaptureResult,
  CaptureSession,
  CaptureSource,
  InteractionEvent,
  Platform,
} from "./types.js";
export { startCapture } from "./capture.js";
export { startVirtualDisplay, type VirtualDisplay } from "./virtualDisplay.js";
// Child processes (ffmpeg, the pointer helper, Xvfb) are signalled when the
// process exits. An application with its own SIGINT/SIGTERM handler can call
// this before exiting; calling process.exit does it too.
export { stopAllChildren } from "./children.js";

export function checkCapture(platform?: Platform): Promise<CaptureCheck> {
  return check(platform);
}

/** Linux: pass `{ xDisplay }` to list a display other than $DISPLAY. */
export function listSources(platform?: Platform, opts?: { xDisplay?: string }): Promise<CaptureSource[]> {
  return list(platform, opts);
}

// Lower-level pieces, for tools that build their own command lines.
export { buildFfmpegArgs, pickH264Encoder, videoFilter, type CapturePlan, type VideoInput, type AudioInput } from "./ffmpegArgs.js";
export { samplesToEvents, parseSampleLine, type PointerSample } from "./sidecar.js";
