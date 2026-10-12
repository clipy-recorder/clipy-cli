#!/usr/bin/env node
// Library management and bug-evidence commands (src/library.ts) plus
// `clipy upload`, against a mock Clipy API.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "clipy-library-"));

// Smallest thing the upload path accepts: an ftyp box (QuickTime brand, i.e. a .mov).
const movPath = join(dir, "Checkout repro.mov");
const mov = Buffer.alloc(64);
mov.writeUInt32BE(20, 0);
mov.write("ftypqt  ", 4, "ascii");
writeFileSync(movPath, mov);

const calls = [];
let denyScope = null;
let loseComplete = false;
let privacyPending = false;
let queuePending = false;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const isJson = (req.headers["content-type"] ?? "").includes("json");
  const call = { method: req.method, url: req.url, body: isJson && raw ? JSON.parse(raw) : raw };
  calls.push(call);
  const send = (status, body) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  if (denyScope) return send(403, { error: `API key missing required scope(s): ${denyScope}` });

  const path = req.url.split("?")[0];
  if (req.method === "PATCH" && path === "/api/v1/recordings/rec-1") {
    return send(200, { recording: { id: "rec-1", name: call.body.name ?? "Old" } });
  }
  if (path === "/api/v1/recordings/rec-1/access") {
    return send(200, { access: { mode: call.body?.mode ?? "public", domains: [], grantedPeople: 0 } });
  }
  if (req.method === "GET" && path === "/api/v1/folders") {
    return send(200, { folders: [{ id: "fold-1", name: "Bug reports", video_count: 3 }] });
  }
  if (req.method === "POST" && path === "/api/v1/folders") {
    return send(201, { folder: { id: "fold-2", name: call.body.name }, created: true });
  }
  if (req.method === "PATCH" && path === "/api/v1/recordings/rec-1/organize") {
    return send(200, { recording: { id: "rec-1", folderId: call.body.folderId ?? null, tags: call.body.addTags ?? [] } });
  }
  if (req.method === "DELETE" && path === "/api/v1/recordings/rec-1") {
    return send(200, { deleted: true, recordingId: "rec-1" });
  }
  if (req.method === "GET" && path === "/api/v1/recordings/rec-1/comments") {
    return send(200, {
      commentsEnabled: true,
      comments: [
        { id: "c1", parentCommentId: null, body: "Button is dead", timestampMs: 65_000, deletedAt: null, resolvedAt: null, author: { name: "Ana" } },
        { id: "c2", parentCommentId: "c1", body: "Fixed in #12", timestampMs: 0, deletedAt: null, resolvedAt: null, author: { name: "Raj" } },
      ],
    });
  }
  if (req.method === "POST" && path === "/api/v1/recordings/rec-1/comments") {
    return send(201, { comment: { id: "c3", timestampMs: call.body.timestampMs ?? 0 } });
  }
  if (path === "/api/v1/recordings/rec-1/analytics") {
    return send(200, { gated: true, viewCount: 9, teaser: { sessions: 4, uniqueViewers: 3 }, upgradeUrl: "https://clipy.online/pricing" });
  }
  if (path === "/api/v1/recordings/rec-1/browser-diagnostics") {
    const q = new URL(req.url, "http://x").searchParams;
    const events = q.get("kinds") === "network"
      ? [{ kind: "network", time_ms: 4_000, method: "POST", url: "https://app.test/api/pay", status: 500, outcome: "http_error", duration_ms: 120 }]
      : [{ kind: "console", time_ms: 2_000, level: "error", message: "TypeError: x is undefined" }];
    return send(200, {
      recordingId: "rec-1",
      attestation: "page-reported",
      attestationNote: "Captured in the recorded page.",
      diagnostics: { environment: { browser_name: "Chrome", browser_version: "141", os_name: "macOS", page_url: "https://app.test/checkout" }, events, dropped_events: 0 },
      // The failed-requests stream has a second page; console fits in one.
      page: {
        totalEvents: 40,
        totalMatching: q.get("kinds") === "network" ? 2 : 1,
        returned: 1,
        nextAfter: q.get("kinds") === "network" && !q.get("after") ? 1 : null,
      },
    });
  }
  if (path === "/api/v1/recordings/rec-1/interactions") {
    const cursor = new URL(req.url, "http://x").searchParams.get("cursor");
    return send(200, {
      status: "present",
      pagination: { nextCursor: cursor ? null : "cur-2", limit: 1 },
      events: [{ kind: "click", tMs: cursor ? 9_000 : 3_000, target: { role: "button", label: cursor ? "Retry" : "Pay" }, position: { x: 10, y: 20 } }],
    });
  }
  if (path === "/api/videos/raw-upload/initiate") {
    return send(200, { initiated: true, uploadToken: "tok", publicId: "new-1", videoId: "v" });
  }
  if (path === "/api/videos/raw-upload/chunk") return send(200, { appended: true, nextPartNumber: 2 });
  if (path === "/api/videos/raw-upload/finalize") return send(200, { finalized: true, totalBytes: 64 });
  if (path === "/api/videos/raw-upload/complete") {
    if (loseComplete) return res.writeHead(504, { "content-type": "text/html" }).end("<html>Gateway Timeout</html>");
    if (privacyPending) return send(503, { error: "sharing not applied", code: "access_mode_pending" });
    if (queuePending) return send(503, { error: "waiting to be queued", code: "queue_pending" });
    return send(201, { id: "v", public_id: "new-1" });
  }
  if (path === "/api/videos/raw-upload/abort") {
    return send(409, { error: "already attached", code: "already_attached" });
  }
  send(404, { error: `unexpected ${req.method} ${req.url}` });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, CLIPY_API_KEY: "clipy_sk_test", CLIPY_API_URL: apiUrl, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const last = () => calls[calls.length - 1];

