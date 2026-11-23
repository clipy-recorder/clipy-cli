#!/usr/bin/env node
// Local-mode commands (dist/local/commands.js) with fake dependencies: the
// capture record flow, setup, models, status, output folders and results.
// No screen, model or network is touched here; local-cli.test.mjs runs the
// real binary.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { before, describe, it } from "node:test";
import { fakeTranscribe, makeVideo, tempDir } from "./local-test-helpers.mjs";

const local = await import(resolve("dist/local/commands.js"));
const media = await import(resolve("dist/local/media.js"));

function captureIo() {
  const io = {
    out: "",
    err: "",
    stops: [],
    stdout(t) {
      io.out += t;
    },
    stderr(t) {
      io.err += t;
    },
    async waitForStop(maxMs) {
      io.stops.push(maxMs);
      return "user";
    },
    onInterrupt() {
      return () => {};
    },
  };
  return io;
}

function resolveTranscription(t) {
  switch (t.kind) {
    case "openai":
    case "groq":
      return { kind: "openai-compatible", baseUrl: `https://${t.kind}.example/v1`, apiKey: t.apiKey, model: t.model ?? "whisper" };
    case "local":
      return { kind: "local", model: t.model ?? "english-fast" };
    case "openai-compatible":
      return { ...t, apiKey: t.apiKey ?? "" };
    default:
      return t;
  }
}

function fakeDeps(overrides = {}) {
  const saved = [];
  const config = { model: null, modelPreset: null, transcription: { kind: "local", model: "english-fast" }, telemetry: false };
  const deps = {
    saved,
    transcribe: fakeTranscribe().transcribe,
    downloadModel: async (model, options) => {
      options?.onProgress?.(0.5);
      options?.onProgress?.(1);
      return `/models/${model}`;
    },
    modelStatus: (model) => ({ installed: model === "english-fast", dir: `/models/${model}` }),
    modelInfo: (model) => ({ label: model === "english-fast" ? "English, fast" : "All languages", sizeBytes: model === "english-fast" ? 104_000_000 : 161_000_000 }),
    checkCapture: async () => ({ ok: true, ffmpeg: "ffmpeg", problems: [], hints: [] }),
    listSources: async () => [{ id: "screen:0", kind: "display", name: "Main display", width: 1920, height: 1080 }],
    startCapture: async () => {
      throw new Error("no capture in this test");
    },
    startVirtualDisplay: async () => ({ display: ":99", stop: async () => {} }),
    loadConfig: () => config,
    saveConfig: (patch) => {
      saved.push(patch);
      if (patch.model !== undefined) {
        config.model = patch.model ? deps.presetProvider(patch.model.preset, patch.model.apiKey, patch.model.model, patch.model.baseUrl) : null;
        config.modelPreset = patch.model ? patch.model.preset : null;
      }
      if (patch.transcription) config.transcription = resolveTranscription(patch.transcription);
    },
    presetProvider: (preset, apiKey, model, baseUrl) => {
      if (preset === "custom" && !baseUrl) throw new Error("A custom provider needs a base URL.");
      return { baseUrl: baseUrl ?? `https://${preset}.example/v1`, model: model ?? `${preset}/default`, ...(apiKey ? { apiKey } : {}) };
    },
    configPath: () => "/config/clipy-local.json",
    ...overrides,
  };
  return deps;
}

function env(deps = fakeDeps(), extra = {}) {
  const io = captureIo();
  return { io, deps, env: { deps: () => deps, io, now: () => new Date(2026, 10, 18, 9, 5, 7), version: "0.0.0-test", ...extra } };
}

let video;
before(() => {
  process.env.CLIPY_FFMPEG = "ffmpeg";
  video = makeVideo(tempDir("clipy-local-videos-"), 6);
});

/** A capture session that "records" by copying the test video. */
function fakeCapture(started, { warnings = [] } = {}) {
  return async (options) => {
    started.push({ ...options });
    return {
      startedAt: Date.now(),
      stop: async () => {
        copyFileSync(video, options.outPath);
        return {
          path: options.outPath,
          durationMs: 6_000,
          interactions: [
            { kind: "move", time_ms: 1_000, x: 100, y: 100 },
            { kind: "down", time_ms: 3_000, x: 320, y: 180, button: 0 },
            { kind: "up", time_ms: 3_050, x: 320, y: 180, button: 0 },
          ],
          geometry: { x: 0, y: 0, width: 640, height: 360, output_width: 640, output_height: 360 },
          warnings,
        };
      },
      abort: async () => {},
    };
  };
}

