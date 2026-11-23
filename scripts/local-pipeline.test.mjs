#!/usr/bin/env node
// The local pipeline (dist/local/pipeline.js) end to end on generated MP4s:
// folder layout, frames, AREC validity, moments (rules, model, fallback,
// narration), the flare frame of the synthetic sample, and failure paths. Ported from the
// local edition's own CLI tests.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  RULES_ONLY,
  decodedSize,
  fakeProvider,
  fakeTranscribe,
  fixtureAvailable,
  keyMomentsJson,
  linkTargets,
  loadFixture,
  makeVideo,
  readJson,
  readText,
  tempDir,
  validateStrict,
  validatorAvailable,
} from "./local-test-helpers.mjs";

const { momentInteractions, processRecording, narrationSegments, narrationMoments, dataBoundary, boundedSegments } = await import(resolve("dist/local/pipeline.js"));
const { renderLocalArec } = await import(resolve("dist/local/arec.js"));

let videos;
let short;
let long;
let silent;
const servers = [];

before(() => {
  videos = tempDir("clipy-local-videos-");
  short = makeVideo(videos, 6);
  long = makeVideo(videos, 27);
  silent = makeVideo(videos, 4, "silent.mp4", { audio: false });
});
after(async () => {
  for (const close of servers) await close();
});

/** Two clicks with some pointer travel, in a 640x360 capture. */
function clickSession() {
  const events = [];
  for (let t = 0; t < 6000; t += 50) events.push({ kind: "move", time_ms: t, x: 100 + t / 30, y: 120 });
  events.push({ kind: "down", time_ms: 2_500, x: 183, y: 120, button: 0 });
  events.push({ kind: "up", time_ms: 2_560, x: 183, y: 120, button: 0 });
  events.push({ kind: "down", time_ms: 4_200, x: 240, y: 120, button: 0 });
  events.push({ kind: "up", time_ms: 4_260, x: 240, y: 120, button: 0 });
  return events.sort((a, b) => a.time_ms - b.time_ms);
}

const GEOMETRY = { x: 0, y: 0, width: 640, height: 360, output_width: 640, output_height: 360 };
const takeDir = () => join(tempDir(), "take");

