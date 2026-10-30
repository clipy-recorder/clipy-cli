/**
 * `clipy context read <bundle-path>` — prints a local bundle's recording.arec.
 * Output is for agents: plain, unpaged, uncoloured.
 *
 * Reading is lenient (AREC specification section 7.1): a bundle written by an
 * older or newer CLI is printed as it is. A missing or unfamiliar manifest is a
 * note on stderr, never a refusal; the only failure is having no document at all.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  AREC_CANONICAL_FILENAME,
  AREC_LEGACY_FILENAME,
} from "../context-core/index.js";

function note(message: string): void {
  process.stderr.write(`note: ${message}\n`);
}

export function cmdContextRead(target: string): void {
  const resolved = resolve(target);

  // An .arec or .md file given directly is printed as it is. Any other file in
  // a bundle (manifest.json, transcript.json) stands for its bundle folder.
  if (existsSync(resolved) && statSync(resolved).isFile() && /\.(arec|md)$/i.test(basename(resolved))) {
    process.stdout.write(readFileSync(resolved, "utf8"));
    return;
  }

  const dir = existsSync(resolved) && statSync(resolved).isFile() ? resolve(resolved, "..") : resolved;
  const arec = join(dir, AREC_CANONICAL_FILENAME);
  const legacy = join(dir, AREC_LEGACY_FILENAME);
  const doc = existsSync(arec) ? arec : existsSync(legacy) ? legacy : null;
  if (!doc) {
    throw new Error(`${dir} has no ${AREC_CANONICAL_FILENAME} or ${AREC_LEGACY_FILENAME} to read.`);
  }

  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    note(`${dir} has no manifest.json; printing the document without its provenance.`);
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bundleVersion?: unknown };
      if (manifest.bundleVersion !== 1) {
        note(
          `bundle version ${String(manifest.bundleVersion)} is not one this CLI knows (it writes 1); printing the document anyway. \`npm i -g @clipy/cli\` updates the CLI.`,
        );
      }
    } catch {
      note(`${manifestPath} is not valid JSON; printing the document anyway.`);
    }
  }
  process.stdout.write(readFileSync(doc, "utf8"));
}
