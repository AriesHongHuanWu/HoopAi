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
 *
 * The free-fall drag test adds a SECOND fps story on top of that one, and it
 * runs the other way: low fps measures velocity MORE precisely (a longer
 * baseline between frames), so the physics gets sharper as the frame rate
 * drops, while the occlusion gap in seconds stays the same. At 8/12/15 fps the
 * two post-gap samples straddle enough time for REAPPEAR.dragMinGapSec to be
 * met and the verdict is a real 'through'; at 24/30 fps the same two samples
 * land inside 0.20 s of the last pre-gap sighting and the honest answer is
 * 'unknown' — the bands cannot discriminate there, so nothing is claimed. Both
 * are asserted below, because "it refuses at 30 fps" is a load-bearing
 * property, not a gap in coverage.
 */
import { REAPPEAR } from '../config';
import { ReappearanceTest, type ReappearanceSample } from '../reappearance';
import type { BallSample, RimGeometry } from '../types';

/**
 * G is DERIVED from the fixture rim width so the fixture describes one
 * coherent camera: the drag test reads image-plane gravity off the locked rim
 * (9.81 · rimWidth / 0.45 m) and refuses when it disagrees with the flight's
 * own curvature. The old G = 900 paired with a 60 px rim implied a 41 px rim —
 * a 45% disagreement that would have made every verdict 'unknown'.
 */
const RIM_W = 60;
const X0 = 100;
const VX = 300;
const Y0 = 600;
const G = 9.81 * (RIM_W / 0.45); // = 1308 px/s²
const VY0 = 1000; // apex y = Y0 - VY0²/2G = 218 < 300 (clears the rim plane)

const yAt = (t: number): number => Y0 - VY0 * t + 0.5 * G * t * t;
const xAt = (t: number): number => X0 + VX * t;
const tCross = (planeY: number): number =>
  (VY0 + Math.sqrt(VY0 * VY0 - 2 * G * (Y0 - planeY))) / G;

const RIM: RimGeometry = (() => {
  const planeY = 300;
  const cx = xAt(tCross(planeY));
  const w = RIM_W;
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

const VY_AT_CROSS = G * CROSS_T - VY0;
/** Vertical speed the net strips at the crossing (a guess — see REAPPEAR.drag*). */
const NET_BRAKE = 120;

/**
 * A physical below-rim reappearance THROUGH THE NET: x frozen at the crossing,
 * y on the gravity arc but starting NET_BRAKE px/s slower from the crossing
 * instant. The un-braked version used to stand in for a swish here; under the
 * free-fall drag test an un-braked drop is by definition a ball that touched
 * nothing, so it is pinned as a veto in reappearance.test.ts instead.
 */
function reappear(t: number, dx = 0): ReappearanceSample {
  const dt = Math.max(0, t - CROSS_T);
  const cy =
    t <= CROSS_T
      ? yAt(t)
      : yAt(CROSS_T) + (VY_AT_CROSS - NET_BRAKE) * dt + 0.5 * G * dt * dt;
  return { cx: xAt(CROSS_T) + dx, cy, vy: G * t - VY0 - NET_BRAKE, diaPx: 24 };
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

        // --- and the free-fall drag test's own fps story -------------------
        // The measurement epoch is the midpoint of the two post-gap samples,
        // so the gap this test sees GROWS as fps falls (the samples are
        // further apart in time). Below REAPPEAR.dragMinGapSec the free-fall
        // increment g·gap does not stand clear of pixel noise and the verdict
        // must be 'unknown' — never a guess, and never a veto.
        expect(res.drag).toBeDefined();
        const gap = res.drag!.gapSec;
        if (gap >= REAPPEAR.dragMinGapSec) {
          // 8 / 12 / 15 fps: gap 0.307 / 0.244 / 0.219 s.
          expect(res.drag!.verdict).toBe('through');
        } else {
          // 24 / 30 fps: gap 0.182 / 0.169 s — under the floor.
          expect(res.drag!.verdict).toBe('unknown');
          // The ratio is still reported so telemetry can re-fit the bands…
          expect(Number.isFinite(res.drag!.ratio)).toBe(true);
          // …and it is nowhere near 1, i.e. the refusal is a genuine
          // statement about resolving power, not a masked 'through'.
          expect(res.drag!.ratio).toBeLessThan(REAPPEAR.dragThroughMax);
        }
        // Either way the corroboration above is UNCHANGED from before the
        // drag test existed: 'through' and 'unknown' are both no-ops.
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
