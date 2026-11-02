#!/usr/bin/env node
// `clipy recheck`: step mapping and route matching on a fixture timeline, a
// run against a scripted driver, the CLI against a mock API, and (when
// Playwright and its Chromium are installed) the real page driver against
// local fixture pages where a control was renamed and another is covered.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../dist/index.js");
const recheck = await import(resolve(here, "../dist/recheck.js"));
const fixture = JSON.parse(readFileSync(join(here, "fixtures/recheck-timeline.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "clipy-recheck-test-"));

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const plan = recheck.buildRecheckPlan(fixture);
assert.equal(plan.truncatedSteps, 0);
assert.deepEqual(
  plan.steps.map((s) => s.kind),
  ["start", "click", "navigate", "type", "click", "navigate", "scroll", "click", "click", "click", "navigate"],
  "pointer moves are skipped, repeat navigations and same-direction scrolls collapse",
);
assert.deepEqual(plan.steps.map((s) => s.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const [start, newProject, , typing, create, , scroll, unlabelled, rightClick, settings] = plan.steps;
assert.equal(start.route, "https://app.example.com/projects");
assert.equal(newProject.label, "New project");
assert.deepEqual(newProject.position, { x: 0.9, y: 0.1 });
assert.equal(newProject.original.frameUrl, "https://cdn.example/frames/2100.jpg", "timeline evidence is kept");
assert.equal(newProject.original.said, "First I click new project.");
assert.equal(create.original.frameUrl, "https://cdn.example/frames/6100.jpg", "a nearby key moment fills missing evidence");
assert.match(typing.unmappable, /typed values are never captured/);
assert.equal(scroll.direction, "down");
assert.match(unlabelled.unmappable, /no element label/);
assert.match(rightClick.unmappable, /secondary-button/);
assert.equal(settings.label, "Settings");
assert.equal(settings.original.said, "Then settings.");
assert.equal(recheck.buildRecheckPlan(fixture, 4).steps.length, 4);
assert.equal(recheck.buildRecheckPlan(fixture, 4).truncatedSteps, 7);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

assert.equal(recheck.routeOf("https://app.example.com/projects/12345678?token=abc#x"), "https://app.example.com/projects/:id");
assert.equal(recheck.routeOf("https://app.example.com/u/a1b2c3d4e5f6"), "https://app.example.com/u/:id");
assert.equal(recheck.routeOf("chrome://settings"), null);
assert.ok(recheck.routeMatches("https://app.example.com/projects/:id", "https://app.example.com/projects/987654", false));
assert.ok(recheck.routeMatches("https://app.example.com/projects/:id?tab", "https://app.example.com/projects/x/", false), "query keys and trailing slash ignored");
assert.ok(!recheck.routeMatches("https://app.example.com/projects/:id", "https://app.example.com/projects", false));
assert.ok(!recheck.routeMatches("https://app.example.com/projects", "http://localhost:3000/projects", false));
assert.ok(recheck.routeMatches("https://app.example.com/projects", "http://localhost:3000/projects", true), "origin ignored when re-checking on another host");
assert.ok(recheck.routeMatches("https://app.example.com", "https://app.example.com/anything/at/all", false, true), "origin-only recordings compare hosts");
assert.ok(!recheck.routeMatches("https://app.example.com", "https://other.example.com/", false, true));
assert.ok(recheck.concreteRoute("https://app.example.com/settings"));
assert.ok(!recheck.concreteRoute("https://app.example.com/projects/:id"));
assert.ok(!recheck.concreteRoute("https://app.example.com/search?q"));
assert.equal(recheck.mapOrigin("https://app.example.com/settings", "http://127.0.0.1:9"), "http://127.0.0.1:9/settings");

// ---------------------------------------------------------------------------
// Run against a scripted driver
// ---------------------------------------------------------------------------

/** A tiny fake app: pages, the controls on each and where a click leads. */
function fakeDriver(app) {
  let url = "";
  const shots = [];
  const clicks = [];
  const opened = [];
  return {
    shots,
    clicks,
    opened,
    async open(next) {
      if (app.unreachable?.includes(next)) throw new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${next}`);
      opened.push(next);
      url = next;
    },
    async url() {
      return url;
    },
    async locate(hint) {
      const page = app[new URL(url).pathname] ?? {};
      if (page.throws) throw new Error(page.throws);
      const named = (page.controls ?? []).filter((c) => c.name.toLowerCase() === hint.label.toLowerCase());
      if (named.length === 0) return { status: "none", nearby: (page.controls ?? []).map((c) => c.name) };
      if (named.length > 1 && hint.x === null) return { status: "ambiguous", candidates: named.length };
      const c = named[0];
      const control = { name: c.name, role: c.role ?? "button", quality: "exact", x: 10, y: 10, candidates: named.length };
      if (c.coveredBy) return { status: "covered", control, coveredBy: c.coveredBy };
      if (c.disabled) return { status: "disabled", control };
      return { status: "found", control };
    },
    async click(x, y) {
      clicks.push([x, y]);
      const page = app[new URL(url).pathname];
      const target = page?.controls?.find((c) => c.to);
      if (target) url = new URL(target.to, url).href;
      if (page?.redirect) url = page.redirect;
    },
    async scroll() {},
    async settle() {},
    async screenshot(path) {
      shots.push(path);
    },
  };
}

let clock = 0;
const fakeTime = { now: () => (clock += 10), sleep: async (ms) => void (clock += ms) };

{
  // Today's app: same flow, but "Settings" was renamed "Preferences".
  const driver = fakeDriver({
    "/projects": { controls: [{ name: "New project", to: "/projects/new" }] },
    "/projects/new": { controls: [{ name: "Create", to: "/projects/12345678" }] },
    "/projects/12345678": { controls: [{ name: "Preferences", role: "link" }] },
  });
  const run = await recheck.runRecheck(plan, driver, {
    startUrl: "http://localhost:3000/projects",
    framesDir: join(work, "fake-frames"),
    navigationTimeoutMs: 1_000,
    ...fakeTime,
  });
  assert.deepEqual(run.originMapping, { from: "https://app.example.com", to: "http://localhost:3000" });
  assert.deepEqual(
    run.steps.map((s) => s.status),
    ["matched", "matched", "matched", "unmapped", "matched", "matched", "replayed", "unmapped", "unmapped", "control_not_found", "different_screen"],
  );
  assert.deepEqual(run.steps[9].observed.nearbyControls, ["Preferences"]);
  assert.match(run.steps[3].reason, /^could not map step: typed values/);
  assert.equal(driver.clicks.length, 2, "only located controls are clicked");
  assert.equal(driver.shots.length, 11, "one frame per step");
  assert.equal(run.steps[1].observed.route, "http://localhost:3000/projects/new");
  const summary = recheck.summarize(run.steps);
  assert.equal(summary.verdict, "diverged");
  assert.equal(summary.firstDivergence, 10);
  assert.equal(summary.matched, 5);
  assert.equal(summary.unmapped, 3);
}

{
  // A click on the wrong screen is never clicked; a duplicate name without a
  // position is reported, not guessed; a thrown error is one step's result.
  const steps = [
    { index: 1, kind: "start", tMs: 0, label: null, role: null, position: null, route: "https://a.test/home", direction: null, button: null, unmappable: null, original: {} },
    { index: 2, kind: "click", tMs: 100, label: "Save", role: null, position: null, route: "https://a.test/home", direction: null, button: "primary", unmappable: null, original: {} },
    { index: 3, kind: "click", tMs: 200, label: "Delete", role: null, position: null, route: "https://a.test/home", direction: null, button: "primary", unmappable: null, original: {} },
    { index: 4, kind: "click", tMs: 300, label: "Boom", role: null, position: null, route: "https://a.test/broken", direction: null, button: "primary", unmappable: null, original: {} },
  ];
  const driver = fakeDriver({
    "/home": { controls: [{ name: "Save" }, { name: "Save" }, { name: "Delete", coveredBy: 'div "Cookie banner"' }] },
  });
  const run = await recheck.runRecheck({ steps, truncatedSteps: 0 }, driver, {
    startUrl: "https://a.test/home",
    framesDir: join(work, "fake-frames-2"),
    navigationTimeoutMs: 0,
    ...fakeTime,
  });
  assert.equal(run.originMapping, null);
  assert.deepEqual(run.steps.map((s) => s.status), ["matched", "unmapped", "different_screen", "different_screen"]);
  assert.match(run.steps[1].reason, /2 controls are named "Save"/);
  assert.match(run.steps[2].reason, /covered by div "Cookie banner"/);
  assert.match(run.steps[3].reason, /not clicked/);
  assert.equal(driver.clicks.length, 0);

  const erroring = fakeDriver({ "/home": { throws: "Execution context was destroyed" } });
  const errorRun = await recheck.runRecheck({ steps: steps.slice(0, 2), truncatedSteps: 0 }, erroring, {
    startUrl: "https://a.test/home",
    framesDir: join(work, "fake-frames-3"),
    navigationTimeoutMs: 0,
    ...fakeTime,
  });
  assert.equal(errorRun.steps[1].status, "error");
  assert.match(errorRun.steps[1].reason, /Execution context was destroyed/);
  assert.equal(recheck.summarize(errorRun.steps).verdict, "incomplete", "an error is not a clean match");
}

{
  // Safety: irreversible-looking controls are never clicked by default, a
  // recorded route on another host is never opened, and the navigation an
  // unmapped click led to is not opened as if typed.
  const step = (index, kind, extra) => ({
    index, kind, tMs: index * 100, label: null, role: null, position: null, route: "https://a.test/home",
    direction: null, button: kind === "click" ? "primary" : null, unmappable: null, original: {}, ...extra,
  });
  assert.ok(recheck.looksIrreversible("Delete project"));
  assert.ok(recheck.looksIrreversible("Pay $499 now"));
  assert.ok(recheck.looksIrreversible("Cancel subscription"));
  assert.ok(recheck.looksIrreversible("Send  invite"));
  assert.ok(!recheck.looksIrreversible("Cancel"), "dismissing a dialog is fine");
  assert.ok(!recheck.looksIrreversible("Settings"));
  assert.ok(!recheck.looksIrreversible("Payments"), "a whole word only");
  assert.ok(!recheck.looksIrreversible(null));

  const risky = {
    events: [
      { kind: "navigation", tMs: 0, pageUrl: "https://a.test/home" },
      { kind: "click", tMs: 100, target: { role: "button", label: "Delete project" }, pageUrl: "https://a.test/home", button: "primary" },
    ],
    moments: [],
    segments: [],
  };
  assert.match(recheck.buildRecheckPlan(risky).steps[1].unmappable, /cannot be undone.*--allow-destructive/);
  assert.equal(recheck.buildRecheckPlan(risky, 50, { allowIrreversible: true }).steps[1].unmappable, null);
  assert.ok(recheck.limitationsFor({ urlPrivacy: "redacted_route", sourcePlatform: "extension" }).some((l) => /--allow-destructive/.test(l)));

  // The live control's name is checked too (a partial match, a renamed control).
  const app = { "/home": { controls: [{ name: "Archive" }] } };
  const steps = [step(1, "start"), step(2, "click", { label: "Archive" })];
  const guarded = fakeDriver(app);
  const guardedRun = await recheck.runRecheck({ steps, truncatedSteps: 0 }, guarded, {
    startUrl: "https://a.test/home", framesDir: join(work, "fake-frames-4"), navigationTimeoutMs: 0, ...fakeTime,
  });
  assert.equal(guardedRun.steps[1].status, "unmapped");
  assert.match(guardedRun.steps[1].reason, /^could not map step: "Archive" looks like/);
  assert.equal(guarded.clicks.length, 0, "not clicked");
  const allowed = fakeDriver(app);
  const allowedRun = await recheck.runRecheck({ steps, truncatedSteps: 0 }, allowed, {
    startUrl: "https://a.test/home", framesDir: join(work, "fake-frames-5"), navigationTimeoutMs: 0, allowIrreversible: true, ...fakeTime,
  });
  assert.equal(allowedRun.steps[1].status, "matched");
  assert.equal(allowed.clicks.length, 1);

  // A typed URL on another host in the timeline is not followed; one on the
  // recording's host is opened, moved onto the re-check's host.
  const hops = fakeDriver({ "/home": { controls: [] }, "/about": { controls: [] } });
  const hopRun = await recheck.runRecheck(
    {
      steps: [
        step(1, "start"),
        step(2, "navigate", { route: "https://evil.test/steal" }),
        step(3, "navigate", { route: "file:///etc/passwd" }),
        step(4, "navigate", { route: "https://a.test/about" }),
      ],
      truncatedSteps: 0,
    },
    hops,
    { startUrl: "http://localhost:3000/home", framesDir: join(work, "fake-frames-6"), navigationTimeoutMs: 0, ...fakeTime },
  );
  assert.deepEqual(hopRun.steps.map((s) => s.status), ["matched", "different_screen", "different_screen", "matched"]);
  assert.match(hopRun.steps[1].reason, /another host/);
  assert.deepEqual(hops.opened, ["http://localhost:3000/home", "http://localhost:3000/about"]);

  // After an unmapped click, the page it led to is not opened directly.
  const afterClick = fakeDriver({ "/home": { controls: [] } });
  const afterRun = await recheck.runRecheck(
    {
      steps: [step(1, "start"), step(2, "click", { unmappable: "no element label was recorded" }), step(3, "navigate", { route: "https://a.test/next" })],
      truncatedSteps: 0,
    },
    afterClick,
    { startUrl: "https://a.test/home", framesDir: join(work, "fake-frames-7"), navigationTimeoutMs: 0, ...fakeTime },
  );
  assert.equal(afterRun.steps[2].status, "different_screen");
  assert.deepEqual(afterClick.opened, ["https://a.test/home"]);

  // Replaying a production recording on another host: a replay site that
  // sends the page back to the recorded (production) host at the same path is
  // a different screen, and nothing is clicked there.
  const prodRedirect = fakeDriver({
    "/home": { controls: [{ name: "Next" }], redirect: "https://a.test/next" },
    "/next": { controls: [{ name: "Finish" }] },
  });
  const prodRun = await recheck.runRecheck(
    {
      steps: [
        step(1, "start"),
        step(2, "click", { label: "Next" }),
        step(3, "navigate", { route: "https://a.test/next" }),
        step(4, "click", { label: "Finish", route: "https://a.test/next" }),
        step(5, "click", { label: "Finish", route: null }),
      ],
      truncatedSteps: 0,
    },
    prodRedirect,
    { startUrl: "http://localhost:3000/home", framesDir: join(work, "fake-frames-10"), navigationTimeoutMs: 0, ...fakeTime },
  );
  assert.deepEqual(prodRun.steps.map((s) => s.status), ["matched", "matched", "different_screen", "different_screen", "different_screen"]);
  assert.match(prodRun.steps[4].reason, /not the re-check's host http:\/\/localhost:3000, so it was not clicked/);
  assert.equal(prodRedirect.clicks.length, 1, "only the click on the replay host");

  // A disabled control is never matched.
  const disabledDriver = fakeDriver({ "/home": { controls: [{ name: "Next", disabled: true }] } });
  const disabledRun = await recheck.runRecheck(
    { steps: [step(1, "start"), step(2, "click", { label: "Next" })], truncatedSteps: 0 },
    disabledDriver,
    { startUrl: "https://a.test/home", framesDir: join(work, "fake-frames-11"), navigationTimeoutMs: 0, ...fakeTime },
  );
  assert.equal(disabledRun.steps[1].status, "different_screen");
  assert.match(disabledRun.steps[1].reason, /disabled, so it was not clicked/);
  assert.equal(disabledDriver.clicks.length, 0);

  // An unreachable start URL is its own error, not "Chrome unavailable".
  await assert.rejects(
    recheck.runRecheck({ steps: [step(1, "start")], truncatedSteps: 0 }, fakeDriver({ unreachable: ["https://down.test/"] }), {
      startUrl: "https://down.test/", framesDir: join(work, "fake-frames-8"), navigationTimeoutMs: 0, ...fakeTime,
    }),
    (error) => error instanceof recheck.RecheckInputError && error.code === "start_url_unreachable",
  );

  // Aborted (Ctrl-C): no further step is taken.
  const aborter = new AbortController();
  const stopping = fakeDriver({ "/home": { controls: [{ name: "Next" }] } });
  const originalShot = stopping.screenshot;
  stopping.screenshot = async (path) => {
    aborter.abort();
    return originalShot(path);
  };
  const stoppedRun = await recheck.runRecheck(
    { steps: [step(1, "start"), step(2, "click", { label: "Next" }), step(3, "click", { label: "Next" })], truncatedSteps: 0 },
    stopping,
    { startUrl: "https://a.test/home", framesDir: join(work, "fake-frames-9"), navigationTimeoutMs: 0, signal: aborter.signal, ...fakeTime },
  );
  assert.equal(stoppedRun.steps.length, 1);
  assert.equal(stopping.clicks.length, 0);
}

{
  const ok = [{ status: "matched" }, { status: "unmapped" }, { status: "replayed" }].map((s, i) => ({ ...s, index: i + 1 }));
  assert.equal(recheck.summarize(ok).verdict, "matches");
  assert.equal(recheck.summarize([{ index: 1, status: "unmapped" }]).verdict, "incomplete");
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

{
  const steps = [
    {
      index: 1, kind: "click", tMs: 2000, timeLabel: "0:02", status: "control_not_found", reason: 'no visible control named "Settings"',
      expected: { label: "Settings", role: "link", position: null, route: null, direction: null, caption: null, said: null, frameUrl: null, cropUrl: null },
      observed: { route: "https://a.test/x", control: null, nearbyControls: ["Preferences"], frame: "/tmp/f.png", atMs: 10 },
    },
  ];
  const report = {
    ok: true, type: "clipy.recheck_report", version: 1,
    original: { id: "abc", name: "Open settings", webUrl: "https://clipy.online/video/abc", contextUrl: null, sourcePlatform: "extension", expectedResult: "Settings page opens", timelineStatus: "present", urlPrivacy: "redacted_route", eventsRead: 3, eventsTruncated: false },
    start: { route: "https://a.test/", originMapping: null },
    run: { browser: "chrome-for-clipy", startedAt: "", finishedAt: "", framesDir: "/tmp/frames", truncatedSteps: 0 },
    recording: { id: "new1", shareUrl: "https://clipy.online/video/new1", contextUrl: "https://clipy.online/video/new1.arec" },
    summary: recheck.summarize(steps), steps, limitations: [], warnings: [],
  };
  const md = recheck.renderMarkdown(report);
  assert.match(md, /^# Re-check: Open settings/);
  assert.match(md, /diverges from the recording, first at step 1/);
  assert.match(md, /\*\*Expected result \(from the original recording\):\*\* Settings page opens/);
  assert.match(md, /Re-check agent context: https:\/\/clipy\.online\/video\/new1\.arec/);
  assert.match(md, /\| 1 \| 0:02 \| click link "Settings" \| control not found \| .*Nearby: "Preferences"/);
  assert.doesNotMatch(md, /—/, "no em dashes in human-facing copy");
  assert.equal(recheck.frameCaption(steps[0], 1), 'Step 1/1 control not found: click link "Settings". No visible control named "Settings"');
  const unmapped = { ...steps[0], kind: "type", status: "unmapped", reason: "could not map step: typed values are never captured" };
  assert.equal(recheck.frameCaption(unmapped, 3), "Step 1/3 could not map step: type (value not captured). Typed values are never captured");
}

// ---------------------------------------------------------------------------
// CLI against a mock API
// ---------------------------------------------------------------------------

const requests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  requests.push(`${req.method} ${url.pathname}${url.search}`);
  assert.equal(req.headers.authorization, "Bearer clipy_test");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const m = url.pathname.match(/^\/api\/v1\/recordings\/([^/]+)(\/[a-z-]+)?$/);
  if (!m) return send(404, { error: "Not found" });
  const [, id, sub] = m;
  if (id === "missing") return send(404, { error: "Recording not found" });
  if (!sub) {
    return send(200, {
      recording: {
        id,
        name: "Create a project",
        webUrl: `https://clipy.online/video/${id}`,
        sourcePlatform: "extension",
        ...(id === "abc123" ? { expectedResult: "The new project opens on its settings page." } : {}),
      },
    });
  }
  if (sub === "/interactions") {
    assert.equal(url.searchParams.get("types"), "navigation,click,scroll,typing,drag");
    if (id === "prep1") return send(200, { status: "preparing", events: [], privacy: { urls: "not_captured" } });
    if (id === "none1") return send(200, { status: "absent", events: [], privacy: { urls: "not_captured" } });
    const half = 6;
    const page2 = url.searchParams.get("cursor") === "c2";
    return send(200, {
      status: "present",
      privacy: { urls: "redacted_route" },
      events: page2 ? fixture.events.slice(half) : fixture.events.slice(0, half),
      pagination: { nextCursor: page2 ? null : "c2", limit: 250 },
    });
  }
  if (sub === "/key-moments") return send(200, { status: "ready", moments: fixture.moments });
  if (sub === "/transcript") return send(200, { status: "ready", transcript: { segments: fixture.segments } });
  return send(404, { error: "Not found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

function runCli(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args, "--api-url", apiUrl, "--key", "clipy_test"], {
      env: { ...process.env, NO_COLOR: "1", HOME: work },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

try {
  {
    const { code, stdout, stderr } = await runCli(["recheck", "https://clipy.online/video/abc123", "--plan", "--json"]);
    assert.equal(code, 0, stderr);
    const body = JSON.parse(stdout);
    assert.equal(body.ok, true);
    assert.equal(body.type, "clipy.recheck_plan");
    assert.equal(body.original.id, "abc123");
    assert.equal(body.original.expectedResult, "The new project opens on its settings page.", "#741 field is carried through");
    assert.equal(body.original.contextUrl, "https://clipy.online/video/abc123.arec");
    assert.equal(body.original.eventsRead, fixture.events.length, "both timeline pages were read");
    assert.equal(body.original.urlPrivacy, "redacted_route");
    assert.equal(body.steps.length, 11);
    assert.deepEqual(body.warnings, []);
    assert.ok(requests.some((r) => r.includes("/interactions?") && r.includes("cursor=c2")), "follows the pagination cursor");
    assert.ok(requests.includes("GET /api/v1/recordings/abc123/key-moments"));
    assert.ok(requests.includes("GET /api/v1/recordings/abc123/transcript"));
  }
  {
    // Without the #741 field the output is the same shape, with null.
    const { code, stdout } = await runCli(["recheck", "other9", "--plan", "--json"]);
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).original.expectedResult, null);
  }
  {
    const { code, stdout } = await runCli(["recheck", "abc123", "--plan"]);
    assert.equal(code, 0);
    assert.match(stdout, /Re-check plan for Create a project \(11 steps\)/);
    assert.match(stdout, /click button "New project"/);
    assert.match(stdout, /could not map: typed values/);
    assert.match(stdout, /Expected result: The new project opens on its settings page\./);
  }
  for (const [id, code] of [["prep1", "timeline_not_ready"], ["none1", "no_interactions"], ["missing", "not_found"]]) {
    const run = await runCli(["recheck", id, "--plan", "--json"]);
    assert.equal(run.code, 1, `${id}: ${run.stderr}`);
    const body = JSON.parse(run.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.code, code);
    assert.ok(body.remediation);
  }
  {
    const run = await runCli(["recheck", "abc123", "--json"]);
    assert.equal(run.code, 2);
    assert.equal(JSON.parse(run.stdout).code, "usage_error", "--url is required to run");
    const bad = await runCli(["recheck", "abc123", "--url", "file:///etc/passwd", "--json"]);
    assert.equal(bad.code, 2);
    assert.match(JSON.parse(bad.stdout).error, /http\(s\) URL/);
    const steps = await runCli(["recheck", "abc123", "--plan", "--max-steps", "99", "--json"]);
    assert.equal(steps.code, 2);
    const port = await runCli(["recheck", "abc123", "--url", "http://127.0.0.1:9/", "--port", "abc", "--json"]);
    assert.equal(port.code, 2);
    assert.match(JSON.parse(port.stdout).error, /--port/);
  }
  {
    const { stdout } = await runCli(["guide", "--json"]);
    const guide = JSON.parse(stdout);
    const doc = guide.commands.find((c) => c.name === "recheck");
    assert.ok(doc, "recheck is in the guide");
    assert.ok(doc.flags.includes("--url <start-url>"));
    assert.ok(doc.flags.includes("--allow-destructive"));
    for (const code of ["timeline_not_ready", "no_interactions", "chrome_unavailable", "start_url_unreachable", "recheck_upload_failed", "upload_unconfirmed"]) {
      assert.ok(guide.errorCodes.some((e) => e.code === code), `guide lists ${code}`);
    }
  }
} finally {
  server.close();
}

// ---------------------------------------------------------------------------
// The real page driver, in Chromium, against local fixture pages
// ---------------------------------------------------------------------------

let chromium = null;
try {
  const require = createRequire(import.meta.url);
  chromium = require("playwright").chromium;
  if (!existsSync(chromium.executablePath())) chromium = null;
} catch {
  chromium = null;
}

if (!chromium) {
  console.log("recheck: Playwright Chromium not installed; skipped the real page driver check");
} else {
  // Today's app: "Settings" was renamed "Preferences"; "Create" sits far down
  // a tall page, so locate must scroll it into view; /covered has a banner on
  // top of its only button.
  const page = (title, body) => `<!doctype html><title>${title}</title><body style="margin:0;font:16px sans-serif">${body}</body>`;
  const pages = {
    "/projects": page("Projects", `<main><h1>Projects</h1><button style="position:absolute;right:20px;top:20px" onclick="location.href='/projects/new'">New project</button></main>`),
    "/projects/new": page("New", `<div style="height:2200px">spacer</div><label>Name <input placeholder="Project name"></label><span role="button" tabindex="0" onclick="location.href='/projects/12345678'"> Create </span>`),
    "/projects/12345678": page("Project", `<nav><a href="/settings">Preferences</a> <a href="/projects">All projects</a></nav><div style="height:3000px">long</div>`),
    "/covered": page("Covered", `<button style="position:absolute;left:50px;top:50px;width:120px;height:40px" onclick="document.title='clicked'">New project</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.5)">Cookie banner</div>`),
  };
  const site = createServer((req, res) => {
    const html = pages[new URL(req.url, "http://x").pathname];
    res.writeHead(html ? 200 : 404, { "content-type": "text/html" });
    res.end(html ?? "not found");
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const driver = recheck.createPageDriver(tab, { settleMs: 50 });
    const framesDir = join(work, "real-frames");
    const run = await recheck.runRecheck(plan, driver, {
      startUrl: `${origin}/projects`,
      framesDir,
      navigationTimeoutMs: 1_500,
      urlPrivacy: "redacted_route",
    });
    const statuses = run.steps.map((s) => `${s.index}:${s.status}`);
    assert.deepEqual(
      statuses,
      ["1:matched", "2:matched", "3:matched", "4:unmapped", "5:matched", "6:matched", "7:replayed", "8:unmapped", "9:unmapped", "10:control_not_found", "11:different_screen"],
      JSON.stringify(run.steps.map((s) => [s.index, s.status, s.reason]), null, 1),
    );
    assert.equal(run.steps[1].observed.control.name, "New project");
    assert.equal(run.steps[1].observed.control.quality, "exact");
    assert.equal(run.steps[4].observed.control.name, "Create", "found by its role=button span after scrolling into view");
    assert.equal(run.steps[5].observed.route, `${origin}/projects/:id`, "the live id is redacted in the report");
    assert.ok(run.steps[9].observed.nearbyControls.includes("Preferences"), run.steps[9].observed.nearbyControls.join(","));
    for (const step of run.steps) {
      assert.ok(step.observed.frame && existsSync(step.observed.frame), `frame for step ${step.index}`);
      assert.equal(readFileSync(step.observed.frame).subarray(1, 4).toString(), "PNG");
    }

    const coveredRun = await recheck.runRecheck(
      { steps: [{ ...plan.steps[1], index: 1, route: null }], truncatedSteps: 0 },
      driver,
      { startUrl: `${origin}/covered`, framesDir, navigationTimeoutMs: 0 },
    );
    assert.equal(coveredRun.steps[0].status, "different_screen");
    assert.match(coveredRun.steps[0].reason, /covered by div "Cookie banner"/);
    assert.notEqual(await tab.title(), "clicked", "a covered control is not clicked");

    // Label matching on pages built to fool it.
    const probe = async (html, hint) => {
      await tab.setContent(html);
      return driver.locate({ x: null, y: null, role: null, ...hint });
    };
    {
      // A dialog titled like its confirm button: the button is the control,
      // not the dialog around it.
      const r = await probe(
        `<div role="dialog" tabindex="-1" aria-labelledby="h" style="width:600px;height:400px;margin:50px"><h2 id="h">Delete project</h2><p>Sure?</p><button style="margin-top:250px">Delete project</button></div>`,
        { label: "Delete project", role: "button" },
      );
      assert.equal(r.status, "found");
      assert.equal(r.control.role, "button");
    }
    {
      // A name that adds words is another control: "Cancel" is not "Cancel plan".
      const r = await probe(`<button>Cancel plan</button><button>Keep plan</button>`, { label: "Cancel", role: "button" });
      assert.equal(r.status, "none");
      assert.ok(r.nearby.includes("Cancel plan"));
      const badge = await probe(`<a href="#">Inbox 3</a>`, { label: "Inbox", role: "link" });
      assert.equal(badge.status, "found", "a count badge is still the same control");
      assert.equal(badge.control.quality, "partial");
    }
    {
      // Text that is not a control (a paragraph in a landmark) is not clicked.
      const r = await probe(`<main><p>Save</p></main><button>Other</button>`, { label: "Save", role: "button" });
      assert.equal(r.status, "none");
    }
    {
      // Disabled controls: the native attribute, aria-disabled and a disabled
      // fieldset are all reported, never matched; an enabled twin is chosen.
      for (const html of [
        `<button disabled>Next</button>`,
        `<div role="button" tabindex="0" aria-disabled="true">Next</div>`,
        `<fieldset disabled><button>Next</button></fieldset>`,
      ]) {
        const r = await probe(html, { label: "Next", role: "button" });
        assert.equal(r.status, "disabled", html);
      }
      const twin = await probe(`<button disabled>Next</button><button onclick="document.title='next'">Next</button>`, { label: "Next", role: "button" });
      assert.equal(twin.status, "found");
      await driver.click(twin.control.x, twin.control.y);
      assert.equal(await tab.title(), "next");
    }
    {
      // A control is named by its own accessible name, never by a descendant's
      // text: this button is "Preview", not "Save".
      const r = await probe(`<button aria-label="Preview"><span>Save</span></button>`, { label: "Save", role: "button" });
      assert.equal(r.status, "none");
      assert.ok(r.nearby.includes("Preview"), r.nearby.join(","));
      const byLabel = await probe(`<button aria-label="Preview"><span>Save</span></button>`, { label: "Preview", role: "button" });
      assert.equal(byLabel.status, "found");
      // aria-labelledby wins over the text; aria-hidden text is not part of a name.
      const labelled = await probe(`<span id="l">Publish draft</span><button aria-labelledby="l">Go</button>`, { label: "Go", role: "button" });
      assert.equal(labelled.status, "none");
      const icon = await probe(`<button><span aria-hidden="true">+</span> Add item</button>`, { label: "Add item", role: "button" });
      assert.equal(icon.status, "found");
      assert.equal(icon.control.quality, "exact");
      // A pointer-cursor card around a real button is not a second "Save".
      const card = await probe(`<div style="cursor:pointer;padding:20px"><button onclick="document.title='card-save'">Save</button></div>`, { label: "Save", role: null });
      assert.equal(card.status, "found");
      assert.equal(card.control.role, "button");
    }
    {
      // Open shadow roots: found by the traversal, named across the shadow
      // boundary (shadow text, slotted text, aria-labelledby inside the root),
      // and the composed hit test does not call them covered.
      await tab.setContent(`<x-a></x-a><x-b>Delete draft</x-b><x-c></x-c><div style="height:10px"></div>`);
      await tab.evaluate(`(() => {
        const a = document.querySelector("x-a").attachShadow({ mode: "open" });
        a.innerHTML = '<button onclick="document.title=\\'shadow-save\\'"><span>Save</span></button>';
        const b = document.querySelector("x-b").attachShadow({ mode: "open" });
        b.innerHTML = '<button><slot></slot></button>';
        const c = document.querySelector("x-c").attachShadow({ mode: "open" });
        c.innerHTML = '<span id="t">Open menu</span><div role="button" tabindex="0" aria-labelledby="t">\u2630</div>';
      })()`);
      const shadow = await driver.locate({ label: "Save", role: "button", x: null, y: null });
      assert.equal(shadow.status, "found", JSON.stringify(shadow));
      await driver.click(shadow.control.x, shadow.control.y);
      assert.equal(await tab.title(), "shadow-save");
      const slotted = await driver.locate({ label: "Delete draft", role: "button", x: null, y: null });
      assert.equal(slotted.status, "found", JSON.stringify(slotted));
      const labelledInShadow = await driver.locate({ label: "Open menu", role: "button", x: null, y: null });
      assert.equal(labelledInShadow.status, "found", JSON.stringify(labelledInShadow));
      // Covered inside a shadow root is still covered.
      await tab.setContent(`<x-d></x-d>`);
      await tab.evaluate(`(() => {
        const d = document.querySelector("x-d").attachShadow({ mode: "open" });
        d.innerHTML = '<button style="position:absolute;left:40px;top:40px;width:100px;height:40px">Save</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.4)">Sign in first</div>';
      })()`);
      const coveredShadow = await driver.locate({ label: "Save", role: "button", x: null, y: null });
      assert.equal(coveredShadow.status, "covered");
      assert.match(coveredShadow.coveredBy, /Sign in first/);
    }
    {
      // Smooth scrolling: the click must land on the control, not where it was.
      await tab.setContent(
        `<style>html{scroll-behavior:smooth}</style><div style="height:300px"></div><button onclick="document.title='keep'" style="display:block;height:40px">Keep</button><div style="height:2000px"></div><button onclick="document.title='save'" style="display:block;height:40px">Save</button><div style="height:2000px"></div>`,
      );
      const r = await driver.locate({ label: "Save", role: "button", x: null, y: null });
      assert.equal(r.status, "found");
      assert.ok(r.control.y >= 0 && r.control.y < 720, `in view: ${r.control.y}`);
      await driver.click(r.control.x, r.control.y);
      assert.equal(await tab.title(), "save");
    }
    console.log("recheck: real page driver checked in Playwright Chromium");
  } finally {
    await browser.close();
    site.close();
  }
}

rmSync(work, { recursive: true, force: true });
console.log("recheck tests passed");
