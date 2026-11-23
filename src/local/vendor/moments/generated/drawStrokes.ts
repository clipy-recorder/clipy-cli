// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/moments/src/generated/drawStrokes.ts by cli/scripts/sync-local.mjs. Do not edit here.
// SPDX-License-Identifier: Apache-2.0
// GENERATED from lib/animation-editor/drawStrokes.ts Do not edit here. Edit the monorepo source and re-run oss/scripts/sync-from-monorepo.mjs.
export type DrawStrokeKind = 'pen' | 'arrow' | 'rect' | 'text' | 'step';
export interface DrawStrokePoint {
    time_ms: number;
    x: number;
    y: number;
}
export interface DrawStroke {
    id: string;
    kind: DrawStrokeKind;
    color: string;
    start_ms: number;
    end_ms: number;
    points: DrawStrokePoint[];
    text?: string;
    value?: number;
}
export interface DrawStrokeTrack {
    schema_version: 1;
    coord_space: 'normalized_video';
    strokes: DrawStroke[];
}
const STROKE_VISIBLE_AFTER_END_MS = 6000;
const MAX_FRAME_FILTERS = 160;
export function activeDrawStrokesAt(track: DrawStrokeTrack | null, tMs: number): DrawStroke[] {
    if (!track || !Number.isFinite(tMs))
        return [];
    return track.strokes.flatMap((stroke) => {
        if (tMs < stroke.start_ms || tMs > stroke.end_ms + STROKE_VISIBLE_AFTER_END_MS) {
            return [];
        }
        const points = tMs < stroke.end_ms
            ? stroke.points.filter((point) => point.time_ms <= tMs)
            : stroke.points;
        if (stroke.kind === 'pen' || stroke.kind === 'arrow' || stroke.kind === 'rect') {
            return points.length >= 2 ? [{ ...stroke, points }] : [];
        }
        return stroke.start_ms <= tMs ? [stroke] : [];
    });
}
export function buildDrawStrokeFrameFilters(strokes: DrawStroke[]): string {
    const filters: string[] = [];
    const activeStrokes = strokes.slice(0, 24);
    for (let i = 0; i < activeStrokes.length; i += 1) {
        const stroke = activeStrokes[i];
        if (filters.length >= MAX_FRAME_FILTERS)
            break;
        const remainingStrokeSlots = activeStrokes.length - i;
        const strokeBudget = Math.max(4, Math.floor((MAX_FRAME_FILTERS - filters.length) / remainingStrokeSlots));
        const color = hexToFfmpegHex(stroke.color);
        if (stroke.kind === 'pen') {
            filters.push(...budgetedFilters(filters, lineDrawboxes(stroke.points, color, 7), strokeBudget));
        }
        else if (stroke.kind === 'arrow') {
            const points = stroke.points.slice(0, 2);
            filters.push(...budgetedFilters(filters, lineDrawboxes(points, color, 7), strokeBudget));
            if (points.length === 2) {
                filters.push(...budgetedFilters(filters, arrowHeadDrawboxes(points[0], points[1], color), strokeBudget));
            }
        }
        else if (stroke.kind === 'rect') {
            const a = stroke.points[0];
            const b = stroke.points[1];
            if (a && b) {
                const x = Math.min(a.x, b.x);
                const y = Math.min(a.y, b.y);
                const w = Math.abs(a.x - b.x);
                const h = Math.abs(a.y - b.y);
                if (w > 0.002 && h > 0.002) {
                    appendFilter(filters, `drawbox=x='iw*${x.toFixed(5)}':y='ih*${y.toFixed(5)}':` +
                        `w='iw*${w.toFixed(5)}':h='ih*${h.toFixed(5)}':` +
                        `color=${color}@0.94:t=5`);
                }
            }
        }
        else if (stroke.kind === 'text') {
            const p = stroke.points[0];
            const text = stroke.text?.trim();
            if (p && text) {
                appendFilter(filters, `drawbox=x='iw*${p.x.toFixed(5)}-16':y='ih*${p.y.toFixed(5)}-16':` +
                    `w=32:h=32:color=${color}@0.96:t=4`);
            }
        }
        else if (stroke.kind === 'step') {
            const p = stroke.points[0];
            if (p && typeof stroke.value === 'number') {
                appendFilter(filters, `drawbox=x='iw*${p.x.toFixed(5)}-18':y='ih*${p.y.toFixed(5)}-18':` +
                    `w=36:h=36:color=${color}@0.96:t=fill`);
            }
        }
    }
    return filters.length > 0 ? `,${filters.join(',')}` : '';
}
function budgetedFilters(existing: string[], next: string[], strokeBudget: number): string[] {
    return next.slice(0, Math.max(0, Math.min(strokeBudget, MAX_FRAME_FILTERS - existing.length)));
}
function appendFilter(filters: string[], filter: string): void {
    if (filters.length < MAX_FRAME_FILTERS) {
        filters.push(filter);
    }
}
function lineDrawboxes(points: DrawStrokePoint[], color: string, thickness: number): string[] {
    const finitePoints = points
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
        .sort((a, b) => a.time_ms - b.time_ms);
    const clean = decimatePoints(finitePoints, 80);
    if (clean.length < 2)
        return [];
    return clean.map((point) => `drawbox=x='iw*${point.x.toFixed(5)}-${Math.round(thickness / 2)}':` +
        `y='ih*${point.y.toFixed(5)}-${Math.round(thickness / 2)}':` +
        `w=${thickness}:h=${thickness}:color=${color}@0.96:t=fill`);
}
function decimatePoints<T>(points: T[], maxPoints: number): T[] {
    if (points.length <= maxPoints)
        return points;
    if (maxPoints <= 1)
        return points.slice(0, 1);
    const out: T[] = [];
    const last = points.length - 1;
    for (let i = 0; i < maxPoints; i += 1) {
        out.push(points[Math.round((i * last) / (maxPoints - 1))]);
    }
    return out;
}
function arrowHeadDrawboxes(from: DrawStrokePoint, to: DrawStrokePoint, color: string): string[] {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const len = 0.035;
    const left = {
        ...to,
        x: to.x - Math.cos(angle - Math.PI / 6) * len,
        y: to.y - Math.sin(angle - Math.PI / 6) * len,
    };
    const right = {
        ...to,
        x: to.x - Math.cos(angle + Math.PI / 6) * len,
        y: to.y - Math.sin(angle + Math.PI / 6) * len,
    };
    return [
        ...lineDrawboxes([left, to], color, 7),
        ...lineDrawboxes([right, to], color, 7),
    ];
}
function hexToFfmpegHex(css: string): string {
    const normalized = css.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
        return `0x${normalized.slice(1)}`;
    }
    return '0xff5a36';
}
