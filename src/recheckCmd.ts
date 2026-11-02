/**
 * `clipy recheck` command: argument handling, Chrome for Clipy, upload and
 * output around the pure pieces in recheck.ts. index.ts only parses flags and
 * hands over the helpers it owns (Playwright loading and the proof upload).
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_CDP_PORT,
  newBackgroundPage,
  startChrome,
  type CfcBrowser,
  type CfcChromium,
  type CfcPage,
} from "./chromeForClipy.js";
import { failure, request, recordingPath, type LibraryDeps } from "./library.js";
import {
  buildRecheckPlan,
  createPageDriver,
  fmtClock,
  frameCaption,
  limitationsFor,
  readOriginalRun,
  RecheckInputError,
  RECHECK_MAX_STEPS,
  RECHECK_REPORT_VERSION,
  renderMarkdown,
  routeOf,
  runRecheck,
  summarize,
  writeReportFiles,
  type RecheckPage,
  type RecheckReport,
} from "./recheck.js";

export interface RecheckOpts {
  startUrl?: string;
  outDir?: string;
  planOnly: boolean;
  upload: boolean;
  settleMs: number;
  navigationTimeoutMs: number;
  maxSteps: number;
  failOnDivergence: boolean;
  /** Click controls that look irreversible (delete, pay, send...). */
  allowDestructive: boolean;
  port?: number;
}

export interface RecheckDeps extends LibraryDeps {
  loadChromium(): Promise<CfcChromium>;
  /** Assembles the frames into a proof recording and uploads it. Throws on failure. */
  uploadFrames(
    frames: { path: string; caption: string }[],
    meta: { name: string; description: string; log: (m: string) => void },
  ): Promise<{ id: string; shareUrl: string; contextUrl: string }>;
}

