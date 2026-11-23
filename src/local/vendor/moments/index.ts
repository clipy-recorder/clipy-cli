// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/moments/src/index.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * @clipy/moments: picks the moments of a screen recording worth a screenshot.
 *
 * The same detectors and planner Clipy's hosted service runs, packaged to run
 * on the user's machine:
 * - Rules (always, offline): hold-to-highlight flares, pen drawings, click
 *   clusters and pointer rests from the interaction sidecar.
 * - Spoken cues (optional): a model reads the transcript for "this button",
 *   "it breaks here" and similar, using the provider the user configured.
 */
import { runWithModelProvider, type ModelProvider } from "./llm.js";
import {
  describePlannerError,
  localMomentInput,
  planLocalMoments,
  type LocalMomentInput,
  type LocalMomentPlan,
} from "./generated/localMomentPlan.js";

export {
  DEFAULT_OPENROUTER_MODEL,
  PROVIDER_BASE_URLS,
  LLMError,
  MODEL_ERROR,
  type ModelProvider,
} from "./llm.js";
export {
  localMomentInput,
  describePlannerError,
  isTransientPlannerError,
  type LocalMoment,
  type LocalMomentInput,
  type LocalMomentPlan,
  type LocalMomentSource,
} from "./generated/localMomentPlan.js";

export interface PlanOptions {
  /** null or omitted: rules only, nothing leaves the machine. */
  provider?: ModelProvider | null;
  signal?: AbortSignal;
  /**
   * When the model provider still fails after the planner's retries:
   * "throw" (default) rejects; "rules" plans again on rules alone and says so
   * in `modelFallback`, so a provider outage never costs the gesture moments.
   */
  onModelFailure?: "throw" | "rules";
}

/** Which planner produced a plan, for the AREC to state. */
export type PlannerUsed = "rules" | "rules+model";

export interface PlanResult {
  plan: LocalMomentPlan;
  planner: PlannerUsed;
  /** Set only with `onModelFailure: "rules"` after the provider failed: the failure's kind (see describePlannerError). */
  modelFallback?: string;
}

/** The planner's limit on interaction events. */
export const MAX_PLANNER_INTERACTIONS = 8000;

/** Button, key and annotation edges: the evidence every gesture rule reads. */
const EDGE_KINDS = new Set(["down", "up", "key_down", "key_up", "annotation"]);

function evenly(indices: number[], budget: number): number[] {
  if (budget <= 0) return [];
  if (indices.length <= budget) return indices;
  const out: number[] = [];
  for (let k = 0; k < budget; k++) out.push(indices[Math.floor((k * indices.length) / budget)]);
  return out;
}

/** macOS Control key codes, the hold-to-highlight key (the local planner reads Mac key codes). */
const CONTROL_KEYCODES = new Set([59, 62]);
/** macOS modifier key codes: pressing one during a Control hold does not make it a chord. */
const isModifierKeycode = (code: number) => code >= 54 && code <= 63;

interface EdgeEvent {
  kind?: unknown;
  time_ms?: unknown;
  key_code?: unknown;
  button?: unknown;
}

/**
 * Button, key and annotation events thinned to `budget` without changing
 * what the gesture rules see: every Control and annotation event, and every
 * non-modifier key press during a Control hold (it makes a chord), are kept;
 * other key presses and clicks are dropped only as whole down/up pairs.
 */