describe("output folder", () => {
  it("defaults to ~/clipy/recordings/<date-time> and never reuses a folder", () => {
    const home = tempDir("clipy-local-home-");
    const now = new Date(2026, 10, 18, 9, 5, 7);
    const expected = join(home, "clipy", "recordings", "2026-11-18-090507");
    assert.equal(local.defaultOutDir(now, home), expected);
    assert.equal(local.resolveOutDir(undefined, { now: () => now, home }), expected);
    mkdirSync(expected, { recursive: true });
    assert.equal(local.resolveOutDir(undefined, { now: () => now, home }), `${expected}-2`);
    assert.equal(local.resolveOutDir("rel/out", { now: () => now, home }), resolve("rel/out"));
  });
});

describe("record --local (capture package)", () => {
  it("records until stopped, then builds the AREC from the capture", async () => {
    const dir = join(tempDir(), "rec");
    const started = [];
    const { io, env: e } = env(fakeDeps({ startCapture: fakeCapture(started, { warnings: ["Microphone unavailable, recorded without audio."] }) }));
    const code = await local.localCaptureRecord(
      { source: "screen:0", maxSeconds: 12, mic: false, out: dir, json: false, narration: [{ startMs: 2_000, text: "Opened the menu" }] },
      e,
    );
    assert.equal(code, 0, io.err);
    assert.deepEqual(started, [{ source: "screen:0", outPath: join(dir, "recording.mp4"), maxSeconds: 12, microphone: false, xDisplay: undefined }]);
    assert.deepEqual(io.stops, [12_000]);
    assert.equal(io.out.trim(), join(dir, "recording.arec"), "the last stdout line is the AREC path");
    assert.match(io.err, /Nothing was uploaded/);
    assert.match(io.err, /clipy upload .*recording\.mp4/);
    const arec = readFileSync(join(dir, "recording.arec"), "utf8");
    assert.ok(arec.includes("- Source: screen capture of screen:0"));
    assert.ok(arec.includes("Microphone unavailable, recorded without audio."));
    assert.ok(arec.includes('"source": "click"'));
    assert.ok(arec.includes('"source": "narration"'));
    assert.ok(arec.includes("- Compiler: clipy 0.0.0-test --local"));
  });

  it("starts and stops a virtual display around the capture and prints one JSON object", async () => {
    const events = [];
    const started = [];
    const capture = fakeCapture(started);
    const { io, env: e } = env(
      fakeDeps({
        startVirtualDisplay: async (size) => {
          events.push(`display up ${size.width}x${size.height}`);
          return { display: ":42", stop: async () => void events.push("display down") };
        },
        startCapture: async (options) => {
          events.push(`capture on ${options.xDisplay}`);
          return capture(options);
        },
      }),
    );
    const dir = join(tempDir(), "rec");
    assert.equal(await local.localCaptureRecord({ mic: true, virtualDisplay: { width: 800, height: 600 }, out: dir, json: true }, e), 0);
    assert.deepEqual(events, ["display up 800x600", "capture on :42", "display down"]);
    assert.equal(started[0].microphone, true);
    const result = JSON.parse(io.out);
    assert.equal(result.ok, true);
    assert.equal(result.local, true);
    assert.equal(result.arec, join(dir, "recording.arec"));
    assert.equal(result.video, join(dir, "recording.mp4"));
    assert.ok(result.frames > 0);
  });

  it("reports a failed take with exit code 1 and a JSON error", async () => {
    const { io, env: e } = env(fakeDeps({ startCapture: async () => { throw new Error("ffmpeg could not open the screen"); } }));
    assert.equal(await local.localCaptureRecord({ mic: false, out: join(tempDir(), "x"), json: true }, e), 1);
    const out = JSON.parse(io.out);
    assert.equal(out.ok, false);
    assert.match(out.error, /could not open the screen/);
  });
});

