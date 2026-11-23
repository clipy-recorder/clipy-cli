// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/models.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * Downloadable speech models for on-device transcription. Nothing is ever
 * downloaded unless `downloadModel` is called, which the app or CLI does only
 * after the user agrees. Every file is checked against a pinned SHA-256, and a
 * model is staged in a temporary folder that is renamed into place only once
 * every file has verified, so a model folder is either complete or absent.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { readTar } from "./tar.js";
import type { LocalModelId } from "./types.js";

export interface ModelFile {
  url: string;
  sha256: string;
  /** Path of the file inside the model folder (for an archive, its name while it downloads). */
  path: string;
  /** Download size in bytes. */
  bytes?: number;
  /** Set when `url` is a `.tar.bz2`: the files to keep from it, each with its own checksum. */
  archive?: { members: Array<{ name: string; path: string; sha256: string }> };
}

export interface LocalModel {
  label: string;
  /** SPDX id of the model weights' license. */
  license?: string;
  /** Who made the model and where it comes from, for notices and `models list`. */
  attribution?: string;
  /** Total download size in bytes. */
  sizeBytes: number;
  files: ModelFile[];
}

/** Bumped when a model's files change, so an older install reads as not installed. */
const MODEL_VERSIONS: Record<LocalModelId, string> = {
  "english-fast": "parakeet-tdt-ctc-110m-en-int8-1",
  multilingual: "whisper-base-int8-1",
};

const PARAKEET_ARCHIVE =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2";
const PARAKEET_DIR = "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8";
// Pinned to a commit so the bytes behind the URL cannot change under the checksum.
const WHISPER_BASE = "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc";

export const LOCAL_MODELS: Record<LocalModelId, LocalModel> = {
  // NVIDIA Parakeet TDT-CTC 110M, English only, int8, run as a CTC model.
  // Same model as Clipy's hosted fast English path. It is only published as
  // an archive (104 MB download, 132 MB unpacked). It fails on long input, so
  // audio is fed in pieces of at most 180 seconds.
  "english-fast": {
    label: "English, fast (Parakeet TDT-CTC 110M)",
    license: "CC-BY-4.0",
    attribution:
      "NVIDIA Parakeet TDT-CTC 110M (https://huggingface.co/nvidia/parakeet-tdt_ctc-110m), CC-BY-4.0, converted to ONNX int8 by the sherpa-onnx project",
    sizeBytes: 104_337_827,
    files: [
      {
        url: PARAKEET_ARCHIVE,
        sha256: "17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b",
        path: "parakeet.tar.bz2",
        bytes: 104_337_827,
        archive: {
          members: [
            {
              name: `${PARAKEET_DIR}/model.int8.onnx`,
              path: "model.int8.onnx",
              sha256: "9177a9146cf32ee0cc8152276ef95116f312018d316be37ccf57f7efea81fc1a",
            },
            {
              name: `${PARAKEET_DIR}/tokens.txt`,
              path: "tokens.txt",
              sha256: "450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10",
            },
          ],
        },
      },
    ],
  },
  // OpenAI Whisper base (multilingual, about 99 languages), int8. Base rather
  // than tiny: tiny is a third smaller but noticeably worse outside English,
  // and base still runs well under real time on a laptop CPU (each 30 s
  // window took about 1 s on 2 threads in testing). Whisper reads at most
  // 30 s at a time, so audio is fed in pieces of at most 28 seconds.
  multilingual: {
    label: "All languages (Whisper base)",
    license: "MIT",
    attribution:
      "OpenAI Whisper base (https://github.com/openai/whisper), MIT, converted to ONNX int8 by the sherpa-onnx project",
    sizeBytes: 160_609_290,
    files: [
      {
        url: `${WHISPER_BASE}/base-encoder.int8.onnx`,
        sha256: "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11",
        path: "encoder.int8.onnx",
        bytes: 29_120_534,
      },
      {
        url: `${WHISPER_BASE}/base-decoder.int8.onnx`,
        sha256: "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d",
        path: "decoder.int8.onnx",
        bytes: 130_672_026,
      },
      {
        url: `${WHISPER_BASE}/base-tokens.txt`,
        sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
        path: "tokens.txt",
        bytes: 816_730,
      },
    ],
  },
};

