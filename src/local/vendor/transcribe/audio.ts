// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/audio.ts by cli/scripts/sync-local.mjs. Do not edit here.
import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSilencedetectOutput, type SilenceSpan } from "./chunking.js";

/** Every engine gets the same audio: 16 kHz, mono, 16-bit PCM WAV. */
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;

/** `CLIPY_FFMPEG` points at a specific ffmpeg; otherwise the one on PATH. */
export function ffmpegPath(): string {
  return process.env.CLIPY_FFMPEG || "ffmpeg";
}

interface RunResult {
  code: number | null;
  stderr: string;
}

function abortError(): Error {
  const err = new Error("Transcription was cancelled");
  err.name = "AbortError";
  return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Run ffmpeg, keeping only the tail of stderr. Rejects clearly when ffmpeg is missing. */
function runFfmpeg(args: string[], signal?: AbortSignal, keepStderr = 64 * 1024): Promise<RunResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    let settled = false;
    const onAbort = () => {
      proc.kill("SIGKILL");
      finish(() => reject(abortError()));
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d: string) => {
      stderr += d;
      if (stderr.length > keepStderr * 2) stderr = stderr.slice(-keepStderr);
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          err.code === "ENOENT"
            ? new Error(
                "ffmpeg was not found. Install ffmpeg (https://ffmpeg.org/download.html) " +
                  "and make sure it is on your PATH, or set CLIPY_FFMPEG to its full path.",
              )
            : new Error(`ffmpeg could not start: ${err.code ?? err.message}`),
        ),
      );
    });
    proc.on("close", (code) => finish(() => resolve({ code, stderr })));
  });
}

/**
 * A local file as an ffmpeg input. Without the `file:` prefix a name such as
 * `take2:final.mp4` is read as protocol `take2`.
 */
export function ffmpegInput(path: string): string {
  return `file:${resolve(path)}`;
}

/** The input has no audio stream, so there is nothing to transcribe. */
export class NoAudioTrackError extends Error {
  constructor(inputPath: string) {
    super(`${inputPath} has no audio track to transcribe`);
    this.name = "NoAudioTrackError";
  }
}

const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

/**
 * How long a media file is and whether it has audio, from ffmpeg's header
 * dump (the same ffmpeg as everything else here, so no ffprobe is needed).
 * A fragmented file with no header duration is decoded to its last
 * timestamp. `durationSec` is null when neither works.
 */
export async function probeMedia(inputPath: string, signal?: AbortSignal): Promise<{ durationSec: number | null; hasAudio: boolean }> {
  const header = await runFfmpeg(["-hide_banner", "-nostdin", "-i", ffmpegInput(inputPath)], signal, 64 * 1024);
  const hasAudio = /Stream #\d+:\d+[^\n]*: Audio:/.test(header.stderr);
  const m = DURATION_RE.exec(header.stderr);
  if (m) return { durationSec: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), hasAudio };
  if (/No such file|Invalid data found|Permission denied|Error opening input/i.test(header.stderr)) {
    throw new Error(`ffmpeg could not read ${inputPath}`);
  }
  const decode = await runFfmpeg(
    ["-hide_banner", "-nostdin", "-nostats", "-progress", "pipe:2", "-i", ffmpegInput(inputPath), "-map", "0", "-c", "copy", "-f", "null", "-"],
    signal,
    16 * 1024,
  );
  const times = [...decode.stderr.matchAll(/out_time_us=(\d+)/g)];
  return { durationSec: times.length > 0 ? Number(times[times.length - 1][1]) / 1e6 : null, hasAudio };
}

/** ffmpeg: any video/audio file -> 16 kHz mono 16-bit WAV. Throws a clear error if ffmpeg is missing. */
export async function extractAudio(inputPath: string, outWavPath: string, signal?: AbortSignal): Promise<void> {
  const { code, stderr } = await runFfmpeg(
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      ffmpegInput(inputPath),
      "-vn",
      "-map_metadata",
      "-1",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      `file:${resolve(outWavPath)}`,
    ],
    signal,
    4 * 1024,
  );
  if (code !== 0) {
    if (/does not contain any stream|Output file #0 does not contain|matches no streams/i.test(stderr)) throw new NoAudioTrackError(inputPath);
    throw new Error(`ffmpeg could not read the audio in ${inputPath} (exit ${code})`);
  }
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  durationSec: number;
}