describe("runLocalTake (import, proof, web and session captures)", () => {
  it("imports a file without moving it and uses a supplied transcript", async () => {
    const { env: e, deps } = env();
    let called = 0;
    deps.transcribe = async () => {
      called++;
      throw new Error("should not transcribe");
    };
    const dir = join(tempDir(), "imp");
    const result = await local.runLocalTake(
      {
        videoPath: video,
        out: dir,
        title: "demo.mp4",
        transcript: { segments: [{ startMs: 0, endMs: 1_000, text: "Hello" }], label: "caption file demo.vtt" },
        origin: { kind: "import", fileName: "demo.mp4" },
        json: true,
      },
      e,
    );
    assert.equal(called, 0);
    assert.ok(existsSync(video), "an imported file is copied, not moved");
    assert.equal(result.transcriptEngine, "caption file demo.vtt");
    assert.ok(readFileSync(join(dir, "recording.arec"), "utf8").includes("- Source: imported file `demo.mp4`"));
  });
});

describe("local setup", () => {
  it("saves setup without ever printing a key", () => {
    const { io, deps, env: e } = env();
    const code = local.cmdLocalSetup(
      { modelProvider: "openrouter", modelKey: "sk-or-SECRET", transcribe: "deepgram", transcribeKey: "dg-SECRET" },
      false,
      e,
    );
    assert.equal(code, 0);
    assert.deepEqual(deps.saved, [{ model: { preset: "openrouter", apiKey: "sk-or-SECRET" }, transcription: { kind: "deepgram", apiKey: "dg-SECRET" } }]);
    assert.ok(!(io.out + io.err).includes("SECRET"));
    assert.ok(io.out.includes("Saved to /config/clipy-local.json."));
    assert.ok(io.out.includes("Moment selection: openrouter: openrouter/default at openrouter.example, key set (the transcript is sent there)"));
    assert.ok(io.out.includes("Transcription: deepgram, key set (the audio is sent there)"));
  });

  it("maps every transcription choice", () => {
    assert.deepEqual(local.transcriptionFor("local-english"), { kind: "local", model: "english-fast" });
    assert.deepEqual(local.transcriptionFor("local-multilingual"), { kind: "local", model: "multilingual" });
    assert.deepEqual(local.transcriptionFor("openai", "k"), { kind: "openai", apiKey: "k" });
    assert.deepEqual(local.transcriptionFor("groq", "k"), { kind: "groq", apiKey: "k" });
    assert.deepEqual(local.transcriptionFor("gemini", "k"), { kind: "gemini", apiKey: "k" });
    assert.deepEqual(local.transcriptionFor("none"), { kind: "none" });
  });

  it("clears the provider, saves a custom endpoint, and refuses what the config rejects", () => {
    let t = env();
    assert.equal(local.cmdLocalSetup({ modelProvider: "none" }, false, t.env), 0);
    assert.deepEqual(t.deps.saved, [{ model: null }]);
    assert.ok(t.io.out.includes("rules only"));

    t = env();
    assert.equal(local.cmdLocalSetup({ modelProvider: "custom", baseUrl: "http://10.0.0.2:8080/v1", model: "qwen" }, true, t.env), 0);
    assert.deepEqual(t.deps.saved, [{ model: { preset: "custom", model: "qwen", baseUrl: "http://10.0.0.2:8080/v1" } }]);
    assert.match(JSON.parse(t.io.out).momentSelection, /custom: qwen at 10\.0\.0\.2:8080/);

    t = env(fakeDeps({ presetProvider: () => { throw new Error("Ollama needs a model name."); } }));
    assert.equal(local.cmdLocalSetup({ modelProvider: "ollama" }, false, t.env), 1);
    assert.deepEqual(t.deps.saved, []);
    assert.ok(t.io.err.includes("Ollama needs a model name."));
  });

  it("rejects flag combinations with exit code 2", () => {
    for (const flags of [
      { modelProvider: "nope" },
      { modelProvider: "custom", model: "m" },
      { modelKey: "k" },
      { transcribe: "whisperx" },
      { transcribeKey: "k" },
      { transcribe: "deepgram" },
    ]) {
      const t = env();
      assert.equal(local.cmdLocalSetup(flags, false, t.env), 2, JSON.stringify(flags));
      assert.deepEqual(t.deps.saved, []);
    }
  });
});

