/**
 * Low-fps trajectory-fit matrix.
 *
 * A quadratic arc fit needs the SAME real physics whether it is sampled at 8
 * or 30 fps — only the number of samples drops. The default fit floor stays
 * at MIN_FIT_SAMPLES (5) so 30 fps is unchanged; low-fps callers pass an
 * fps-scaled floor, and no fit is ever allowed below ABS_MIN_FIT_SAMPLES (3),
 * the minimum that determines the three-coefficient quadratic.
 */
import {
  ABS_MIN_FIT_SAMPLES,
  MIN_FIT_SAMPLES,
  fitArc,
} from '../trajectory';
import type { BallSample } from '../types';

const G = 900;
const X0 = 100;
const VX = 150;
const Y0 = 500;
const VY0 = 600;

/** Sample the reference projectile at `fps` over [0, durationSec]. */
function projectile(fps: number, durationSec: number): BallSample[] {
  const out: BallSample[] = [];
  const dt = 1 / fps;
  for (let t = 0; t <= durationSec + 1e-9; t += dt) {
    out.push({
      cx: X0 + VX * t,
      cy: Y0 - VY0 * t + 0.5 * G * t * t,
      r: 12,
      t,
      score: 0.9,
      predicted: false,
    });
  }
  return out;
}

describe('fitArc low-fps', () => {
  test('default floor is unchanged (30 fps identical): 4 samples still null, 5 fits', () => {
    expect(MIN_FIT_SAMPLES).toBe(5);
    // A quarter-second at 30 fps ≈ 8 samples; a 4-sample slice is null.
    const full = projectile(30, 0.25);
    expect(fitArc(full.slice(0, 4))).toBeNull();
    expect(fitArc(full.slice(0, 5))).not.toBeNull();
  });

  test('a sparse 8 fps arc (3 samples) fits when the caller passes the scaled floor', () => {
    // 3 samples over a real descending arc: below the default 5, so null by
    // default — but a low-fps caller passing minSamples=3 gets a valid fit.
    const sparse = projectile(8, 0.25); // ~3 samples
    expect(sparse.length).toBeGreaterThanOrEqual(ABS_MIN_FIT_SAMPLES);
    expect(fitArc(sparse)).toBeNull(); // default floor rejects it
    const fit = fitArc(sparse, ABS_MIN_FIT_SAMPLES);
    expect(fit).not.toBeNull();
    // 3 points exactly determine the quadratic → recovers g/2 essentially exactly.
    expect(Math.abs(fit!.ya - G / 2)).toBeLessThan(1);
  });

  test('the hard floor holds: a caller passing minSamples below 3 still cannot fit 2 points', () => {
    const two = projectile(8, 0.2).slice(0, 2);
    expect(two).toHaveLength(2);
    // Even minSamples=1 cannot fit 2 points — ABS_MIN_FIT_SAMPLES (3) is the
    // hard clamp inside fitArc.
    expect(fitArc(two, 1)).toBeNull();
  });
});
