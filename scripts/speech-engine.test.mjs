#!/usr/bin/env node
// The on-device speech engine is downloaded on first use, after consent
// (dist/local/speechEngine.js): the prompt, the non-interactive refusal, the
// already-installed fast path, the installer itself (with a stand-in npm, so
// no network), and the same flow through the real binary.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { before, describe, it } from "node:test";
import { cliRoot, fakeTranscribe, makeVideo, tempDir } from "./local-test-helpers.mjs";

const engine = await import(resolve(cliRoot, "dist/local/speechEngine.js"));
const local = await import(resolve(cliRoot, "dist/local/commands.js"));
const CLI = join(cliRoot, "dist", "index.js");

// ---- fakes -------------------------------------------------------------------

function fakeSpeech({ installed = false, failInstall = null } = {}) {
  const calls = { status: 0, install: 0 };
  const state = { installed };
  const status = () => ({
    installed: state.installed,
    entry: state.installed ? "/engine/node_modules/sherpa-onnx-node/sherpa-onnx.js" : null,
    source: state.installed ? "clipy" : null,
    dir: "/engine/sherpa-onnx-node-2.0.1",
    version: "2.0.1",
  });
  return {
    calls,
    status() {
      calls.status++;
      return status();
    },
    async install(options) {
      calls.install++;
      calls.signal = options?.signal;
      if (failInstall) throw new Error(failInstall);
      state.installed = true;
      return status();
    },
  };
}

function captureIo({ answer } = {}) {
  const io = {
    out: "",
    err: "",
    asked: [],
    stdout(t) {
      io.out += t;
    },
    stderr(t) {
      io.err += t;
    },
    async waitForStop() {
      return "user";
    },
    onInterrupt() {
      return () => {};
    },
  };
  if (answer !== undefined) {
    io.confirm = async (question) => {
      io.asked.push(question);
      return answer;
    };
  }
  return io;
}

function fakeDeps({ transcription = { kind: "local", model: "english-fast" }, modelInstalled = true, transcribe } = {}) {
  return {
    transcribe: transcribe ?? fakeTranscribe().transcribe,
    downloadModel: async (model) => `/models/${model}`,
    modelStatus: (model) => ({ installed: modelInstalled, dir: `/models/${model}` }),
    modelInfo: (model) => ({ label: model, sizeBytes: 1 }),
    checkCapture: async () => ({ ok: true, ffmpeg: "ffmpeg", problems: [], hints: [] }),
    listSources: async () => [],
    startCapture: async () => {
      throw new Error("no capture in this test");
    },
    startVirtualDisplay: async () => ({ display: ":99", stop: async () => {} }),
    loadConfig: () => ({ model: null, modelPreset: null, transcription, telemetry: false }),
    saveConfig: () => {},
    presetProvider: () => ({ baseUrl: "https://x.example/v1", model: "m" }),
    configPath: () => "/config/clipy-local.json",
  };
}

function makeEnv({ speech, answer, deps = fakeDeps(), assumeYes = false } = {}) {
  const io = captureIo({ answer });
  return { io, env: { deps: () => deps, io, now: () => new Date(2026, 10, 21, 9, 0, 0), version: "0.0.0-test", speech, assumeYes } };
}

let video;
before(() => {
  process.env.CLIPY_FFMPEG = "ffmpeg";
  video = makeVideo(tempDir("clipy-speech-videos-"), 3);
});

// ---- consent -------------------------------------------------------------------