const USAGE =
  "usage: clipy recheck <id|url> --url <start-url> [--out <dir>] [--plan] [--no-upload] [--settle-ms N] [--nav-timeout-ms N] [--max-steps N] [--fail-on-divergence] [--allow-destructive] [--port N] [--json]";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function cmdRecheck(deps: RecheckDeps, id: string | undefined, opts: RecheckOpts): Promise<void> {
  const usage = (message: string): never =>
    failure(deps, "usage_error", message, "Fix the arguments; `clipy guide --json` lists every command's flags.", 2);
  if (!id) usage(USAGE);
  if (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1 || opts.maxSteps > RECHECK_MAX_STEPS) {
    usage(`--max-steps must be an integer from 1 to ${RECHECK_MAX_STEPS}`);
  }
  if (!Number.isFinite(opts.settleMs) || opts.settleMs < 0 || opts.settleMs > 30_000) usage("--settle-ms must be 0-30000");
  if (!Number.isFinite(opts.navigationTimeoutMs) || opts.navigationTimeoutMs < 0 || opts.navigationTimeoutMs > 60_000) {
    usage("--nav-timeout-ms must be 0-60000");
  }
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)) {
    usage("--port must be an integer from 1 to 65535");
  }
  let startUrl: string | null = null;
  if (opts.startUrl) {
    try {
      const u = new URL(opts.startUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
      startUrl = u.href;
    } catch {
      usage("--url must be an http(s) URL");
    }
  } else if (!opts.planOnly) {
    usage(`--url <start-url> is required (the page the workflow starts on)\n${USAGE}`);
  }

  const log = (m: string) => {
    if (!deps.json) process.stderr.write(`${deps.color.dim(m)}\n`);
  };
  const { pid } = recordingPath(deps, id as string);
  let original;
  try {
    original = await readOriginalRun((path) => request(deps, "GET", path), pid);
  } catch (error) {
    if (error instanceof RecheckInputError) failure(deps, error.code, error.message, error.remediation);
    throw error;
  }
  const planOpts = { allowIrreversible: opts.allowDestructive };
  const plan = buildRecheckPlan(original, opts.maxSteps, planOpts);
  const contextUrl = original.webUrl ? `${original.webUrl}.arec` : null;

  if (opts.planOnly) {
    const result = {
      ok: true,
      type: "clipy.recheck_plan",
      version: RECHECK_REPORT_VERSION,
      original: {
        id: original.id,
        name: original.name,
        webUrl: original.webUrl,
        contextUrl,
        expectedResult: original.expectedResult,
        timelineStatus: original.timelineStatus,
        urlPrivacy: original.urlPrivacy,
        eventsRead: original.events.length,
        eventsTruncated: original.eventsTruncated,
      },
      steps: plan.steps,
      truncatedSteps: plan.truncatedSteps,
      limitations: limitationsFor(original, planOpts),
      warnings: [],
    };
    if (deps.json) return deps.printJson(result);
    process.stdout.write(`${deps.color.bold(`Re-check plan for ${original.name || original.id}`)} (${plan.steps.length} steps)\n`);
    for (const step of plan.steps) {
      const what =
        step.kind === "click"
          ? `click ${step.role ?? "control"}${step.label ? ` "${step.label}"` : ""}`
          : step.kind === "start" || step.kind === "navigate"
            ? `${step.kind} ${step.route}`
            : `${step.kind}${step.direction ? ` ${step.direction}` : ""}`;
      process.stdout.write(
        `${deps.color.cyan(String(step.index).padStart(2))}  ${fmtClock(step.tMs)}  ${what}` +
          (step.unmappable ? deps.color.yellow(`  (could not map: ${step.unmappable})`) : "") +
          "\n",
      );
    }
    if (original.expectedResult) process.stdout.write(`\nExpected result: ${original.expectedResult}\n`);
    return;
  }

  // The default folder is private (mkdtemp is 0700): the frames are
  // screenshots of a signed-in app, and /tmp is shared on Linux. The id comes
  // from the server, so it is reduced to a safe name before it touches a path.
  let outDir: string;
  if (opts.outDir) {
    outDir = resolve(opts.outDir);
  } else {
    const safeId = original.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "recording";
    outDir = mkdtempSync(join(tmpdir(), `clipy-recheck-${safeId}-${stamp()}-`));
  }
  const framesDir = join(outDir, "frames");
  mkdirSync(framesDir, { recursive: true, mode: 0o700 });

  const chromium = await deps.loadChromium();
  const started = await startChrome(homedir(), process.env, process.platform, opts.port ?? DEFAULT_CDP_PORT);
  if (!started.ok) {
    failure(
      deps,
      "chrome_unavailable",
      `Chrome for Clipy is not available: ${started.error}`,
      "Run `clipy chrome status --json` and `clipy chrome start`; sign in to the app there once if the workflow needs a login, then re-run.",
    );
  }
  log(`Chrome for Clipy ready on port ${started.state.port}`);
  let browser: CfcBrowser | null = null;
  let page: CfcPage | null = null;
  // Tabs the replayed site opened (target=_blank, window.open): closed with
  // the re-check's own window so nothing is left behind in Chrome for Clipy.
  const popups: CfcPage[] = [];
  let run: Awaited<ReturnType<typeof runRecheck>> | undefined;
  let runError: unknown = null;
  const aborter = new AbortController();
  let cleaned: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    cleaned ??= (async () => {
      for (const p of [...popups, page]) await p?.close().catch(() => {});
      // Disconnects; Chrome for Clipy keeps running.
      await browser?.close().catch(() => {});
    })();
    return cleaned;
  };
  // Ctrl-C would otherwise end the process with the window still open on the
  // replayed site: stop taking steps, close it, then exit as interrupted.
  const onSignal = (signal: NodeJS.Signals) => {
    aborter.abort();
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${started.state.port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome for Clipy has no browser context to attach to");
    // Its own background window: the re-check never takes over a tab the user
    // or another agent is using, and never brings Chrome to the front.
    page = await newBackgroundPage(browser, context, true);
    (page as unknown as { on?(event: "popup", fn: (p: CfcPage) => void): unknown }).on?.("popup", (p) => {
      popups.push(p);
    });
    const driver = createPageDriver(page as unknown as RecheckPage, { settleMs: opts.settleMs });
    run = await runRecheck(plan, driver, {
      startUrl: startUrl as string,
      framesDir,
      navigationTimeoutMs: opts.navigationTimeoutMs,
      urlPrivacy: original.urlPrivacy,
      allowIrreversible: opts.allowDestructive,
      signal: aborter.signal,
      log,
    });
  } catch (error) {
    runError = error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // Here, before any failure(): failure() exits the process, so a finally
    // around it would never run and the window would stay open.
    await cleanup();
  }
  // Interrupted: the signal handler closes the window and owns the exit.
  if (aborter.signal.aborted) return;
  if (runError || !run) {
    if (runError instanceof RecheckInputError) failure(deps, runError.code, runError.message, runError.remediation);
    failure(
      deps,
      "chrome_unavailable",
      `the re-check could not drive Chrome for Clipy: ${(runError as Error | null)?.message ?? "no result"}`,
      "Run `clipy chrome status --json`; if Chrome for Clipy is running, re-run once.",
    );
  }

  const summary = summarize(run.steps);
  const report: RecheckReport = {
    ok: true,
    type: "clipy.recheck_report",
    version: RECHECK_REPORT_VERSION,
    original: {
      id: original.id,
      name: original.name,
      webUrl: original.webUrl,
      contextUrl,
      sourcePlatform: original.sourcePlatform,
      expectedResult: original.expectedResult,
      timelineStatus: original.timelineStatus,
      urlPrivacy: original.urlPrivacy,
      eventsRead: original.events.length,
      eventsTruncated: original.eventsTruncated,
    },
    start: { route: startUrl ? routeOf(startUrl) : null, originMapping: run.originMapping },
    run: {
      browser: "chrome-for-clipy",
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      framesDir,
      truncatedSteps: plan.truncatedSteps,
    },
    recording: null,
    summary,
    steps: run.steps,
    limitations: limitationsFor(original, planOpts),
    warnings: [],
  };
  // Written before the upload, so a failed upload never costs the report.
  writeReportFiles(outDir, report);

  if (opts.upload) {
    const frames = run.steps
      .filter((s) => s.observed.frame)
      .map((s) => ({ path: s.observed.frame as string, caption: frameCaption(s, run.steps.length) }));
    if (frames.length === 0) {
      report.warnings.push({
        code: "recheck_upload_failed",
        error: "no step frame was captured, so there is nothing to upload",
        remediation: "Read the report; the per-step results do not depend on the frames.",
      });
    } else {
      try {
        const uploaded = await deps.uploadFrames(frames, {
          name: `Re-check: ${original.name || original.id}`,
          description:
            `Re-check of ${original.webUrl ?? original.id} on ${report.start.route ?? "the start URL"}: ` +
            `${summary.matched} matched, ${summary.controlNotFound} control not found, ${summary.differentScreen} different screen, ` +
            `${summary.error} error, ${summary.unmapped} could not map.`,
          log,
        });
        report.recording = uploaded;
      } catch (error) {
        // The upload became a recording whose completion was not confirmed:
        // uploading the frames again would make a duplicate.
        const stranded = (error as { publicId?: string }).publicId;
        if (stranded) {
          report.recording = {
            id: stranded,
            shareUrl: `${deps.apiUrl}/video/${stranded}`,
            contextUrl: `${deps.apiUrl}/video/${stranded}.arec`,
          };
          report.warnings.push({
            code: "upload_unconfirmed",
            error: `the step frames were uploaded as ${stranded}, but the server did not confirm its completion: ${(error as Error).message}`,
            remediation: `Do not upload again; the recording exists. Check it with: clipy show ${stranded}`,
          });
        } else {
          report.warnings.push({
            code: "recheck_upload_failed",
            error: `the step frames could not be uploaded: ${(error as Error).message}`,
            remediation: `The report and frames are saved in ${outDir}. Upload them with \`clipy proof --frame\` if a share link is needed; do not re-run the whole re-check for it.`,
          });
        }
      }
    }
    writeReportFiles(outDir, report);
  }

  if (deps.json) {
    deps.printJson({ ...report, files: { json: join(outDir, "report.json"), markdown: join(outDir, "report.md") } });
  } else {
    process.stdout.write(renderMarkdown(report));
    process.stdout.write(`${deps.color.dim(`report: ${join(outDir, "report.json")}`)}\n`);
  }
  // exitCode, not exit(): a large report written to a pipe must be flushed
  // before the process ends (pipe writes are asynchronous on macOS).
  if (opts.failOnDivergence && summary.verdict !== "matches") process.exitCode = 4;
}
