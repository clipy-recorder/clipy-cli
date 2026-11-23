// Shared helpers for the local-mode tests (local-*.test.mjs). Run after
// `pnpm run build`; they import from dist/.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const cliRoot = resolve(here, "..");
export const repoRoot = resolve(cliRoot, "..");

export function tempDir(prefix = "clipy-local-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function has(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
}

/** A real MP4 with video and a tone, made with ffmpeg's test sources. */
export function makeVideo(dir, seconds, name = `test-${seconds}s.mp4`, { audio = true } = {}) {
  const out = join(dir, name);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=640x360:rate=30`,
    ...(audio ? ["-f", "lavfi", "-i", `sine=duration=${seconds}`] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    ...(audio ? ["-c:a", "aac", "-shortest"] : []),
    out,
  ]);
  return out;
}

/** A PNG test card, for proof frames. */
export function makePng(dir, name, color) {
  const out = join(dir, name);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=640x360`, "-frames:v", "1", out]);
  return out;
}

/** Width and height of an image or video, read by decoding it. */
export function decodedSize(file) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`could not decode ${file}: ${run.stderr}`);
  const match = /Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(run.stderr);
  if (!match) throw new Error(`no video stream in ${file}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export const RULES_ONLY = { model: null, transcription: { kind: "local", model: "english-fast" } };

export function fakeTranscribe(result = {}) {
  const calls = [];
  const transcribe = async (path, config) => {
    calls.push({ path, kind: config.kind });
    return {
      engine: "fake-engine",
      language: "en",
      gaps: [],
      segments: [
        { startMs: 400, endMs: 2_200, text: "Here is the settings page." },
        { startMs: 2_400, endMs: 4_800, text: "I click this button and it breaks." },
      ],
      ...result,
    };
  };
  return { transcribe, calls };
}

/** A stand-in OpenAI-compatible endpoint. */
export async function fakeProvider(respond) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    seen.push(body);
    const { status, json } = respond(body);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(json));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

const FIXTURE = join(repoRoot, "oss", "packages", "moments", "test", "fixtures", "flare-sample.json");
/** The synthetic flare sample from the local edition (oss/), present only inside the monorepo. */
export const fixtureAvailable = existsSync(FIXTURE);
export function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

const VALIDATOR = join(repoRoot, "arec-spec", "validator", "validate.mjs");
/** The reference AREC validator, present only inside the monorepo. */
export const validatorAvailable = existsSync(VALIDATOR);
export async function validateStrict(text) {
  const mod = await import(pathToFileURL(VALIDATOR).href);
  return mod.validateArec(text, { mode: "conform" });
}

/** Every Markdown link and image target in a document. */
export function linkTargets(markdown) {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}

export function keyMomentsJson(arec) {
  const section = arec.split("## Key moments")[1];
  const block = /```json\n([\s\S]*?)\n```/.exec(section);
  if (!block) throw new Error("no key moments JSON");
  return JSON.parse(block[1]);
}

export function readJson(dir, file) {
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

export function readText(dir, file) {
  return readFileSync(join(dir, file), "utf8");
}