function thinEdges<T>(events: readonly T[], edges: number[], budget: number): number[] {
  if (edges.length <= budget) return edges;
  const at = (i: number) => events[i] as EdgeEvent;
  const time = (i: number) => (typeof at(i).time_ms === "number" ? (at(i).time_ms as number) : 0);
  const ordered = [...edges].sort((a, b) => time(a) - time(b) || a - b);
  const kept: number[] = [];
  const units: number[][] = [];
  const openKeys = new Map<unknown, number[]>();
  const openButtons = new Map<unknown, number[]>();
  let held = 0;
  for (const i of ordered) {
    const e = at(i);
    const code = e.key_code;
    if (e.kind === "annotation") {
      kept.push(i);
    } else if ((e.kind === "key_down" || e.kind === "key_up") && typeof code === "number" && CONTROL_KEYCODES.has(code)) {
      kept.push(i);
      held = e.kind === "key_down" ? held + 1 : 0;
    } else if (e.kind === "key_down" && held > 0 && typeof code === "number" && !isModifierKeycode(code)) {
      kept.push(i);
    } else if (e.kind === "key_down" || e.kind === "down") {
      const open = e.kind === "key_down" ? openKeys : openButtons;
      const id = e.kind === "key_down" ? code : e.button;
      const unit = [i];
      units.push(unit);
      if (!open.has(id)) open.set(id, []);
      open.get(id)!.push(units.length - 1);
    } else {
      const open = e.kind === "key_up" ? openKeys : openButtons;
      const id = e.kind === "key_up" ? code : e.button;
      const pending = open.get(id);
      const unitIndex = pending?.shift();
      if (unitIndex !== undefined) units[unitIndex].push(i);
      else units.push([i]);
    }
  }
  if (kept.length >= budget) return evenly(kept, budget);
  const room = budget - kept.length;
  const size = (list: number[][]) => list.reduce((n, u) => n + u.length, 0);
  let count = Math.min(units.length, room);
  let chosen = evenly(units.map((_u, k) => k), count).map((k) => units[k]);
  while (size(chosen) > room && count > 0) {
    count = Math.max(0, count - Math.ceil((size(chosen) - room) / 2));
    chosen = evenly(units.map((_u, k) => k), count).map((k) => units[k]);
  }
  return [...kept, ...chosen.flat()];
}

/**
 * Interactions thinned to `limit`, in their original order: button, key and
 * annotation events first (thinned only when they alone pass the limit, see
 * thinEdges), then scrolls, and pointer moves are thinned evenly into what is
 * left. Within the limit the array comes back unchanged. (A 20 Hz pointer
 * track passes 8000 events in under seven minutes.)
 */
export function boundInteractions<T>(events: readonly T[], limit = MAX_PLANNER_INTERACTIONS): T[] {
  if (events.length <= limit) return events as T[];
  const kindOf = (e: T) => (e && typeof e === "object" ? (e as { kind?: unknown }).kind : undefined);
  const edges: number[] = [];
  const scrolls: number[] = [];
  const rest: number[] = [];
  events.forEach((e, i) => {
    const kind = kindOf(e);
    if (typeof kind === "string" && EDGE_KINDS.has(kind)) edges.push(i);
    else if (kind === "scroll") scrolls.push(i);
    else rest.push(i);
  });
  const keptEdges = thinEdges(events, edges, limit);
  const keptScrolls = evenly(scrolls, limit - keptEdges.length);
  const keptRest = evenly(rest, limit - keptEdges.length - keptScrolls.length);
  const keep = new Set([...keptEdges, ...keptScrolls, ...keptRest]);
  return events.filter((_e, i) => keep.has(i));
}

export async function planMoments(input: LocalMomentInput, options: PlanOptions = {}): Promise<PlanResult> {
  const raw = input as { interactions?: unknown };
  const bounded =
    Array.isArray(raw.interactions) && raw.interactions.length > MAX_PLANNER_INTERACTIONS
      ? { ...input, interactions: boundInteractions(input.interactions) }
      : input;
  const parsed = localMomentInput.parse(bounded);
  const provider = options.provider ?? null;
  const signal = options.signal ?? new AbortController().signal;
  try {
    // Scoped to this call, so concurrent calls with different providers are safe.
    const { result: plan, modelAnswers } = await runWithModelProvider(provider, () => planLocalMoments(parsed, signal));
    // "rules+model" only when a model's answer went into the plan: with an
    // empty transcript the model is never asked, whatever is configured.
    return { plan, planner: modelAnswers > 0 ? "rules+model" : "rules" };
  } catch (error) {
    if (!provider || options.onModelFailure !== "rules" || signal.aborted) throw error;
    const { result: plan } = await runWithModelProvider(null, () => planLocalMoments(parsed, signal));
    return { plan, planner: "rules", modelFallback: String(describePlannerError(error).kind ?? "error") };
  }
}
