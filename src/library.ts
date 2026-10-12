/**
 * Library management and bug-report evidence commands:
 *
 *   update, share, organize, folders, delete      (manage a recording)
 *   comments, comment                             (the review thread)
 *   analytics                                     (who watched)
 *   diagnostics, interactions                     (what the browser and the
 *                                                  pointer did, for bug reports)
 *
 * Each one is a thin call to a /api/v1 endpoint. They live here rather than in
 * index.ts so that file stops growing; index.ts owns argument parsing and hands
 * over a small set of helpers.
 */

export interface LibraryDeps {
  apiUrl: string;
  apiKey: string | null;
  version: string;
  json: boolean;
  normalizeId(input: string): string;
  die(message: string, code?: number): never;
  printJson(value: unknown): void;
  color: {
    bold(s: string): string;
    dim(s: string): string;
    green(s: string): string;
    yellow(s: string): string;
    red(s: string): string;
    cyan(s: string): string;
  };
}

type Json = Record<string, unknown>;

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Ends the command with an error. Under --json that is the CLI's documented
 * envelope, exactly one object on stdout:
 * {ok:false, code, error, remediation, partial:null}. Codes are the stable
 * ones `clipy guide --json` lists; agents branch on them, never on the text.
 */
export function failure(
  deps: Pick<LibraryDeps, "json" | "die">,
  code: string,
  message: string,
  remediation: string,
  exitCode = 1,
  partial: Record<string, unknown> | null = null,
): never {
  if (deps.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code, error: message, remediation, partial }, null, 2)}\n`,
    );
    process.exit(exitCode);
  }
  deps.die(remediation ? `${message}\n${remediation}` : message, exitCode);
}

const USAGE_REMEDY = "Fix the arguments; `clipy guide --json` lists every command's flags.";

function usage(deps: LibraryDeps, message: string): never {
  return failure(deps, "usage_error", message, USAGE_REMEDY, 2);
}

/** The scope each kind of call needs, and how to get a key that carries it. */
const SCOPE_REMEDIES: Record<string, string> = {
  "recordings:read": "clipy login",
  "recordings:write": "clipy login",
  "comments:read": "clipy login",
  "comments:write": "clipy login",
  "analytics:read": "clipy login",
  "recordings:delete": "clipy login --allow-delete",
  ingest: "clipy login",
};

function scopeRemedy(message: string): string {
  const missing = Object.keys(SCOPE_REMEDIES).filter((scope) => message.includes(scope));
  if (missing.length === 0) {
    return "The key lacks a permission this call needs. Create one with it at https://clipy.online/settings/api-keys; retrying with the same key cannot help.";
  }
  const remedy = SCOPE_REMEDIES[missing[0]];
  return (
    `Your key does not carry ${missing.join(", ")}. Run \`${remedy}\` to approve a key that does, ` +
    `or create one at https://clipy.online/settings/api-keys. Retrying with the same key cannot help.`
  );
}