describe("ensureSpeechEngine", () => {
  it("already installed: no prompt, no download, no output", async () => {
    const speech = fakeSpeech({ installed: true });
    const io = captureIo({ answer: true });
    assert.equal(await engine.ensureSpeechEngine(speech, io, { json: false, env: {} }), "present");
    assert.equal(speech.calls.install, 0);
    assert.deepEqual(io.asked, []);
    assert.equal(io.err, "");
  });

  it("asks on a terminal, says what and how big, and installs on yes", async () => {
    const speech = fakeSpeech();
    const io = captureIo({ answer: true });
    assert.equal(await engine.ensureSpeechEngine(speech, io, { json: false, env: {} }), "installed");
    assert.equal(io.asked.length, 1);
    assert.match(io.asked[0], /speech engine: sherpa-onnx-node 2\.0\.1 from npm, about 35 MB/);
    assert.match(io.asked[0], /\/engine\/sherpa-onnx-node-2\.0\.1/);
    assert.match(io.asked[0], /\[Y\/n\] $/);
    assert.equal(speech.calls.install, 1);
    assert.match(io.err, /Speech engine ready/);
  });

  it("stops cleanly on no, naming the command to run later", async () => {
    const speech = fakeSpeech();
    const io = captureIo({ answer: false });
    const err = await engine.ensureSpeechEngine(speech, io, { json: false, env: {} }).catch((e) => e);
    assert.ok(err instanceof engine.SpeechEngineRequiredError);
    assert.equal(err.declined, true);
    assert.equal(err.code, "speech_engine_required");
    assert.match(err.message, /^Stopped: .*clipy speech install/);
    assert.equal(speech.calls.install, 0);
  });

  it("never prompts without a terminal: a structured error that names the command", async () => {
    const speech = fakeSpeech();
    const err = await engine.ensureSpeechEngine(speech, captureIo(), { json: false, env: {} }).catch((e) => e);
    assert.ok(err instanceof engine.SpeechEngineRequiredError);
    assert.equal(err.declined, false);
    assert.equal(err.command, "clipy speech install");
    assert.match(err.message, /clipy speech install.*--yes.*CLIPY_INSTALL_SPEECH_ENGINE=1/);
    assert.equal(speech.calls.install, 0);
  });

  it("never prompts with --json, even on a terminal", async () => {
    const speech = fakeSpeech();
    const io = captureIo({ answer: true });
    await assert.rejects(engine.ensureSpeechEngine(speech, io, { json: true, env: {} }), engine.SpeechEngineRequiredError);
    assert.deepEqual(io.asked, []);
  });

  it("--yes and CLIPY_INSTALL_SPEECH_ENGINE=1 accept up front", async () => {
    let speech = fakeSpeech();
    let io = captureIo();
    assert.equal(await engine.ensureSpeechEngine(speech, io, { json: true, assumeYes: true, env: {} }), "installed");
    assert.equal(speech.calls.install, 1);
    assert.equal(io.err, "", "--json keeps stderr quiet");
    speech = fakeSpeech();
    io = captureIo();
    assert.equal(await engine.ensureSpeechEngine(speech, io, { json: false, env: { CLIPY_INSTALL_SPEECH_ENGINE: "1" } }), "installed");
    assert.equal(speech.calls.install, 1);
    assert.equal(engine.acceptedByEnv({ CLIPY_INSTALL_SPEECH_ENGINE: "yes" }), true);
    assert.equal(engine.acceptedByEnv({ CLIPY_INSTALL_SPEECH_ENGINE: "0" }), false);
  });

  it("copy has no em dashes", () => {
    for (const text of [engine.speechEnginePrompt("/d"), new engine.SpeechEngineRequiredError(false).message, new engine.SpeechEngineRequiredError(true).message]) {
      assert.ok(!text.includes("\u2014"), text);
    }
  });
});

// ---- a local take asks before anything is recorded ------------------------------

