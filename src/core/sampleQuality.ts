/**
 * sampleQuality — pre-crossing sample selector for the depth-ratio gate and
 * the reappearance depth check.
 *
 * The depth ratio needs the ball's TRUE apparent diameter right before the
 * crossing, but exactly there the measurement is at its worst: motion blur
 * elongates the detector box (biasing the radius UP systematically) and the
 * ball starts overlapping the rim box (the detector merges rim/net pixels
 * into the ball box). So the selector walks the trajectory BACKWARD from the
 * crossing and keeps only:
 *   - REAL detections (never Kalman-predicted samples — their radius is just
 *     the smoothed history, not a measurement), that were captured
 *   - BEFORE the ball box overlaps the rim box, and whose
 *   - box aspect is within DEPTH_GATE.blurAspectRejectFrac of round (the blur
 *     filter — an elongated box is a smear, not a ball).
 *
 * Pure TypeScript, stateless, unit-testable.
 */
import { DEPTH_GATE } from './config';
import type { BallSample, Box } from './types';

export interface DepthSampleSelection {
  /** Mean DIAMETER (2·r) of the surviving samples, px; null when none. */
  avgDiaPx: number | null;
  /** Surviving real, non-blurred, pre-overlap sample count. */
  nReal: number;
  /** How many real samples the blur filter rejected (diagnostics). */
  rejectedBlur: number;
}

/** Circle (cx,cy,r) vs box overlap test. */
function overlapsRim(s: BallSample, rim: Box): boolean {
  return (
    s.cx + s.r > rim.x &&
    s.cx - s.r < rim.x + rim.width &&
    s.cy + s.r > rim.y &&
    s.cy - s.r < rim.y + rim.height
  );
}

/**
 * Select the last `maxN` usable samples before the ball reached the rim.
 *
 * `history` is the shot trajectory in time order (the FSM's buffer). The
 * walk starts at the end and skips everything from the first rim-overlapping
 * sample backward-inclusive — i.e. only samples strictly before the ball
 * touched the rim's box feed the average.
 *
 * NOTE on the blur test: BallSample carries the SMOOTHED radius (the tracker
 * EMA), not the raw box, so aspect can't be recomputed here. The tracker's
 * aspect gate (TRACKER.aspectWidthFactor = 1.4) has already rejected heavily
 * elongated boxes upstream, and the radius EMA's 12%/frame clamp bounds the
 * per-sample inflation to ~the blurAspectRejectFrac budget. The residual bias
 * this leaves is exactly what DEPTH_GATE.blurAllowanceLn covers. Samples with
 * score 0 (predicted) are excluded outright.
 */
export function selectDepthSamples(
  history: readonly BallSample[],
  rimBox: Box,
  maxN: number = DEPTH_GATE.avgWindow,
): DepthSampleSelection {
  // Find the first index (from the end) where the ball overlaps the rim; only
  // samples strictly before it are usable.
  let cutoff = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i]!;
    if (overlapsRim(s, rimBox)) cutoff = i;
  }

  let sum = 0;
  let n = 0;
  let rejectedBlur = 0;
  for (let i = cutoff - 1; i >= 0 && n < maxN; i--) {
    const s = history[i]!;
    if (s.predicted || s.r <= 0) continue;
    // Radius sanity vs the local neighborhood: a sample whose radius jumps
    // more than the blur budget above the running minimum of its neighbors is
    // treated as blur-inflated and skipped (cheap stand-in for the box-aspect
    // test, which the smoothed samples can't provide).
    const prev = i > 0 ? history[i - 1]! : null;
    if (
      prev != null &&
      !prev.predicted &&
      prev.r > 0 &&
      s.r > prev.r * (1 + DEPTH_GATE.blurAspectRejectFrac)
    ) {
      rejectedBlur++;
      continue;
    }
    sum += 2 * s.r;
    n++;
  }
  return { avgDiaPx: n > 0 ? sum / n : null, nReal: n, rejectedBlur };
}
