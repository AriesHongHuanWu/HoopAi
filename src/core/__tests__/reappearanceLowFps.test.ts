/**
 * Low-fps reappearance-corroborator matrix.
 *
 * The corroborator arms off a pre-gap parabola fit. At 30 fps the pre-gap
 * flight easily clears the 5-sample floor; at 8 fps the same wall-clock flight
 * carries far fewer samples, so the floor is now fps-scaled off the history's
 * own measured cadence (never below the 3-sample hard floor that determines a
 * quadratic). These tests sample the SAME continuous flight at 8 / 12 / 15 /
 * 24 / 30 fps and assert: it still ARMS at low fps, and the honest below-rim
 * reappearance still CORROBORATES.
 */
import { ReappearanceTest, type ReappearanceSample } from '../reappearance';
import type { BallSample, RimGeometry } from '../types';

const G = 900;
const X0 = 100;
const VX = 300;
const Y0 = 600;
const VY0 = 800; // apex y = Y0 - VY0²/2G = 244 < 300 (clears the rim plane)

const yAt = (t: number): number => Y0 - VY0 * t + 0.5 * G * t * t;
const xAt = (t: number): number => X0 + VX * t;
const tCross = (planeY: number): number =>
  (VY0 + Math.sqrt(VY0 * VY0 - 2 * G * (Y0 - planeY))) / G;

const RIM: RimGeometry = (() => {
  const planeY = 300;
  const cx = xAt(tCross(planeY));
  const w = 60;
  return {
    box: { x: cx - w / 2, y: planeY - 15, width: w, height: 30 },
    cx,
    cy: planeY,
    planeY,
    spanLeft: cx - 24,
    spanRight: cx + 24,
    belowY: planeY + 15 + 15,
    upZone: { x: cx - 120, y: planeY - 200, width: 240, height: 200 },
    hoopRoi: { x: cx - 75, y: planeY - 40, width: 150, height: 80 },
    netRoi: { x: cx - 30, y: planeY, width: 60, height: 36 },
  } as RimGeometry;
})();

const CROSS_T = tCross(RIM.planeY);
const LOST_T = CROSS_T - 0.1;

const FPS_RATES = [8, 12, 15, 24, 30] as const;

/** Pre-gap real samples at `fps` over [0, tEnd]. */
function preGap(fps: number, tEnd: number): BallSample[] {
  const out: BallSample[] = [];
  const dt = 1 / fps;
  for (let t = 0; t <= tEnd + 1e-9; t += dt) {
    out.push({ cx: xAt(t), cy: yAt(t), r: 12, t, score: 0.7, predicted: false });
  }
  return out;
}

/** A physical below-rim reappearance (x frozen at the crossing, y on the arc). */
function reappear(t: number, dx = 0): ReappearanceSample {
  return { cx: xAt(CROSS_T) + dx, cy: yAt(t), vy: G * t - VY0, diaPx: 24 };
}

describe('ReappearanceTest low-fps matrix', () => {
  describe('arms off the pre-gap arc at every fps (fps-scaled sample floor)', () => {
    for (const fps of FPS_RATES) {
      test(`${fps}fps: arms`, () => {
        const r = new ReappearanceTest();
        const history = preGap(fps, LOST_T);
        r.armOnBallLost(history, RIM, LOST_T);
        expect(r.armed).toBe(true);
      });
    }
  });

  describe('honest below-rim swish corroborates at every fps', () => {
    for (const fps of FPS_RATES) {
      test(`${fps}fps: two descending on-arc samples → corroborates`, () => {
        const r = new ReappearanceTest();
        r.armOnBallLost(preGap(fps, LOST_T), RIM, LOST_T);
        expect(r.armed).toBe(true);
        const dt = 1 / fps;
        const t1 = CROSS_T + dt;
        expect(r.onSample(reappear(t1), t1, 0.3, 7).fired).toBe(false);
        const t2 = t1 + dt;
        const res = r.onSample(reappear(t2), t2, 0.3, 7);
        expect(res.fired).toBe(true);
        expect(res.corroborates).toBe(true);
      });
    }
  });

  test('a too-short history (below the 3-sample hard floor) still refuses to arm', () => {
    // Even fps-scaling never drops below ABS_MIN_FIT_SAMPLES (3): a 2-sample
    // history cannot determine a quadratic and must not arm.
    const r = new ReappearanceTest();
    const dt = 1 / 8;
    const twoSamples: BallSample[] = [
      { cx: xAt(0), cy: yAt(0), r: 12, t: 0, score: 0.7, predicted: false },
      { cx: xAt(dt), cy: yAt(dt), r: 12, t: dt, score: 0.7, predicted: false },
    ];
    r.armOnBallLost(twoSamples, RIM, dt);
    expect(r.armed).toBe(false);
  });
});