describe("a local take settles the engine first", () => {
  it("non-interactive import: speech_engine_required in the JSON, no folder, nothing transcribed", async () => {
    const speech = fakeSpeech();
    const fake = fakeTranscribe();
    const t = makeEnv({ speech, deps: fakeDeps({ transcribe: fake.transcribe }) });
    const out = join(tempDir("clipy-speech-take-"), "take");
    const err = await local
      .runLocalTake({ videoPath: video, out, origin: { kind: "import", fileName: "v.mp4" }, json: true }, t.env)
      .catch((e) => e);
    assert.ok(err instanceof local.SpeechEngineRequiredError);
    local.printLocalError(err, true, t.io);
    const printed = JSON.parse(t.io.out);
    assert.equal(printed.ok, false);
    assert.equal(printed.code, "speech_engine_required");
    assert.match(printed.remediation, /clipy speech install/);
    assert.equal(existsSync(out), false);
    assert.equal(fake.calls.length, 0);
  });

  it("interactive import: yes installs, then transcribes", async () => {
    const speech = fakeSpeech();
    const fake = fakeTranscribe();
    const t = makeEnv({ speech, answer: true, deps: fakeDeps({ transcribe: fake.transcribe }) });
    const out = join(tempDir("clipy-speech-take-"), "take");
    const result = await local.runLocalTake({ videoPath: video, out, origin: { kind: "import", fileName: "v.mp4" }, json: false }, t.env);
    assert.equal(t.io.asked.length, 1);
    assert.equal(speech.calls.install, 1);
    assert.ok(speech.calls.signal instanceof AbortSignal, "Ctrl-C can cancel the download");
    assert.equal(fake.calls.length, 1);
    assert.equal(result.transcriptSegments, 2);
  });

  it("interactive import: no stops before anything is written", async () => {
    const speech = fakeSpeech();
    const t = makeEnv({ speech, answer: false });
    const out = join(tempDir("clipy-speech-take-"), "take");
    await assert.rejects(local.runLocalTake({ videoPath: video, out, origin: { kind: "import", fileName: "v.mp4" }, json: false }, t.env), (e) => e instanceof local.SpeechEngineRequiredError && /^Stopped: /.test(e.message));
    assert.equal(existsSync(out), false);
    assert.equal(speech.calls.install, 0);
  });

  it("does not ask when the engine is not needed", async () => {
    const cases = [
      { why: "a supplied transcript", deps: fakeDeps(), req: { transcript: { segments: [{ startMs: 0, endMs: 1000, text: "hi" }], label: "supplied" } } },
      { why: "the model is not downloaded", deps: fakeDeps({ modelInstalled: false }), req: {} },
      { why: "a transcription key", deps: fakeDeps({ transcription: { kind: "deepgram", apiKey: "k" } }), req: {} },
      { why: "transcription off", deps: fakeDeps({ transcription: { kind: "none" } }), req: {} },
      { why: "a session's folder claimed at start", deps: fakeDeps(), req: { outClaimed: true } },
    ];
    for (const c of cases) {
      const speech = fakeSpeech();
      const t = makeEnv({ speech, deps: c.deps });
      const out = join(tempDir("clipy-speech-take-"), "take");
      await local.runLocalTake({ videoPath: video, out, origin: { kind: "import", fileName: "v.mp4" }, json: true, ...c.req }, t.env);
      assert.equal(speech.calls.status, 0, c.why);
      assert.equal(speech.calls.install, 0, c.why);
    }
  });

  it("a file with no audio track is imported without the engine", async () => {
    const silent = makeVideo(tempDir("clipy-speech-silent-"), 2, "silent.mp4", { audio: false });
    const speech = fakeSpeech();
    const t = makeEnv({ speech });
    const out = join(tempDir("clipy-speech-take-"), "take");
    const result = await local.runLocalTake({ videoPath: silent, out, origin: { kind: "import", fileName: "silent.mp4" }, json: true }, t.env);
    assert.equal(speech.calls.install, 0);
    assert.match(result.transcriptEngine, /no audio track/);
  });

  it("record --local asks only with --mic, before the capture starts", async () => {
    const started = [];
    const deps = { ...fakeDeps(), startCapture: async (o) => (started.push(o), Promise.reject(new Error("stop here"))) };
    let speech = fakeSpeech();
    let t = makeEnv({ speech, deps });
    assert.equal(await local.localCaptureRecord({ mic: true, json: true, out: join(tempDir(), "take") }, t.env), 1);
    assert.equal(JSON.parse(t.io.out).code, "speech_engine_required");
    assert.equal(started.length, 0, "nothing was recorded");

    speech = fakeSpeech();
    t = makeEnv({ speech, deps });
    await local.localCaptureRecord({ mic: false, json: true, out: join(tempDir(), "take") }, t.env);
    assert.equal(speech.calls.status, 0, "a silent take does not need the engine");
    assert.equal(started.length, 1);
  });
});

// ---- clipy speech, clipy models download, status ----------------------------------

