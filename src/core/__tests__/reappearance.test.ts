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
const G = 900;
const X0 = 100;
const VX = 300;
const Y0 = 600;
// Must clear the rim plane at y=300: apex y = Y0 - VY0²/2G = 244 < 300 ✓.
const VY0 = 800;

/** y(t), x(t) of the reference flight. */
const yAt = (t: number) => Y0 - VY0 * t + 0.5 * G * t * t;
const xAt = (t: number) => X0 + VX * t;
/** Descending crossing time of plane y. */
const tCross = (planeY: number) =>
  (VY0 + Math.sqrt(VY0 * VY0 - 2 * G * (Y0 - planeY))) / G;

const RIM: RimGeometry = (() => {
  const planeY = 300;
  const cx = xAt(tCross(planeY)); // rim centered where the flight arrives
  const w = 60;
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

/**
 * A PHYSICAL below-rim reappearance: dropping through the net strips the
 * horizontal velocity, so x freezes at the crossing point (+ optional net
 * deflection) while y keeps following the gravity arc.
 */
function reappear(t: number, dx = 0): ReappearanceSample {
  return { cx: xAt(tCross(RIM.planeY)) + dx, cy: yAt(t), vy: G * t - VY0, diaPx: 24 };
}

const CROSS_T = tCross(RIM.planeY);
/** Ball lost shortly before the crossing. */
const LOST_T = CROSS_T - 0.15;

function armed(): ReappearanceTest {
  const r = new ReappearanceTest();
  r.armOnBallLost(preGap(LOST_T), RIM, LOST_T);
  expect(r.armed).toBe(true);
  return r;
}

describe('ReappearanceTest', () => {
  test('HONEST PATH: swish reappears below on the arc → corroborates', () => {
    const r = armed();
    const t1 = CROSS_T + 0.1; // below plane, y on the parabola, x frozen at the rim
    expect(r.onSample(reappear(t1), t1, 0.3, 7).fired).toBe(false); // 1st descending
    const t2 = t1 + 1 / FPS;
    const res = r.onSample(reappear(t2), t2, 0.3, 7);
    expect(res.fired).toBe(true);
    expect(res.corroborates).toBe(true);
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
    const r = new ReappearanceTest();
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
    const r = new ReappearanceTest();
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
