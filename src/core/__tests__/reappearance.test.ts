/**
 * Reappearance corroborator tests — the five adversarial fixtures (A–E) that
 * BROKE the naive "reappeared below ⇒ make" design, each now asserted to be
 * handled, plus the honest-path corroboration.
 *
 * Geometry: analysis px, +y down. A ballistic flight toward a rim whose
 * plane sits at y=300.
 */
import { REAPPEAR } from '../config';
import { ReappearanceTest, type ReappearanceSample } from '../reappearance';
import { evalArc, fitArc } from '../trajectory';
import type { BallSample, RimGeometry } from '../types';

const FPS = 30;
/**
 * PHYSICAL CONSISTENCY — required by the free-fall drag test, new here.
 *
 * The drag test derives image-plane gravity from the LOCKED RIM
 * (9.81 · rimWidth / 0.45 m) and refuses to answer when that disagrees with
 * the flight's own fitted curvature by more than REAPPEAR.dragGravityAgreeFrac.
 * The old fixture paired G = 900 px/s² with a 60 px rim — but 900 px/s² is a
 * 41 px rim, a 45% disagreement — so every drag verdict would have come back
 * 'unknown' and this suite would have pinned the new gate at nothing. G is now
 * DERIVED from the rim width so the fixture describes one coherent camera.
 */
const RIM_W = 60;
const G = 9.81 * (RIM_W / 0.45); // = 1308 px/s²
const X0 = 100;
const VX = 300;
const Y0 = 600;
// Must clear the rim plane at y=300: apex y = Y0 - VY0²/2G = 218 < 300 ✓.
// (Raised from 800 with G: a stronger gravity needs a stronger launch.)
const VY0 = 1000;

/** y(t), x(t) of the reference flight. */
const yAt = (t: number) => Y0 - VY0 * t + 0.5 * G * t * t;
const xAt = (t: number) => X0 + VX * t;
/** Descending crossing time of plane y. */
const tCross = (planeY: number) =>
  (VY0 + Math.sqrt(VY0 * VY0 - 2 * G * (Y0 - planeY))) / G;

const RIM: RimGeometry = (() => {
  const planeY = 300;
  const cx = xAt(tCross(planeY)); // rim centered where the flight arrives
  const w = RIM_W;
  return {
    box: { x: cx - w / 2, y: planeY - 15, width: w, height: 30 },
    planeY,
    spanLeft: cx - 24,
    spanRight: cx + 24,
    belowY: planeY + 15 + 15,
    upZone: { x: cx - 120, y: planeY - 200, width: 240, height: 200 },
    hoopRoi: { x: cx - 75, y: planeY - 40, width: 150, height: 80 },
    netRoi: { x: cx - 30, y: planeY, width: 60, height: 36 },
  } as RimGeometry;
})();

/** Real pre-gap samples t=0 .. tEnd. */
function preGap(tEnd: number): BallSample[] {
  const out: BallSample[] = [];
  for (let i = 0; i * (1 / FPS) <= tEnd; i++) {
    const t = i / FPS;
    out.push({ cx: xAt(t), cy: yAt(t), r: 12, t, score: 0.7, predicted: false });
  }
  return out;
}

/** A real sample ON the true flight at time t (below-rim reappearance). */
function onArc(t: number, over: Partial<ReappearanceSample> = {}): ReappearanceSample {
  return { cx: xAt(t), cy: yAt(t), vy: G * t - VY0, diaPx: 24, ...over };
}

const CROSS_T = tCross(RIM.planeY);
/** Ball lost shortly before the crossing. */
const LOST_T = CROSS_T - 0.15;
/** True descending speed at the instant the ball reaches the rim plane. */
const VY_AT_CROSS = G * CROSS_T - VY0;

/**
 * Vertical speed the net removes at the crossing instant, px/s.
 *
 * ⚠ A GUESS, like every drag-test number — nobody has measured what a real net
 * takes off a real make in this app's footage. 120 px/s at this fixture's
 * 133 px/m scale is ~0.9 m/s off a ~4.6 m/s entry, which lands the ratio at
 * 0.80 — comfortably inside the cited 10–90% 'through' band without hugging
 * either edge, so the suite pins the BAND rather than a boundary.
 */
const NET_BRAKE = 120;

/**
 * y(t) for a ball that lost `brake` px/s of vertical speed at the crossing.
 * Constant acceleration on both sides, one impulse at CROSS_T.
 */
