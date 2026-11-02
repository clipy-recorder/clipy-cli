/**
 * `clipy recheck <id> --url <start-url>`: replays a recorded workflow against
 * today's UI and reports, step by step, where it still works and where it
 * diverges.
 *
 * The original run comes from the existing API: the interaction timeline
 * (clicks with element labels, navigations, scrolls, typing bursts), key
 * moments (frames) and the transcript. The replay drives Chrome for Clipy
 * through a small RecheckDriver interface, so everything here except
 * `createPageDriver` is plain data in, plain data out and testable without a
 * browser.
 *
 * Honesty rules, which are the point of the command:
 *  - A click is replayed only by its recorded element label. A raw position is
 *    never clicked on its own; an unlabelled click is reported as "could not
 *    map step" instead of a guess.
 *  - Typed values are never captured, so typing is never replayed.
 *  - A step whose page does not match the recorded route is "different
 *    screen" and is not clicked: clicking a same-named control on another
 *    screen is exactly the silent failure this command exists to catch.
 *
 * Safety rules, because the replay runs on a real, signed-in site:
 *  - A control whose name reads as irreversible (delete, pay, send, submit and
 *    similar) is not clicked unless the caller passes allowIrreversible.
 *  - A recorded page is opened directly only on the recording's own host
 *    (moved onto the re-check's host), never on a host the timeline names.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RECHECK_REPORT_VERSION = 1;
/** clipy proof accepts 1-50 frames, and one frame is captured per step. */
export const RECHECK_MAX_STEPS = 50;

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Inputs, as the API returns them
// ---------------------------------------------------------------------------

export interface TimelineEvent {
  id?: string;
  kind: string;
  tMs: number;
  endMs?: number;
  position?: { x: number; y: number };
  target?: { role: string | null; label: string | null };
  pageUrl?: string;
  button?: string;
  direction?: string;
  eventCount?: number;
  evidence?: { tMs: number; caption: string; frameUrl: string | null; cropUrl: string | null };
}