const MARKER = ".installed.json";

/** Platform cache folder for models: `~/.cache/clipy-local/models` on Linux. */
export function defaultModelDir(): string {
  const home = homedir();
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(base, "clipy-local", "models");
  }
  if (process.platform === "darwin") return join(home, "Library", "Caches", "clipy-local", "models");
  const base = process.env.XDG_CACHE_HOME || join(home, ".cache");
  return join(base, "clipy-local", "models");
}

/** Final paths of a model's files inside its folder. */
export function modelFilePaths(model: LocalModelId, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of LOCAL_MODELS[model].files) {
    if (f.archive) for (const m of f.archive.members) out[m.path] = join(dir, m.path);
    else out[f.path] = join(dir, f.path);
  }
  return out;
}

export function modelStatus(model: LocalModelId, modelDir?: string): { installed: boolean; dir: string } {
  if (!(model in LOCAL_MODELS)) throw new Error(`Unknown local model "${model}"`);
  const dir = join(modelDir ?? defaultModelDir(), model);
  let installed = false;
  try {
    const marker = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { version?: string };
    installed = marker.version === MODEL_VERSIONS[model] && Object.values(modelFilePaths(model, dir)).every((p) => existsSync(p));
  } catch {
    installed = false;
  }
  return { installed, dir };
}

export function formatBytes(n: number): string {
  return `${Math.round(n / 1_000_000)} MB`;
}

export class ChecksumError extends Error {
  constructor(what: string) {
    super(`Checksum mismatch for ${what}: the download is corrupt or was changed. Nothing was installed; try again.`);
    this.name = "ChecksumError";
  }
}

function cancelled(): Error {
  const err = new Error("Model download was cancelled");
  err.name = "AbortError";
  return err;
}

export class DownloadTooLargeError extends Error {
  constructor(what: string, maxBytes: number) {
    super(`The download of ${what} is larger than the expected ${maxBytes} bytes, so it was stopped. Nothing was installed.`);
    this.name = "DownloadTooLargeError";
  }
}

/** A model download that receives nothing for this long is abandoned. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/**
 * Stream `url` to `dest`, hashing as it goes. Throws ChecksumError on a
 * mismatch. With `maxBytes` (the file's expected size), a server that sends
 * more is cut off at that size instead of filling the disk.
 *
 * Redirects are followed: the model hosts serve from a CDN, and no key or
 * other credential is sent with these requests.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  sha256: string,
  label: string,
  signal?: AbortSignal,
  onBytes?: (n: number) => void,
  maxBytes?: number,
  idleMs: number = DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<void> {
  // Abandon a connection that stops sending: the clock restarts on every chunk.
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), idleMs);
  };
  const stalled = () => new Error(`Could not download ${label}: the connection stalled (nothing received for ${Math.round(idleMs / 1000)} s)`);
  const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  bump();
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: combined, redirect: "follow" });
    } catch (err) {
      if (signal?.aborted) throw cancelled();
      if (idle.signal.aborted) throw stalled();
      const code = (err as { cause?: { code?: string } }).cause?.code;
      throw new Error(`Could not download ${label}: ${code ? `network error (${code})` : "the server could not be reached"}`);
    }
    bump();
    await saveVerified(res, dest, sha256, label, signal, onBytes, maxBytes, bump, () => idle.signal.aborted, stalled);
  } finally {
    clearTimeout(timer);
  }
}

async function saveVerified(
  res: Response,
  dest: string,
  sha256: string,
  label: string,
  signal: AbortSignal | undefined,
  onBytes: ((n: number) => void) | undefined,
  maxBytes: number | undefined,
  bump: () => void,
  isStalled: () => boolean,
  stalled: () => Error,
): Promise<void> {
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Could not download ${label} (HTTP ${res.status})`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => undefined);
    throw new DownloadTooLargeError(label, maxBytes);
  }
  const hash = createHash("sha256");
  const fh = await open(dest, "w");
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      received += value.byteLength;
      if (maxBytes !== undefined && received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadTooLargeError(label, maxBytes);
      }
      hash.update(value);
      await fh.write(value);
      onBytes?.(value.byteLength);
    }
  } catch (err) {
    if (err instanceof DownloadTooLargeError) throw err;
    if (signal?.aborted) throw cancelled();
    if (isStalled()) throw stalled();
    throw new Error(`Could not download ${label}: the connection dropped`);
  } finally {
    await fh.close();
  }
  if (hash.digest("hex") !== sha256.toLowerCase()) throw new ChecksumError(label);
}

/**
 * Remove staging folders left by a download whose process died before it
 * could clean up (killed, power loss). A folder whose process is still alive
 * belongs to a download in progress and is left alone.
 */