describe("clipy speech", () => {
  it("status reports what is missing and how to install it", async () => {
    const t = makeEnv({ speech: fakeSpeech() });
    assert.equal(await local.cmdSpeech(["status"], true, t.env), 0);
    const report = JSON.parse(t.io.out);
    assert.equal(report.installed, false);
    assert.equal(report.version, "2.0.1");
    assert.equal(report.install, "clipy speech install");
  });

  it("install is the consent: no prompt; already installed is a no-op", async () => {
    const speech = fakeSpeech();
    let t = makeEnv({ speech });
    assert.equal(await local.cmdSpeech(["install"], true, t.env), 0);
    assert.equal(speech.calls.install, 1);
    assert.equal(JSON.parse(t.io.out).installedNow, true);
    t = makeEnv({ speech });
    assert.equal(await local.cmdSpeech(["install"], true, t.env), 0);
    assert.equal(speech.calls.install, 1);
    assert.equal(JSON.parse(t.io.out).installedNow, false);
  });

  it("a failed install exits 1 with the reason; a bad action is a usage error", async () => {
    let t = makeEnv({ speech: fakeSpeech({ failInstall: "npm could not download sherpa-onnx-node@2.0.1: E404" }) });
    assert.equal(await local.cmdSpeech(["install"], true, t.env), 1);
    assert.match(JSON.parse(t.io.out).error, /E404/);
    t = makeEnv({ speech: fakeSpeech() });
    assert.equal(await local.cmdSpeech(["remove"], false, t.env), 2);
  });

  it("models download offers the engine: a note without consent, an install with --yes", async () => {
    let speech = fakeSpeech();
    let t = makeEnv({ speech });
    assert.equal(await local.cmdModels(["download", "english-fast"], true, t.env), 0);
    assert.deepEqual(JSON.parse(t.io.out).speechEngine, { installed: false, dir: "/engine/sherpa-onnx-node-2.0.1", install: "clipy speech install" });
    assert.equal(speech.calls.install, 0);

    speech = fakeSpeech();
    t = makeEnv({ speech, assumeYes: true });
    assert.equal(await local.cmdModels(["download", "english-fast"], true, t.env), 0);
    assert.equal(JSON.parse(t.io.out).speechEngine.installed, true);
    assert.equal(speech.calls.install, 1);

    speech = fakeSpeech({ installed: true });
    t = makeEnv({ speech });
    assert.equal(await local.cmdModels(["download", "english-fast"], true, t.env), 0);
    assert.equal(JSON.parse(t.io.out).speechEngine, undefined);
  });

  it("local status reports a missing engine as info with the install command, never an error", async () => {
    const t = makeEnv({ speech: fakeSpeech() });
    assert.equal(await local.cmdLocalStatus(true, t.env), 0);
    const check = JSON.parse(t.io.out).checks.find((c) => c.name === "local speech");
    assert.equal(check.status, "info");
    assert.match(check.hint, /clipy speech install/);
    assert.equal(check.data.install, "clipy speech install");
  });
});

// ---- the installer, with a stand-in npm ------------------------------------------

/** An npm-cli.js that installs a tiny sherpa-onnx-node into --prefix. */
function fakeNpm(dir) {
  const script = join(dir, "fake-npm-cli.js");
  writeFileSync(
    script,
    `const fs = require("fs"); const path = require("path");
const args = process.argv.slice(2);
if (process.env.FAKE_NPM_LOG) fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
if (process.env.FAKE_NPM_FAIL) { process.stderr.write("npm ERR! code E404\\nnpm ERR! 404 Not Found\\n"); process.exit(1); }
const prefix = args[args.indexOf("--prefix") + 1];
const pkg = path.join(prefix, "node_modules", "sherpa-onnx-node");
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "sherpa-onnx-node", version: "2.0.1", main: "sherpa-onnx.js" }));
fs.writeFileSync(path.join(pkg, "sherpa-onnx.js"), process.env.FAKE_ENGINE_THROWS ? "throw new Error('no addon for this platform')" : "module.exports = { fake: true };");
`,
  );
  return script;
}

