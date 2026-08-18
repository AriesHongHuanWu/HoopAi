/**
 * Pose cadence vs form-sequence budget.
 *
 * WHY THIS EXISTS: the pose pass used to run on EVERY analysed frame, which is
 * why shooting-form analysis — the side-by-side comparison this product is
 * demoed on — was restricted to `poseSafe` (high-tier) phones and force-
 * disabled on everything else. It is now THROTTLED per tier instead
 * (FORM.poseMinIntervalMs), which only works if the throttled rate still fills
 * a form sequence.
 *
 * These tests pin that budget. Raising an interval far enough to starve
 * buildSequence() would silently break form analysis on that tier — the
 * failure mode would be "Form Studio shows nothing and nobody knows why" —
 * so the relationship is asserted rather than left as a comment.
 */
import { FORM } from '../config';
import { SEQ_WINDOW_SEC } from '../formSequence';

/** buildSequence() refuses below this many raw frames (formSequence.ts). */
const MIN_RAW_FRAMES = 4;

/** Frames captured in one sequence window at a given inter-pose gap. */
function framesInWindow(gapMs: number): number {
  if (gapMs <= 0) return Infinity; // every analysed frame
  return Math.floor((SEQ_WINDOW_SEC * 1000) / gapMs);
}

describe('pose cadence budget', () => {
  test('every tier still fills a form sequence with margin', () => {
    for (const tier of ['high', 'mid', 'entry'] as const) {
      const frames = framesInWindow(FORM.poseMinIntervalMs[tier]);
      // 2x the floor: a shot near the window edge, or one dropped pose, must
      // not take the tier below the refusal threshold.
      expect(frames).toBeGreaterThanOrEqual(MIN_RAW_FRAMES * 2);
    }
  });

  test('entry tier — the phone class that was denied the feature — clears the floor', () => {
    expect(framesInWindow(FORM.poseMinIntervalMs.entry)).toBeGreaterThanOrEqual(10);
  });

  test('high tier is unthrottled, so its behaviour is unchanged', () => {
    expect(FORM.poseMinIntervalMs.high).toBe(0);
  });

  test('cadence is ordered: a weaker tier never samples MORE often', () => {
    const { high, mid, entry } = FORM.poseMinIntervalMs;
    expect(high).toBeLessThanOrEqual(mid);
    expect(mid).toBeLessThanOrEqual(entry);
  });
});