async function removeAbandonedStages(root: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^\..+\.partial-(\d+)-[0-9a-f]+$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || processAlive(pid)) continue;
    await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Decompress a .bz2 file on a worker thread so the event loop stays free. */
function bunzip2(path: string, signal?: AbortSignal): Promise<Buffer> {
  const bzipPath = createRequire(import.meta.url).resolve("seek-bzip");
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    const fs = require("node:fs");
    const Bunzip = require(workerData.bzipPath);
    const out = Bunzip.decode(fs.readFileSync(workerData.path));
    const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
    parentPort.postMessage(ab, [ab]);
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { bzipPath, path } });
    const onAbort = () => {
      void worker.terminate();
      reject(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (ab: ArrayBuffer) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(Buffer.from(ab));
    });
    worker.once("error", () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("The model archive could not be unpacked"));
    });
  });
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Pull the listed members out of a verified archive, checking each one. */
export async function extractArchiveMembers(
  archivePath: string,
  members: Array<{ name: string; path: string; sha256: string }>,
  outDir: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  const tar = await bunzip2(archivePath, signal);
  const wanted = new Map(members.map((m) => [m.name, m]));
  const found = new Set<string>();
  for (const entry of readTar(tar)) {
    const m = wanted.get(entry.name);
    if (!m) continue;
    if (sha256Hex(entry.data) !== m.sha256.toLowerCase()) throw new ChecksumError(`${label} (${m.path})`);
    const tmp = join(outDir, `.${m.path}.${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(tmp, entry.data);
    await rename(tmp, join(outDir, m.path));
    found.add(m.name);
  }
  const missing = members.filter((m) => !found.has(m.name));
  if (missing.length) throw new Error(`The ${label} archive is missing ${missing.map((m) => m.path).join(", ")}`);
}

/**
 * Download, verify and install a model. Returns its folder. Safe to call
 * again: an installed model is returned as is.
 */
export async function downloadModel(
  model: LocalModelId,
  options: { modelDir?: string; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<string> {
  const spec = LOCAL_MODELS[model];
  if (!spec) throw new Error(`Unknown local model "${model}"`);
  const root = options.modelDir ?? defaultModelDir();
  const status = modelStatus(model, root);
  if (status.installed) {
    options.onProgress?.(1);
    return status.dir;
  }
  await mkdir(root, { recursive: true });
  await removeAbandonedStages(root);
  const stage = join(root, `.${model}.partial-${process.pid}-${randomBytes(4).toString("hex")}`);
  await mkdir(stage, { recursive: true });
  const hasArchive = spec.files.some((f) => f.archive);
  const total = spec.files.reduce((n, f) => n + (f.bytes ?? 0), 0) || spec.sizeBytes;
  const downloadShare = hasArchive ? 0.85 : 1;
  let done = 0;
  const report = (n: number) => {
    done += n;
    options.onProgress?.(Math.min(downloadShare, (done / total) * downloadShare));
  };
  try {
    options.onProgress?.(0);
    for (const f of spec.files) {
      const dest = join(stage, f.path);
      await downloadVerified(f.url, dest, f.sha256, spec.label, options.signal, report, f.bytes);
      if (f.archive) {
        await extractArchiveMembers(dest, f.archive.members, stage, spec.label, options.signal);
        await rm(dest, { force: true });
      }
    }
    await writeFile(join(stage, MARKER), JSON.stringify({ model, version: MODEL_VERSIONS[model], installedAt: new Date().toISOString() }, null, 2));
    const final = status.dir;
    await rm(final, { recursive: true, force: true });
    await rename(stage, final);
    options.onProgress?.(1);
    return final;
  } catch (err) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (options.signal?.aborted) throw cancelled();
    throw err;
  }
}