describe("processRecording end to end", () => {
  it("writes the local folder layout with decodable frames and a valid AREC", async () => {
    const dir = takeDir();
    const { transcribe, calls } = fakeTranscribe();
    const stages = [];
    const result = await processRecording({
      dir,
      videoPath: short,
      interactions: clickSession(),
      geometry: GEOMETRY,
      durationMs: 6_000,
      deps: { transcribe },
      config: RULES_ONLY,
      compiler: "clipy 0.0.0-test --local",
      onStatus: (s) => stages.push(s.stage),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, join(dir, "recording.mp4"));
    assert.deepEqual(stages, ["transcribing", "selecting", "extracting", "ready"]);
    assert.equal(result.arecPath, join(dir, "recording.arec"));
    assert.equal(result.planner, "rules");
    for (const file of ["recording.mp4", "recording.cursor.json", "transcript.json", "moments.json", "frames.json", "metadata.json", "status.json", "recording.arec"]) {
      assert.ok(existsSync(join(dir, file)), file);
    }
    assert.ok(existsSync(short), "the source video is copied, not moved");
    assert.equal(readJson(dir, "status.json").stage, "ready");
    const transcript = readJson(dir, "transcript.json");
    assert.equal(transcript.engine, "fake-engine");
    assert.equal(transcript.segments.length, 2);
    const sidecar = readJson(dir, "recording.cursor.json");
    assert.equal(sidecar.events.length, clickSession().length);
    assert.deepEqual(sidecar.capture, GEOMETRY);
    const metadata = readJson(dir, "metadata.json");
    assert.equal(metadata.recording_id, "take");
    assert.equal(metadata.duration_ms, 6_000);
    assert.equal(metadata.edition, "clipy-cli");
    assert.equal(metadata.mode, "local");
    assert.equal(metadata.planner.used, "rules");

    const moments = readJson(dir, "moments.json");
    assert.ok(moments.some((m) => m.source === "click"));
    const frames = readJson(dir, "frames.json");
    assert.equal(frames.length, moments.length);
    assert.equal(result.frames, frames.length);
    for (const frame of frames) {
      assert.match(frame.frame, /^frames\/\d{12}\.jpg$/);
      assert.equal(decodedSize(join(dir, frame.frame)).width, 640);
    }

    const arec = readText(dir, "recording.arec");
    assert.ok(arec.startsWith("<!-- arec\nspec_version: 1.4\nprofile: recording\n-->"));
    for (const heading of ["## Metadata", "## Evidence boundaries", "## How to use this recording", "## Capture gaps", "## Key moments", "## Interactions", "## Transcript", "## Share it"]) {
      assert.ok(arec.includes(heading), heading);
    }
    assert.ok(arec.includes("- Status: Complete"));
    assert.ok(arec.includes("- Compiler: clipy 0.0.0-test --local"));
    assert.match(arec, /- Moment: \d+ ms; frame requested at \d+ ms; extracted frame: \d{2}:\d{2}:\d{2}\.\d{3} \(\d+ ms\)\./);
    assert.ok(arec.includes("> [00:00:02.400] (2400 to 4800 ms) I click this button and it breaks."));
    assert.ok(arec.includes("Run: clipy upload recording.mp4"), "the share hint names clipy upload");
    assert.ok(arec.includes("https://clipy.online"));
    assert.ok(arec.includes("Nothing is sent to Clipy."));
    assert.ok(!arec.includes("—"), "no em dashes");
    const targets = linkTargets(arec);
    for (const t of ["recording.mp4", "transcript.json", "recording.cursor.json", "metadata.json"]) assert.ok(targets.includes(t), t);
    for (const target of targets) {
      assert.ok(!(target.startsWith("/") || /^[a-z]+:/i.test(target)), target);
      assert.ok(existsSync(join(dir, target)), target);
    }
    for (const moment of keyMomentsJson(arec)) {
      assert.ok(existsSync(join(dir, String(moment.frame_url))));
      assert.equal(typeof moment.caption, "string");
    }
  });

  it("passes the reference AREC validator in strict mode", { skip: !validatorAvailable && "validator not in this checkout" }, async () => {
    const dir = takeDir();
    await processRecording({ dir, videoPath: short, interactions: clickSession(), geometry: GEOMETRY, deps: { transcribe: fakeTranscribe().transcribe }, config: RULES_ONLY });
    const check = await validateStrict(readText(dir, "recording.arec"));
    assert.deepEqual(check.errors, []);
    assert.equal(check.ok, true);
    assert.equal(check.legacy, false);
    assert.deepEqual(check.warnings, []);
    assert.ok(check.counts.keyMoments > 0);
  });

  it("probes the duration with ffmpeg when the caller does not give one", async () => {
    const result = await processRecording({ dir: takeDir(), videoPath: short, deps: { transcribe: fakeTranscribe().transcribe }, config: RULES_ONLY });
    assert.ok(Math.abs(result.durationMs - 6_000) < 100);
  });
});

describe("moment selection", () => {
  it("says spoken references were not selected when no provider is configured", async () => {
    const dir = takeDir();
    const result = await processRecording({ dir, videoPath: short, interactions: clickSession(), geometry: GEOMETRY, durationMs: 6_000, deps: { transcribe: fakeTranscribe().transcribe }, config: RULES_ONLY });
    assert.equal(result.planner, "rules");
    assert.equal(result.modelFallback, null);
    const arec = readText(dir, "recording.arec");
    assert.ok(arec.includes("Moment selection: rules on this machine"));
    assert.ok(arec.includes("Spoken references were not selected: no model provider is configured. Run clipy local setup --model-provider"));
    assert.ok(!keyMomentsJson(arec).some((m) => m.source === "deixis"));
  });

  it("adds the model's spoken references when a provider answers", async () => {
    const provider = await fakeProvider(() => ({
      status: 200,
      json: { choices: [{ message: { content: JSON.stringify({ moments: [{ timestamp_ms: 2_400, reason: "Points at the button that breaks" }] }) } }] },
    }));
    servers.push(provider.close);
    const dir = takeDir();
    const result = await processRecording({
      dir, videoPath: short, durationMs: 6_000,
      deps: { transcribe: fakeTranscribe().transcribe },
      config: { model: { baseUrl: provider.baseUrl, apiKey: "k", model: "test/model" }, transcription: RULES_ONLY.transcription },
    });
    assert.equal(provider.seen.length, 1);
    assert.equal(result.planner, "rules+model");
    const arec = readText(dir, "recording.arec");
    const moments = keyMomentsJson(arec);
    assert.equal(moments.length, 1);
    assert.equal(moments[0].t_ms, 2_400);
    assert.equal(moments[0].source, "deixis");
    assert.equal(moments[0].caption, "Points at the button that breaks");
    assert.ok(arec.includes("plus test/model at 127.0.0.1"));
    assert.ok(arec.includes("read by a model running on this machine"));
  });

  it("falls back to rules and says so when the model call fails", async () => {
    const provider = await fakeProvider(() => ({ status: 400, json: { error: "bad request" } }));
    servers.push(provider.close);
    const dir = takeDir();
    const result = await processRecording({
      dir, videoPath: short, interactions: clickSession(), geometry: GEOMETRY, durationMs: 6_000,
      deps: { transcribe: fakeTranscribe().transcribe },
      config: { model: { baseUrl: provider.baseUrl, model: "test/model" }, transcription: RULES_ONLY.transcription },
    });
    assert.equal(result.planner, "rules");
    assert.equal(result.modelFallback, "provider_error");
    assert.match(result.warnings.join(" "), /moments come from rules only/);
    assert.equal(readJson(dir, "status.json").stage, "ready");
    const arec = readText(dir, "recording.arec");
    assert.ok(arec.includes("failed (provider_error), so moments come from rules only and spoken references were not selected"));
    assert.ok(keyMomentsJson(arec).some((m) => m.source === "click"));
  });

  it("takes labeled overview frames when the plan is empty", async () => {
    const dir = takeDir();
    const result = await processRecording({ dir, videoPath: short, interactions: null, durationMs: 6_000, deps: { transcribe: fakeTranscribe({ segments: [] }).transcribe }, config: RULES_ONLY });
    assert.equal(result.frames, 3);
    const frames = readJson(dir, "frames.json");
    assert.deepEqual(frames.map((f) => f.frameAtMs), [0, 3_000, 5_750]);
    assert.ok(frames.every((f) => f.overview));
    for (const f of frames) decodedSize(join(dir, f.frame));
    const arec = readText(dir, "recording.arec");
    assert.ok(arec.includes("Overview sample; not a selected key moment or a visual interpretation"));
    assert.ok(!arec.includes("Evidence: Flare"));
    assert.ok(arec.includes("Interaction sidecar absent. This is a capture gap"));
    assert.ok(arec.includes("No recognized speech."));
    assert.ok(!existsSync(join(dir, "recording.cursor.json")));
    for (const moment of keyMomentsJson(arec)) {
      assert.equal(moment.overview, true);
      assert.equal(moment.source, undefined);
    }
  });

  it("frames the hold-to-highlight flare of the synthetic sample at 22633 ms", { skip: !fixtureAvailable && "fixture not in this checkout" }, async () => {
    const fixture = loadFixture();
    const dir = takeDir();
    const result = await processRecording({
      dir,
      videoPath: long,
      interactions: fixture.events,
      clickElements: fixture.click_elements,
      geometry: fixture.capture,
      durationMs: fixture.durationMs,
      deps: { transcribe: fakeTranscribe({ segments: fixture.transcript }).transcribe },
      config: RULES_ONLY,
    });
    assert.equal(result.planner, "rules");
    const frames = readJson(dir, "frames.json");
    const flare = frames.find((f) => f.source === "flare");
    assert.ok(flare, "a flare frame");
    assert.equal(flare.timestampMs, 20_223);
    assert.equal(flare.frameAtMs, 22_633);
    assert.equal(flare.frame, "frames/000000020223.jpg");
    assert.ok(Math.abs(flare.x - 367 / 1512) < 0.001);
    assert.ok(statSync(join(dir, flare.frame)).size > 0);
    decodedSize(join(dir, flare.frame));
    const arec = readText(dir, "recording.arec");
    assert.ok(arec.includes("### 00:00:20.223"));
    assert.ok(arec.includes("frame requested at 22633 ms; extracted frame: 00:00:22.633 (22633 ms)."));
    assert.ok(arec.includes("Evidence: Flare highlight"));
    const km = keyMomentsJson(arec).find((m) => m.source === "flare");
    assert.equal(km.t_ms, 20_223);
    assert.equal(km.frame_at_ms, 22_633);
    assert.equal(km.frame_url, "frames/000000020223.jpg");
    if (validatorAvailable) assert.deepEqual((await validateStrict(arec)).errors, []);
  });
});

describe("narration (notes, marks, captions)", () => {
  it("adds notes to the transcript and gives each its own moment and frame", async () => {
    const dir = takeDir();
    const { transcribe } = fakeTranscribe();
    const result = await processRecording({
      dir, videoPath: short, durationMs: 6_000, deps: { transcribe }, config: RULES_ONLY,
      narration: [{ startMs: 1_000, text: "Opened settings" }, { startMs: 3_500, text: "Save button stays grey", frameAtMs: 3_700 }],
    });
    const transcript = readJson(dir, "transcript.json");
    assert.equal(transcript.engine, "fake-engine plus narration notes");
    assert.ok(transcript.segments.some((s) => s.text === "Narration: Opened settings" && s.startMs === 1_000));
    const moments = readJson(dir, "moments.json").filter((m) => m.source === "narration");
    assert.deepEqual(moments.map((m) => [m.timestamp_ms, m.frame_at_ms]), [[1_000, 1_000], [3_500, 3_700]]);
    assert.equal(result.frames, 2);
    const arec = readText(dir, "recording.arec");
    const km = keyMomentsJson(arec);
    assert.ok(km.every((m) => m.source === "narration"));
    assert.ok(arec.includes("Evidence: Narration mark"));
    if (validatorAvailable) {
      const check = await validateStrict(arec);
      assert.deepEqual(check.errors, []);
      assert.deepEqual(check.warnings, []);
    }
  });

  it("skips transcription for a capture with no audio track and keeps the notes", async () => {
    const dir = takeDir();
    const { transcribe, calls } = fakeTranscribe();
    const result = await processRecording({ dir, videoPath: silent, deps: { transcribe }, config: RULES_ONLY, narration: [{ startMs: 500, text: "Page loaded" }] });
    assert.equal(calls.length, 0, "nothing to transcribe");
    assert.equal(result.transcriptEngine, "narration notes");
    const arec = readText(dir, "recording.arec");
    assert.ok(arec.includes("- Status: Complete"));
    assert.ok(arec.includes("The recording has no audio track"));
    assert.ok(!arec.includes("No recognized speech"), "silence is a fact here, not a gap");
  });

  it("splits notes into segments and drops a note at an instant a planned moment covers", () => {
    const segs = narrationSegments([{ startMs: 0, text: "a" }, { startMs: 1_000, text: "b" }, { startMs: 9_000, text: " " }], 10_000);
    assert.deepEqual(segs, [
      { startMs: 0, endMs: 1_000, text: "Narration: a" },
      { startMs: 1_000, endMs: 6_000, text: "Narration: b" },
    ]);
    const moments = narrationMoments([{ startMs: 2_000, text: "dup" }, { startMs: 3_000, text: "new" }], [{ timestamp_ms: 2_000, frame_at_ms: 2_000, reason: "click" }], 10_000);
    assert.deepEqual(moments.map((m) => m.timestamp_ms), [3_000]);
  });
});

describe("failures and gaps", () => {
  it("keeps going without a transcript when transcription fails, and marks the AREC partial", async () => {
    const dir = takeDir();
    const result = await processRecording({
      dir, videoPath: short, interactions: clickSession(), geometry: GEOMETRY, durationMs: 6_000,
      deps: { transcribe: async () => { throw new Error("model files missing"); } },
      config: RULES_ONLY,
    });
    assert.equal(result.transcriptSegments, 0);
    assert.ok(result.frames > 0);
    const arec = readText(dir, "recording.arec");
    assert.ok(arec.includes("- Status: Partial: transcription failed"));
    assert.ok(arec.includes("Transcription failed (model files missing)"));
  });

  it("discloses audio sent to a remote transcriber even when it then fails (Codex P2)", async () => {
    const dir = takeDir();
    await processRecording({
      dir, videoPath: short, interactions: clickSession(), geometry: GEOMETRY, durationMs: 6_000,
      deps: { transcribe: async () => { throw new Error("provider answered 500"); } },
      config: { model: null, transcription: { kind: "deepgram", apiKey: "k" } },
    });
    const arec = readText(dir, "recording.arec");
    assert.ok(arec.includes("The audio was sent to deepgram for transcription."));
    assert.ok(!arec.includes("Nothing left this machine."));
    assert.ok(!arec.includes("The audio stays on this machine."));
  });

  it("discloses a model request that was cancelled mid-flight (Codex P2)", async () => {
    const dir = takeDir();
    const controller = new AbortController();
    const provider = { baseUrl: "https://models.example.test/v1", model: "m", apiKey: "k" };
    await assert.rejects(processRecording({
      dir, videoPath: short, interactions: clickSession(), geometry: GEOMETRY, durationMs: 6_000,
      signal: controller.signal,
      deps: { transcribe: async () => ({ segments: [{ startMs: 0, endMs: 2_000, text: "Look at this button" }], engine: "fake", gaps: [] }) },
      config: { model: provider, transcription: { kind: "local", model: "english-fast" } },
      onStatus: (s) => { if (s.stage === "selecting") controller.abort(); },
    }));
    const arec = readText(dir, "recording.arec");
    assert.ok(arec.includes("were sent to models.example.test"), "the transcript left for the model before the cancel");
    assert.ok(!arec.includes("Nothing left this machine."));
  });

  it("does not call a transcriber when transcription is off", async () => {
    const dir = takeDir();
    const { transcribe, calls } = fakeTranscribe();
    await processRecording({ dir, videoPath: short, durationMs: 6_000, deps: { transcribe }, config: { model: null, transcription: { kind: "none" } } });
    assert.equal(calls.length, 0);
    assert.ok(readText(dir, "recording.arec").includes("Transcription is turned off"));
  });

  it("writes a failed status and AREC when the video cannot be read", async () => {
    const dir = takeDir();
    await assert.rejects(processRecording({ dir, videoPath: join(videos, "missing.mp4"), deps: { transcribe: fakeTranscribe().transcribe }, config: RULES_ONLY }));
    assert.equal(readJson(dir, "status.json").stage, "failed");
    assert.ok(readText(dir, "recording.arec").includes("- Status: Failed:"));
  });

  it("stops when cancelled", async () => {
    const dir = takeDir();
    const controller = new AbortController();
    await assert.rejects(
      processRecording({
        dir, videoPath: short, durationMs: 6_000, config: RULES_ONLY, signal: controller.signal,
        deps: { transcribe: async () => { controller.abort(new Error("Cancelled")); throw new Error("aborted"); } },
      }),
      /Cancelled/,
    );
    assert.equal(readJson(dir, "status.json").stage, "failed");
  });
});

describe("boundedSegments (Codex P2)", () => {
  it("splits a segment over the planner limit instead of dropping text", () => {
    const words = Array.from({ length: 5_000 }, (_, i) => `word${i}`).join(" ");
    const out = boundedSegments([{ startMs: 1_000, endMs: 61_000, text: words }], 120_000);
    assert.ok(out.length > 1);
    assert.ok(out.every((s) => s.text.length <= 10_000));
    assert.equal(out.map((s) => s.text).join(" "), words, "every word survives, in order");
    assert.equal(out[0].startMs, 1_000);
    assert.equal(out.at(-1).endMs, 61_000);
    for (let i = 1; i < out.length; i++) assert.ok(out[i].startMs >= out[i - 1].startMs);
  });

  it("keeps short segments as they are", () => {
    assert.deepEqual(boundedSegments([{ startMs: 0, endMs: 500, text: "hi" }], 1_000), [{ startMs: 0, endMs: 500, text: "hi" }]);
  });
});

describe("momentInteractions", () => {
  it("keeps every button and key event and strides moves into the 8000-event budget", () => {
    const events = [];
    for (let i = 0; i < 20_000; i++) events.push({ kind: "move", time_ms: i, x: i % 500, y: 10 });
    for (let i = 0; i < 3_000; i++) events.push({ kind: "scroll", time_ms: i + 0.5, delta_y: 1 });
    for (let i = 0; i < 50; i++) events.push({ kind: "down", time_ms: i * 100 + 0.25, x: 1, y: 1, button: 0 });
    events.push({ kind: "key_down", time_ms: 30, key_code: 59 }, { kind: "key_up", time_ms: 900, key_code: 59 });
    const out = momentInteractions(events);
    assert.ok(out.length <= 8000 && out.length > 6000);
    assert.equal(momentInteractions(events.slice(0, 7000)).length, 7000);
    assert.equal(out.filter((e) => e.kind === "down").length, 50);
    assert.equal(out.filter((e) => e.kind === "key_down" || e.kind === "key_up").length, 2);
    assert.ok(out.filter((e) => e.kind === "scroll").length <= 3_000);
    for (let i = 1; i < out.length; i++) assert.ok(out[i].time_ms >= out[i - 1].time_ms);
  });

  it("drops fields the planner does not accept", () => {
    assert.deepEqual(momentInteractions([{ kind: "move", time_ms: 1, x: 2, y: 3, cursor_type: "cursor" }]), [{ kind: "move", time_ms: 1, x: 2, y: 3 }]);
  });
});

describe("what the AREC says about data (L9)", () => {
  const remote = { model: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "m" }, transcription: { kind: "local", model: "english-fast" } };
  const remoteAudio = { model: null, transcription: { kind: "deepgram", apiKey: "k" } };

  it("with no provider, nothing leaves", () => {
    const text = dataBoundary(RULES_ONLY, { audioSent: true, modelCalled: false });
    assert.match(text, /Nothing left this machine\./);
    assert.match(text, /The audio stays on this machine\./);
    assert.match(text, /The interaction evidence stays on this machine\./);
  });

  it("with a model provider, names exactly what went to it and never claims the interactions stayed", () => {
    const text = dataBoundary(remote, { audioSent: true, modelCalled: true });
    assert.match(text, /The transcript text, click labels, a bounded sample of pointer and key events, and the capture area were sent to openrouter\.ai/);
    assert.ok(!/interaction (sidecar|evidence) stays?/i.test(text), text);
    assert.ok(!/Nothing left this machine/.test(text), text);
    assert.match(text, /video and screenshots stay on this machine/);
  });

  it("with a transcription key, the audio goes to that provider", () => {
    const text = dataBoundary(remoteAudio, { audioSent: true, modelCalled: false });
    assert.match(text, /The audio was sent to deepgram for transcription\./);
    assert.ok(!/Nothing left this machine/.test(text), text);
  });

  it("counts interaction events and clicks with the right plural, and has no em dashes", () => {
    const base = {
      title: "t", recordingId: "r", state: "complete", statusText: "Complete", createdAt: "2026-11-18T00:00:00.000Z", durationMs: 1000,
      origin: { kind: "capture" }, transcript: { ready: true, segments: [], engineLabel: "none", gaps: [] }, planner: null, frames: [],
      dataBoundary: dataBoundary(RULES_ONLY, { audioSent: false, modelCalled: false }), captureGaps: [],
    };
    const one = renderLocalArec({ ...base, interactions: { captured: true, eventCount: 1, clicks: [{ time_ms: 5, x: 1, y: 1, button: 0 }] } });
    assert.ok(one.includes("recording.cursor.json), 1 event\n"), "1 event, not 1 events");
    assert.ok(one.includes("1 click (at most the first 200"));
    const many = renderLocalArec({ ...base, interactions: { captured: true, eventCount: 3, clicks: [] } });
    assert.ok(many.includes("3 events"));
    assert.ok(many.includes("0 clicks (at most the first 200"));
    assert.ok(!one.includes("—") && !many.includes("—"));
  });
});
