/**
 * Wrist-path trail + shared ground-plane rule for the 3D stage and the share
 * still.
 *
 * HONESTY: the trail is the ESTIMATED pose wrist path, never ball tracking.
 * Frames where the 2D wrist was missing are SKIPPED, never interpolated —
 * gaps stay gaps, and every point carries the lift's depth confidence so the
 * renderer can fade uncertain segments.
 *
 * `sequenceGroundY` is the single ground-plane rule shared by the live stage
 * (FormStage3D) and the offscreen share still, extracted so both draw the
 * floor at byte-identical height.
 *
 * Pure TypeScript: no I/O, no wall clock, no React/Skia imports; functions
 * are deterministic and never mutate their inputs.
 */
import type { PoseKeypointName, ShootingHand } from '../types';
import type { LiftedSequence } from './lift';

/** One trail sample, in the shared world contract (+x right, +y DOWN). */
export interface TrailPoint {
  x: number;
  y: number;
  z: number;
  /** Depth confidence of the wrist joint at this frame, 0..1. */
  c: number;
  /** Source frame index in seq.frames. */
  frame: number;
}

/**
 * Shooting-hand wrist path from frame 0 up to and including `upToFrame`
 * (fractional values floor; values past the end clamp to the last frame).
 * Only frames where the wrist actually exists contribute a point — missing
 * frames are skipped, NEVER interpolated. Returns [] when `upToFrame` < 0 or
 * the sequence has no frames.
 */
export function wristTrail(
  seq: LiftedSequence,
  hand: ShootingHand,
  upToFrame: number,
): TrailPoint[] {
  const wristName: PoseKeypointName = hand === 'right' ? 'right_wrist' : 'left_wrist';
  const out: TrailPoint[] = [];
  if (upToFrame < 0 || seq.frames.length === 0) return out;
  const last = Math.min(Math.floor(upToFrame), seq.frames.length - 1);
  for (let i = 0; i <= last; i++) {
    const joint = seq.frames[i]?.[wristName];
    if (joint) out.push({ x: joint.x, y: joint.y, z: joint.z, c: joint.c, frame: i });
  }
  return out;
}

/**
 * Ground plane for a lifted sequence: the lowest (max, +y is DOWN) ankle
 * seen in the first 3 frames — fixed per sequence so the floor doesn't bob
 * while scrubbing. Falls back to 0.5 when no ankle was ever lifted. Exact
 * port of the inline rule FormStage3D used before this was shared.
 */
export function sequenceGroundY(seq: LiftedSequence): number {
  let g = -Infinity;
  for (const frame of seq.frames.slice(0, 3)) {
    for (const name of ['left_ankle', 'right_ankle'] as const) {
      const j = frame[name];
      if (j) g = Math.max(g, j.y);
    }
  }
  return Number.isFinite(g) ? g : 0.5;
}
