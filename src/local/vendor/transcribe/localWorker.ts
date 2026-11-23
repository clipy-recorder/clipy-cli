// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/localWorker.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * Child process that runs sherpa-onnx on pieces of a WAV file. It runs in its
 * own process because a native crash in the model (Parakeet aborts on input
 * that is too long) would otherwise take the whole CLI down; here it only
 * costs one piece, which the parent records as a gap.
 *
 * Self-contained on purpose (Node built-ins and sherpa-onnx-node only, type
 * annotations only), so Node can also run it straight from source. The parent
 * names the engine's entry file when it lives outside this package (the CLI
 * installs it on first use into a folder of its own).
 */
import { createRequire } from "node:module";
import { closeSync, openSync, readSync } from "node:fs";

interface WavRef {
  path: string;
  dataOffset: number;
  dataBytes: number;
  sampleRate: number;
}

interface Piece {
  index: number;
  startSec: number;
  durSec: number;
}

interface RunMessage {
  type: "run";
  recognizerConfig: unknown;
  engine?: string | null;
  wav: WavRef;
  pieces: Piece[];
}

interface SherpaResult {
  text?: string;
  tokens?: string[];
  timestamps?: number[];
  lang?: string;
}

function send(msg: unknown): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) return resolve();
    process.send(msg, undefined, {}, () => resolve());
  });
}

function readPiece(fd: number, wav: WavRef, piece: Piece): Float32Array {
  const startSample = Math.max(0, Math.round(piece.startSec * wav.sampleRate));
  const startByte = Math.min(wav.dataBytes, startSample * 2);
  const endByte = Math.min(wav.dataBytes, Math.round((piece.startSec + piece.durSec) * wav.sampleRate) * 2);
  const len = Math.max(0, endByte - startByte) & ~1;
  const buf = Buffer.alloc(len);
  if (len > 0) readSync(fd, buf, 0, len, wav.dataOffset + startByte);
  const out = new Float32Array(len / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

async function run(msg: RunMessage): Promise<void> {
  const require = createRequire(import.meta.url);
  let recognizer: {
    createStream(): { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void };
    decodeAsync(stream: unknown): Promise<SherpaResult>;
  };
  try {
    const sherpa = require(msg.engine ?? "sherpa-onnx-node");
    recognizer = await sherpa.OfflineRecognizer.createAsync(msg.recognizerConfig);
  } catch (err) {
    await send({ type: "fatal", message: `the speech model could not be loaded: ${(err as Error).message.split("\n")[0]}` });
    process.exit(2);
  }
  const fd = openSync(msg.wav.path, "r");
  try {
    for (const piece of msg.pieces) {
      await send({ type: "started", index: piece.index });
      try {
        const samples = readPiece(fd, msg.wav, piece);
        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: msg.wav.sampleRate });
        const r = await recognizer.decodeAsync(stream);
        await send({
          type: "result",
          index: piece.index,
          text: r.text ?? "",
          tokens: r.tokens ?? [],
          timestamps: r.timestamps ?? [],
          lang: r.lang || undefined,
        });
      } catch (err) {
        await send({ type: "error", index: piece.index, message: (err as Error).name });
      }
    }
  } finally {
    closeSync(fd);
  }
  await send({ type: "done" });
  process.exit(0);
}

process.on("message", (msg: RunMessage) => {
  if (msg && msg.type === "run") void run(msg);
});