try {
  // update
  let r = await run(["update", "rec-1", "--title", "Checkout bug", "--clear-description"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(last().body, { name: "Checkout bug", description: null });
  r = await run(["update", "rec-1"]);
  assert.equal(r.code, 2, "update with nothing to change is a usage error");

  // share
  r = await run(["share", "https://clipy.online/video/rec-1", "private"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(last().method, "PUT");
  assert.deepEqual(last().body, { mode: "private" });
  r = await run(["share", "rec-1", "everyone"]);
  assert.equal(r.code, 2);

  // organize resolves a folder name to its id
  r = await run(["organize", "rec-1", "--folder", "bug reports", "--tag", "checkout", "--untag", "draft"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(last().body, { folderId: "fold-1", addTags: ["checkout"], removeTags: ["draft"] });
  r = await run(["organize", "rec-1", "--folder", "Nope"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /clipy folders --create "Nope"/);

  r = await run(["folders", "--create", "Releases", "--json"]);
  assert.equal(JSON.parse(r.stdout).folder.id, "fold-2");

  // delete needs --yes, and sends the confirmation the API requires
  const before = calls.length;
  r = await run(["delete", "rec-1"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--yes/);
  assert.equal(calls.length, before, "no request without --yes");
  r = await run(["delete", "rec-1", "--yes", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(last().url, "/api/v1/recordings/rec-1?confirm=rec-1");

  // comments
  r = await run(["comments", "rec-1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[1:05\] Ana: Button is dead/);
  assert.match(r.stdout, /↳ Raj: Fixed in #12/);
  r = await run(["comment", "rec-1", "Repro", "steps", "attached", "--at", "12.5"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(last().body, { kind: "comment", body: "Repro steps attached", timestampMs: 12_500 });
  r = await run(["comment", "rec-1", "Thanks", "--reply-to", "c1"]);
  assert.deepEqual(last().body, { kind: "reply", body: "Thanks", parentCommentId: "c1" });

  // analytics (free account)
  r = await run(["analytics", "rec-1", "--range", "7"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(last().url, "/api/v1/recordings/rec-1/analytics?range=7");
  assert.match(r.stdout, /9 opens · 3 unique viewers/);
  r = await run(["analytics", "rec-1", "--range", "0"]);
  assert.equal(r.code, 2);

  // diagnostics --errors = console errors + failed requests, merged by time
  const diagStart = calls.length;
  r = await run(["diagnostics", "rec-1", "--errors"]);
  assert.equal(r.code, 0, r.stderr);
  const diagCalls = calls.slice(diagStart).map((call) => call.url).sort();
  assert.deepEqual(diagCalls, [
    "/api/v1/recordings/rec-1/browser-diagnostics?kinds=console%2Cerror&levels=error",
    "/api/v1/recordings/rec-1/browser-diagnostics?kinds=network&status=failed",
  ]);
  const lines = r.stdout.split("\n");
  const consoleLine = lines.findIndex((line) => line.includes("TypeError"));
  const networkLine = lines.findIndex((line) => line.includes("POST 500"));
  assert.ok(consoleLine > 0 && networkLine > consoleLine, r.stdout);
  assert.match(r.stdout, /Chrome 141 · macOS/);
  // each merged stream reports its own continuation, as a runnable command
  assert.match(r.stdout, /more requests: clipy diagnostics rec-1 --errors --network --after 1/);
  assert.doesNotMatch(r.stdout, /more console events/);
  r = await run(["diagnostics", "rec-1", "--errors", "--json"]);
  const merged = JSON.parse(r.stdout).page;
  assert.equal(merged.truncated, true);
  assert.deepEqual(
    merged.streams.map((stream) => [stream.stream, stream.nextAfter]),
    [["console", null], ["network", 1]],
  );
  // one --after cannot continue two streams
  const beforeAfter = calls.length;
  r = await run(["diagnostics", "rec-1", "--errors", "--after", "1"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--console or --network/);
  assert.equal(calls.length, beforeAfter);
  r = await run(["diagnostics", "rec-1", "--errors", "--network", "--after", "1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(last().url, "/api/v1/recordings/rec-1/browser-diagnostics?kinds=network&status=failed&after=1");

  r = await run(["logs", "rec-1", "--network", "--status", "5xx", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(last().url, "/api/v1/recordings/rec-1/browser-diagnostics?kinds=network&status=5xx");
  assert.equal(JSON.parse(r.stdout).diagnostics.events[0].status, 500);

  r = await run(["interactions", "rec-1", "--types", "click"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /0:03 {2}click button "Pay"/);
  assert.match(r.stdout, /--cursor cur-2/);
  r = await run(["interactions", "rec-1", "--types", "click", "--cursor", "cur-2"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(last().url, "/api/v1/recordings/rec-1/interactions?types=click&cursor=cur-2");
  assert.match(r.stdout, /0:09 {2}click button "Retry"/);

  // upload: a .mov goes through the four-step pipeline titled after the file
  const uploadStart = calls.length;
  r = await run(["upload", movPath, "--access", "private", "--type", "bug", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const uploadPaths = calls.slice(uploadStart).map((call) => call.url);
  assert.deepEqual(uploadPaths, [
    "/api/videos/raw-upload/initiate",
    "/api/videos/raw-upload/chunk",
    "/api/videos/raw-upload/finalize",
    "/api/videos/raw-upload/complete",
  ]);
  const complete = calls[calls.length - 1].body;
  assert.equal(complete.name, "Checkout repro");
  assert.equal(complete.accessMode, "private");
  assert.equal(complete.recordingKind, "bug_report");
  assert.equal(complete.nameIsUserProvided, undefined, "a filename title stays replaceable by auto-titling");
  assert.equal(JSON.parse(r.stdout).shareUrl, `${apiUrl}/video/new-1`);
  r = await run(["upload", movPath, "--access", "secret"]);
  assert.equal(r.code, 2);

  // argument errors on upload honor --json too, before anything is sent
  const beforeBadArgs = calls.length;
  r = await run(["upload", movPath, "--type", "nonsense", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).code, "usage_error");
  r = await run(["upload", movPath, "--note", "pass2: mobile", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).code, "usage_error");
  assert.equal(calls.length, beforeBadArgs);

  // a /complete that committed but never answered is still a success
  loseComplete = true;
  r = await run(["upload", movPath, "--json"]);
  loseComplete = false;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).id, "new-1");
  assert.equal(last().url, "/api/videos/raw-upload/abort");

  // ...but sharing that could not be applied is a failure, never a share link
  privacyPending = true;
  r = await run(["upload", movPath, "--access", "private", "--json"]);
  privacyPending = false;
  assert.notEqual(r.code, 0);
  const stranded = JSON.parse(r.stdout);
  assert.equal(stranded.ok, false);
  // names the recording that exists, and says to fix its sharing, not re-upload
  assert.equal(stranded.code, "sharing_not_applied");
  assert.equal(stranded.partial.id, "new-1");
  assert.match(stranded.remediation, /clipy share new-1 private/);
  assert.match(stranded.remediation, /Do not upload again/);
  // reported straight from the coded answer: no abort that could fail
  assert.equal(last().url, "/api/videos/raw-upload/complete");

  // ...and any other unconfirmed completion names the recording too
  queuePending = true;
  r = await run(["upload", movPath, "--json"]);
  queuePending = false;
  assert.notEqual(r.code, 0);
  const unconfirmed = JSON.parse(r.stdout);
  assert.equal(unconfirmed.code, "upload_unconfirmed");
  assert.equal(unconfirmed.partial.id, "new-1");
  assert.match(unconfirmed.remediation, /clipy show new-1/);

  // a wait that fails after the upload is a warning, never a failure to retry
  r = await run(["upload", movPath, "--wait", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const waited = JSON.parse(r.stdout);
  assert.equal(waited.ok, true);
  assert.equal(waited.id, "new-1");
  assert.equal(waited.warnings[0].code, "wait_incomplete");
  assert.match(waited.warnings[0].remediation, /Do not upload again/);

  // a 403 names the missing scope and how to get it
  denyScope = "recordings:delete";
  r = await run(["delete", "rec-1", "--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /clipy login --allow-delete/);
  // under --json a failure is still exactly one object on stdout
  r = await run(["delete", "rec-1", "--yes", "--json"]);
  assert.equal(r.code, 1);
  let envelope = JSON.parse(r.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, "wrong_scope");
  assert.match(envelope.remediation, /clipy login --allow-delete/);
  assert.equal(envelope.partial, null);
  denyScope = null;

  r = await run(["update", "rec-1", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).code, "usage_error");
  r = await run(["delete", "rec-1", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).code, "confirmation_required");
  r = await run(["comments", "nope", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).code, "not_found");
  r = await run(["comment", "rec-1", "x", "--at", "soon", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).code, "usage_error");
  r = await run(["analytics", "rec-1", "--range", "0", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).code, "usage_error");
  r = await run(["upload", join(dir, "missing.mp4"), "--json"]);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).code, "source_unreadable");

  // the guide lists every new command
  r = await run(["guide", "--json"]);
  const names = JSON.parse(r.stdout).commands.map((command) => command.name);
  for (const name of ["upload", "update", "share", "organize", "folders", "comments", "comment", "analytics", "delete", "diagnostics", "interactions"]) {
    assert.ok(names.includes(name), `guide is missing ${name}`);
  }

  console.log("library commands ok");
} finally {
  server.close();
}
