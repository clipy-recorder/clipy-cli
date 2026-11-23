// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/moments/src/generated/types.ts by cli/scripts/sync-local.mjs. Do not edit here.
// SPDX-License-Identifier: Apache-2.0
// GENERATED from lib/server/momentPlanner.ts and lib/models/keyMoments.ts (types only) Do not edit here. Edit the monorepo source and re-run oss/scripts/sync-from-monorepo.mjs.
export interface PlannedMoment {
    tMs: number;
    caption: string;
    motionTargetTMs: number | null;
    motionRelation: 'move' | 'drag' | null;
}
export type KeyMomentSource = 'deixis' | 'click' | 'fused' | 'hover' | 'draw' | 'flare';
export interface KeyMomentInput {
    tMs: number;
    source: KeyMomentSource;
    caption: string;
    frameUrl: string | null;
    cropUrl: string | null;
    x: number | null;
    y: number | null;
    confidence: number;
    targetX?: number | null;
    targetY?: number | null;
    targetFrameUrl?: string | null;
    relation?: 'move' | 'drag' | null;
    motionConfidence?: number | null;
}