describe("models, sources and status", () => {
  it("lists and downloads models", async () => {
    let t = env();
    assert.equal(await local.cmdModels(["list"], false, t.env), 0);
    assert.ok(t.io.out.includes("english-fast\tinstalled"));
    assert.ok(t.io.out.includes("multilingual\tnot downloaded (161 MB)"));
    t = env();
    assert.equal(await local.cmdModels(["download", "multilingual"], false, t.env), 0);
    assert.equal(t.io.out.trim(), "/models/multilingual");
    assert.ok(t.io.err.includes("100%"));
    t = env();
    assert.equal(await local.cmdModels(["download", "giant"], false, t.env), 2);
    t = env();
    assert.equal(await local.cmdModels(["list"], true, t.env), 0);
    assert.equal(JSON.parse(t.io.out).models.length, 2);
  });

  it("lists capture sources", async () => {
    const t = env();
    assert.equal(await local.localSources(true, t.env), 0);
    assert.equal(JSON.parse(t.io.out).sources[0].id, "screen:0");
  });

  it("reports status without failing, with a hint for a missing model or engine", async () => {
    let t = env();
    assert.equal(await local.cmdLocalStatus(true, t.env, { installed: true, entry: "/engine/sherpa-onnx.js", source: "clipy", dir: "/engine", version: "2.0.1" }), 0);
    let checks = JSON.parse(t.io.out).checks;
    const byName = (name) => checks.find((c) => c.name === name);
    assert.equal(byName("local config").status, "pass");
    assert.equal(byName("local models").status, "pass");
    assert.equal(byName("local speech").status, "pass");
    assert.equal(byName("local capture").status, "pass");

    t = env(fakeDeps({ modelStatus: (m) => ({ installed: false, dir: `/models/${m}` }), checkCapture: async () => ({ ok: false, ffmpeg: null, problems: ["no ffmpeg"], hints: ["install it"] }) }));
    assert.equal(await local.cmdLocalStatus(true, t.env, { installed: false, entry: null, source: null, dir: "/engine", version: "2.0.1" }), 0);
    checks = JSON.parse(t.io.out).checks;
    assert.equal(byName("local models").status, "warn");
    assert.match(byName("local models").hint, /clipy models download english-fast/);
    assert.equal(byName("local speech").status, "info");
    assert.match(byName("local speech").hint, /clipy speech install/);
    assert.equal(byName("local capture").status, "warn");
    assert.ok(checks.every((c) => c.status !== "fail"));

    t = env(fakeDeps({ loadConfig: () => { throw new Error("The config file /x is not valid JSON at line 1, column 2."); } }));
    assert.equal(await local.cmdLocalStatus(false, t.env, { installed: true, entry: "/engine/sherpa-onnx.js", source: "clipy", dir: "/engine", version: "2.0.1" }), 0);
    assert.match(t.io.out, /WARN  local config/);
  });
});

// ---- Review fixes: nothing recorded is lost, and nothing is overwritten ----

