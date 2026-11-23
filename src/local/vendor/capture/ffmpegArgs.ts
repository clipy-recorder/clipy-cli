// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/capture/src/ffmpegArgs.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * ffmpeg argument building, one backend per OS. Pure functions, so every
 * platform's command line is unit tested on any machine.
 */
import type { Platform } from "./types.js";

export type Backend = "x11grab" | "avfoundation" | "ddagrab" | "gdigrab";

/** H.264 encoders in order of preference per platform. */
export type H264Encoder = "libx264" | "h264_videotoolbox" | "h264_mf";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type VideoInput =
  /** Linux. `rect` absent: the whole X screen. */
  | { backend: "x11grab"; xDisplay: string; rect?: Rect; windowId?: number }
  /** macOS. `device` is the avfoundation video index or name ("Capture screen 0"). */
  | { backend: "avfoundation"; device: string }
  /** Windows. DXGI output index. */
  | { backend: "ddagrab"; outputIndex: number }
  /** Windows fallback. `rect` absent: the whole virtual desktop. */
  | { backend: "gdigrab"; rect?: Rect };

export type AudioInput =
  | { backend: "pulse"; device: string }
  | { backend: "alsa"; device: string }
  /** macOS: the audio half of the avfoundation input, an index, a name or "default". */
  | { backend: "avfoundation"; device: string }
  | { backend: "dshow"; device: string };

export interface CapturePlan {
  video: VideoInput;
  audio?: AudioInput;
  fps: number;
  encoder: H264Encoder;
  maxSeconds?: number;
  output: string;
}

/** H.264 and yuv420p both need even dimensions. */
export function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** Pick the H.264 encoder from `ffmpeg -encoders` output. */
export function pickH264Encoder(encodersText: string, platform: Platform): H264Encoder | null {
  if (/^\s*V\S*\s+libx264\s/m.test(encodersText)) return "libx264";
  if (platform === "darwin" && /^\s*V\S*\s+h264_videotoolbox\s/m.test(encodersText)) return "h264_videotoolbox";
  if (platform === "win32" && /^\s*V\S*\s+h264_mf\s/m.test(encodersText)) return "h264_mf";
  return null;
}

function videoInputArgs(v: VideoInput, fps: number): string[] {
  switch (v.backend) {
    case "x11grab": {
      const args = ["-thread_queue_size", "1024", "-f", "x11grab", "-draw_mouse", "1", "-framerate", String(fps)];
      if (v.windowId !== undefined) {
        args.push("-window_id", `0x${v.windowId.toString(16)}`);
      } else if (v.rect) {
        args.push(
          "-video_size",
          `${even(v.rect.width)}x${even(v.rect.height)}`,
          "-grab_x",
          String(Math.max(0, v.rect.x)),
          "-grab_y",
          String(Math.max(0, v.rect.y)),
        );
      }
      args.push("-i", v.xDisplay);
      return args;
    }
    case "avfoundation":
      // The audio half of the device string is filled in by buildFfmpegArgs.
      return ["-thread_queue_size", "1024", "-f", "avfoundation", "-capture_cursor", "1", "-capture_mouse_clicks", "1", "-framerate", String(fps)];
    case "ddagrab":
      return ["-thread_queue_size", "1024", "-f", "lavfi", "-i", `ddagrab=output_idx=${v.outputIndex}:framerate=${fps}:draw_mouse=1`];
    case "gdigrab": {
      const args = ["-thread_queue_size", "1024", "-f", "gdigrab", "-draw_mouse", "1", "-framerate", String(fps)];
      if (v.rect) {
        args.push(
          "-offset_x",
          String(v.rect.x),
          "-offset_y",
          String(v.rect.y),
          "-video_size",
          `${even(v.rect.width)}x${even(v.rect.height)}`,
        );
      }
      args.push("-i", "desktop");
      return args;
    }
  }
}

function audioInputArgs(a: AudioInput): string[] {
  switch (a.backend) {
    case "pulse":
      return ["-thread_queue_size", "1024", "-f", "pulse", "-i", a.device];
    case "alsa":
      return ["-thread_queue_size", "1024", "-f", "alsa", "-i", a.device];
    case "dshow":
      return ["-thread_queue_size", "1024", "-f", "dshow", "-i", `audio=${a.device}`];
    case "avfoundation":
      return [];
  }
}

function encoderArgs(encoder: H264Encoder, fps: number): string[] {
  // A keyframe every two seconds: each MP4 fragment starts on one, so a crash
  // loses at most the last couple of seconds.
  const gop = ["-g", String(Math.max(1, Math.round(fps * 2)))];
  switch (encoder) {
    case "libx264":
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", ...gop];
    case "h264_videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-realtime", "1", "-b:v", "8M", "-pix_fmt", "yuv420p", ...gop];
    case "h264_mf":
      return ["-c:v", "h264_mf", "-b:v", "8M", "-pix_fmt", "yuv420p", ...gop];
  }
}

/** Frames to yuv420p at even sizes; ddagrab frames live on the GPU first. */
export function videoFilter(backend: Backend): string {
  const common = "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p";
  return backend === "ddagrab" ? `hwdownload,format=bgra,${common}` : common;
}

/**
 * The full ffmpeg command line for one capture. Output is a fragmented MP4
 * (moov first, a fragment per keyframe): playable even if ffmpeg is killed.
 */
export function buildFfmpegArgs(plan: CapturePlan): string[] {
  const args = ["-hide_banner", "-loglevel", "info", "-nostats", "-y"];
  const video = videoInputArgs(plan.video, plan.fps);
  args.push(...video);
  let audioMap: string | null = null;
  if (plan.video.backend === "avfoundation") {
    const audio = plan.audio?.backend === "avfoundation" ? plan.audio.device : "none";
    args.push("-i", `${plan.video.device}:${audio}`);
    if (plan.audio?.backend === "avfoundation") audioMap = "0:a:0";
  } else if (plan.audio) {
    if (plan.audio.backend === "avfoundation") throw new Error("avfoundation audio needs the avfoundation video backend");
    args.push(...audioInputArgs(plan.audio));
    audioMap = "1:a:0";
  }
  args.push("-map", "0:v:0");
  if (audioMap) args.push("-map", audioMap);
  args.push("-vf", videoFilter(plan.video.backend));
  args.push(...encoderArgs(plan.encoder, plan.fps));
  if (audioMap) args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
  if (plan.maxSeconds !== undefined && plan.maxSeconds > 0) args.push("-t", String(plan.maxSeconds));
  // A still screen compresses to almost nothing, so without flushing the
  // header and fragments can sit in ffmpeg's output buffer for many seconds
  // and a crash would leave a file with no moov.
  args.push("-flush_packets", "1", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", plan.output);
  return args;
}
