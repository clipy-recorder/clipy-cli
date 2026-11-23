// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/tar.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * Just enough of tar to pull named files out of an archive held in memory
 * (ustar, GNU long names and pax path records). Used for model archives that
 * are only published as `.tar.bz2`.
 */

function readString(buf: Buffer, start: number, len: number): string {
  const raw = buf.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString("utf8");
}

function readOctal(buf: Buffer, start: number, len: number): number {
  const s = readString(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

export interface TarEntry {
  name: string;
  data: Buffer;
}

/** Every regular file in the archive, in order. */
export function* readTar(buf: Buffer): Generator<TarEntry> {
  let pos = 0;
  let longName: string | null = null;
  while (pos + 512 <= buf.length) {
    const header = buf.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) return;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = readString(header, 345, 155);
    let name = readString(header, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = pos + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = readString(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (m) longName = m[1];
      continue;
    }
    if (type === "g") continue;
    if (longName !== null) {
      name = longName;
      longName = null;
    }
    if (type === "0" || type === "\0" || type === "7") yield { name: name.replace(/^\.\//, ""), data };
  }
}
