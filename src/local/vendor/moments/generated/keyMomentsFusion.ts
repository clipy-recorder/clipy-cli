// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/moments/src/generated/keyMomentsFusion.ts by cli/scripts/sync-local.mjs. Do not edit here.
// SPDX-License-Identifier: Apache-2.0
// GENERATED from lib/queue/keyMomentsFusion.ts Do not edit here. Edit the monorepo source and re-run oss/scripts/sync-from-monorepo.mjs.
import type { PlannedMoment } from './types.js';
import type { KeyMomentInput } from './types.js';
import type { DrawStroke } from './drawStrokes.js';
import { cursorPositionAt, cursorPositionBefore, cursorSpeedAt, type ClickCluster, type CursorMove, type FlareSpan, type HoverDwell, } from './keyMomentsCursorContext.js';
function envInt(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
export const FUSE_BEFORE_MS = 3000;
export const FUSE_AFTER_MS = 5000;
export const MID_FLIGHT_MAX_SPEED_PX_S = 180;
export const FALLBACK_MAX_SAMPLE_GAP_MS = 600;
export const STANDALONE_FLARE_MIN_MS = envInt('KEY_MOMENTS_STANDALONE_FLARE_MIN_MS', 400);
export const ANNOTATION_MOMENTS_CEILING = envInt('KEY_MOMENTS_ANNOTATION_CEILING', 200);
export const MAX_STANDALONE_FLARES = ANNOTATION_MOMENTS_CEILING;
export const FLARE_SAMPLE_MAX_GAP_MS = 1000;
export const FLARE_TRAIL_LEAD_MS = 120;
export const STANDALONE_HOVER_MIN_MS = envInt('KEY_MOMENTS_STANDALONE_HOVER_MIN_MS', 2000);
export const MAX_STANDALONE_CLICKS = envInt('KEY_MOMENTS_MAX_STANDALONE_CLICKS', 8);
export const MAX_STANDALONE_HOVERS = envInt('KEY_MOMENTS_MAX_STANDALONE_HOVERS', 6);
export const INTERACTION_DEDUPE_MS = 2000;
export type NormalizeAt = (x: number, y: number, tMs: number) => {
    readonly x: number;
    readonly y: number;
} | null;
export type FusedMoment = KeyMomentInput & {
    frameAtMs: number;
    interaction?: boolean;
    targetFrameAtMs?: number | null;
    motionTargetTMs?: number | null;
    motionRelation?: 'move' | 'drag' | null;
};
export interface FuseInput {
    readonly deixis: readonly PlannedMoment[];
    readonly clicks: readonly ClickCluster[];
    readonly moves: readonly CursorMove[];
    readonly hovers: readonly HoverDwell[];
    readonly strokes?: readonly DrawStroke[];
    readonly flares?: readonly FlareSpan[];
    readonly segments: readonly {
        start: number;
        end: number;
        text: string;
    }[];
    readonly durationMs: number;
    readonly maxMoments: number;
    readonly generousInteractions?: boolean;
    readonly maxAnnotationMoments?: number;
    readonly normalizeAt: NormalizeAt;
}
interface PointerAnchor {
    readonly x: number;
    readonly y: number;
    readonly atMs: number;
    readonly confidence: number;
    readonly dwell: HoverDwell | null;
}
export function withClickedLabel(caption: string, label: string | null): string {
    if (!label)
        return caption;
    return `${caption}, clicked '${label}'`.slice(0, 220);
}
export function assignClicks(deixis: readonly PlannedMoment[], clicks: readonly ClickCluster[]): Map<number, ClickCluster> {
    const pairs: Array<{
        cueIndex: number;
        click: ClickCluster;
        score: number;
    }> = [];
    deixis.forEach((cue, cueIndex) => {
        for (const click of clicks) {
            const delta = click.tMs - cue.tMs;
            if (delta < -FUSE_BEFORE_MS || delta > FUSE_AFTER_MS)
                continue;
            pairs.push({
                cueIndex,
                click,
                score: delta >= 0 ? delta : FUSE_AFTER_MS + Math.abs(delta),
            });
        }
    });
    pairs.sort((a, b) => a.score - b.score || a.cueIndex - b.cueIndex);
    const byCue = new Map<number, ClickCluster>();
    const takenClicks = new Set<number>();
    for (const pair of pairs) {
        if (byCue.has(pair.cueIndex) || takenClicks.has(pair.click.tMs))
            continue;
        byCue.set(pair.cueIndex, pair.click);
        takenClicks.add(pair.click.tMs);
    }
    return byCue;
}
export function resolvePointerAnchor(tMs: number, moves: readonly CursorMove[], hovers: readonly HoverDwell[], normalizeAt: NormalizeAt): PointerAnchor | null {
    const windowStart = tMs - FUSE_BEFORE_MS;
    const windowEnd = tMs + FUSE_AFTER_MS;
    let best: HoverDwell | null = null;
    let bestDistance = Infinity;
    for (const dwell of hovers) {
        if (dwell.endMs < windowStart || dwell.startMs > windowEnd)
            continue;
        const distance = tMs < dwell.startMs
            ? dwell.startMs - tMs
            : tMs > dwell.endMs
                ? tMs - dwell.endMs
                : 0;
        if (distance < bestDistance) {
            best = dwell;
            bestDistance = distance;
        }
    }
    if (best) {
        const atMs = best.endMs;
        const norm = normalizeAt(best.x, best.y, atMs);
        if (norm) {
            return {
                x: norm.x,
                y: norm.y,
                atMs,
                confidence: bestDistance === 0 ? 0.8 : 0.75,
                dwell: best,
            };
        }
    }
    const sample = cursorPositionAt(moves, tMs, FALLBACK_MAX_SAMPLE_GAP_MS);
    if (!sample)
        return null;
    const speed = cursorSpeedAt(moves, tMs);
    if (speed != null && speed > MID_FLIGHT_MAX_SPEED_PX_S)
        return null;
    const norm = normalizeAt(sample.x, sample.y, tMs);
    if (!norm)
        return null;
    return { x: norm.x, y: norm.y, atMs: tMs, confidence: 0.7, dwell: null };
}
export interface DrawAnnotation {
    readonly startMs: number;
    readonly endMs: number;
    readonly x: number;
    readonly y: number;
    readonly strokes: readonly DrawStroke[];
}
export const DRAW_CLUSTER_GAP_MS = 2500;
function annotationAnchor(strokes: readonly DrawStroke[]): {
    x: number;
    y: number;
} | null {
    const last = strokes[strokes.length - 1];
    if (last?.kind === 'arrow' && last.points.length >= 2) {
        const head = last.points[last.points.length - 1];
        if (head)
            return { x: head.x, y: head.y };
    }
    const points = strokes.flatMap((s) => s.points);
    if (points.length === 0)
        return null;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    return {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
}
export function groupDrawAnnotations(strokes: readonly DrawStroke[]): DrawAnnotation[] {
    const ordered = [...strokes].sort((a, b) => a.start_ms - b.start_ms);
    const groups: DrawStroke[][] = [];
    for (const stroke of ordered) {
        const current = groups[groups.length - 1];
        const previous = current?.[current.length - 1];
        if (current && previous && stroke.start_ms - previous.end_ms <= DRAW_CLUSTER_GAP_MS) {
            current.push(stroke);
            continue;
        }
        groups.push([stroke]);
    }
    return groups.flatMap((group) => {
        const anchor = annotationAnchor(group);
        if (!anchor)
            return [];
        return [
            {
                startMs: Math.min(...group.map((s) => s.start_ms)),
                endMs: Math.max(...group.map((s) => s.end_ms)),
                x: Number(anchor.x.toFixed(4)),
                y: Number(anchor.y.toFixed(4)),
                strokes: group,
            },
        ];
    });
}
function describeAnnotation(strokes: readonly DrawStroke[]): string {
    const text = strokes.find((s) => s.kind === 'text' && s.text?.trim())?.text?.trim();
    if (text)
        return `Writes '${text.slice(0, 40)}' here`;
    const step = strokes.find((s) => s.kind === 'step');
    if (step && typeof step.value === 'number')
        return `Marks step ${step.value} here`;
    if (strokes.some((s) => s.kind === 'arrow'))
        return 'Draws an arrow pointing here';
    if (strokes.some((s) => s.kind === 'rect'))
        return 'Boxes this area';
    return 'Draws over this area';
}
export function narrationAround(segments: readonly {
    start: number;
    end: number;
    text: string;
}[], tMs: number, windowMs = 8000): string {
    return segments
        .filter((seg) => seg.start * 1000 <= tMs + windowMs && seg.end * 1000 >= tMs - windowMs)
        .map((seg) => seg.text.trim())
        .join(' ')
        .trim();
}
function sayingSuffix(narration: string): string {
    return narration
        ? `, while saying: "${narration.slice(0, 110)}${narration.length > 110 ? '…' : ''}"`
        : ' (no narration at this moment)';
}
function flarePosition(moves: readonly CursorMove[], atMs: number): {
    readonly x: number;
    readonly y: number;
} | null {
    return cursorPositionAt(moves, atMs, FLARE_SAMPLE_MAX_GAP_MS) ?? cursorPositionBefore(moves, atMs);
}
export function fuseMoments(input: FuseInput): FusedMoment[] {
    const { deixis, clicks, moves, hovers, segments, durationMs, normalizeAt } = input;
    const clickByCue = assignClicks(deixis, clicks);
    const usedClicks = new Set<number>([...clickByCue.values()].map((click) => click.tMs));
    const usedDwells = new Set<number>();
    const annotations = groupDrawAnnotations(input.strokes ?? []);
    const usedAnnotations = new Set<number>();
    const flares = input.flares ?? [];
    const usedFlares = new Set<number>();
    const flareAnchorFor = (tMs: number): {
        flare: FlareSpan;
        atMs: number;
        x: number;
        y: number;
    } | null => {
        let best: FlareSpan | null = null;
        let bestDistance = Infinity;
        for (const flare of flares) {
            if (flare.endMs < tMs - FUSE_BEFORE_MS)
                continue;
            if (flare.startMs > tMs + FUSE_AFTER_MS)
                continue;
            const distance = tMs < flare.startMs
                ? flare.startMs - tMs
                : tMs > flare.endMs
                    ? tMs - flare.endMs
                    : 0;
            if (distance < bestDistance) {
                best = flare;
                bestDistance = distance;
            }
        }
        if (!best)
            return null;
        const atMs = Math.max(best.startMs, best.endMs - FLARE_TRAIL_LEAD_MS);
        const position = flarePosition(moves, atMs);
        if (!position)
            return null;
        const norm = normalizeAt(position.x, position.y, atMs);
        if (!norm)
            return null;
        return { flare: best, atMs, x: norm.x, y: norm.y };
    };
    const annotationFor = (tMs: number): DrawAnnotation | null => {
        let best: DrawAnnotation | null = null;
        let bestDistance = Infinity;
        for (const annotation of annotations) {
            if (annotation.endMs < tMs - FUSE_BEFORE_MS)
                continue;
            if (annotation.startMs > tMs + FUSE_AFTER_MS)
                continue;
            const distance = tMs < annotation.startMs
                ? annotation.startMs - tMs
                : tMs > annotation.endMs
                    ? tMs - annotation.endMs
                    : 0;
            if (distance < bestDistance) {
                best = annotation;
                bestDistance = distance;
            }
        }
        return best;
    };
    const moments: FusedMoment[] = deixis.map((cue, index) => {
        const click = clickByCue.get(index);
        if (click) {
            const norm = normalizeAt(click.x, click.y, click.tMs);
            return {
                tMs: cue.tMs,
                source: 'fused',
                caption: withClickedLabel(cue.caption, click.label),
                frameUrl: null,
                cropUrl: null,
                x: norm?.x ?? null,
                y: norm?.y ?? null,
                confidence: 0.9,
                frameAtMs: click.tMs,
                motionTargetTMs: cue.motionTargetTMs,
                motionRelation: cue.motionRelation,
            };
        }
        const flared = flareAnchorFor(cue.tMs);
        if (flared) {
            usedFlares.add(flared.flare.startMs);
            return {
                tMs: cue.tMs,
                source: 'flare',
                caption: cue.caption,
                frameUrl: null,
                cropUrl: null,
                x: flared.x,
                y: flared.y,
                confidence: 0.88,
                frameAtMs: Math.min(flared.atMs, durationMs),
                motionTargetTMs: cue.motionTargetTMs,
                motionRelation: cue.motionRelation,
            };
        }
        const drawn = annotationFor(cue.tMs);
        if (drawn) {
            usedAnnotations.add(drawn.startMs);
            return {
                tMs: cue.tMs,
                source: 'draw',
                caption: cue.caption,
                frameUrl: null,
                cropUrl: null,
                x: drawn.x,
                y: drawn.y,
                confidence: 0.85,
                frameAtMs: Math.min(drawn.endMs, durationMs),
                motionTargetTMs: cue.motionTargetTMs,
                motionRelation: cue.motionRelation,
            };
        }
        const anchor = resolvePointerAnchor(cue.tMs, moves, hovers, normalizeAt);
        if (anchor?.dwell)
            usedDwells.add(anchor.dwell.startMs);
        return {
            tMs: cue.tMs,
            source: anchor ? 'hover' : 'deixis',
            caption: cue.caption,
            frameUrl: null,
            cropUrl: null,
            x: anchor?.x ?? null,
            y: anchor?.y ?? null,
            confidence: anchor?.confidence ?? 0.7,
            frameAtMs: anchor?.atMs ?? cue.tMs,
            motionTargetTMs: cue.motionTargetTMs,
            motionRelation: cue.motionRelation,
        };
    });
    const covered = (tMs: number): boolean => moments.some((m) => Math.abs(m.tMs - tMs) < INTERACTION_DEDUPE_MS);
    const isAnnotation = (m: FusedMoment): boolean => m.source === 'flare' || m.source === 'draw';
    const remaining = (): number => Math.max(0, input.maxMoments - moments.filter((m) => !isAnnotation(m)).length);
    const budgetFor = (cap: number): number => input.generousInteractions ? remaining() : Math.min(cap, remaining());
    const annotationCeiling = Math.min(ANNOTATION_MOMENTS_CEILING, input.maxAnnotationMoments ?? ANNOTATION_MOMENTS_CEILING);
    const flareBudget = Math.min(MAX_STANDALONE_FLARES, annotationCeiling);
    const standaloneFlares = flares
        .filter((f) => !usedFlares.has(f.startMs))
        .filter((f) => !covered(f.startMs))
        .filter((f) => f.endMs - f.startMs >= STANDALONE_FLARE_MIN_MS)
        .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs) || a.startMs - b.startMs)
        .slice(0, flareBudget);
    for (const flare of standaloneFlares) {
        const atMs = Math.min(Math.max(flare.startMs, flare.endMs - FLARE_TRAIL_LEAD_MS), durationMs);
        const position = flarePosition(moves, atMs);
        if (!position)
            continue;
        const norm = normalizeAt(position.x, position.y, atMs);
        if (!norm)
            continue;
        const seconds = ((flare.endMs - flare.startMs) / 1000).toFixed(1);
        const saying = sayingSuffix(narrationAround(segments, flare.startMs));
        moments.push({
            tMs: Math.round(flare.startMs),
            source: 'flare',
            caption: `Highlights this spot with Flare for ${seconds}s${saying}`.slice(0, 220),
            frameUrl: null,
            cropUrl: null,
            x: norm.x,
            y: norm.y,
            confidence: 0.75,
            frameAtMs: Math.round(atMs),
            interaction: true,
        });
    }
    const drawBudget = Math.max(0, annotationCeiling - moments.filter((m) => m.source === 'flare').length);
    const standaloneDraws = annotations
        .filter((a) => !usedAnnotations.has(a.startMs))
        .filter((a) => !covered(a.startMs))
        .slice(0, drawBudget);
    for (const annotation of standaloneDraws) {
        const saying = sayingSuffix(narrationAround(segments, annotation.startMs));
        moments.push({
            tMs: annotation.startMs,
            source: 'draw',
            caption: `${describeAnnotation(annotation.strokes)}${saying}`.slice(0, 220),
            frameUrl: null,
            cropUrl: null,
            x: annotation.x,
            y: annotation.y,
            confidence: 0.7,
            frameAtMs: Math.min(annotation.endMs, durationMs),
            interaction: true,
        });
    }
    const clickBudget = budgetFor(MAX_STANDALONE_CLICKS);
    const standaloneClicks = clicks
        .filter((click) => !usedClicks.has(click.tMs))
        .sort((a, b) => b.count - a.count || a.tMs - b.tMs)
        .slice(0, clickBudget);
    for (const click of standaloneClicks) {
        const norm = normalizeAt(click.x, click.y, click.tMs);
        if (!norm)
            continue;
        const target = click.label ? `'${click.label}'` : 'here';
        const saying = sayingSuffix(narrationAround(segments, click.tMs));
        moments.push({
            tMs: click.tMs,
            source: 'click',
            caption: (click.count >= 2
                ? `Clicks ${target} ${click.count} times${saying}`
                : `Clicks ${target}${saying}`).slice(0, 220),
            frameUrl: null,
            cropUrl: null,
            x: norm.x,
            y: norm.y,
            confidence: 0.6,
            frameAtMs: click.tMs,
            interaction: true,
        });
    }
    const hoverBudget = budgetFor(MAX_STANDALONE_HOVERS);
    const standaloneHovers = hovers
        .filter((dwell) => !usedDwells.has(dwell.startMs))
        .filter((dwell) => dwell.endMs - dwell.startMs >= STANDALONE_HOVER_MIN_MS)
        .filter((dwell) => !covered(dwell.startMs) && !moments.some((m) => m.tMs >= dwell.startMs - INTERACTION_DEDUPE_MS &&
        m.tMs <= dwell.endMs + INTERACTION_DEDUPE_MS))
        .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs) || a.startMs - b.startMs)
        .slice(0, hoverBudget);
    for (const dwell of standaloneHovers) {
        const atMs = Math.min(dwell.endMs, durationMs);
        const norm = normalizeAt(dwell.x, dwell.y, atMs);
        if (!norm)
            continue;
        const seconds = ((dwell.endMs - dwell.startMs) / 1000).toFixed(1);
        const saying = sayingSuffix(narrationAround(segments, dwell.startMs));
        moments.push({
            tMs: dwell.startMs,
            source: 'hover',
            caption: `Rests the pointer here for ${seconds}s${saying}`.slice(0, 220),
            frameUrl: null,
            cropUrl: null,
            x: norm.x,
            y: norm.y,
            confidence: 0.55,
            frameAtMs: atMs,
            interaction: true,
        });
    }
    for (const m of moments) {
        m.tMs = Math.round(m.tMs);
        m.frameAtMs = Math.round(m.frameAtMs);
    }
    moments.sort((a, b) => a.tMs - b.tMs);
    return moments;
}
