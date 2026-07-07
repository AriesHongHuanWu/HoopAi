/**
 * placementGrade — pure grading of the pre-lock camera placement.
 *
 * Turns the engine's cheap aiming-time signals (latest rim-detection width,
 * analysis-square side, time since a rim was last seen, effective detection
 * fps) into a Good / OK / Poor grade with ONE actionable reason, rendered as
 * a chip on the aiming overlay. Pure TypeScript, no I/O — the 5 Hz poll and
 * the SharedValue reads live in the HUD layer
 * (src/components/hud/PlacementGrade.tsx).
 *
 * The size band is anchored on the detector's sweet spot: a rim ~8–15% of the
 * analysis-square side is where rim lock + ball tracking are most reliable
 * (mirrors the tap-to-set default of ~12% in live.tsx). Outside ~4–25%,
 * detection degrades enough that the user should physically move the phone.
 */
import { DETECTION } from './config';
import type { LightProfile } from './lightProfile';

export type PlacementGradeLevel = 'good' | 'ok' | 'poor';

export interface PlacementGradeResult {
  grade: PlacementGradeLevel;
  /** One actionable sentence — always present; the chip's whole value. */
  reason: string;
}

export interface PlacementInputs {
  /** Width of the most recent rim sighting, analysis px; null if never seen. */
  rimWidthPx: number | null;
  /** Analysis-square side, px (max(frameW, frameH)); <= 0 before any frame. */
  frameSide: number;
  /** Milliseconds since a rim detection was last seen (0 = seen this poll). */
  msSinceRimSeen: number;
  /** Effective detection fps from the engine debug; 0 = unknown/not measured. */
  fps: number;
  /**
   * Scene-light profile classified from the overlay's luma estimate
   * (src/core/lightProfile.ts), or null/undefined when not yet measured
   * (demo mode, model warm-up). Only 'dark' affects the grade — a heads-up
   * that tracking will be weaker, ranked below every size reason.
   */
  light?: LightProfile | null;
}

// --- thresholds (exported for tests + the ghost-rim band) --------------------

/** Below this rim-width fraction of the analysis side, the hoop is too far. */
export const RIM_FRACTION_MIN = 0.04;
/** Good-band floor — matches the ghost rim's ideal apparent-size band. */
export const RIM_FRACTION_IDEAL_MIN = 0.08;
/** Good-band ceiling. */
export const RIM_FRACTION_IDEAL_MAX = 0.15;
/** Above this fraction the camera is too close (rim fills the frame). */
export const RIM_FRACTION_MAX = 0.25;
/** No rim sighting for this long → "point the camera at the hoop". */
export const NO_RIM_TIMEOUT_MS = 2000;
/** Effective detection fps below this = the phone is struggling. */
export const LOW_FPS_MIN = 10;
/** Poll cadence for the HUD hook (5 Hz — same as the rimCountdown poll). */
export const GRADE_POLL_MS = 200;

/** Every reason the chip can show, exported so tests pin exact copy. */
export const PLACEMENT_REASON = {
  searching: 'Looking for the hoop…',
  noRim: 'Point the camera at the hoop',
  tooSmall: 'Move closer — the rim looks too small',
  tooLarge: 'Step back a little — the rim fills the frame',
  lowFps: 'Phone is struggling — close other apps',
  slightlySmall: 'Almost there — a step closer is ideal',
  slightlyLarge: 'Almost there — a small step back is ideal',
  tooDark: 'Low light — expect weaker tracking; add light if you can',
  good: 'Great framing — hold steady',
} as const;

/**
 * Grades the current placement. Priority order (first hit wins):
 *   1. Rim unseen past the timeout — the camera is pointed wrong; nothing else
 *      matters until the hoop is in frame.
 *   2. No usable signal yet (grace window / no frames) — calm "searching".
 *   3. Hard size failures (too far / too close) — the most actionable fixes.
 *   4. Low detection fps — framing may be fine, but tracking will be choppy.
 *   5. Soft size nudges toward the ideal band.
 *   6. Dark scene — framing and fps are fine, but low light weakens the
 *      detector; a heads-up (with the mitigations already engaged), ranked
 *      below every size reason because moving the phone fixes those.
 */
export function gradePlacement(input: PlacementInputs): PlacementGradeResult {
  const { rimWidthPx, frameSide, msSinceRimSeen, fps, light } = input;

  if (msSinceRimSeen > NO_RIM_TIMEOUT_MS) {
    return { grade: 'poor', reason: PLACEMENT_REASON.noRim };
  }
  if (rimWidthPx == null || rimWidthPx <= 0 || frameSide <= 0) {
    return { grade: 'ok', reason: PLACEMENT_REASON.searching };
  }

  const frac = rimWidthPx / frameSide;
  if (frac < RIM_FRACTION_MIN) {
    return { grade: 'poor', reason: PLACEMENT_REASON.tooSmall };
  }
  if (frac > RIM_FRACTION_MAX) {
    return { grade: 'poor', reason: PLACEMENT_REASON.tooLarge };
  }
  if (fps > 0 && fps < LOW_FPS_MIN) {
    return { grade: 'ok', reason: PLACEMENT_REASON.lowFps };
  }
  if (frac < RIM_FRACTION_IDEAL_MIN) {
    return { grade: 'ok', reason: PLACEMENT_REASON.slightlySmall };
  }
  if (frac > RIM_FRACTION_IDEAL_MAX) {
    return { grade: 'ok', reason: PLACEMENT_REASON.slightlyLarge };
  }
  if (light === 'dark') {
    return { grade: 'ok', reason: PLACEMENT_REASON.tooDark };
  }
  return { grade: 'good', reason: PLACEMENT_REASON.good };
}

/**
 * Width of the best (highest-score) rim detection in the overlay's raw
 * detection list, or null when none clears the gate. Pre-lock the LOCKED rim
 * is null on the overlay, so raw detections are the only rim signal; the gate
 * defaults to the pipeline's own rim confidence floor. Structural input
 * (cls/w/score) so this module never imports camera types.
 */
export function bestRimWidth(
  dets: readonly { cls: string; w: number; score: number }[],
  scoreMin: number = DETECTION.rimScoreMin,
): number | null {
  let best: number | null = null;
  let bestScore = -1;
  for (let i = 0; i < dets.length; i++) {
    const d = dets[i]!;
    if (d.cls !== 'rim' || d.score < scoreMin || d.w <= 0) continue;
    if (d.score > bestScore) {
      bestScore = d.score;
      best = d.w;
    }
  }
  return best;
}
