/**
 * motionCandidate — classical frame-difference assist for the tiny/dark ball.
 *
 * The detector's blind spot is a small, fast, low-contrast ball mid-flight:
 * it may score below every gate or not fire at all. But that ball is usually
 * the ONLY thing moving against a static background (locked camera!). A
 * coarse luma grid diffed between consecutive analysed frames finds it for
 * ~2k float reads — no model, no allocation churn.
 *
 * SAFETY MODEL: the candidate is injected as a synthetic 'ball' detection at
 * score DETECTION.motionCandidate.score (0.13) — deliberately BETWEEN the
 * tracking gate (0.12) and the cold-acquisition gate (0.2). So motion can
 * only ever CONTINUE a fresh track (where the jump gate also demands it lands
 * near the Kalman prediction); it can never start one. False motion (players,
 * net, shadows) is additionally suppressed by:
 *   - person-box exclusion (inflated 15%),
 *   - net-ROI exclusion (flapping net),
 *   - a global-motion bail-out (too many active cells = camera bump/exposure
 *     shift, not a ball).
 *
 * All functions are 'worklet' + pure so the frame processor can call them and
 * jest can test them.
 */
import type { Box } from '../core/types';

export interface MotionCandidate {
  /** Centroid, analysis px. */
  cx: number;
  cy: number;
  /** Peak cell |diff| (0..1 luma units). */
  strength: number;
}

export interface MotionOpts {
  /** Grid cells per side. */
  grid: number;
  /** Analysis frame side, px. */
  size: number;
  /** Min peak cell diff to count as motion. */
  minCellDiff: number;
  /** Bail out when more than this fraction of cells are active (global motion). */
  maxActiveFrac: number;
  /** Regions to ignore (net ROI, person boxes...), analysis px. */
  exclude: readonly Box[];
}

/** Cell center in analysis px. */
function cellCenter(i: number, grid: number, size: number): { x: number; y: number } {
  'worklet';
  const gx = i % grid;
  const gy = (i / grid) | 0;
  return {
    x: ((gx + 0.5) / grid) * size,
    y: ((gy + 0.5) / grid) * size,
  };
}

function inAnyBox(x: number, y: number, boxes: readonly Box[]): boolean {
  'worklet';
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
      return true;
    }
  }
  return false;
}

/**
 * Find the strongest local motion blob between two luma grids.
 * Returns null when there is no clear, local, non-excluded mover.
 */
export function findMotionCandidate(
  prev: readonly number[],
  curr: readonly number[],
  opts: MotionOpts,
): MotionCandidate | null {
  'worklet';
  const { grid, size, minCellDiff, maxActiveFrac, exclude } = opts;
  const n = grid * grid;
  if (prev.length !== n || curr.length !== n) return null;

  let best = -1;
  let bestDiff = 0;
  let active = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(curr[i]! - prev[i]!);
    if (d >= minCellDiff) {
      active++;
      const c = cellCenter(i, grid, size);
      if (inAnyBox(c.x, c.y, exclude)) continue;
      if (d > bestDiff) {
        bestDiff = d;
        best = i;
      }
    }
  }
  if (best < 0 || bestDiff < minCellDiff) return null;
  // Global-motion bail-out: a camera bump / exposure hunt lights up the whole
  // grid — that is not a ball, and injecting anything would poison the track.
  if (active > n * maxActiveFrac) return null;

  // Refine: diff-weighted centroid over the 3x3 neighborhood of the peak.
  const bx = best % grid;
  const by = (best / grid) | 0;
  let wsum = 0;
  let xsum = 0;
  let ysum = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = bx + dx;
      const gy = by + dy;
      if (gx < 0 || gx >= grid || gy < 0 || gy >= grid) continue;
      const i = gy * grid + gx;
      const d = Math.abs(curr[i]! - prev[i]!);
      if (d < minCellDiff * 0.5) continue;
      const c = cellCenter(i, grid, size);
      wsum += d;
      xsum += d * c.x;
      ysum += d * c.y;
    }
  }
  if (wsum <= 0) return null;
  return { cx: xsum / wsum, cy: ysum / wsum, strength: bestDiff };
}