function yBraked(t: number, brake: number): number {
  if (t <= CROSS_T) return yAt(t);
  const dt = t - CROSS_T;
  return yAt(CROSS_T) + (VY_AT_CROSS - brake) * dt + 0.5 * G * dt * dt;
}

/**
 * A PHYSICAL below-rim reappearance THROUGH THE NET: dropping through the net
 * strips the horizontal velocity, so x freezes at the crossing point (+ any
 * net deflection) — and it strips VERTICAL speed too, which is the entire
 * premise of the free-fall drag test. The old fixture kept the ball on the
 * un-braked parabola, i.e. it modelled a swish as a FRICTIONLESS fall through
 * the hoop; under the drag test that is the signature of a ball that touched
 * NOTHING. Pinning it as the honest make path would have pinned the exact
 * physics the new gate exists to reject, so the swish is now braked.
 * (The un-braked version is still pinned — as a VETO, below.)
 */
function reappear(t: number, dx = 0): ReappearanceSample {
  return {
    cx: xAt(CROSS_T) + dx,
    cy: yBraked(t, NET_BRAKE),
    vy: G * t - VY0 - NET_BRAKE,
    diaPx: 24,
  };
}

/**
 * The same reappearance with NO energy loss — the ball fell through clean air
 * at 100% of free fall. Geometrically identical to a swish (below the plane,
 * in span, on the arc, descending); only the drag test can tell them apart.
 */
function freeFallReappear(t: number, dx = 0): ReappearanceSample {
  return { cx: xAt(CROSS_T) + dx, cy: yAt(t), vy: G * t - VY0, diaPx: 24 };
}

function armed(): ReappearanceTest {
  const r = new ReappearanceTest({ dragVetoEnabled: true });
  r.armOnBallLost(preGap(LOST_T), RIM, LOST_T);
  expect(r.armed).toBe(true);
  return r;
}

