#!/usr/bin/env node
// The real `clipy` binary with --local: argument handling for every local
// command, and real runs (proof, context import, record on a virtual display,
// headless web, a Linux screen session) under a fetch stub and a mock Clipy
// API, asserting that nothing reaches the network. CLIPY_TEST_MODELS=1 also
// transcribes synthetic speech with the on-device english-fast model.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import {
  cliRoot,
  decodedSize,
  has,
  keyMomentsJson,
  makePng,
  makeVideo,
  readJson,
  readText,
  tempDir,
  validateStrict,
  validatorAvailable,
} from "./local-test-helpers.mjs";

const CLI = resolve(cliRoot, "dist", "index.js");
const work = tempDir("clipy-local-cli-");
const home = join(work, "home");
const fetchLog = join(work, "fetch.log");
mkdirSync(home, { recursive: true });

// Every request that reaches "Clipy" in these tests lands here.
const apiRequests = [];
const api = createServer((req, res) => {
  apiRequests.push(`${req.method} ${req.url}`);
  res.statusCode = 500;
  res.end("{}");
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

// A page for the headless web capture.
const site = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end('<html><body style="background:#2a6"><h1>Settings</h1><button>Save</button></body></html>');
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;

after(async () => {
  await new Promise((r) => api.close(() => r()));
  await new Promise((r) => site.close(() => r()));
});

function cliEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("CLIPY_")) delete env[k];
  }
  delete env.XDG_CONFIG_HOME;
  return {
    ...env,
    HOME: home,
    CLIPY_API_URL: apiUrl,
    CLIPY_LOCAL_CONFIG: join(work, "local-config.json"),
    CLIPY_TEST_FETCH_LOG: fetchLog,
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(cliRoot, "scripts", "local-no-network.mjs")).href}`.trim(),
    NO_COLOR: "1",
    ...extra,
  };
}

/**
 * Runs the CLI without blocking this process (the mock API must stay able to
 * answer). `input` is written to stdin and closed; without it stdin is
 * /dev/null.
 */
function runCli(args, { cwd = work, env = {}, timeoutMs = 180_000, input } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: cliEnv(env), stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input !== undefined) child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

function assertNoNetwork() {
  const fetched = existsSync(fetchLog) ? readFileSync(fetchLog, "utf8").trim() : "";
  assert.equal(fetched, "", `--local made a network request: ${fetched}`);
  assert.deepEqual(apiRequests, [], "--local must not call the Clipy API");
}

// A machine that IS signed in to Clipy: a key in the environment and a saved
// login pointing at the mock API. --local must still send nothing.
const loggedHome = join(work, "home-logged-in");
mkdirSync(join(loggedHome, ".config", "clipy"), { recursive: true });
writeFileSync(join(loggedHome, ".config", "clipy", "config.json"), JSON.stringify({ apiKey: "clipy_saved_key", apiUrl }));
const PROFILES = [
  { name: "no account", tag: "anon", env: {} },
  { name: "with a key and a saved login", tag: "logged", env: { HOME: loggedHome, CLIPY_API_KEY: "clipy_test_key" } },
];

async function assertValidArec(arecPath) {
  assert.ok(existsSync(arecPath), arecPath);
  const text = readFileSync(arecPath, "utf8");
  assert.ok(text.startsWith("<!-- arec\nspec_version: 1.4\nprofile: recording\n-->"));
  if (validatorAvailable) {
    const check = await validateStrict(text);
    assert.deepEqual(check.errors, []);
    assert.equal(check.ok, true);
  }
  return text;
}

const xvfb = process.platform === "linux" && has("Xvfb") && has("ffmpeg");
const playwright = (() => {
  const r = spawnSync(process.execPath, [CLI, "playwright-path", "--json"], { encoding: "utf8", env: cliEnv() });
  if (r.status !== 0) return false;
  try {
    const { path } = JSON.parse(r.stdout);
    const check = spawnSync(process.execPath, ["-e", `const p=require(${JSON.stringify(path)});process.exit(require("fs").existsSync(p.chromium.executablePath())?0:1)`]);
    return check.status === 0;
  } catch {
    return false;
  }
})();

let video;
let silentVideo;
before(() => {
  video = makeVideo(work, 6);
  silentVideo = makeVideo(work, 4, "silent.mp4", { audio: false });
});

describe("arguments", () => {
  const refusals = [
    [["record", "--local", "--source", "web"], /--url/],
    [["record", "--local", "--source", "chrome-for-clipy"], /web \(with --url\) or screen/],
    [["record", "--local", "--x-display", ":5"], /--x-display applies to --source screen/],
    [["record", "--local", "--max", "0"], /--max must be/],
    [["record", "--local", "--url", "http://x.test", "--mic"], /records no audio/],
    [["session", "start", "--local", "--source", "chrome-extension", "--url", "http://x.test"], /chrome-extension is not available with --local/],
    [["proof", "--frame", "a.png", "--local", "--for", "abc123"], /does not apply with --local/],
    [["context", "import", "x.mp4", "--local", "--sync"], /does not go with --local/],
    [["local", "bogus"], /usage: clipy local/],
    [["local", "setup", "--transcribe", "deepgram"], /needs --transcribe-key/],
    [["local", "setup", "--model-key", "k"], /go with --model-provider/],
    [["models", "download", "giant"], /Unknown model giant/],
    [["models", "fetch"], /usage: clipy models/],
    // --local promises no upload, so commands that upload or read the library refuse it.
    [["upload", "x.mp4", "--local"], /--local does not apply to `clipy upload`/],
    [["context", "abc123", "--local"], /--local does not apply to `clipy context abc123`/],
    [["list", "--local"], /--local does not apply to `clipy list`/],
  ];
  for (const [args, message] of refusals) {
    it(`refuses ${args.join(" ")} with exit code 2`, async () => {
      const r = await runCli(args);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout + r.stderr, message);
    });
  }

  it("documents local mode in --help and guide --json", async () => {
    const help = await runCli(["--help"]);
    assert.match(help.stdout, /LOCAL/);
    assert.match(help.stdout, /record --local/);
    assert.match(help.stdout, /models download <english-fast\|multilingual>/);
    const guide = JSON.parse((await runCli(["guide", "--json"])).stdout);
    const names = guide.commands.map((cmd) => cmd.name);
    for (const name of ["record --local", "session start --local", "proof --local", "context import --local", "local setup", "local status", "models"]) {
      assert.ok(names.includes(name), name);
    }
    const local = guide.commands.filter((cmd) => / --local|^local |^models/.test(cmd.name));
    for (const cmd of local) {
      assert.ok(!/—/.test(cmd.description), `${cmd.name}: no em dash`);
      assert.ok(!/for developers/i.test(cmd.description), `${cmd.name}: not "for developers"`);
    }
  });

  it("local status, models list and doctor work with nothing set up, and never fail on local mode", async () => {
    const status = await runCli(["local", "status", "--json"]);
    assert.equal(status.code, 0);
    assert.ok(JSON.parse(status.stdout).checks.length >= 4);
    const models = await runCli(["models", "list", "--json"]);
    assert.equal(models.code, 0);
    assert.deepEqual(JSON.parse(models.stdout).models.map((m) => m.model), ["english-fast", "multilingual"]);
    const doctor = await runCli(["doctor", "--json"]);
    const checks = JSON.parse(doctor.stdout).checks.filter((chk) => chk.name.startsWith("local "));
    assert.ok(checks.length >= 4);
    assert.ok(checks.every((chk) => chk.status !== "fail"));
    // Doctor itself reaches the API (that is its job), so reset the log.
    apiRequests.length = 0;
    rmSync(fetchLog, { force: true });
  });

  it("local setup saves to the local config file and never prints the key", async () => {
    const config = join(work, "setup-config.json");
    const r = await runCli(["local", "setup", "--model-provider", "openrouter", "--model-key", "sk-or-SECRET123", "--transcribe", "none"], {
      env: { CLIPY_LOCAL_CONFIG: config },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes("SECRET123"));
    const saved = JSON.parse(readFileSync(config, "utf8"));
    assert.equal(saved.model.preset, "openrouter");
    assert.equal(saved.transcription.kind, "none");
    assertNoNetwork();
  });
});

for (const profile of PROFILES) describe(`local runs never touch the network (${profile.name})`, () => {
  const run = (args, opts = {}) => runCli(args, { ...opts, env: { ...profile.env, ...(opts.env ?? {}) } });
  const p = (name) => join(work, `${name}-${profile.tag}`);

  it("context import <file> --local --transcript builds the full folder", async () => {
    const vtt = join(work, "talk.vtt");
    writeFileSync(vtt, "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nThis is the settings page\n\n00:00:02.500 --> 00:00:04.000\nThis button breaks\n");
    const out = p("imported");
    const r = await run(["context", "import", video, "--local", "--transcript", vtt, "--out", out, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.local, true);
    assert.equal(result.arec, join(out, "recording.arec"));
    assert.equal(result.transcript.segments, 2);
    assert.ok(existsSync(video), "the imported file stays where it was");
    const arec = await assertValidArec(result.arec);
    assert.ok(arec.includes("caption file talk.vtt"));
    assert.ok(arec.includes("This button breaks"));
    for (const f of readJson(out, "frames.json")) decodedSize(join(out, f.frame));
    assertNoNetwork();
  });

  it("context import <file> --local without a transcript or model leaves a partial AREC, not a download", async () => {
    const out = p("imported-nomodel");
    const r = await run(["context", "import", video, "--local", "--out", out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").pop(), join(out, "recording.arec"), "AREC path is the last stdout line");
    assert.match(r.stderr, /clipy upload/);
    const arec = await assertValidArec(join(out, "recording.arec"));
    assert.ok(arec.includes("- Status: Partial: transcription failed"));
    assert.match(arec, /clipy models download english-fast/);
    assertNoNetwork();
  });

  it("proof --frame --local turns each frame and caption into a key moment", async () => {
    const a = makePng(work, "before.png", "red");
    const b = makePng(work, "after.png", "blue");
    const out = p("proof");
    const r = await run(["proof", "--frame", a, "--caption", "Before: Save is grey", "--frame", b, "--caption", "After: Save is blue", "--local", "--hold", "2", "--out", out, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.frames, 2);
    assert.equal(result.source.kind, "proof-frames");
    const arec = await assertValidArec(result.arec);
    const moments = keyMomentsJson(arec);
    assert.deepEqual(moments.map((m) => [m.t_ms, m.frame_at_ms, m.source]), [[0, 1000, "narration"], [2000, 3000, "narration"]]);
    assert.match(moments[0].caption, /Before: Save is grey/);
    assert.ok(arec.includes("Narration: proof frame 2/2 After: Save is blue"));
    assertNoNetwork();
  });

  it("proof --video --local with notes", async () => {
    const out = p("proof-video");
    const r = await run(["proof", "--video", silentVideo, "--note", "1: Dialog opened", "--local", "--out", out, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.source.kind, "proof-video");
    assert.equal(result.transcript.engine, "narration notes");
    const arec = await assertValidArec(result.arec);
    assert.ok(arec.includes("Dialog opened"));
    assert.ok(existsSync(silentVideo), "the supplied video is copied, not moved");
    assertNoNetwork();
  });

  it("record --local --virtual-display --max 3 records a real take on Xvfb", { skip: !xvfb && "needs Linux with Xvfb and ffmpeg" }, async () => {
    const out = p("rec");
    const r = await run(["record", "--local", "--virtual-display", "--max", "3", "--out", out, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.ok, true);
    assert.ok(result.durationMs >= 2_000 && result.durationMs <= 6_000, `duration ${result.durationMs}`);
    assert.ok(result.frames >= 1);
    assert.match(r.stderr, /Virtual display :\d+/);
    const arec = await assertValidArec(result.arec);
    assert.ok(arec.includes("- Source: screen capture of a virtual display"));
    assert.ok(existsSync(join(out, "recording.cursor.json")));
    assert.equal(decodedSize(join(out, "recording.mp4")).width, 1280);
    assertNoNetwork();
  });

  it("record --local --url records a page headlessly and builds the AREC", { skip: !playwright && "needs Playwright with Chromium" }, async () => {
    const out = p("web");
    const r = await run(["record", "--local", "--url", siteUrl, "--for", "2", "--note", "1: page loaded", "--out", out, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.source.kind, "web");
    assert.equal(result.transcript.engine, "narration notes");
    const arec = await assertValidArec(result.arec);
    assert.ok(arec.includes("page loaded"));
    assert.ok(arec.includes("The recording has no audio track"));
    // The page itself was fetched by the browser, but nothing went to Clipy.
    assertNoNetwork();
  });

  it("session start --local on a Linux virtual display: marks become moments, stop builds the AREC", { skip: !xvfb && "needs Linux with Xvfb and ffmpeg" }, async () => {
    const cwd = p("session-ws");
    mkdirSync(cwd, { recursive: true });
    const out = p("session");
    const start = await run(["session", "start", "--local", "--source", "screen", "--virtual-display", "--max", "60", "--out", out, "--json"], { cwd });
    assert.equal(start.code, 0, start.stderr);
    const started = JSON.parse(start.stdout);
    assert.equal(started.local, true);
    assert.equal(started.out, out);
    await new Promise((r) => setTimeout(r, 1500));
    const mark = await run(["mark", "Clicked Save"], { cwd });
    assert.equal(mark.code, 0, mark.stderr);
    await new Promise((r) => setTimeout(r, 1500));
    const stop = await run(["session", "stop"], { cwd });
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(stop.stdout.trim().split("\n").pop(), join(out, "recording.arec"));
    assert.match(stop.stderr, /Nothing was uploaded/);
    const arec = await assertValidArec(join(out, "recording.arec"));
    const moments = keyMomentsJson(arec);
    assert.ok(moments.some((m) => m.source === "narration" && /Clicked Save/.test(m.caption)));
    assert.ok(arec.includes("Narration: Clicked Save"));
    assertNoNetwork();
  });

  it("session start --local --url (headless web) runs the same lifecycle", { skip: !playwright && "needs Playwright with Chromium" }, async () => {
    const cwd = p("web-session-ws");
    mkdirSync(cwd, { recursive: true });
    const out = p("web-session");
    const start = await run(["session", "start", "--local", "--url", siteUrl, "--max", "60", "--out", out, "--json"], { cwd });
    assert.equal(start.code, 0, start.stderr);
    assert.equal(JSON.parse(start.stdout).local, true);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal((await run(["mark", "Saw the Save button"], { cwd })).code, 0);
    await new Promise((r) => setTimeout(r, 1000));
    // --local on stop is accepted for a session that was started with --local.
    const stop = await run(["session", "stop", "--local", "--json"], { cwd });
    assert.equal(stop.code, 0, stop.stderr);
    const result = JSON.parse(stop.stdout);
    assert.equal(result.local, true);
    const arec = await assertValidArec(result.arec);
    assert.ok(arec.includes("Saw the Save button"));
    assertNoNetwork();
  });

  it("doctor --local checks only local mode and makes no request", async () => {
    const r = await run(["doctor", "--local", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.local, true);
    assert.ok(report.checks.length >= 4);
    assert.ok(report.checks.every((chk) => chk.name.startsWith("local ")), report.checks.map((chk) => chk.name).join(", "));
    const text = await run(["doctor", "--local"]);
    assert.equal(text.code, 0);
    assert.match(text.stdout, /clipy doctor --local/);
    assert.ok(!text.stdout.includes("—"), "no em dash in doctor --local");
    assertNoNetwork();
  });
});

// ---- Review fixes, through the real binary --------------------------------

/**
 * A stand-in for a running app's agent bridge: one JSON request line in, one
 * response line out, every request kept. `edition` is what its discovery file
 * says; the file is written to `file`.
 */
async function fakeBridge(file, edition, stopped = { status: "ready", message: "Ready" }, { localTakes = false, echoLocal = true } = {}) {
  const requests = [];
  let localTake = edition === "local";
  const dir = tempDir("clipy-lb-");
  const socketPath = join(dir, "b.sock");
  const take = join(dir, "local-recordings", "8c1f2d0e-1111-4222-8333-944455556666");
  const server = createNetServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      requests.push(req);
      const reply = (data) => conn.end(`${JSON.stringify({ ok: true, data })}\n`);
      if (req.token !== "tok") return conn.end(`${JSON.stringify({ ok: false, error: { code: "unauthorized", message: "bad token" } })}\n`);
      if (req.cmd === "status") return reply({ appVersion: "0.9.0", protocolVersion: 3, edition, agentSession: { elapsedSec: 1, maxSec: 60, marks: 0 } });
      if (req.cmd === "sources") return reply({ displays: [{ id: 1, name: "Built-in", width: 1512, height: 982 }], windows: [] });
      if (req.cmd === "start") {
        localTake = edition === "local" || (localTakes && req.local === true && echoLocal);
        return reply({
          recordingId: "8c1f2d0e-1111-4222-8333-944455556666",
          maxSec: req.maxSec,
          state: "recording",
          audio: { includeSystemAudio: req.audio?.includeSystemAudio ?? true, includeMic: req.audio?.includeMic ?? false, micDeviceId: null },
          ...(localTake ? { local: true, arecPath: join(take, "recording.arec"), directory: take } : {}),
        });
      }
      if (req.cmd === "mark") return reply({ atSeconds: 1.2, totalMarks: requests.filter((r) => r.cmd === "mark").length });
      if (req.cmd === "stop") {
        return reply(
          localTake
            ? { local: true, recordingId: "8c1f2d0e-1111-4222-8333-944455556666", arecPath: join(take, "recording.arec"), directory: take, ...stopped, autoStopped: false, sizeBytes: 4096 }
            : { publicId: "pub", shareUrl: "https://clipy.online/video/pub", autoStopped: false, sizeBytes: 1 },
        );
      }
      if (req.cmd === "abort") return reply({ aborted: true });
      return reply({});
    });
  });
  await new Promise((r) => server.listen(socketPath, r));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ socketPath, token: "tok", pid: process.pid, appVersion: "0.9.0", protocolVersion: localTakes ? 4 : 3, edition, ...(localTakes ? { localTakes: true } : {}) }),
  );
  return { requests, take, close: () => new Promise((r) => server.close(() => r())) };
}

describe("Clipy Local through its agent bridge (--source mac-screen --local)", () => {
  const appSupport = join(home, "Library", "Application Support");
  // On macOS the CLI finds Clipy Local at its default path under HOME; other
  // platforms need the explicit file to get past the macOS check.
  const localFile = join(appSupport, "Clipy Local", "agent-bridge.json");
  const localEnv = process.platform === "darwin" ? {} : { CLIPY_LOCAL_BRIDGE_FILE: localFile };
  // The official app, which uploads: present and answering, and never asked.
  const officialFile = join(appSupport, "Clipy", "agent-bridge.json");
  let official;
  before(async () => {
    official = await fakeBridge(officialFile, "cloud");
  });
  after(async () => {
    await official.close();
    rmSync(officialFile, { force: true });
  });

  it("without Clipy Local running, says so and never asks the official app", async () => {
    rmSync(localFile, { force: true });
    const r = await runCli(["record", "--local", "--source", "mac-screen", "--for", "1"], { env: { CLIPY_BRIDGE_FILE: officialFile } });
    if (process.platform === "darwin") {
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /Clipy Local is not running/);
      assert.match(r.stderr, /Open Clipy Local/);
      assert.match(r.stderr, /cannot keep a recording on this computer/, "an official app without local takes is never used");
    } else {
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /Clipy Local, which runs on macOS/);
    }
    assert.deepEqual(official.requests, []);
    assertNoNetwork();
  });

  it("refuses a bridge file that is not Clipy Local's", async () => {
    const wrong = join(work, "wrong-edition.json");
    writeFileSync(wrong, readFileSync(officialFile));
    const r = await runCli(["session", "start", "--local", "--source", "mac-screen"], { env: { CLIPY_LOCAL_BRIDGE_FILE: wrong } });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /not Clipy Local's/);
    assert.deepEqual(official.requests, []);
  });

  it("without --local, a mac-screen take never records through Clipy Local", async () => {
    const app = await fakeBridge(localFile, "local");
    try {
      const r = await runCli(["record", "--source", "mac-screen", "--for", "1"], { env: { CLIPY_BRIDGE_FILE: localFile, CLIPY_API_KEY: "clipy_test_key" } });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /Clipy Local's.*Add --local/);
      assert.deepEqual(app.requests, []);
    } finally {
      await app.close();
      rmSync(localFile, { force: true });
      apiRequests.length = 0;
      rmSync(fetchLog, { force: true });
    }
  });

  it("refuses --out, which Clipy Local decides itself", async () => {
    const r = await runCli(["record", "--local", "--source", "mac-screen", "--out", join(work, "lb-out")], { env: { CLIPY_LOCAL_BRIDGE_FILE: localFile } });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--out and --force do not apply/);
  });

  it("a session forwards marks and chapters and stop returns the AREC path", async () => {
    const app = await fakeBridge(localFile, "local");
    const cwd = tempDir("clipy-lb-session-");
    try {
      const start = await runCli(["session", "start", "--local", "--source", "mac-screen", "--max", "60", "--json"], { cwd, env: localEnv });
      assert.equal(start.code, 0, start.stderr);
      const started = JSON.parse(start.stdout);
      assert.equal(started.local, true);
      assert.equal(started.app, "Clipy Local");
      assert.equal(started.arec, join(app.take, "recording.arec"));
      assert.equal(started.out, app.take);

      const mark = await runCli(["mark", "Clicked Save"], { cwd, env: localEnv });
      assert.equal(mark.code, 0, mark.stderr);
      const chapter = await runCli(["chapter", "AFTER"], { cwd, env: localEnv });
      assert.equal(chapter.code, 0, chapter.stderr);
      const sources = await runCli(["sources", "--local", "--source", "mac-screen", "--json"], { cwd, env: localEnv });
      assert.equal(sources.code, 0, sources.stderr);
      assert.equal(JSON.parse(sources.stdout).displays[0].source.title, "Built-in", "Clipy Local's own ids");
      const status = await runCli(["session", "status", "--local", "--json"], { cwd, env: localEnv });
      assert.equal(status.code, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).state, "recording");

      const stop = await runCli(["session", "stop", "--local", "--json"], { cwd, env: localEnv });
      assert.equal(stop.code, 0, stop.stderr);
      const result = JSON.parse(stop.stdout);
      assert.equal(result.ok, true);
      assert.equal(result.local, true);
      assert.equal(result.status, "ready");
      assert.equal(result.arec, join(app.take, "recording.arec"));
      assert.equal(result.arecPath, result.arec);
      assert.equal(result.out, app.take);
      assert.equal(result.video, join(app.take, "recording.mp4"));

      const cmds = app.requests.map((r) => r.cmd);
      assert.deepEqual(cmds.filter((c) => c !== "status" && c !== "sources"), ["start", "mark", "mark", "stop"]);
      const marks = app.requests.filter((r) => r.cmd === "mark").map((r) => r.text);
      assert.deepEqual(marks, ["Clicked Save", "=== CHAPTER: AFTER ==="]);
      const startReq = app.requests.find((r) => r.cmd === "start");
      assert.equal(startReq.audio.includeMic, false, "the mic stays off unless asked for");
      assert.equal(startReq.maxSec, 60);
      assert.deepEqual(official.requests, [], "--local never talks to the official app");
      assertNoNetwork();
    } finally {
      await app.close();
      rmSync(localFile, { force: true });
    }
  });

  it("record prints the AREC path last and sends --note values as narration", async () => {
    const app = await fakeBridge(localFile, "local");
    try {
      const r = await runCli(["record", "--local", "--source", "mac-screen", "--for", "1", "--note", "0: Opened settings"], { env: localEnv });
      assert.equal(r.code, 0, r.stderr);
      const lines = r.stdout.trim().split("\n");
      assert.equal(lines.at(-1), join(app.take, "recording.arec"));
      assert.match(r.stderr, /Nothing was uploaded/);
      const startReq = app.requests.find((q) => q.cmd === "start");
      assert.deepEqual(startReq.notes, [{ startMs: 0, text: "Opened settings" }]);
      assert.ok(app.requests.some((q) => q.cmd === "stop"));
      assert.deepEqual(official.requests, []);
      assertNoNetwork();
    } finally {
      await app.close();
      rmSync(localFile, { force: true });
    }
  });

  it("a failed take still prints the Partial AREC path and exits 1", async () => {
    const app = await fakeBridge(localFile, "local", { status: "failed", message: "Moment selection unavailable" });
    const cwd = tempDir("clipy-lb-failed-");
    try {
      const start = await runCli(["session", "start", "--local", "--source", "mac-screen", "--json"], { cwd, env: localEnv });
      assert.equal(start.code, 0, start.stderr);
      const stop = await runCli(["session", "stop", "--json"], { cwd, env: localEnv });
      assert.equal(stop.code, 1, stop.stdout + stop.stderr);
      const result = JSON.parse(stop.stdout);
      assert.equal(result.status, "failed");
      assert.equal(result.ok, false);
      assert.equal(result.arec, join(app.take, "recording.arec"));
      assert.match(stop.stderr, /Moment selection unavailable/);
    } finally {
      await app.close();
      rmSync(localFile, { force: true });
    }
  });
});

describe("the official app keeps a take on this computer (--local, bridge protocol 4)", { skip: process.platform !== "darwin" && "the official app runs on macOS" }, () => {
  const appSupport = join(home, "Library", "Application Support");
  const localFile = join(appSupport, "Clipy Local", "agent-bridge.json");
  const officialFile = join(appSupport, "Clipy", "agent-bridge.json");

  it("a session asks for a local take, and stop returns the AREC with nothing uploaded", async () => {
    rmSync(localFile, { force: true });
    const app = await fakeBridge(officialFile, "cloud", undefined, { localTakes: true });
    const cwd = tempDir("clipy-official-local-");
    try {
      const start = await runCli(["session", "start", "--local", "--source", "mac-screen", "--mic", "--max", "120", "--json"], { cwd });
      assert.equal(start.code, 0, start.stderr);
      const started = JSON.parse(start.stdout);
      assert.equal(started.local, true);
      assert.equal(started.app, "Clipy");
      assert.equal(started.arec, join(app.take, "recording.arec"));
      const startReq = app.requests.find((r) => r.cmd === "start");
      assert.equal(startReq.local, true, "the official app is asked for a local take");
      assert.equal(startReq.audio.includeMic, true);

      const mark = await runCli(["mark", "Opened the settings"], { cwd });
      assert.equal(mark.code, 0, mark.stderr);
      const stop = await runCli(["session", "stop", "--local", "--json"], { cwd });
      assert.equal(stop.code, 0, stop.stderr);
      const result = JSON.parse(stop.stdout);
      assert.equal(result.local, true);
      assert.equal(result.app, "Clipy");
      assert.equal(result.status, "ready");
      assert.equal(result.arec, join(app.take, "recording.arec"));
      assert.equal(result.shareUrl, undefined, "a local take has no share link");
      assertNoNetwork();
    } finally {
      await app.close();
      rmSync(officialFile, { force: true });
    }
  });

  it("Clipy Local still wins when both apps are running", async () => {
    const official = await fakeBridge(officialFile, "cloud", undefined, { localTakes: true });
    const local = await fakeBridge(localFile, "local");
    try {
      const r = await runCli(["record", "--local", "--source", "mac-screen", "--for", "1", "--json"]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).app, "Clipy Local");
      assert.deepEqual(official.requests, []);
    } finally {
      await local.close();
      await official.close();
      rmSync(localFile, { force: true });
      rmSync(officialFile, { force: true });
    }
  });

  it("a start that does not come back local is discarded, never uploaded", async () => {
    rmSync(localFile, { force: true });
    const app = await fakeBridge(officialFile, "cloud", undefined, { localTakes: true, echoLocal: false });
    const cwd = tempDir("clipy-official-upload-");
    try {
      const r = await runCli(["session", "start", "--local", "--source", "mac-screen", "--json"], { cwd });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /discarded/);
      assert.deepEqual(app.requests.map((q) => q.cmd).filter((c) => c !== "sources"), ["start", "abort"]);
      const stop = await runCli(["session", "stop", "--json"], { cwd });
      assert.notEqual(stop.code, 0, "no session is left to stop and upload");
      assert.ok(!app.requests.some((q) => q.cmd === "stop"));
    } finally {
      await app.close();
      rmSync(officialFile, { force: true });
    }
  });

  it("with neither app running, says to open Clipy", async () => {
    rmSync(localFile, { force: true });
    rmSync(officialFile, { force: true });
    const r = await runCli(["session", "start", "--local", "--source", "mac-screen"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Neither the Clipy app nor Clipy Local is running/);
  });
});

describe("nothing recorded is lost (H1)", () => {
  const brokenConfig = join(work, "broken-config.json");
  before(() => writeFileSync(brokenConfig, JSON.stringify({ model: { preset: "openrouter" } })));

  it("record --local --url with a provider but no key fails before recording, leaving nothing", { skip: !playwright && "needs Playwright with Chromium" }, async () => {
    const out = join(work, "h1-web");
    const r = await runCli(["record", "--local", "--url", siteUrl, "--for", "2", "--out", out], { env: { CLIPY_LOCAL_CONFIG: brokenConfig } });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /OpenRouter needs an API key/);
    assert.ok(!/recording for/.test(r.stderr), "the browser never started recording");
    assert.ok(!existsSync(out), "no folder for a take that could not run");
    assertNoNetwork();
  });

  it("record --local on a virtual display with a broken config fails before recording", { skip: !xvfb && "needs Linux with Xvfb and ffmpeg" }, async () => {
    const out = join(work, "h1-screen");
    const r = await runCli(["record", "--local", "--virtual-display", "--max", "2", "--out", out], { env: { CLIPY_LOCAL_CONFIG: brokenConfig } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /OpenRouter needs an API key/);
    assert.ok(!/Recording/.test(r.stderr));
    assert.ok(!existsSync(out));
  });

  it("proof --local and session start --local check the config first too", async () => {
    const png = makePng(work, "h1.png", "green");
    const proof = await runCli(["proof", "--frame", png, "--local", "--out", join(work, "h1-proof")], { env: { CLIPY_LOCAL_CONFIG: brokenConfig } });
    assert.equal(proof.code, 1);
    assert.match(proof.stderr, /OpenRouter needs an API key/);
    assert.ok(!/assembling/.test(proof.stderr), "no frames were rendered");
    assert.ok(!existsSync(join(work, "h1-proof")));
    const cwd = join(work, "h1-session-ws");
    mkdirSync(cwd, { recursive: true });
    const start = await runCli(["session", "start", "--local", "--url", siteUrl, "--out", join(work, "h1-session")], { cwd, env: { CLIPY_LOCAL_CONFIG: brokenConfig } });
    assert.equal(start.code, 1, start.stdout + start.stderr);
    assert.match(start.stderr, /OpenRouter needs an API key/);
    assertNoNetwork();
  });

  it("a failure after the capture keeps the video and says where", { skip: !xvfb && "needs Linux with Xvfb and ffmpeg" }, async () => {
    // An ffmpeg that records and converts but cannot extract a frame.
    const wrapper = join(work, "ffmpeg-no-frames.sh");
    writeFileSync(wrapper, '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-frames:v" ] && exit 1; done\nexec ffmpeg "$@"\n', { mode: 0o755 });
    const out = join(work, "h1-kept");
    const r = await runCli(["record", "--local", "--virtual-display", "--max", "2", "--out", out, "--json"], { env: { CLIPY_FFMPEG: wrapper } });
    assert.equal(r.code, 1, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.keptVideo, join(out, "recording.mp4"));
    assert.ok(statSync(result.keptVideo).size > 0);
    assert.match(r.stderr, /The capture was kept at /);
    assertNoNetwork();
  });
});

/** Every process whose parent is `pid` (from /proc), with its command name and state. */
function children(pid) {
  const out = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const m = /^\d+ \((.*)\) (\S) (\d+)/.exec(stat);
      if (m && Number(m[3]) === pid) out.push({ pid: Number(entry), comm: m[1], state: m[2] });
    } catch {
      // gone
    }
  }
  return out;
}

/** Whether a process is still running (a zombie only waits to be reaped by init). */
function running(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return /^\d+ \(.*\) (\S)/.exec(stat)?.[1] !== "Z";
  } catch {
    return false;
  }
}

describe("stopping a recording (H2)", { skip: !(xvfb && process.platform === "linux") && "needs Linux with Xvfb and ffmpeg" }, () => {
  async function startRecording(args) {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: work, env: cliEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise((r) => child.on("close", (code, signal) => r({ code, signal })));
    const deadline = Date.now() + 30_000;
    while (!/Recording\./.test(stderr) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.match(stderr, /Recording\./, "the recording started");
    await new Promise((r) => setTimeout(r, 2_000));
    const spawned = children(child.pid);
    return { child, exited, spawned, output: () => ({ stdout, stderr }) };
  }

  it("SIGTERM with no --max stops ffmpeg and Xvfb and still builds the take", async () => {
    const out = join(work, "h2-term");
    const rec = await startRecording(["record", "--local", "--virtual-display", "--out", out, "--json"]);
    const names = rec.spawned.map((c) => c.comm);
    assert.ok(names.includes("Xvfb") && names.includes("ffmpeg"), `children: ${names.join(", ")}`);
    rec.child.kill("SIGTERM");
    const { code, signal } = await rec.exited;
    const { stdout, stderr } = rec.output();
    assert.equal(signal, null, "the CLI handled SIGTERM instead of dying on it");
    assert.equal(code, 0, stderr);
    assert.match(stderr, /stdin is not a terminal/);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.ok(result.durationMs >= 1_000, `duration ${result.durationMs}`);
    await assertValidArec(result.arec);
    await new Promise((r) => setTimeout(r, 500));
    for (const c of rec.spawned) assert.ok(!running(c.pid), `${c.comm} (${c.pid}) is still running after SIGTERM`);
  });

  it("closing a non-terminal stdin stops the recording too", async () => {
    const out = join(work, "h2-stdin");
    const rec = await startRecording(["record", "--local", "--virtual-display", "--out", out, "--json"]);
    rec.child.stdin.end();
    const { code } = await rec.exited;
    assert.equal(code, 0, rec.output().stderr);
    assert.equal(JSON.parse(rec.output().stdout).ok, true);
    for (const c of rec.spawned) assert.ok(!running(c.pid), `${c.comm} (${c.pid}) is still running`);
  });

  it("SIGTERM during record --local --source screen stops early and builds the take", async () => {
    const out = join(work, "h2-linux");
    const child = spawn(process.execPath, [CLI, "record", "--local", "--source", "screen", "--virtual-display", "--for", "60", "--out", out, "--json"], {
      cwd: work,
      env: cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise((r) => child.on("close", (code, signal) => r({ code, signal })));
    await new Promise((r) => setTimeout(r, 5_000));
    const spawned = children(child.pid);
    const started = Date.now();
    child.kill("SIGTERM");
    const { code, signal } = await exited;
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    assert.ok(Date.now() - started < 40_000, "stopped well before --for 60");
    assert.equal(JSON.parse(stdout).ok, true);
    await new Promise((r) => setTimeout(r, 500));
    for (const c of spawned) assert.ok(!running(c.pid), `${c.comm} (${c.pid}) is still running`);
  });
});

describe("sessions, folders, keys and flags", () => {
  it("session stop|status --local refuse a session that would upload (M1)", async () => {
    const sessionFile = join(work, "upload-session.json");
    const state = { version: 1, kind: "web", pid: 999_999, cwd: work, url: "http://x.test", state: "recording", maxSec: 60, width: 1280, height: 720, marksPath: join(work, "m.jsonl"), controlPath: join(work, "c.json"), logPath: join(work, "d.log"), tmpDir: join(work, "nope") };
    writeFileSync(sessionFile, JSON.stringify(state));
    for (const verb of ["stop", "status"]) {
      const r = await runCli(["session", verb, "--local"], { env: { CLIPY_SESSION_FILE: sessionFile } });
      assert.equal(r.code, 2, `${verb}: ${r.stderr}`);
      assert.match(r.stderr, /started without --local and uploads on stop; use clipy session abort to discard it/);
      assert.ok(existsSync(sessionFile), "the session is left alone");
    }
    assertNoNetwork();
  });

  it("context import <file> --local twice into one --out: refused, then replaced with --force (M5)", async () => {
    const out = join(work, "m5");
    const vtt = join(work, "m5.vtt");
    writeFileSync(vtt, "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nHello\n");
    assert.equal((await runCli(["context", "import", video, "--local", "--transcript", vtt, "--out", out])).code, 0);
    writeFileSync(join(out, "frames", "000000999999.jpg"), "stale");
    writeFileSync(join(out, "my-notes.txt"), "keep me");
    const again = await runCli(["context", "import", video, "--local", "--transcript", vtt, "--out", out]);
    assert.equal(again.code, 2, again.stderr);
    assert.match(again.stderr, /is not empty.*--force/);
    assert.ok(existsSync(join(out, "frames", "000000999999.jpg")), "nothing touched without --force");
    const forced = await runCli(["context", "import", video, "--local", "--transcript", vtt, "--out", out, "--force"]);
    assert.equal(forced.code, 0, forced.stderr);
    assert.ok(!existsSync(join(out, "frames", "000000999999.jpg")), "no stale frames after --force");
    assert.ok(existsSync(join(out, "my-notes.txt")));
    assert.equal(statSync(out).mode & 0o777, 0o700, "take folders are private (L3)");
    assertNoNetwork();
  });

  it("context import <file> --local refuses flags it would ignore (L2)", async () => {
    for (const flag of [["--language", "en"], ["--tag", "x"], ["--folder", "f"], ["--no-frames"]]) {
      const r = await runCli(["context", "import", video, "--local", ...flag]);
      assert.equal(r.code, 2, flag.join(" "));
      assert.match(r.stderr, new RegExp(`${flag[0]} does not apply to context import <file> --local`));
    }
  });

  it("local setup reads a key from stdin with -, and notes a literal key (M4)", async () => {
    const config = join(work, "m4-config.json");
    const piped = await runCli(["local", "setup", "--model-provider", "openrouter", "--model-key", "-"], { env: { CLIPY_LOCAL_CONFIG: config }, input: "sk-or-FROMSTDIN\n" });
    assert.equal(piped.code, 0, piped.stderr);
    assert.equal(JSON.parse(readFileSync(config, "utf8")).model.apiKey, "sk-or-FROMSTDIN");
    assert.ok(!(piped.stdout + piped.stderr).includes("FROMSTDIN"));
    assert.ok(!/shell history/.test(piped.stderr), "no note when the key came from stdin");
    const literal = await runCli(["local", "setup", "--model-provider", "openrouter", "--model-key", "sk-or-LITERAL"], { env: { CLIPY_LOCAL_CONFIG: config } });
    assert.equal(literal.code, 0, literal.stderr);
    assert.match(literal.stderr, /shell history/);
    assert.ok(!(literal.stdout + literal.stderr).includes("LITERAL"));
    const empty = await runCli(["local", "setup", "--model-provider", "openrouter", "--model-key", "-"], { env: { CLIPY_LOCAL_CONFIG: config }, input: "" });
    assert.equal(empty.code, 2);
    assertNoNetwork();
  });

  it("models list shows each model's licence (L7)", async () => {
    const r = await runCli(["models", "list"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /english-fast\t.*\tCC-BY-4\.0\t/);
    assert.match(r.stdout, /multilingual\t.*\tMIT\t/);
    assert.match(r.stderr, /sherpa-onnx \(Apache-2\.0\)/);
  });

  it("the no-network hook catches fetch, http, https and raw sockets", async () => {
    rmSync(fetchLog, { force: true });
    const probe = [
      "const http = await import('node:http'); const https = await import('node:https'); const net = await import('node:net');",
      "const tries = [",
      `  () => http.request('${apiUrl}/api/health'),`,
      "  () => https.request('https://clipy.online/'),",
      "  () => http.get({ host: 'example.com', port: 80 }),",
      `  () => net.connect(${new URL(apiUrl).port}, '127.0.0.1'),`,
      "  () => net.createConnection({ host: '1.1.1.1', port: 443 }),",
      "];",
      "let refused = 0; for (const t of tries) { try { t(); } catch { refused++; } }",
      "try { await fetch('https://clipy.online/'); } catch { refused++; }",
      "console.log(refused);",
    ].join("\n");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env: cliEnv(), encoding: "utf8" });
    assert.equal(r.stdout.trim(), "6", r.stderr);
    const logged = readFileSync(fetchLog, "utf8").trim().split("\n");
    assert.equal(logged.length, 6, logged.join("\n"));
    rmSync(fetchLog, { force: true });
    assert.deepEqual(apiRequests, []);
  });
});

const modelsDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "clipy-local", "models", "english-fast");
const speechReady = process.env.CLIPY_TEST_MODELS === "1" && has("espeak-ng") && existsSync(join(modelsDir, "model.int8.onnx"));

describe("on-device transcription", () => {
  it("context import <file> --local transcribes speech with english-fast", { skip: !speechReady && "set CLIPY_TEST_MODELS=1 with espeak-ng and the english-fast model downloaded" }, async () => {
    const wav = join(work, "speech.wav");
    const spoken = join(work, "speech.mp4");
    const tts = spawnSync("espeak-ng", ["-s", "140", "-w", wav, "The save button on the settings page does nothing when I click it."]);
    assert.equal(tts.status, 0);
    const mux = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-i", wav,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", spoken,
    ]);
    assert.equal(mux.status, 0, String(mux.stderr));
    const out = join(work, "speech-take");
    const r = await runCli(["context", "import", spoken, "--local", "--out", out, "--json"], {
      env: { XDG_CACHE_HOME: resolve(modelsDir, "..", "..", "..") },
    });
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.match(result.transcript.engine, /local:english-fast/);
    const text = readJson(out, "transcript.json").segments.map((s) => s.text).join(" ").toLowerCase();
    for (const word of ["button", "page", "nothing", "click"]) assert.ok(text.includes(word), `heard "${word}" in: ${text}`);
    const arec = await assertValidArec(result.arec);
    assert.ok(arec.includes("- Status: Complete"));
    assert.ok(arec.includes("The audio stays on this machine."));
    assertNoNetwork();
  });
});