/** Read a PCM WAV header (RIFF chunks, so extra LIST chunks are skipped). */
export async function readWavInfo(path: string): Promise<WavInfo> {
  const size = (await stat(path)).size;
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    await fh.read(head, 0, head.length, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error(`${path} is not a WAV file`);
    }
    let pos = 12;
    let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
    while (pos + 8 <= head.length) {
      const id = head.toString("ascii", pos, pos + 4);
      const len = head.readUInt32LE(pos + 4);
      const body = pos + 8;
      if (id === "fmt ") {
        fmt = {
          channels: head.readUInt16LE(body + 2),
          sampleRate: head.readUInt32LE(body + 4),
          bits: head.readUInt16LE(body + 14),
        };
      } else if (id === "data") {
        if (!fmt) break;
        // A streamed WAV can carry a placeholder length; trust the file size.
        const dataBytes = Math.min(len, size - body);
        const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
        return {
          sampleRate: fmt.sampleRate,
          channels: fmt.channels,
          bitsPerSample: fmt.bits,
          dataOffset: body,
          dataBytes,
          durationSec: dataBytes / bytesPerSec,
        };
      }
      pos = body + len + (len % 2);
    }
    throw new Error(`${path} has no PCM data chunk`);
  } finally {
    await fh.close();
  }
}

/** A complete 16 kHz mono WAV file holding the given PCM bytes. */
export function wavFromPcm(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Cut [startSec, startSec + durSec) out of a 16-bit mono WAV as its own WAV file in memory. */
export async function readWavSlice(path: string, info: WavInfo, startSec: number, durSec: number): Promise<Buffer> {
  const frame = info.channels * (info.bitsPerSample / 8);
  const startByte = Math.min(info.dataBytes, Math.max(0, Math.round(startSec * info.sampleRate)) * frame);
  const endByte = Math.min(info.dataBytes, Math.round((startSec + durSec) * info.sampleRate) * frame);
  const len = Math.max(0, endByte - startByte);
  const pcm = Buffer.alloc(len);
  const fh = await open(path, "r");
  try {
    await fh.read(pcm, 0, len, info.dataOffset + startByte);
  } finally {
    await fh.close();
  }
  return wavFromPcm(pcm, info.sampleRate);
}

/** ffmpeg silencedetect over the WAV. Best effort: any failure means "no silences found". */
export async function detectSilences(
  wavPath: string,
  signal?: AbortSignal,
  totalSec?: number,
  noiseDb = -30,
  minSilenceSec = 0.4,
): Promise<SilenceSpan[]> {
  try {
    const { code, stderr } = await runFfmpeg(
      ["-hide_banner", "-nostats", "-nostdin", "-i", ffmpegInput(wavPath), "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`, "-f", "null", "-"],
      signal,
      16 * 1024 * 1024,
    );
    if (code !== 0) return [];
    return parseSilencedetectOutput(stderr, totalSec);
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return [];
  }
}

/** Mean volume of the WAV in dBFS (ffmpeg volumedetect), or null when it cannot be measured. */
export async function measureMeanVolume(wavPath: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const { code, stderr } = await runFfmpeg(
      ["-hide_banner", "-nostats", "-nostdin", "-i", ffmpegInput(wavPath), "-af", "volumedetect", "-f", "null", "-"],
      signal,
      64 * 1024,
    );
    if (code !== 0) return null;
    const m = /mean_volume:\s*(-?[0-9.]+|-inf) dB/.exec(stderr);
    if (!m || m[1] === "-inf") return null;
    const db = Number(m[1]);
    return Number.isFinite(db) ? db : null;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return null;
  }
}

/** A recording whose mean volume is under this is quiet: its silence thresholds follow it down. */
export const QUIET_MEAN_DB = -35;

/**
 * Silence thresholds for one recording, from its mean volume.
 *
 * - `quiet`: the mean is under QUIET_MEAN_DB. Normal speech (a mic take
 *   averages about -25 dB) is not quiet.
 * - `splitDb` finds the pauses to cut long audio at, and decides that a
 *   piece holds nothing worth sending to an engine that invents words in
 *   silence. -30 dB, or for a quiet recording 12 dB under its mean, so speech
 *   peaking around -31 dBFS is not one long "silence".
 * - `skipDb` decides that a piece holds no speech at all. Skipping loses
 *   words when it is wrong, so it is far stricter: at most -50 dB and 30 dB
 *   under the mean.
 */
export function silenceThresholds(meanDb: number | null): { splitDb: number; skipDb: number; quiet: boolean } {
  if (meanDb === null || !Number.isFinite(meanDb)) return { splitDb: -30, skipDb: -50, quiet: false };
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const quiet = meanDb < QUIET_MEAN_DB;
  return { splitDb: quiet ? clamp(meanDb - 12, -70, -30) : -30, skipDb: clamp(meanDb - 30, -80, -50), quiet };
}