describe("a take is prepared before anything is recorded (H1)", () => {
  it("a broken config fails before the capture starts, and leaves no folder", async () => {
    const started = [];
    const dir = join(tempDir(), "never");
    const { io, env: e } = env(
      fakeDeps({
        loadConfig: () => {
          throw new Error("OpenRouter needs an API key. Set CLIPY_MODEL_API_KEY.");
        },
        startCapture: fakeCapture(started),
      }),
    );
    assert.equal(await local.localCaptureRecord({ mic: false, out: dir, json: true }, e), 1);
    assert.deepEqual(started, [], "nothing was recorded");
    assert.match(JSON.parse(io.out).error, /needs an API key/);
    assert.ok(!existsSync(dir), "no folder is claimed for a take that cannot run");
  });

  it("a missing ffmpeg fails before the capture starts", async () => {
    const saved = process.env.CLIPY_FFMPEG;
    delete process.env.CLIPY_FFMPEG;
    try {
      const started = [];
      const { io, env: e } = env(
        fakeDeps({ checkCapture: async () => ({ ok: false, ffmpeg: null, problems: ["ffmpeg was not found on PATH"], hints: [] }), startCapture: fakeCapture(started) }),
      );
      assert.equal(await local.localCaptureRecord({ mic: false, out: join(tempDir(), "x"), json: false }, e), 1);
      assert.deepEqual(started, []);
      assert.match(io.err, /ffmpeg was not found/);
    } finally {
      process.env.CLIPY_FFMPEG = saved;
    }
  });

  it("a pipeline failure after the capture keeps the video in the take folder", async () => {
    // The recorder left its file outside the folder (a browser's temp dir).
    const tmp = tempDir("clipy-capture-");
    const captured = join(tmp, "capture.mp4");
    copyFileSync(video, captured);
    const { env: e } = env();
    const prepared = await local.prepareLocalTake({ out: join(tempDir(), "take") }, e);
    // An ffmpeg that cannot run: the MP4 is moved in (no conversion needed),
    // then reading its duration fails.
    prepared.ffmpeg = "/bin/false";
    await assert.rejects(
      local.runLocalTake({ videoPath: captured, moveVideo: true, prepared, origin: { kind: "capture" }, json: true }, e),
      (error) => {
        assert.ok(error instanceof local.LocalTakeError);
        assert.equal(error.keptPath, join(prepared.dir, "recording.mp4"));
        assert.match(error.message, /The capture was kept at .*recording\.mp4/);
        return true;
      },
    );
    assert.ok(existsSync(join(prepared.dir, "recording.mp4")));
  });

  it("a capture that never reached the folder is moved into it on failure", async () => {
    const tmp = tempDir("clipy-capture-");
    const captured = join(tmp, "capture.webm");
    copyFileSync(video, captured);
    const { env: e } = env();
    const prepared = await local.prepareLocalTake({ out: join(tempDir(), "take") }, e);
    prepared.ffmpeg = "/bin/false"; // a WebM needs ffmpeg to become recording.mp4, and that fails
    const error = await local
      .runLocalTake({ videoPath: captured, moveVideo: true, prepared, origin: { kind: "capture" }, json: true }, e)
      .catch((err) => err);
    assert.ok(error instanceof local.LocalTakeError, String(error));
    assert.equal(error.keptPath, join(prepared.dir, "recording.webm"));
    assert.ok(existsSync(join(prepared.dir, "recording.webm")));
    assert.ok(!existsSync(captured), "moved, not copied");
  });

  it("printLocalError reports where the capture was kept in --json", () => {
    const io = captureIo();
    local.printLocalError(new local.LocalTakeError("frames failed", "/tmp/take/recording.mp4"), true, io);
    assert.deepEqual(JSON.parse(io.out), { ok: false, local: true, error: "frames failed", keptVideo: "/tmp/take/recording.mp4" });
    assert.match(io.err, /The capture was kept at \/tmp\/take\/recording\.mp4/);
  });
});