async function request(
  deps: LibraryDeps,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Json> {
  if (!deps.apiKey) {
    failure(
      deps,
      "auth_required",
      "no API key",
      "Run `clipy login` to approve this device in your browser, or set CLIPY_API_KEY.",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${deps.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        Accept: "application/json",
        "User-Agent": `clipy-cli/${deps.version}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    failure(
      deps,
      "server_unreachable",
      (e as Error).name === "AbortError"
        ? `request timed out after ${FETCH_TIMEOUT_MS / 1000}s (${path})`
        : `could not reach ${deps.apiUrl}: ${(e as Error).message}`,
      "Check the network and `clipy doctor --json`, then re-run once.",
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = text ? (JSON.parse(text) as Json) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const msg = (typeof parsed.error === "string" && parsed.error) || `Clipy API error ${res.status}`;
    if (res.status === 401) {
      failure(deps, "auth_required", msg, "Run `clipy login` to set a new key, then retry.");
    }
    if (res.status === 403) failure(deps, "wrong_scope", msg, scopeRemedy(msg));
    if (res.status === 404) {
      failure(deps, "not_found", msg, "Check the id with `clipy list --json`; ids from another account never resolve.");
    }
    if (res.status === 429) {
      failure(deps, "quota_exceeded", msg, "Report the limit to the user and stop; a retry loop only burns it.");
    }
    if (res.status >= 500) {
      failure(deps, "server_unreachable", msg, "Clipy is having trouble; re-run once after a short pause.");
    }
    failure(deps, "invalid_request", msg, "The API refused this request as sent; re-running it unchanged fails the same way.");
  }
  return parsed;
}

function recordingPath(deps: LibraryDeps, id: string, sub = ""): { pid: string; path: string } {
  const pid = deps.normalizeId(id);
  return { pid, path: `/api/v1/recordings/${encodeURIComponent(pid)}${sub}` };
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// update / share / organize / folders / delete
// ---------------------------------------------------------------------------

export async function cmdUpdate(
  deps: LibraryDeps,
  id: string,
  opts: { title?: string; description?: string; clearDescription?: boolean },
): Promise<void> {
  const patch: Json = {};
  if (opts.title !== undefined) {
    if (!opts.title.trim()) usage(deps, "--title cannot be empty");
    patch.name = opts.title.trim();
  }
  if (opts.clearDescription) patch.description = null;
  else if (opts.description !== undefined) patch.description = opts.description;
  if (Object.keys(patch).length === 0) {
    usage(deps, 'usage: clipy update <id|url> [--title "<title>"] [--description "<text>" | --clear-description]');
  }
  const { path } = recordingPath(deps, id);
  const body = await request(deps, "PATCH", path, patch);
  if (deps.json) return deps.printJson(body);
  const rec = (body.recording ?? {}) as Json;
  out(`${deps.color.green("✓")} updated ${deps.color.bold(String(rec.name ?? rec.id ?? id))}`);
}

const ACCESS_MODES = ["public", "restricted", "private"] as const;

export async function cmdShare(deps: LibraryDeps, id: string, mode: string | undefined): Promise<void> {
  const { path } = recordingPath(deps, id, "/access");
  let body: Json;
  if (mode === undefined) {
    body = await request(deps, "GET", path);
  } else {
    if (!(ACCESS_MODES as readonly string[]).includes(mode)) {
      usage(deps, `share mode must be one of ${ACCESS_MODES.join(", ")}`);
    }
    body = await request(deps, "PUT", path, { mode });
  }
  if (deps.json) return deps.printJson(body);
  const access = (body.access ?? {}) as Json;
  const domains = Array.isArray(access.domains) ? (access.domains as string[]) : [];
  const verb = mode === undefined ? "sharing is" : "sharing set to";
  out(`${mode === undefined ? "" : `${deps.color.green("✓")} `}${verb} ${deps.color.bold(String(access.mode))}`);
  if (access.mode === "restricted") {
    out(
      deps.color.dim(
        `${access.grantedPeople ?? 0} people${domains.length ? `, domains: ${domains.join(", ")}` : ""}. Invite people from the share dialog on the watch page.`,
      ),
    );
  }
}

interface Folder {
  id: string;
  name: string;
  video_count?: number;
}

async function listFolders(deps: LibraryDeps): Promise<Folder[]> {
  const body = await request(deps, "GET", "/api/v1/folders");
  return Array.isArray(body.folders) ? (body.folders as Folder[]) : [];
}

export async function cmdFolders(deps: LibraryDeps, opts: { create?: string }): Promise<void> {
  if (opts.create !== undefined) {
    const name = opts.create.trim();
    if (!name) usage(deps, "usage: clipy folders --create <name>");
    const body = await request(deps, "POST", "/api/v1/folders", { name });
    if (deps.json) return deps.printJson(body);
    const folder = (body.folder ?? {}) as Folder;
    out(
      body.created === false
        ? `folder ${deps.color.bold(folder.name)} already exists ${deps.color.dim(folder.id)}`
        : `${deps.color.green("✓")} created folder ${deps.color.bold(folder.name)} ${deps.color.dim(folder.id)}`,
    );
    return;
  }
  const folders = await listFolders(deps);
  if (deps.json) return deps.printJson({ folders });
  if (folders.length === 0) {
    out(deps.color.dim("no folders yet. Create one with: clipy folders --create <name>"));
    return;
  }
  for (const folder of folders) {
    out(`${folder.id}\t${folder.name}\t${deps.color.dim(`${folder.video_count ?? 0} items`)}`);
  }
}

export async function cmdOrganize(
  deps: LibraryDeps,
  id: string,
  opts: { folder?: string; noFolder?: boolean; addTags: string[]; removeTags: string[] },
): Promise<void> {
  if (opts.folder !== undefined && opts.noFolder) {
    usage(deps, "--folder and --no-folder are mutually exclusive");
  }
  const patch: Json = {};
  if (opts.noFolder) patch.folderId = null;
  if (opts.folder !== undefined) {
    const wanted = opts.folder.trim();
    const folders = await listFolders(deps);
    const match =
      folders.find((f) => f.id === wanted) ??
      folders.find((f) => f.name.toLowerCase() === wanted.toLowerCase());
    if (!match) {
      failure(deps, "not_found", `no folder named "${wanted}"`, `Create it with: clipy folders --create "${wanted}"`);
    }
    patch.folderId = match.id;
  }
  if (opts.addTags.length) patch.addTags = opts.addTags;
  if (opts.removeTags.length) patch.removeTags = opts.removeTags;
  if (Object.keys(patch).length === 0) {
    usage(deps, "usage: clipy organize <id|url> [--folder <name|id> | --no-folder] [--tag <t>]… [--untag <t>]…");
  }
  const { path } = recordingPath(deps, id, "/organize");
  const body = await request(deps, "PATCH", path, patch);
  if (deps.json) return deps.printJson(body);
  const rec = (body.recording ?? {}) as Json;
  const tags = Array.isArray(rec.tags) ? (rec.tags as string[]) : [];
  out(
    `${deps.color.green("✓")} organized ${deps.color.bold(String(rec.id ?? id))}` +
      deps.color.dim(` folder: ${rec.folderId ?? "none"} · tags: ${tags.length ? tags.join(", ") : "none"}`),
  );
}

export async function cmdDelete(deps: LibraryDeps, id: string, opts: { yes: boolean }): Promise<void> {
  const { pid, path } = recordingPath(deps, id);
  if (!opts.yes) {
    failure(
      deps,
      "confirmation_required",
      `deleting ${pid} is permanent (video, transcript, summary, comments)`,
      "Only if the user asked for this recording to be deleted: re-run with --yes. The key also needs recordings:delete (clipy login --allow-delete).",
      2,
    );
  }
  const body = await request(deps, "DELETE", `${path}?confirm=${encodeURIComponent(pid)}`);
  if (deps.json) return deps.printJson(body);
  out(`${deps.color.green("✓")} deleted ${deps.color.bold(pid)}`);
}

// ---------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------

interface Comment {
  id: string;
  parentCommentId: string | null;
  body: string | null;
  timestampMs: number;
  createdAt: string;
  deletedAt: string | null;
  resolvedAt: string | null;
  author: { name: string };
}

export async function cmdComments(deps: LibraryDeps, id: string): Promise<void> {
  const { path } = recordingPath(deps, id, "/comments");
  const body = await request(deps, "GET", path);
  if (deps.json) return deps.printJson(body);
  const comments = Array.isArray(body.comments) ? (body.comments as Comment[]) : [];
  if (comments.length === 0) {
    out(deps.color.dim("no comments yet"));
    return;
  }
  const replies = new Map<string, Comment[]>();
  for (const comment of comments) {
    if (!comment.parentCommentId) continue;
    const list = replies.get(comment.parentCommentId) ?? [];
    list.push(comment);
    replies.set(comment.parentCommentId, list);
  }
  const line = (comment: Comment, indent: string) => {
    const text = comment.deletedAt ? deps.color.dim("(deleted)") : (comment.body ?? "");
    const resolved = comment.resolvedAt ? deps.color.green(" [resolved]") : "";
    out(`${indent}${deps.color.bold(comment.author.name)}${resolved}: ${text} ${deps.color.dim(comment.id)}`);
  };
  for (const comment of comments.filter((c) => !c.parentCommentId)) {
    process.stdout.write(`${deps.color.cyan(`[${fmtClock(comment.timestampMs)}]`)} `);
    line(comment, "");
    for (const reply of replies.get(comment.id) ?? []) line(reply, "    ↳ ");
  }
  if (body.commentsEnabled === false) out(deps.color.dim("new comments are turned off for this recording"));
}

export async function cmdComment(
  deps: LibraryDeps,
  id: string,
  text: string,
  opts: { atSeconds?: number; replyTo?: string },
): Promise<void> {
  if (!text.trim()) usage(deps, 'usage: clipy comment <id|url> "<text>" [--at <seconds> | --reply-to <comment-id>]');
  if (opts.replyTo && opts.atSeconds !== undefined) {
    usage(deps, "--at applies to a new comment; a reply sits under its parent. Pick one.");
  }
  const payload = opts.replyTo
    ? { kind: "reply", body: text, parentCommentId: opts.replyTo }
    : { kind: "comment", body: text, timestampMs: Math.round((opts.atSeconds ?? 0) * 1000) };
  const { path } = recordingPath(deps, id, "/comments");
  const body = await request(deps, "POST", path, payload);
  if (deps.json) return deps.printJson(body);
  const comment = (body.comment ?? {}) as Comment;
  out(`${deps.color.green("✓")} ${opts.replyTo ? "replied" : `commented at ${fmtClock(comment.timestampMs ?? 0)}`} ${deps.color.dim(comment.id ?? "")}`);
}

// ---------------------------------------------------------------------------
// analytics
// ---------------------------------------------------------------------------

export async function cmdAnalytics(deps: LibraryDeps, id: string, opts: { range?: number }): Promise<void> {
  const { path } = recordingPath(deps, id, "/analytics");
  const body = await request(deps, "GET", opts.range ? `${path}?range=${opts.range}` : path);
  if (deps.json) return deps.printJson(body);
  if (body.gated) {
    const teaser = (body.teaser ?? {}) as Json;
    out(`${body.viewCount ?? 0} opens · ${teaser.uniqueViewers ?? 0} unique viewers · ${teaser.sessions ?? 0} sessions`);
    out(deps.color.dim(`Who watched and how far is a Pro feature: ${body.upgradeUrl ?? "https://clipy.online/pricing"}`));
    return;
  }
  const analytics = (body.analytics ?? {}) as Json;
  const totals = (analytics.totals ?? {}) as Json;
  out(
    `${totals.viewCount ?? 0} opens · ${totals.uniqueViewers ?? 0} unique viewers · ${totals.plays ?? 0} plays · ` +
      `${Math.round(Number(totals.avgCompletionPercent ?? 0))}% average completion`,
  );
  const viewers = ((analytics.viewers ?? {}) as Json).identified;
  if (Array.isArray(viewers) && viewers.length) {
    out(deps.color.bold("VIEWERS"));
    for (const v of viewers as Json[]) {
      out(`  ${v.name}\t${Math.round(Number(v.bestCompletionPercent ?? 0))}%\t${deps.color.dim(String(v.lastWatchedAt ?? ""))}`);
    }
  }
  const anonymous = ((analytics.viewers ?? {}) as Json).anonymousCount;
  if (anonymous) out(deps.color.dim(`  + ${anonymous} anonymous`));
  if (body.analyticsDisabled) out(deps.color.dim("viewer analytics are off for this recording"));
}

// ---------------------------------------------------------------------------
// diagnostics / interactions: the bug-report evidence the Chrome extension
// and Clipy-driven browsers attach to a recording.
// ---------------------------------------------------------------------------

export interface DiagnosticsOpts {
  console?: boolean;
  network?: boolean;
  errors?: boolean;
  levels?: string;
  status?: string;
  method?: string;
  host?: string;
  bodies?: string;
  limit?: number;
  after?: number;
}

export type DiagnosticsStream = "console" | "network" | "all";

/**
 * The query (or queries) a diagnostics call needs. The API ANDs its filters,
 * and a status filter only ever matches network rows, so "everything that
 * went wrong" (console errors, uncaught exceptions AND failed requests) is two
 * queries whose events the CLI merges by time. Each query is its own stream
 * with its own continuation offset, which is why `--after` is only accepted
 * once the call is narrowed to one stream.
 */
export function diagnosticsQueries(opts: DiagnosticsOpts): Array<{ stream: DiagnosticsStream; query: URLSearchParams }> {
  const common = (query: URLSearchParams) => {
    if (opts.bodies) query.set("bodies", opts.bodies);
    if (opts.limit) query.set("limit", String(opts.limit));
    if (opts.after !== undefined) query.set("after", String(opts.after));
    return query;
  };
  const consoleQuery = (errorsOnly: boolean) => {
    const query = new URLSearchParams({ kinds: "console,error" });
    const levels = opts.levels ?? (errorsOnly ? "error" : undefined);
    if (levels) query.set("levels", levels);
    return { stream: "console" as const, query: common(query) };
  };
  const networkQuery = (errorsOnly: boolean) => {
    const query = new URLSearchParams({ kinds: "network" });
    const status = opts.status ?? (errorsOnly ? "failed" : undefined);
    if (status) query.set("status", status);
    if (opts.method) query.set("method", opts.method.toUpperCase());
    if (opts.host) query.set("host", opts.host);
    return { stream: "network" as const, query: common(query) };
  };

  const wantConsole = Boolean(opts.console);
  const wantNetwork = Boolean(opts.network || opts.status || opts.method || opts.host);
  if (opts.errors) {
    if (wantConsole && !wantNetwork) return [consoleQuery(true)];
    if (wantNetwork && !wantConsole) return [networkQuery(true)];
    return [consoleQuery(true), networkQuery(true)];
  }
  if (wantConsole && wantNetwork) return [consoleQuery(false), networkQuery(false)];
  if (wantConsole) return [consoleQuery(false)];
  if (wantNetwork) return [networkQuery(false)];
  if (opts.levels) return [consoleQuery(false)];
  // No filter: the whole sidecar, unless paging or body options were given.
  const paging = common(new URLSearchParams());
  return paging.toString() ? [{ stream: "all", query: paging }] : [];
}

/** The command that continues one stream from `after`, so a reader never has to guess an offset. */
function continueCommand(id: string, opts: DiagnosticsOpts, stream: DiagnosticsStream, after: number): string {
  const flags = ["clipy", "diagnostics", id];
  if (opts.errors) flags.push("--errors");
  if (stream === "console") flags.push("--console");
  if (stream === "network") flags.push("--network");
  if (stream === "console" && opts.levels) flags.push("--levels", opts.levels);
  if (stream === "network") {
    if (opts.status) flags.push("--status", opts.status);
    if (opts.method) flags.push("--method", opts.method);
    if (opts.host) flags.push("--host", opts.host);
  }
  if (opts.bodies) flags.push("--bodies", opts.bodies);
  if (opts.limit) flags.push("--limit", String(opts.limit));
  flags.push("--after", String(after));
  return flags.join(" ");
}

function describeEvent(deps: LibraryDeps, event: Json): string {
  const kind = String(event.kind);
  switch (kind) {
    case "console": {
      const level = String(event.level);
      const tag = level === "error" ? deps.color.red(`console.${level}`) : level === "warn" ? deps.color.yellow(`console.${level}`) : `console.${level}`;
      return `${tag}  ${event.message}`;
    }
    case "error":
    case "unhandled_rejection":
      return `${deps.color.red(kind)}  ${event.message}${event.source ? deps.color.dim(` (${event.source}:${event.line ?? "?"})`) : ""}`;
    case "network": {
      const failed = event.outcome !== "success";
      const status = event.status === null ? String(event.outcome) : String(event.status);
      const label = `${event.method} ${failed ? deps.color.red(status) : status}`;
      const gql = event.graphql as Json | undefined;
      const extra = gql?.first_error ? deps.color.red(` graphql: ${gql.first_error}`) : event.error ? deps.color.red(` ${event.error}`) : "";
      return `network  ${label} ${event.url} ${deps.color.dim(`${event.duration_ms}ms`)}${extra}`;
    }
    case "navigation":
      return `${deps.color.cyan("navigate")}  ${event.url}`;
    case "action":
      return `action  ${event.action} ${event.target}`;
    case "stream":
      return `stream  ${event.protocol} ${event.action} ${event.url}`;
    default:
      return `${kind}  ${JSON.stringify(event)}`;
  }
}

export async function cmdDiagnostics(deps: LibraryDeps, id: string, opts: DiagnosticsOpts): Promise<void> {
  const { pid, path } = recordingPath(deps, id, "/browser-diagnostics");
  const queries = diagnosticsQueries(opts);
  if (queries.length > 1 && opts.after !== undefined) {
    usage(
      deps,
      "--after continues one stream, and this call merges console and network events. " +
        "Add --console or --network (the follow-up commands printed after a truncated page do this for you).",
    );
  }
  const responses = queries.length
    ? await Promise.all(queries.map(({ query }) => request(deps, "GET", `${path}?${query}`)))
    : [await request(deps, "GET", path)];
  const first = responses[0];
  const diagnostics = first.diagnostics as Json | null;
  const events = responses
    .flatMap((body) => {
      const d = body.diagnostics as Json | null;
      return d && Array.isArray(d.events) ? (d.events as Json[]) : [];
    })
    .sort((a, b) => Number(a.time_ms ?? 0) - Number(b.time_ms ?? 0));
  const streams = responses.flatMap((body, index) => {
    const page = body.page as Json | undefined;
    if (!page) return [];
    const stream = queries[index]?.stream ?? "all";
    const nextAfter = typeof page.nextAfter === "number" ? page.nextAfter : null;
    return [{
      stream,
      query: queries[index]?.query.toString() ?? "",
      totalEvents: page.totalEvents,
      totalMatching: page.totalMatching,
      returned: page.returned,
      nextAfter,
      continueWith: nextAfter === null ? null : continueCommand(pid, opts, stream, nextAfter),
    }];
  });

  if (deps.json) {
    if (responses.length === 1) return deps.printJson(first);
    return deps.printJson({
      ...first,
      diagnostics: diagnostics ? { ...diagnostics, events } : null,
      page: {
        returned: events.length,
        truncated: streams.some((stream) => stream.nextAfter !== null),
        streams,
      },
    });
  }
  if (!diagnostics) {
    out(deps.color.dim("this recording has no browser diagnostics. They are captured by the Clipy Chrome extension's bug capture, or by browsers Clipy drives (clipy record / session)."));
    return;
  }
  const env = (diagnostics.environment ?? {}) as Json;
  const browser = [env.browser_name, env.browser_version].filter(Boolean).join(" ");
  const os = [env.os_name, env.os_version].filter(Boolean).join(" ");
  const viewport = env.viewport_width ? `${env.viewport_width}×${env.viewport_height}` : "";
  out(deps.color.bold([browser, os, viewport].filter(Boolean).join(" · ") || "browser"));
  if (env.page_url) out(deps.color.dim(String(env.page_url)));
  if (first.attestationNote) out(deps.color.dim(String(first.attestationNote)));
  if (events.length === 0) out(deps.color.dim("no matching events"));
  for (const event of events) {
    out(`${deps.color.cyan(fmtClock(Number(event.time_ms ?? 0)))}  ${describeEvent(deps, event)}`);
  }
  if (streams.length) {
    const total = streams.reduce((sum, stream) => sum + Number(stream.totalMatching ?? 0), 0);
    out(deps.color.dim(`${events.length} of ${total} matching events (${streams[0].totalEvents} captured)`));
    for (const stream of streams) {
      if (!stream.continueWith) continue;
      const label = stream.stream === "console" ? "more console events" : stream.stream === "network" ? "more requests" : "more events";
      out(deps.color.dim(`${label}: ${stream.continueWith}`));
    }
  }
  if (Number(diagnostics.dropped_events ?? 0) > 0) {
    out(deps.color.yellow(`${diagnostics.dropped_events} events were dropped during capture`));
  }
}

export async function cmdInteractions(
  deps: LibraryDeps,
  id: string,
  opts: { types?: string; fromMs?: number; toMs?: number; limit?: number; cursor?: string },
): Promise<void> {
  const { path } = recordingPath(deps, id, "/interactions");
  const query = new URLSearchParams();
  if (opts.types) query.set("types", opts.types);
  if (opts.fromMs !== undefined) query.set("fromMs", String(opts.fromMs));
  if (opts.toMs !== undefined) query.set("toMs", String(opts.toMs));
  if (opts.limit) query.set("limit", String(opts.limit));
  // A cursor is bound to the filters that produced it, so a follow-up call
  // must repeat the same --types/--from-ms/--to-ms alongside it.
  if (opts.cursor) query.set("cursor", opts.cursor);
  const qs = query.toString();
  const body = await request(deps, "GET", qs ? `${path}?${qs}` : path);
  if (deps.json) return deps.printJson(body);
  if (body.status === "preparing") {
    out(deps.color.dim("the interaction timeline is being prepared. Try again in a minute."));
    return;
  }
  const events = Array.isArray(body.events) ? (body.events as Json[]) : [];
  if (events.length === 0) {
    out(deps.color.dim(`no interactions (${body.status ?? "absent"})`));
    return;
  }
  for (const event of events) {
    const target = event.target as Json | undefined;
    const label = target?.label ? `${target.role ?? "element"} "${target.label}"` : "";
    const at = event.position as Json | undefined;
    const where = at ? deps.color.dim(` @${at.x},${at.y}`) : "";
    const evidence = event.evidence as Json | undefined;
    out(
      `${deps.color.cyan(fmtClock(Number(event.tMs ?? 0)))}  ${event.kind}${label ? ` ${label}` : ""}${where}` +
        (evidence?.caption ? deps.color.dim(`  ${evidence.caption}`) : ""),
    );
  }
  const pagination = body.pagination as Json | undefined;
  if (pagination?.nextCursor) {
    out(deps.color.dim(`more events: re-run with the same filters and --cursor ${pagination.nextCursor}`));
  }
}