export interface KeyMoment {
  tMs: number;
  caption: string;
  frameUrl: string | null;
  cropUrl?: string | null;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface OriginalRun {
  id: string;
  name: string;
  webUrl: string | null;
  sourcePlatform: string | null;
  /** Issue #741: "what should have happened". Optional; absent on older servers. */
  expectedResult: string | null;
  timelineStatus: string;
  urlPrivacy: string | null;
  events: TimelineEvent[];
  eventsTruncated: boolean;
  moments: KeyMoment[];
  segments: TranscriptSegment[];
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type StepKind = "start" | "navigate" | "click" | "scroll" | "type" | "drag";

export interface PlannedStep {
  index: number;
  kind: StepKind;
  tMs: number;
  /** Recorded element label and role (clicks). */
  label: string | null;
  role: string | null;
  /** Normalized 0..1 of the capture viewport (clicks). */
  position: { x: number; y: number } | null;
  /** Recorded page route: origin + path with ids as `:id`, query keys only. */
  route: string | null;
  direction: string | null;
  button: string | null;
  /** Set when the step cannot be replayed at all; the reason says why. */
  unmappable: string | null;
  original: {
    caption: string | null;
    frameUrl: string | null;
    cropUrl: string | null;
    said: string | null;
  };
}

export interface RecheckPlan {
  steps: PlannedStep[];
  /** Steps dropped because the plan was longer than maxSteps. */
  truncatedSteps: number;
}

const MOMENT_MATCH_MS = 2_500;

/** Words on a control that usually change or spend something on a real
 *  account and cannot be taken back. A heuristic: it errs toward not clicking,
 *  and --allow-destructive turns it off. */
const IRREVERSIBLE_LABEL =
  /\b(?:delete|remove|destroy|erase|purge|wipe|discard|pay|purchase|buy|checkout|check out|place order|order now|subscribe|unsubscribe|upgrade|downgrade|cancel (?:subscription|plan|account|order|membership|trial)|transfer|send|submit|publish|deploy|merge|archive|revoke|deactivate|reset|refund|charge|donate|invite|confirm|approve|reject|sign out|log out|logout|leave)\b/i;

export function looksIrreversible(label: string | null | undefined): boolean {
  return Boolean(label && IRREVERSIBLE_LABEL.test(label.replace(/\s+/g, " ")));
}

function irreversibleReason(name: string): string {
  return `"${name}" looks like it changes or spends something that cannot be undone (delete, pay, send, submit and similar), so it is not clicked without --allow-destructive`;
}

export interface PlanOptions {
  /** Replay clicks on controls that look irreversible (--allow-destructive). */
  allowIrreversible?: boolean;
}

function nearestMoment(tMs: number, moments: readonly KeyMoment[]): KeyMoment | null {
  let best: KeyMoment | null = null;
  for (const m of moments) {
    if (!best || Math.abs(m.tMs - tMs) < Math.abs(best.tMs - tMs)) best = m;
  }
  return best && Math.abs(best.tMs - tMs) <= MOMENT_MATCH_MS ? best : null;
}

/** What was said while the step happened: the segment covering it, else the
 *  last one that ended within two seconds before it. */
export function saidAt(tMs: number, segments: readonly TranscriptSegment[]): string | null {
  const t = tMs / 1000;
  const covering = segments.find((s) => s.start <= t && t <= s.end);
  if (covering) return covering.text.trim() || null;
  let previous: TranscriptSegment | null = null;
  for (const s of segments) if (s.end <= t && t - s.end <= 2 && (!previous || s.end > previous.end)) previous = s;
  return previous?.text.trim() || null;
}

/** Turns the recorded timeline into replayable steps. Pointer moves, dwells
 *  and highlights are evidence, not actions, and are skipped. Repeated
 *  navigations to one route (SPA re-renders) and consecutive scrolls in one
 *  direction collapse into one step. */
export function buildRecheckPlan(
  run: Pick<OriginalRun, "events" | "moments" | "segments">,
  maxSteps = RECHECK_MAX_STEPS,
  planOpts: PlanOptions = {},
): RecheckPlan {
  const events = [...run.events].sort((a, b) => a.tMs - b.tMs);
  const steps: Omit<PlannedStep, "index">[] = [];
  let lastRoute: string | null = null;
  for (const event of events) {
    const evidence = event.evidence ?? null;
    const moment = evidence ? null : nearestMoment(event.tMs, run.moments);
    const original = {
      caption: evidence?.caption ?? moment?.caption ?? null,
      frameUrl: evidence?.frameUrl ?? moment?.frameUrl ?? null,
      cropUrl: evidence?.cropUrl ?? moment?.cropUrl ?? null,
      said: saidAt(event.tMs, run.segments),
    };
    const base = {
      tMs: Math.max(0, Math.round(event.tMs)),
      label: null,
      role: null,
      position: null,
      route: event.pageUrl ?? lastRoute,
      direction: null,
      button: null,
      unmappable: null,
      original,
    };
    switch (event.kind) {
      case "navigation": {
        const route = event.pageUrl ?? null;
        if (!route || route === lastRoute) break;
        steps.push({ ...base, kind: steps.length === 0 ? "start" : "navigate", route });
        lastRoute = route;
        break;
      }
      case "click": {
        const label = event.target?.label?.trim() || null;
        const button = event.button ?? "primary";
        let unmappable: string | null = null;
        if (button !== "primary") {
          unmappable = `a ${button}-button click is not replayed`;
        } else if (!label) {
          unmappable = "no element label was recorded for this click, and a raw screen position is not clicked on its own";
        } else if (!planOpts.allowIrreversible && looksIrreversible(label)) {
          unmappable = irreversibleReason(label);
        }
        steps.push({
          ...base,
          kind: "click",
          label,
          role: event.target?.role ?? null,
          position: event.position ?? null,
          button,
          unmappable,
        });
        break;
      }
      case "scroll": {
        const direction = event.direction ?? "mixed";
        const prev = steps[steps.length - 1];
        if (prev?.kind === "scroll" && prev.direction === direction) break;
        steps.push({
          ...base,
          kind: "scroll",
          direction,
          unmappable: direction === "mixed" ? "the recorded scroll has no single direction" : null,
        });
        break;
      }
      case "typing":
        steps.push({
          ...base,
          kind: "type",
          unmappable: "typed values are never captured in a recording, so typing is not replayed",
        });
        break;
      case "drag":
        steps.push({
          ...base,
          kind: "drag",
          position: event.position ?? null,
          unmappable: "drags are not replayed yet",
        });
        break;
      default:
        break;
    }
    if (event.pageUrl) lastRoute = event.pageUrl;
  }
  const kept = steps.slice(0, maxSteps).map((s, i) => ({ ...s, index: i + 1 }));
  return { steps: kept, truncatedSteps: Math.max(0, steps.length - kept.length) };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Mirrors SENSITIVE_PATH_SEGMENT_PATTERN in lib/browserDiagnostics.ts, which is
// how recorded routes were redacted: long numbers, UUIDs, long tokens and
// mixed letter-digit ids become `:id`.
const SENSITIVE_PATH_SEGMENT =
  /^(?:[0-9]{4,}|[A-Fa-f0-9]{8}-(?:[A-Fa-f0-9]{4}-){3}[A-Fa-f0-9]{12}|[A-Za-z0-9_-]{16,}|(?=[A-Za-z0-9_-]{10,}$)(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]+)$/;

function segmentsOf(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/** A live URL reduced to the same shape recordings store: origin and path,
 *  with id-like segments as `:id` and no query or hash. Used in reports, so a
 *  token in the live URL never lands in one. */
export function routeOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const path = segmentsOf(u.pathname)
      .map((s) => (SENSITIVE_PATH_SEGMENT.test(s) ? ":id" : s))
      .join("/");
    return `${u.origin}/${path}`;
  } catch {
    return null;
  }
}

export function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Whether a live URL is on the recorded route. `:id` and redacted segments
 *  match anything; query strings are ignored (recordings keep key names only).
 *  With `ignoreOrigin` (the re-check runs on another host, e.g. staging) only
 *  the path is compared. */
export function routeMatches(expected: string, liveUrl: string, ignoreOrigin: boolean, originOnly = false): boolean {
  let exp: URL;
  let live: URL;
  try {
    exp = new URL(expected);
    live = new URL(liveUrl);
  } catch {
    return false;
  }
  if (!ignoreOrigin && exp.origin !== live.origin) return false;
  // The recording kept origins only: there is no path to compare.
  if (originOnly) return true;
  const a = segmentsOf(exp.pathname);
  const b = segmentsOf(live.pathname);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => {
    if (seg === ":id" || seg.includes("[redacted")) return true;
    let liveSeg = b[i];
    try {
      liveSeg = decodeURIComponent(liveSeg);
    } catch {
      // keep it encoded
    }
    let expSeg = seg;
    try {
      expSeg = decodeURIComponent(seg);
    } catch {
      // keep it encoded
    }
    return expSeg === liveSeg;
  });
}

/** A recorded route we can open directly: no redacted parts and no query
 *  (only key names were kept, so the values are gone). */
export function concreteRoute(route: string): boolean {
  return !route.includes(":id") && !route.includes("[redacted") && !route.includes("?");
}

/** Moves a recorded route onto the re-check's origin. */
export function mapOrigin(route: string, toOrigin: string): string {
  try {
    const u = new URL(route);
    return `${toOrigin}${u.pathname}`;
  } catch {
    return route;
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface LocateHint {
  label: string;
  role: string | null;
  /** Normalized 0..1; null when the recording had no position. */
  x: number | null;
  y: number | null;
}

export interface LocatedControl {
  name: string;
  role: string;
  quality: "exact" | "partial";
  /** Viewport pixels of the control's centre, after scrolling it into view. */
  x: number;
  y: number;
  candidates: number;
}

export type LocateResult =
  | { status: "found"; control: LocatedControl }
  | { status: "none"; nearby: string[] }
  | { status: "ambiguous"; candidates: number }
  | { status: "covered"; control: LocatedControl; coveredBy: string }
  | { status: "disabled"; control: LocatedControl };

export interface RecheckDriver {
  open(url: string): Promise<void>;
  url(): Promise<string>;
  locate(hint: LocateHint): Promise<LocateResult>;
  click(x: number, y: number): Promise<void>;
  scroll(direction: string): Promise<void>;
  /** Waits for the page to settle after an action. */
  settle(): Promise<void>;
  screenshot(path: string): Promise<void>;
}

/** Structural slice of a Playwright Page, so this module needs no playwright import. */
export interface RecheckPage {
  url(): string;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  mouse: {
    click(x: number, y: number): Promise<void>;
    wheel(dx: number, dy: number): Promise<void>;
  };
  screenshot(opts: { path: string; type?: "png" }): Promise<unknown>;
  waitForLoadState?(state: "load" | "domcontentloaded" | "networkidle", opts?: { timeout?: number }): Promise<void>;
}

/**
 * Runs in the page. Collects the visible controls (interactive elements, and
 * pointer-cursor elements that hold no interactive element), computes each
 * control's OWN accessible name, roughly per accname (aria-labelledby,
 * aria-label, a form control's value or label, alt, then the text of its
 * rendered subtree with hidden parts skipped, then title), and matches the
 * recorded label against that name only. Descendant text never names an
 * ancestor on its own: `<button aria-label="Preview"><span>Save</span>` is
 * "Preview". A name equal to the label (case and whitespace folded) is exact;
 * the label plus digits or punctuation only (an unread count, "Inbox 3") is
 * partial; a name that adds words ("Cancel plan" for "Cancel") is another
 * control. Several matches are told apart by the recorded role, then by
 * distance to the recorded position; with no way to choose, it reports
 * "ambiguous" rather than picking one.
 *
 * Everything works on the composed (flat) tree: open shadow roots are walked,
 * names cross into shadow content and slots, containment and the coverage
 * hit test descend through shadow hosts. Iframes are not searched.
 */
const LOCATE_SCRIPT = `(hint) => {
  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const clean = (s, n) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, n);
  const want = norm(hint.label);
  const roleWant = norm(hint.role).replace(/^ax/, "");
  // Interactive roles only: [role] alone would make a dialog, list or landmark
  // around the text the "control", and a dialog's tabindex="-1" likewise.
  const ROLES = ["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "checkbox", "radio", "switch", "option", "combobox", "treeitem", "textbox", "searchbox", "slider", "spinbutton"];
  const CLICKABLE = 'a[href],button,input,select,textarea,summary,label,option,[onclick],[tabindex]:not([tabindex^="-"]),[contenteditable="true"],' + ROLES.map((r) => '[role="' + r + '"]').join(",");

  // Composed-tree helpers: a shadow root's parent is its host.
  const parentOf = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  const composedContains = (outer, inner) => {
    for (let n = inner; n; n = parentOf(n)) if (n === outer) return true;
    return false;
  };
  const composedClosest = (el, selector) => {
    for (let n = el; n; n = parentOf(n)) if (n.matches && n.matches(selector)) return n;
    return null;
  };
  const childrenOf = (node) => {
    if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
    if (node.tagName === "SLOT") {
      const assigned = node.assignedNodes({ flatten: true });
      return assigned.length ? assigned : Array.from(node.childNodes);
    }
    return Array.from(node.childNodes);
  };
  const hiddenForName = (el) => {
    if (el.getAttribute("aria-hidden") === "true" || el.hidden) return true;
    const s = getComputedStyle(el);
    return s.display === "none" || s.visibility === "hidden";
  };

  /** The text an element contributes to its ancestor's name: its own
   *  aria-label or alt when it has one, else its rendered subtree. */
  const subtreeText = (node) => {
    if (node.nodeType === 3) return node.data;
    if (node.nodeType !== 1 || hiddenForName(node)) return "";
    const aria = node.getAttribute("aria-label");
    if (aria && aria.trim()) return " " + aria + " ";
    const tag = node.tagName.toLowerCase();
    if (tag === "img") return " " + (node.getAttribute("alt") || "") + " ";
    if (tag === "input" && ["button", "submit", "reset"].includes((node.getAttribute("type") || "").toLowerCase())) return " " + node.value + " ";
    const inner = childrenOf(node).map(subtreeText).join("");
    const display = getComputedStyle(node).display;
    return display === "inline" ? inner : " " + inner + " ";
  };
  const byId = (el, id) => {
    const root = el.getRootNode();
    return (root.getElementById && root.getElementById(id)) || document.getElementById(id);
  };
  const nameOf = (el) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\\s+/).map((id) => { const n = byId(el, id); return n ? childrenOf(n).map(subtreeText).join("") : ""; }).join(" ");
      if (norm(t)) return t;
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return el.value || type;
      if (type === "image") return el.getAttribute("alt") || el.getAttribute("title") || "";
    }
    if (tag === "input" || tag === "select" || tag === "textarea") {
      if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => childrenOf(l).map(subtreeText).join("")).join(" ");
      return el.getAttribute("placeholder") || el.getAttribute("title") || "";
    }
    if (tag === "img") return el.getAttribute("alt") || el.getAttribute("title") || "";
    const text = childrenOf(el).map(subtreeText).join("");
    if (norm(text)) return text;
    return el.getAttribute("title") || "";
  };
  const roleOf = (el) => norm(el.getAttribute("role") || ({ a: "link", button: "button", input: "textbox", select: "combobox", textarea: "textbox", summary: "button" })[el.tagName.toLowerCase()] || el.tagName);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
  };
  const pointer = (el) => el && el.nodeType === 1 && getComputedStyle(el).cursor === "pointer";
  /** A control: an interactive element, or the outermost pointer-cursor
   *  element (cursor inherits) that is not inside or around an interactive one. */
  const isControl = (el) => {
    if (el.matches(CLICKABLE)) return true;
    if (!pointer(el) || pointer(parentOf(el))) return false;
    if (composedClosest(el, CLICKABLE)) return false;
    return !el.querySelector(CLICKABLE);
  };

  const exact = new Set(), partial = new Set(), all = new Set();
  const visit = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (el.shadowRoot) visit(el.shadowRoot);
      if (!isControl(el) || !visible(el)) continue;
      all.add(el);
      const name = norm(nameOf(el));
      if (!name) continue;
      if (name === want) exact.add(el);
      else if (want.length >= 3 && name.includes(want) && !/\\p{L}/u.test(name.replace(want, ""))) partial.add(el);
    }
  };
  visit(document);
  // A control nested in another with the same name (a button inside a link):
  // keep the outermost one.
  const prune = (set) => Array.from(set).filter((el) => !Array.from(set).some((o) => o !== el && composedContains(o, el)));
  let quality = "exact";
  let pool = prune(exact);
  if (!pool.length) { pool = prune(partial); quality = "partial"; }
  const vw = innerWidth, vh = innerHeight;
  const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  if (!pool.length) {
    const px = hint.x == null ? vw / 2 : hint.x * vw, py = hint.y == null ? vh / 2 : hint.y * vh;
    const nearby = Array.from(all)
      .map((el) => ({ el, d: Math.hypot(center(el).x - px, center(el).y - py), n: clean(nameOf(el), 60) }))
      .filter((c) => c.n)
      .sort((a, b) => a.d - b.d)
      .slice(0, 6)
      .map((c) => c.n);
    return { status: "none", nearby: Array.from(new Set(nearby)) };
  }
  // A disabled control ignores the click, so it is never "matched": prefer an
  // enabled one with the same name, and report it when every one is disabled.
  const disabled = (el) => el.matches(":disabled") || Boolean(composedClosest(el, '[aria-disabled="true"]'));
  const enabled = pool.filter((el) => !disabled(el));
  const allDisabled = enabled.length === 0;
  if (!allDisabled) pool = enabled;
  if (pool.length > 1 && roleWant) {
    const byRole = pool.filter((el) => roleOf(el) === roleWant || roleOf(el).includes(roleWant) || roleWant.includes(roleOf(el)));
    if (byRole.length) pool = byRole;
  }
  let chosen = pool[0];
  if (pool.length > 1) {
    if (hint.x == null || hint.y == null) return { status: "ambiguous", candidates: pool.length };
    const px = hint.x * vw, py = hint.y * vh;
    pool.sort((a, b) => Math.hypot(center(a).x - px, center(a).y - py) - Math.hypot(center(b).x - px, center(b).y - py));
    chosen = pool[0];
  }
  const r0 = chosen.getBoundingClientRect();
  // "instant": a page with scroll-behavior: smooth would otherwise still be
  // scrolling when the centre is measured, and the click would land elsewhere.
  if (r0.top < 0 || r0.left < 0 || r0.bottom > vh || r0.right > vw) chosen.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const c = center(chosen);
  const control = { name: clean(nameOf(chosen), 120), role: roleOf(chosen), quality, x: Math.round(c.x), y: Math.round(c.y), candidates: pool.length };
  if (allDisabled) return { status: "disabled", control };
  if (c.x < 0 || c.y < 0 || c.x >= vw || c.y >= vh) return { status: "covered", control, coveredBy: "the edge of the window (it could not be scrolled into view)" };
  // Hit test on the composed tree: document.elementFromPoint stops at a
  // shadow host, so descend through open shadow roots to the real element.
  let top = document.elementFromPoint(c.x, c.y);
  while (top && top.shadowRoot) {
    const inner = top.shadowRoot.elementFromPoint(c.x, c.y);
    if (!inner || inner === top) break;
    top = inner;
  }
  if (!top) return { status: "covered", control, coveredBy: "nothing the page reports at that point" };
  if (!composedContains(chosen, top) && !composedContains(top, chosen)) {
    const name = clean(nameOf(top), 60);
    return { status: "covered", control, coveredBy: top.tagName.toLowerCase() + (name ? ' "' + name + '"' : "") };
  }
  return { status: "found", control };
}`;

export function createPageDriver(page: RecheckPage, opts: { settleMs: number }): RecheckDriver {
  const settle = async () => {
    try {
      await page.waitForLoadState?.("domcontentloaded", { timeout: 10_000 });
    } catch {
      // a slow page is still checked in whatever state it reached
    }
    await new Promise((r) => setTimeout(r, opts.settleMs));
  };
  return {
    async open(url) {
      try {
        await page.goto(url, { waitUntil: "load", timeout: 30_000 });
      } catch (error) {
        // A load that times out still leaves a page to check; an unreachable
        // URL does not.
        if (!/timeout/i.test(String((error as Error)?.message ?? error))) throw error;
      }
      await settle();
    },
    async url() {
      return page.url();
    },
    async locate(hint) {
      return page.evaluate<LocateResult>(`(${LOCATE_SCRIPT})(${JSON.stringify(hint)})`);
    },
    async click(x, y) {
      await page.mouse.click(x, y);
    },
    async scroll(direction) {
      const viewport = await page.evaluate<{ w: number; h: number }>("({ w: innerWidth, h: innerHeight })");
      const dy = Math.round(viewport.h * 0.8);
      const dx = Math.round(viewport.w * 0.8);
      const delta: Record<string, [number, number]> = { down: [0, dy], up: [0, -dy], right: [dx, 0], left: [-dx, 0] };
      const [x, y] = delta[direction] ?? [0, 0];
      await page.mouse.wheel(x, y);
    },
    settle,
    async screenshot(path) {
      await page.screenshot({ path, type: "png" });
    },
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type StepStatus = "matched" | "replayed" | "control_not_found" | "different_screen" | "error" | "unmapped";

export interface StepResult {
  index: number;
  kind: StepKind;
  tMs: number;
  timeLabel: string;
  status: StepStatus;
  reason: string;
  expected: {
    label: string | null;
    role: string | null;
    position: { x: number; y: number } | null;
    route: string | null;
    direction: string | null;
    caption: string | null;
    said: string | null;
    frameUrl: string | null;
    cropUrl: string | null;
  };
  observed: {
    route: string | null;
    control: LocatedControl | null;
    nearbyControls: string[];
    /** Local PNG captured after the step. */
    frame: string | null;
    /** Milliseconds from the start of the re-check run. */
    atMs: number;
  };
}

export interface RunOptions {
  startUrl: string;
  framesDir: string;
  /** How long a navigation step waits for the live page to reach the recorded route. */
  navigationTimeoutMs: number;
  /** The recording's URL policy (`privacy.urls`); "origin_only" compares hosts only. */
  urlPrivacy?: string | null;
  /** Click controls that look irreversible (--allow-destructive). */
  allowIrreversible?: boolean;
  /** Aborted (Ctrl-C): no further step is taken. */
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface RunResult {
  steps: StepResult[];
  originMapping: { from: string; to: string } | null;
  startedAt: string;
  finishedAt: string;
}

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 300);
}

export async function runRecheck(plan: RecheckPlan, driver: RecheckDriver, opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  mkdirSync(opts.framesDir, { recursive: true });
  const startedAt = new Date(now()).toISOString();
  const t0 = now();

  const recordedOrigin = originOf(plan.steps.find((s) => s.route)?.route ?? null);
  const liveOrigin = originOf(opts.startUrl);
  const originMapping =
    recordedOrigin && liveOrigin && recordedOrigin !== liveOrigin ? { from: recordedOrigin, to: liveOrigin } : null;
  const ignoreOrigin = originMapping !== null;
  const originOnly = opts.urlPrivacy === "origin_only";

  try {
    await driver.open(opts.startUrl);
  } catch (error) {
    throw new RecheckInputError(
      "start_url_unreachable",
      `the start URL could not be opened in Chrome for Clipy: ${errorText(error)}`,
      "Check that --url loads (is the server running, is it the right host?), then re-run.",
    );
  }

  const liveRoute = async (): Promise<{ url: string; route: string | null }> => {
    const url = await driver.url();
    return { url, route: routeOf(url) };
  };
  /** A recorded route on the recording's host, moved onto the replay host.
   *  Routes are then compared with their origin, so a replay site that
   *  redirects back to the recorded (production) host at the same path is a
   *  different screen, never a match. */
  const onReplayHost = (route: string): string =>
    ignoreOrigin && liveOrigin && originOf(route) === recordedOrigin ? mapOrigin(route, liveOrigin) : route;
  const waitForRoute = async (route: string, timeoutMs: number): Promise<boolean> => {
    const deadline = now() + timeoutMs;
    for (;;) {
      if (routeMatches(onReplayHost(route), (await liveRoute()).url, false, originOnly)) return true;
      if (now() >= deadline) return false;
      await sleep(250);
    }
  };

  /** Only the recording's own (http) host is ever opened directly; a route on
   *  another host comes from the timeline and could point anywhere. */
  const sameHostAsRecording = (route: string): boolean =>
    /^https?:\/\//i.test(route) && recordedOrigin !== null && originOf(route) === recordedOrigin;

  /** Clicks happen only on the replay host (--url's origin). Without an origin
   *  mapping, a host the recording itself clicked on (an SSO page) is allowed
   *  once its route matched; with one, nothing but the replay host is, so a
   *  redirect to production never gets a click. */
  const clickHostAllowed = async (route: string | null): Promise<string | null> => {
    const live = originOf(await driver.url());
    if (live && live === liveOrigin) return null;
    if (!ignoreOrigin && route && live && live === originOf(route)) return null;
    return live ?? "an unreadable URL";
  };

  const results: StepResult[] = [];
  let previousKind: StepKind | null = null;
  for (const step of plan.steps) {
    if (opts.signal?.aborted) break;
    let status: StepStatus = "error";
    let reason = "";
    let control: LocatedControl | null = null;
    let nearby: string[] = [];
    try {
      if (step.unmappable) {
        status = "unmapped";
        reason = `could not map step: ${step.unmappable}`;
      } else if (step.kind === "start" || step.kind === "navigate") {
        const route = step.route as string;
        const timeout = step.kind === "start" ? 0 : opts.navigationTimeoutMs;
        if (await waitForRoute(route, timeout)) {
          status = "matched";
          reason = step.kind === "start" ? "the start page is on the recorded route" : "the page reached the recorded route";
        } else if (
          step.kind === "navigate" &&
          previousKind !== "click" &&
          !originOnly &&
          concreteRoute(route) &&
          !sameHostAsRecording(route)
        ) {
          status = "different_screen";
          reason = `expected ${route}, the page is on ${(await liveRoute()).route ?? "an unreadable URL"}; the recording went to another host here, and a re-check never opens a host the recording names`;
        } else if (step.kind === "navigate" && previousKind !== "click" && !originOnly && concreteRoute(route)) {
          // Nothing clicked led here in the original (a typed URL, a link from
          // outside), so open it the way the user did, on the re-check's host.
          await driver.open(onReplayHost(route));
          if (await waitForRoute(route, 0)) {
            status = "matched";
            reason = "opened the recorded route directly (no click led here in the original)";
          } else {
            status = "different_screen";
            reason = `opening the recorded route landed on ${(await liveRoute()).route ?? "an unreadable URL"}`;
          }
        } else {
          status = "different_screen";
          reason = `expected ${route}, the page is on ${(await liveRoute()).route ?? "an unreadable URL"}`;
        }
      } else if (step.kind === "click") {
        // A click that follows another action may still be navigating: give
        // the page a moment to arrive before calling it a different screen.
        if (step.route && !(await waitForRoute(step.route, previousKind === "click" ? opts.navigationTimeoutMs : 0))) {
          status = "different_screen";
          reason = `the click happened on ${step.route}; the page is on ${(await liveRoute()).route ?? "an unreadable URL"}, so it was not clicked`;
        } else if (await clickHostAllowed(step.route)) {
          status = "different_screen";
          reason = `the page is on ${await clickHostAllowed(step.route)}, not the re-check's host ${liveOrigin ?? "(unknown)"}, so it was not clicked`;
        } else {
          const located = await driver.locate({
            label: step.label as string,
            role: step.role,
            x: step.position?.x ?? null,
            y: step.position?.y ?? null,
          });
          if (located.status === "none") {
            status = "control_not_found";
            nearby = located.nearby;
            reason = `no visible control named "${step.label}"`;
          } else if (located.status === "ambiguous") {
            status = "unmapped";
            reason = `could not map step: ${located.candidates} controls are named "${step.label}" and the recording has no position to choose between them`;
          } else if (located.status === "covered") {
            status = "different_screen";
            control = located.control;
            reason = `"${step.label}" is on the page but covered by ${located.coveredBy}, so it was not clicked`;
          } else if (located.status === "disabled") {
            status = "different_screen";
            control = located.control;
            reason = `"${step.label}" is on the page but disabled, so it was not clicked`;
          } else if (!opts.allowIrreversible && looksIrreversible(located.control.name)) {
            status = "unmapped";
            control = located.control;
            reason = `could not map step: ${irreversibleReason(located.control.name)}`;
          } else if (opts.signal?.aborted) {
            status = "error";
            reason = "the re-check was interrupted before this click";
          } else if (await clickHostAllowed(step.route)) {
            status = "different_screen";
            control = located.control;
            reason = `the page moved to ${await clickHostAllowed(step.route)} before the click, so it was not clicked`;
          } else {
            control = located.control;
            await driver.click(control.x, control.y);
            await driver.settle();
            status = "matched";
            reason =
              control.quality === "exact"
                ? `clicked ${control.role} "${control.name}"`
                : `clicked ${control.role} "${control.name}" (its name contains the recorded label "${step.label}")`;
          }
        }
      } else if (step.kind === "scroll") {
        await driver.scroll(step.direction ?? "down");
        await driver.settle();
        status = "replayed";
        reason = `scrolled ${step.direction} (the recording keeps the direction, not the distance)`;
      }
    } catch (error) {
      status = "error";
      reason = `unexpected error: ${errorText(error)}`;
    }

    let frame: string | null = join(opts.framesDir, `step-${String(step.index).padStart(2, "0")}.png`);
    try {
      await driver.screenshot(frame);
    } catch (error) {
      log(`step ${step.index}: frame capture failed (${errorText(error)})`);
      frame = null;
    }
    let observedRoute: string | null = null;
    try {
      observedRoute = (await liveRoute()).route;
    } catch {
      // reported as null
    }
    results.push({
      index: step.index,
      kind: step.kind,
      tMs: step.tMs,
      timeLabel: fmtClock(step.tMs),
      status,
      reason,
      expected: {
        label: step.label,
        role: step.role,
        position: step.position,
        route: step.route,
        direction: step.direction,
        caption: step.original.caption,
        said: step.original.said,
        frameUrl: step.original.frameUrl,
        cropUrl: step.original.cropUrl,
      },
      observed: { route: observedRoute, control, nearbyControls: nearby, frame, atMs: Math.max(0, now() - t0) },
    });
    log(`step ${step.index}/${plan.steps.length} ${status}: ${reason}`);
    // An unmapped click still led to whatever came next in the original, so
    // the next navigation is not opened directly as if typed.
    if (!step.unmappable || step.kind === "click") previousKind = step.kind;
  }
  return { steps: results, originMapping, startedAt, finishedAt: new Date(now()).toISOString() };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface RecheckSummary {
  total: number;
  matched: number;
  replayed: number;
  controlNotFound: number;
  differentScreen: number;
  error: number;
  unmapped: number;
  /** Index of the first step that diverged (control not found, different screen or error). */
  firstDivergence: number | null;
  /** matches: every mapped step worked. diverged: today's UI differs. incomplete: nothing, or not enough, could be checked. */
  verdict: "matches" | "diverged" | "incomplete";
}

export function summarize(steps: readonly StepResult[]): RecheckSummary {
  const count = (s: StepStatus) => steps.filter((r) => r.status === s).length;
  const diverging = steps.find((r) => r.status === "control_not_found" || r.status === "different_screen" || r.status === "error");
  const matched = count("matched");
  const checked = matched + count("control_not_found") + count("different_screen");
  const summary: RecheckSummary = {
    total: steps.length,
    matched,
    replayed: count("replayed"),
    controlNotFound: count("control_not_found"),
    differentScreen: count("different_screen"),
    error: count("error"),
    unmapped: count("unmapped"),
    firstDivergence: diverging?.index ?? null,
    verdict: "incomplete",
  };
  if (summary.controlNotFound > 0 || summary.differentScreen > 0) summary.verdict = "diverged";
  else if (summary.error === 0 && checked > 0) summary.verdict = "matches";
  return summary;
}

export interface RecheckReport {
  ok: true;
  type: "clipy.recheck_report";
  version: typeof RECHECK_REPORT_VERSION;
  original: {
    id: string;
    name: string;
    webUrl: string | null;
    contextUrl: string | null;
    sourcePlatform: string | null;
    expectedResult: string | null;
    timelineStatus: string;
    urlPrivacy: string | null;
    eventsRead: number;
    eventsTruncated: boolean;
  };
  start: { route: string | null; originMapping: { from: string; to: string } | null };
  run: { browser: "chrome-for-clipy"; startedAt: string; finishedAt: string; framesDir: string; truncatedSteps: number };
  /** The re-check's own recording, when it was uploaded. */
  recording: { id: string; shareUrl: string; contextUrl: string } | null;
  summary: RecheckSummary;
  steps: StepResult[];
  limitations: string[];
  warnings: { code: string; error: string; remediation: string }[];
}

export function limitationsFor(run: Pick<OriginalRun, "urlPrivacy" | "sourcePlatform">, opts: PlanOptions = {}): string[] {
  const notes = [
    "Clicks are replayed by their recorded element label only; an unlabelled click is reported as unmapped, never clicked by position.",
    ...(opts.allowIrreversible
      ? []
      : ["Controls whose names read as irreversible (delete, pay, send, submit and similar) are not clicked; those steps are unmapped. --allow-destructive replays them, on a site where that is safe."]),
    "Typed values are never captured, so typing steps are not replayed; a later step that depends on that input may diverge for that reason.",
    "Frames are compared by people or agents reading them: the report pairs each original key-moment frame with the new screenshot but does not diff pixels.",
    "Controls inside iframes are not searched.",
  ];
  if (run.urlPrivacy === "origin_only") notes.push("The original recording kept page origins only, so route checks compare the host, not the path.");
  if (run.urlPrivacy === "not_captured" || run.urlPrivacy === null) {
    notes.push("The original recording has no page URLs, so no step can be flagged as a different screen by route; only missing or covered controls are detected.");
  }
  if (run.sourcePlatform === "mac" || run.sourcePlatform === "windows") {
    notes.push("Click positions from a desktop recording are relative to the captured window, not the page, so they only break ties between same-named controls.");
  }
  return notes;
}

const STATUS_LABEL: Record<StepStatus, string> = {
  matched: "matched",
  replayed: "replayed",
  control_not_found: "control not found",
  different_screen: "different screen",
  error: "error",
  unmapped: "could not map step",
};

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/** Desktop recordings carry macOS roles ("AXButton"); show them as the page would. */
function displayRole(role: string | null): string {
  if (!role) return "control";
  return role.replace(/^AX/, "").replace(/^[A-Z]/, (c) => c.toLowerCase());
}

function describeExpected(step: StepResult): string {
  switch (step.kind) {
    case "start":
      return `start on ${step.expected.route ?? "the start URL"}`;
    case "navigate":
      return `go to ${step.expected.route}`;
    case "click":
      return step.expected.label ? `click ${displayRole(step.expected.role)} "${step.expected.label}"` : "click (no label recorded)";
    case "scroll":
      return `scroll ${step.expected.direction ?? ""}`.trim();
    case "type":
      return "type (value not captured)";
    case "drag":
      return "drag";
  }
}

export function renderMarkdown(report: RecheckReport): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`# Re-check: ${report.original.name || report.original.id}`);
  lines.push("");
  const verdict =
    s.verdict === "matches"
      ? "The recorded workflow still works on today's UI."
      : s.verdict === "diverged"
        ? `Today's UI diverges from the recording, first at step ${s.firstDivergence}.`
        : "Not enough of the recording could be replayed to say whether it still works.";
  lines.push(verdict);
  lines.push("");
  lines.push(
    `${s.total} steps: ${s.matched} matched, ${s.replayed} replayed, ${s.controlNotFound} control not found, ` +
      `${s.differentScreen} different screen, ${s.error} error, ${s.unmapped} could not map.`,
  );
  lines.push("");
  if (report.original.webUrl) lines.push(`- Original recording: ${report.original.webUrl}`);
  if (report.recording) {
    lines.push(`- Re-check recording: ${report.recording.shareUrl}`);
    lines.push(`- Re-check agent context: ${report.recording.contextUrl}`);
  }
  if (report.start.originMapping) {
    lines.push(`- Recorded on ${report.start.originMapping.from}, re-checked on ${report.start.originMapping.to} (recorded paths checked on the re-check host; nothing is clicked on any other host)`);
  }
  lines.push(`- Frames: ${report.run.framesDir}`);
  if (report.original.expectedResult) {
    lines.push("");
    lines.push(`**Expected result (from the original recording):** ${report.original.expectedResult}`);
    lines.push("Compare it with the last frame; the re-check does not judge it automatically.");
  }
  lines.push("");
  lines.push("| # | At | Step | Result | Detail |");
  lines.push("|---|----|------|--------|--------|");
  for (const step of report.steps) {
    // The Result column already says "could not map step".
    let detail = step.reason.replace(/^could not map step: /, "");
    if (step.observed.nearbyControls.length) detail += `. Nearby: ${step.observed.nearbyControls.map((n) => `"${n}"`).join(", ")}`;
    lines.push(`| ${step.index} | ${step.timeLabel} | ${cell(describeExpected(step))} | ${STATUS_LABEL[step.status]} | ${cell(detail)} |`);
  }
  if (report.run.truncatedSteps > 0) {
    lines.push("");
    lines.push(`${report.run.truncatedSteps} later steps were not checked (a re-check covers at most ${RECHECK_MAX_STEPS} steps).`);
  }
  if (report.warnings.length) {
    lines.push("");
    for (const w of report.warnings) lines.push(`Warning: ${w.error} ${w.remediation}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** One caption per frame for the uploaded proof. */
export function frameCaption(step: StepResult, total: number): string {
  const reason = step.reason.replace(/^could not map step: /, "");
  const sentence = reason.charAt(0).toUpperCase() + reason.slice(1);
  return `Step ${step.index}/${total} ${STATUS_LABEL[step.status]}: ${describeExpected(step)}. ${sentence}`.slice(0, 400);
}

// ---------------------------------------------------------------------------
// Reading the original run
// ---------------------------------------------------------------------------

export type GetJson = (path: string) => Promise<Json>;

const MAX_TIMELINE_PAGES = 20;

export class RecheckInputError extends Error {
  constructor(
    readonly code: "timeline_not_ready" | "no_interactions" | "start_url_unreachable",
    message: string,
    readonly remediation: string,
  ) {
    super(message);
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Reads the recording, its interaction timeline (every page), key moments and
 *  transcript. Moments and the transcript are optional evidence: when they are
 *  not ready the steps simply carry less of it. */
export async function readOriginalRun(getJson: GetJson, publicId: string): Promise<OriginalRun> {
  const base = `/api/v1/recordings/${encodeURIComponent(publicId)}`;
  const recording = ((await getJson(base)).recording ?? {}) as Json;
  const types = "navigation,click,scroll,typing,drag";
  const events: TimelineEvent[] = [];
  let cursor: string | null = null;
  let status = "absent";
  let urlPrivacy: string | null = null;
  let pages = 0;
  let truncated = false;
  do {
    const query = new URLSearchParams({ types, limit: "250" });
    if (cursor) query.set("cursor", cursor);
    const page = await getJson(`${base}/interactions?${query}`);
    status = String(page.status ?? "absent");
    urlPrivacy = str((page.privacy as Json | undefined)?.urls) ?? urlPrivacy;
    if (Array.isArray(page.events)) events.push(...(page.events as TimelineEvent[]));
    cursor = str((page.pagination as Json | undefined)?.nextCursor);
    pages += 1;
    if (cursor && pages >= MAX_TIMELINE_PAGES) {
      truncated = true;
      cursor = null;
    }
  } while (cursor);
  if (status === "preparing") {
    throw new RecheckInputError(
      "timeline_not_ready",
      "the recording's interaction timeline is still being prepared",
      "Wait a minute and re-run the same command.",
    );
  }
  if (events.filter((e) => e.kind === "click" || e.kind === "navigation").length === 0) {
    throw new RecheckInputError(
      "no_interactions",
      `the recording has no clicks or page navigations to replay (timeline ${status})`,
      "Only recordings with click or browser-navigation data can be re-checked: Chrome extension, Chrome for Clipy, Mac and Windows app takes. A plain web-recorder take has none.",
    );
  }

  let moments: KeyMoment[] = [];
  try {
    const body = await getJson(`${base}/key-moments`);
    if (Array.isArray(body.moments)) moments = body.moments as KeyMoment[];
  } catch {
    // evidence only
  }
  let segments: TranscriptSegment[] = [];
  try {
    const body = await getJson(`${base}/transcript`);
    const t = body.transcript as Json | null | undefined;
    if (t && Array.isArray(t.segments)) segments = t.segments as TranscriptSegment[];
  } catch {
    // evidence only
  }

  return {
    id: str(recording.id) ?? publicId,
    name: str(recording.name) ?? "",
    webUrl: str(recording.webUrl),
    sourcePlatform: str(recording.sourcePlatform),
    expectedResult: str(recording.expectedResult),
    timelineStatus: status,
    urlPrivacy,
    events,
    eventsTruncated: truncated,
    moments,
    segments,
  };
}

export function writeReportFiles(dir: string, report: RecheckReport): { json: string; markdown: string } {
  mkdirSync(dir, { recursive: true });
  const json = join(dir, "report.json");
  const markdown = join(dir, "report.md");
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, renderMarkdown(report));
  return { json, markdown };
}