describe("output folders (M5, L3, L10)", () => {
  it("refuses a non-empty --out, and --force clears only the previous take's files", async () => {
    const { env: e } = env();
    const dir = join(tempDir(), "out");
    mkdirSync(join(dir, "frames"), { recursive: true });
    writeFileSync(join(dir, "frames", "000000999999.jpg"), "stale");
    writeFileSync(join(dir, "recording.arec"), "old");
    writeFileSync(join(dir, "transcript.json"), "{}");
    writeFileSync(join(dir, "notes.txt"), "mine");
    await assert.rejects(local.claimOutDir(dir, e), (error) => error instanceof local.UsageError && /not empty.*--force/.test(error.message));
    assert.ok(existsSync(join(dir, "recording.arec")), "nothing is touched without --force");
    assert.equal(await local.claimOutDir(dir, e, { force: true }), dir);
    assert.ok(!existsSync(join(dir, "frames")));
    assert.ok(!existsSync(join(dir, "recording.arec")));
    assert.ok(!existsSync(join(dir, "transcript.json")));
    assert.ok(existsSync(join(dir, "notes.txt")), "files that are not part of a take stay");
  });

  it("record --local into a non-empty --out exits 2 before recording", async () => {
    const dir = tempDir("clipy-out-");
    writeFileSync(join(dir, "recording.mp4"), "previous take");
    const started = [];
    const { io, env: e } = env(fakeDeps({ startCapture: fakeCapture(started) }));
    assert.equal(await local.localCaptureRecord({ mic: false, out: dir, json: false }, e), 2);
    assert.deepEqual(started, []);
    assert.equal(readFileSync(join(dir, "recording.mp4"), "utf8"), "previous take");
    assert.match(io.err, /not empty/);
  });

  it("runLocalTake refuses to overwrite an earlier import unless forced", async () => {
    const dir = join(tempDir(), "imp");
    const take = (force) =>
      local.runLocalTake(
        {
          videoPath: video,
          out: dir,
          force,
          transcript: { segments: [{ startMs: 0, endMs: 1_000, text: "Hello" }], label: "caption file demo.vtt" },
          origin: { kind: "import", fileName: "demo.mp4" },
          json: true,
        },
        env().env,
      );
    await take(false);
    writeFileSync(join(dir, "frames", "000000999999.jpg"), "stale");
    await assert.rejects(take(false), (error) => error instanceof local.UsageError);
    await take(true);
    assert.ok(!existsSync(join(dir, "frames", "000000999999.jpg")), "--force leaves no stale frames");
  });

  it("never deletes the input it is importing, even with --force (Codex P1)", async () => {
    const dir = join(tempDir(), "take");
    mkdirSync(dir, { recursive: true });
    const input = join(dir, "recording.mp4");
    writeFileSync(input, readFileSync(video));
    for (const force of [false, true]) {
      await assert.rejects(
        local.runLocalTake(
          {
            videoPath: input,
            out: dir,
            force,
            transcript: { segments: [{ startMs: 0, endMs: 1_000, text: "Hello" }], label: "caption file demo.vtt" },
            origin: { kind: "import", fileName: "recording.mp4" },
            json: true,
          },
          env().env,
        ),
        (error) => error instanceof local.UsageError && /contains the input/.test(error.message),
      );
      assert.ok(existsSync(input), `the input survives (force=${force})`);
    }
    const { env: e } = env();
    await assert.rejects(
      local.claimOutDir(dirname(dir), e, { force: true, inputs: [input] }),
      (error) => error instanceof local.UsageError,
      "an input in a subfolder of --out is protected too",
    );
    assert.ok(existsSync(input));
  });

  it("creates take folders readable by their owner only", async () => {
    const { env: e } = env();
    const explicit = await local.claimOutDir(join(tempDir(), "a", "b"), e);
    assert.equal(statSync(explicit).mode & 0o777, 0o700);
    const home = tempDir("clipy-local-home-");
    const dated = await local.claimOutDir(undefined, { now: () => new Date(2026, 10, 18, 9, 5, 7), home });
    assert.equal(statSync(dated).mode & 0o777, 0o700);
  });

  it("two takes started in the same second claim different default folders", async () => {
    const home = tempDir("clipy-local-home-");
    const at = { now: () => new Date(2026, 10, 18, 9, 5, 7), home };
    const dirs = await Promise.all([local.claimOutDir(undefined, at), local.claimOutDir(undefined, at), local.claimOutDir(undefined, at)]);
    assert.equal(new Set(dirs).size, 3, dirs.join(", "));
    const base = join(home, "clipy", "recordings", "2026-11-18-090507");
    assert.deepEqual([...dirs].sort(), [base, `${base}-2`, `${base}-3`]);
  });
});

describe("stopping a recording (H2)", () => {
  it("warns when stdin is not a terminal and there is no --max", async () => {
    const { io, env: e } = env(fakeDeps({ startCapture: fakeCapture([]) }));
    io.stdinIsTTY = false;
    assert.equal(await local.localCaptureRecord({ mic: false, out: join(tempDir(), "r"), json: false }, e), 0, io.err);
    assert.match(io.err, /stdin is not a terminal.*stops when stdin closes or on Ctrl-C, SIGTERM or SIGHUP/);
    const quiet = env(fakeDeps({ startCapture: fakeCapture([]) }));
    quiet.io.stdinIsTTY = false;
    assert.equal(await local.localCaptureRecord({ mic: false, maxSeconds: 5, out: join(tempDir(), "r"), json: false }, quiet.env), 0);
    assert.ok(!/stdin is not a terminal/.test(quiet.io.err), "--max bounds the take, so no warning");
  });

  it("processIo stops on SIGTERM and SIGHUP like Ctrl-C", async () => {
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
      const io = local.processIo();
      const stopped = io.waitForStop(60_000);
      process.emit(signal, signal);
      assert.equal(await stopped, "user", signal);
      assert.equal(process.listenerCount(signal), 0, `${signal} handler removed`);
    }
    process.stdin.pause();
  });

  it("onInterrupt fires on SIGTERM and SIGHUP too", () => {
    const io = local.processIo();
    const seen = [];
    const dispose = io.onInterrupt(() => seen.push("x"));
    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGHUP", "SIGHUP");
    process.emit("SIGINT", "SIGINT");
    dispose();
    assert.equal(seen.length, 3);
    for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) assert.equal(process.listenerCount(sig), 0);
  });
});

