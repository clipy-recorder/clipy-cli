// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/capture/src/types.ts by cli/scripts/sync-local.mjs. Do not edit here.
export type Platform = "darwin" | "win32" | "linux";

export interface CaptureSource {
  id: string;
  kind: "display" | "window";
  name: string;
  width?: number;
  height?: number;
}

/** Same shape as the moment planner's interaction schema. */
export interface InteractionEvent {
  kind: "move" | "down" | "up" | "scroll" | "key_down" | "key_up";
  time_ms: number;
  x?: number;
  y?: number;
  button?: number;
}

/**
 * The captured rectangle in the same coordinate space as the pointer events
 * (screen pixels on Linux and Windows, points on macOS), plus the size of the
 * video frames it became.
 */
export interface CaptureGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  output_width?: number;
  output_height?: number;
}

export interface CaptureOptions {
  /** A CaptureSource id; default: the main display. */
  source?: string;
  /** .mp4 (H.264, yuv420p, fragmented MP4 so a crash leaves a playable file). */
  outPath: string;
  /** Default 30. */
  fps?: number;
  /** Stop automatically after this many seconds. */
  maxSeconds?: number;
  /** false (default), true (default device) or a device name. */
  microphone?: boolean | string;
  /** Linux only, e.g. ":99". Default: $DISPLAY. */
  xDisplay?: string;
}

export interface CaptureResult {
  path: string;
  durationMs: number;
  interactions: InteractionEvent[];
  geometry: CaptureGeometry | null;
  warnings: string[];
}

export interface CaptureSession {
  /** Epoch ms when ffmpeg started recording: time_ms 0 of the interactions. */
  readonly startedAt: number;
  /**
   * Resolves when ffmpeg exits by itself (maxSeconds reached, or a failure).
   * stop() still has to be called to collect the result.
   */
  readonly ended: Promise<void>;
  stop(): Promise<CaptureResult>;
  abort(): Promise<void>;
}

export interface CaptureCheck {
  ok: boolean;
  ffmpeg: string | null;
  problems: string[];
  hints: string[];
}