describe("installSpeechEngine", () => {
  it("installs the exact version into its own folder, then the fast path skips npm", async () => {
    const dir = tempDir("clipy-speech-install-");
    const log = join(dir, "npm.log");
    const env = { ...process.env, CLIPY_NPM: fakeNpm(dir), FAKE_NPM_LOG: log };
    const root = join(dir, "root");
    mkdirSync(join(root, "sherpa-onnx-node-1.0.0"), { recursive: true });
    const status = await engine.installSpeechEngine({ root, env, alongside: () => null });
    assert.equal(status.installed, true);
    assert.equal(status.source, "clipy");
    assert.equal(realpathSync(status.entry), realpathSync(join(root, "sherpa-onnx-node-2.0.1", "node_modules", "sherpa-onnx-node", "sherpa-onnx.js")));
    const args = JSON.parse(readFileSync(log, "utf8").trim());
    assert.ok(args.includes("sherpa-onnx-node@2.0.1"));
    assert.ok(args.includes("--ignore-scripts"));
    assert.deepEqual(readdirSync(root), ["sherpa-onnx-node-2.0.1"], "no staging folder or older version left");
    assert.equal(engine.speechEngineStatus(root, () => null).installed, true);
    await engine.installSpeechEngine({ root, env, alongside: () => null });
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "npm ran once");
  });

  it("an npm failure leaves nothing behind and says why", async () => {
    const dir = tempDir("clipy-speech-install-");
    const root = join(dir, "root");
    const env = { ...process.env, CLIPY_NPM: fakeNpm(dir), FAKE_NPM_FAIL: "1" };
    await assert.rejects(engine.installSpeechEngine({ root, env, alongside: () => null }), /npm could not download sherpa-onnx-node@2\.0\.1: npm ERR! code E404/);
    assert.deepEqual(readdirSync(root), []);
  });

  it("an engine that does not load on this machine is not kept", async () => {
    const dir = tempDir("clipy-speech-install-");
    const root = join(dir, "root");
    const env = { ...process.env, CLIPY_NPM: fakeNpm(dir), FAKE_ENGINE_THROWS: "1" };
    await assert.rejects(engine.installSpeechEngine({ root, env, alongside: () => null }), /does not load on this machine/);
    assert.deepEqual(readdirSync(root), []);
  });

  it("falls back to a copy installed alongside the CLI", () => {
    const root = tempDir("clipy-speech-root-");
    const status = engine.speechEngineStatus(root, () => "/global/node_modules/sherpa-onnx-node/sherpa-onnx.js");
    assert.equal(status.installed, true);
    assert.equal(status.source, "alongside");
  });

  it("the folder follows the platform cache, or CLIPY_SPEECH_ENGINE_DIR", () => {
    assert.equal(engine.speechEngineRoot({}, "darwin", "/Users/u"), "/Users/u/Library/Caches/clipy-local/speech-engine");
    assert.equal(engine.speechEngineRoot({ XDG_CACHE_HOME: "/c" }, "linux", "/home/u"), "/c/clipy-local/speech-engine");
    assert.equal(engine.speechEngineRoot({ CLIPY_SPEECH_ENGINE_DIR: "/x" }, "linux", "/home/u"), "/x");
  });
});

// ---- the real binary -------------------------------------------------------------

describe("the CLI binary", () => {
  /** A temp HOME holding a stand-in english-fast model, so the take needs the engine. */
  function homeWithModel() {
    const home = tempDir("clipy-speech-home-");
    const cache = process.platform === "darwin" ? join(home, "Library", "Caches") : join(home, ".cache");
    const model = join(cache, "clipy-local", "models", "english-fast");
    mkdirSync(model, { recursive: true });
    writeFileSync(join(model, "model.int8.onnx"), "x");
    writeFileSync(join(model, "tokens.txt"), "x");
    writeFileSync(join(model, ".installed.json"), JSON.stringify({ version: "parakeet-tdt-ctc-110m-en-int8-1" }));
    return home;
  }

  function cliEnv(home, extra = {}) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("CLIPY_")) delete env[k];
    delete env.XDG_CACHE_HOME;
    return { ...env, HOME: home, CLIPY_LOCAL_CONFIG: join(home, "local.json"), CLIPY_SPEECH_ENGINE_DIR: join(home, "engine"), NO_COLOR: "1", ...extra };
  }

  it("without a terminal, context import --local refuses before writing anything, with the command to run", () => {
    const home = homeWithModel();
    const out = join(home, "take");
    const r = spawnSync(process.execPath, [CLI, "context", "import", video, "--local", "--json", "--out", out], {
      env: cliEnv(home),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(r.status, 1, r.stderr);
    const printed = JSON.parse(r.stdout);
    assert.equal(printed.code, "speech_engine_required");
    assert.match(r.stderr, /clipy speech install/);
    assert.equal(existsSync(out), false);
  });

  it("--yes installs the engine and the take hands its path to the speech worker", () => {
    const home = homeWithModel();
    const out = join(home, "take");
    const r = spawnSync(process.execPath, [CLI, "context", "import", video, "--local", "--json", "--yes", "--out", out], {
      env: cliEnv(home, { CLIPY_NPM: fakeNpm(home) }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.ok(existsSync(join(home, "engine", "sherpa-onnx-node-2.0.1", "node_modules", "sherpa-onnx-node")));
    // The stand-in engine has no recognizer, so the worker loaded it from the
    // Clipy folder and failed on the model, not on finding the engine.
    const failure = result.warnings.join(" ");
    assert.match(failure, /speech model could not be loaded/);
    assert.doesNotMatch(failure, /needs the speech engine/);
  });
});