describe("provider keys (M4)", () => {
  it("reads --model-key - from stdin and records literal keys for the note", async () => {
    const fromStdin = await local.resolveKeyFlags({ modelKey: "-" }, async () => "sk-or-FROMSTDIN\n");
    assert.deepEqual(fromStdin, { modelKey: "sk-or-FROMSTDIN", literal: [] });
    const literal = await local.resolveKeyFlags({ modelKey: "sk-or-x", transcribeKey: "-" }, async () => "  dg-key  \r\nignored\n");
    assert.deepEqual(literal, { modelKey: "sk-or-x", transcribeKey: "dg-key", literal: ["--model-key"] });
    await assert.rejects(local.resolveKeyFlags({ modelKey: "-", transcribeKey: "-" }, async () => "k"), local.UsageError);
    await assert.rejects(local.resolveKeyFlags({ transcribeKey: "-" }, async () => "\n"), /stdin was empty/);
    assert.match(local.LITERAL_KEY_NOTE, /CLIPY_MODEL_API_KEY/);
    assert.ok(!local.LITERAL_KEY_NOTE.includes("—"));
  });
});

describe("models (L6, L7)", () => {
  it("lists each model's licence, from the model table or the fallback", async () => {
    let t = env();
    assert.equal(await local.cmdModels(["list"], true, t.env), 0);
    const listed = JSON.parse(t.io.out);
    assert.deepEqual(listed.models.map((m) => m.license), ["CC-BY-4.0", "MIT"]);
    assert.match(listed.models[0].attribution, /NVIDIA Parakeet TDT-CTC 110M/);
    assert.match(listed.runtime, /sherpa-onnx \(Apache-2\.0\)/);
    t = env(fakeDeps({ modelInfo: (m) => ({ label: m, sizeBytes: 1, license: "Custom-1.0", attribution: "From the table" }) }));
    assert.equal(await local.cmdModels(["list"], false, t.env), 0);
    assert.match(t.io.out, /english-fast\tinstalled\tenglish-fast\tCustom-1\.0\t/);
  });

  it("passes an abort signal to the download and aborts it on Ctrl-C or SIGTERM", async () => {
    let interrupt = () => {};
    const deps = fakeDeps({
      downloadModel: (_model, options) =>
        new Promise((_resolve, reject) => {
          assert.ok(options.signal instanceof AbortSignal);
          options.signal.addEventListener("abort", () => reject(options.signal.reason));
          setTimeout(() => interrupt(), 10);
        }),
    });
    const t = env(deps);
    t.io.onInterrupt = (fn) => {
      interrupt = fn;
      return () => {
        interrupt = () => {};
      };
    };
    assert.equal(await local.cmdModels(["download", "multilingual"], false, t.env), 1);
    assert.match(t.io.err, /Download cancelled/);
  });
});

describe("a cancelled conversion keeps the original capture (Codex P1)", () => {
  // A stand-in ffmpeg that writes part of its output file, then stalls the
  // way a long remux does, so the test can cancel it part-way.
  function stallingFfmpeg() {
    const dir = tempDir("clipy-fake-ffmpeg-");
    const bin = join(dir, "ffmpeg");
    writeFileSync(bin, '#!/bin/sh\nfor last; do :; done\nprintf partial > "$last"\nexec sleep 30\n');
    chmodSync(bin, 0o755);
    return bin;
  }

  it("leaves no partial recording.mp4 and keeps the WebM when cancelled", async () => {
    const work = tempDir("clipy-cancel-");
    const source = join(work, "capture.webm");
    writeFileSync(source, "the whole capture");
    const dir = join(work, "take");
    mkdirSync(dir);
    const target = join(dir, "recording.mp4");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(media.placeVideo(stallingFfmpeg(), source, target, { move: true, signal: controller.signal }));
    assert.ok(!existsSync(target), "no partial recording.mp4");
    assert.ok(!existsSync(`${target}.tmp`), "the temporary file is cleaned up");
    assert.equal(readFileSync(source, "utf8"), "the whole capture", "the source is untouched");

    const kept = await local.keepCapture(source, dir, true);
    assert.equal(kept, join(dir, "recording.webm"));
    assert.equal(readFileSync(kept, "utf8"), "the whole capture");
  });

  it("keepCapture prefers the intact source over a recording.mp4 already in the folder", async () => {
    const work = tempDir("clipy-keep-");
    const source = join(work, "capture.webm");
    writeFileSync(source, "intact");
    const dir = join(work, "take");
    mkdirSync(dir);
    writeFileSync(join(dir, "recording.mp4"), "partial");
    assert.equal(await local.keepCapture(source, dir, true), join(dir, "recording.webm"));
  });
});