describe('ReappearanceTest', () => {
  test('HONEST PATH: net-braked swish reappears below on the arc → corroborates', () => {
    const r = armed();
    const t1 = CROSS_T + 0.1; // below plane, y on the parabola, x frozen at the rim
    expect(r.onSample(reappear(t1), t1, 0.3, 7).fired).toBe(false); // 1st descending
    const t2 = t1 + 1 / FPS;
    const res = r.onSample(reappear(t2), t2, 0.3, 7);
    expect(res.fired).toBe(true);
    expect(res.corroborates).toBe(true);
    // The drag test ran and said "something braked it" — hand-checked below.
    expect(res.drag?.verdict).toBe('through');
    expect(res.drag?.ratio).toBeCloseTo(0.805, 2);
  });

  // -------------------------------------------------------------------------
  // FIXTURE F — free-fall drag: the ball that fell through CLEAN AIR
  // -------------------------------------------------------------------------

  test('FIXTURE F: an UN-BRAKED reappearance (100% free fall) is VETOED', () => {
    // Geometrically this sample is indistinguishable from the honest swish
    // above: below the plane, on the pre-gap arc, descending, dead centre of
    // the span, depth-consistent. Every pre-existing gate passes it. Only the
    // physics separates them — nothing bled energy off this ball, so it never
    // touched the net, so it did not go through. This is the failure the
    // Roboflow write-up describes from the other side: a call made with no
    // detection at the rim at all.
    const r = armed();
    const t1 = CROSS_T + 0.1;
    expect(r.onSample(freeFallReappear(t1), t1, 0.3, 7).fired).toBe(false);
    const t2 = t1 + 1 / FPS;
    const res = r.onSample(freeFallReappear(t2), t2, 0.3, 7);
    expect(res.fired).toBe(true);
    expect(res.corroborates).toBe(false); // ← the veto
    expect(res.drag?.verdict).toBe('untouched');
    expect(res.drag?.ratio).toBeCloseTo(1.0, 2);
    expect(res.reason).toContain('untouched');
  });

  test('FIXTURE F2: the veto is measured, not assumed — hand-computed numbers', () => {
    // Every number here is derived on paper from the fixture constants, so a
    // silent change to the measurement path fails the test instead of being
    // absorbed by it.
    //   G        = 9.81 · 60/0.45                       = 1308 px/s²
    //   CROSS_T  = (VY0 + √(VY0² − 2G(Y0−300)))/G       = 1.11919 s
    //   LOST_T   = CROSS_T − 0.15                       = 0.96919 s
    //   last pre-gap sample at 30 fps = floor(0.96919·30)/30 = 29/30 = 0.96667
    //   vyEntry  = −VY0 + G·0.96667                     = 264.4 px/s
    //   samples at t1 = CROSS_T+0.1 and t2 = t1+1/30; midpoint 1.23586 s
    //   gap      = 1.23586 − 0.96667                    = 0.26919 s
    //   expected = 264.4 + 1308·0.26919                 = 616.5 px/s
    // Free fall measures exactly 616.5 ⇒ ratio 1.000; braking by NET_BRAKE
    // (120) measures 496.5 ⇒ ratio 0.805.
    const r = armed();
    const t1 = CROSS_T + 0.1;
    const t2 = t1 + 1 / FPS;
    r.onSample(freeFallReappear(t1), t1, 0.3, 7);
    const d = r.onSample(freeFallReappear(t2), t2, 0.3, 7).drag;
    expect(d).toBeDefined();
    expect(d!.gravityPxPerSec2).toBeCloseTo(1308, 0);
    expect(d!.vyEntryPxPerSec).toBeCloseTo(264.4, 1);
    expect(d!.gapSec).toBeCloseTo(0.26919, 4);
    expect(d!.expectedPxPerSec).toBeCloseTo(616.5, 1);
    expect(d!.vyMeasuredPxPerSec).toBeCloseTo(616.5, 1);
    // And the braked twin, same epochs, one impulse different.
    const r2 = armed();
    r2.onSample(reappear(t1), t1, 0.3, 7);
    const d2 = r2.onSample(reappear(t2), t2, 0.3, 7).drag;
    expect(d2!.vyMeasuredPxPerSec).toBeCloseTo(616.5 - NET_BRAKE, 1);
    expect(d2!.ratio).toBeCloseTo((616.5 - NET_BRAKE) / 616.5, 3);
  });

  test('FIXTURE F3: a ball hanging motionless below the rim is REJECTED', () => {
    // Two below-rim sightings at the same height: measured speed ≈ 0 against
    // an expected 616 px/s. That is not the ball we lost — a court ball
    // sitting in frame, a tracker switch — so the sample is discarded as
    // not-the-same-ball and the trap disarms rather than waiting for a better
    // one. BREAD-BALL: strictly removes a make term.
    const r = armed();
    const t1 = CROSS_T + 0.1;
    const t2 = t1 + 1 / FPS;
    const cy = yBraked(t1, NET_BRAKE);
    const still = (t: number): ReappearanceSample => ({
      cx: xAt(CROSS_T),
      cy, // identical height at both epochs ⇒ vyMeasured = 0
      vy: 200, // the tracker still *claims* it is descending…
      diaPx: 24,
    });
    expect(r.onSample(still(t1), t1, 0.3, 7).fired).toBe(false);
    const res = r.onSample(still(t2), t2, 0.3, 7);
    expect(res.fired).toBe(true);
    expect(res.corroborates).toBe(false);
    expect(res.drag?.verdict).toBe('reject');
    expect(res.drag?.ratio).toBeCloseTo(0, 3);
  });

  test('FIXTURE F4: the drag test reads POSITION, never the tracker vy', () => {
    // The tracker's vy is Kalman state carrying a gravity prior that coasts
    // through exactly this occlusion, so it is biased toward the free-fall
    // answer the test is trying to falsify. Handing the trap a wildly wrong vy
    // (while the positions still describe a braked drop) must not move the
    // verdict at all — if this ever fails, the measurement went circular.
    const r = armed();
    const t1 = CROSS_T + 0.1;
    const t2 = t1 + 1 / FPS;
    const liar = (t: number): ReappearanceSample => ({
      ...reappear(t),
      vy: 99999, // absurd, but still > 0 so the descending gate passes
    });
    r.onSample(liar(t1), t1, 0.3, 7);
    const res = r.onSample(liar(t2), t2, 0.3, 7);
    expect(res.drag?.verdict).toBe('through');
    expect(res.drag?.vyMeasuredPxPerSec).toBeCloseTo(616.5 - NET_BRAKE, 1);
  });

  test('FIXTURE A: rim bounce inside the gap → y-residual rejects, no make', () => {
    const r = armed();
    // A bounce kills the vertical momentum: the ball shows up ~0.3s later far
    // ABOVE where the un-bounced arc would be (hundreds of px of residual).
    const t = CROSS_T + 0.3;
    const bounced: ReappearanceSample = {
      cx: xAt(t),
      cy: yAt(t) - 350, // way off the pre-gap arc
      vy: 120,
      diaPx: 24,
    };
    const res = r.onSample(bounced, t, 0.3, 7);
    expect(res.fired).toBe(true);
    expect(res.corroborates).toBe(false);
    expect(res.reason).toContain('y-residual');
    expect(r.armed).toBe(false); // disarmed, not lingering
  });

  test('FIXTURE B: front-parallax ball (renders too big) → depth veto', () => {
    // Close-framing scene (rim 90px wide): a ball ~1m in FRONT of the hoop
    // renders ~63px — provably front even at single-sample noise. (Against
    // the 60px rim the same offset is only ~1.9σ and the gate honestly stays
    // silent — that regime is owned by the pre-crossing averaged veto.)
    const closeRim = { ...RIM, box: { ...RIM.box, width: 90 } };
    const r = new ReappearanceTest({ dragVetoEnabled: true });
    r.armOnBallLost(preGap(LOST_T), closeRim, LOST_T);
    expect(r.armed).toBe(true);
    const t = CROSS_T + 0.1;
    const res = r.onSample({ ...reappear(t), diaPx: 63 }, t, 0.1, 7);
    expect(res.fired).toBe(true);
    expect(res.corroborates).toBe(false);
    expect(res.reason).toContain('depth front');
  });

  test('FIXTURE C: putback rise through the band → vy gate rejects', () => {
    const r = armed();
    const t = CROSS_T + 0.12;
    const rising = onArc(t, { vy: -200 }); // moving UP
    const res = r.onSample(rising, t, 0.2, 7);
    expect(res.fired).toBe(true);
    expect(res.corroborates).toBe(false);
    expect(res.reason).toContain('descending');
  });

  test('FIXTURE C2: TTL hard-clears a stale trap (weak net)', () => {
    const r = armed();
    const late = CROSS_T + REAPPEAR.ttlAfterPredictedCrossSec + 0.05;
    const res = r.onSample(onArc(late), late, 0.02, 7); // net quiet
    expect(res.fired).toBe(true);
    expect(res.corroborates).toBe(false);
    expect(res.reason).toBe('ttl');
  });

  test('FIXTURE D: net-deflected swish +28px lateral → widened span passes', () => {
    const r = armed();
    const t1 = CROSS_T + 0.1;
    // +28px puts the ball OUTSIDE the raw span half-width (24px) but inside
    // the 15%-widened one — the old 10px x-rule false-missed exactly this.
    expect(r.onSample(reappear(t1, 28), t1, 0.4, 7).fired).toBe(false);
    const t2 = t1 + 1 / FPS;
    const res = r.onSample(reappear(t2, 28), t2, 0.4, 7);
    expect(res.corroborates).toBe(true);
  });

  test('FIXTURE E: net-hang extends the window only while net stays hot', () => {
    const r = armed();
    const hangT = CROSS_T + REAPPEAR.ttlAfterPredictedCrossSec + 0.2;
    // Net elevated → NOT expired yet (extended to maxGapNetHangSec).
    expect(r.expired(hangT, 0.4)).toBe(false);
    // Net quiet → the same instant is past TTL.
    expect(r.expired(hangT, 0.02)).toBe(true);
    // But even net-hang has a hard end.
    expect(r.expired(LOST_T + REAPPEAR.maxGapNetHangSec + 0.05, 0.4)).toBe(true);
  });

  test('refuses to arm without a trustworthy pre-gap arc', () => {
    const r = new ReappearanceTest({ dragVetoEnabled: true });
    r.armOnBallLost(preGap(0.1), RIM, 0.1); // only ~4 samples
    expect(r.armed).toBe(false);
    // Flat roll (no gravity signature): never arms.
    const flat: BallSample[] = Array.from({ length: 10 }, (_, i) => ({
      cx: 100 + i * 20,
      cy: 500,
      r: 12,
      t: i / FPS,
      score: 0.7,
      predicted: false,
    }));
    r.armOnBallLost(flat, RIM, 0.33);
    expect(r.armed).toBe(false);
  });

  test('sanity: the fixture arc really is time-consistent with itself', () => {
    const fit = fitArc(preGap(LOST_T));
    expect(fit).not.toBeNull();
    const t = CROSS_T + 0.1;
    expect(Math.abs(evalArc(fit!, t).y - yAt(t))).toBeLessThan(2);
  });
});
