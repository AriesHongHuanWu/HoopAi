import { SHOT_FSM } from '../config';
import {
  apexPoint,
  entryAngleDegAtPlane,
  evalArc,
  backfillPredictedGap,
  fitArc,
  plausibleArcCurvature,
  predictLanding,
  releaseAngleDeg,
  sampleArc,
  xAtPlaneY,
} from '../trajectory';
import type { ArcFit } from '../trajectory';
import type { BallSample } from '../types';

const FPS = 30;
/** Gravity in analysis px/s² (matches TRACKER.gravityPxPerSec2Fallback). */
const G = 900;

// Reference projectile (screen coords, +y DOWN):
//   y(t) = Y0 - VY0*t + 0.5*G*t²   x(t) = X0 + VX*t
const X0 = 100;
const VX = 150;
const Y0 = 500;
const VY0 = 600;

// Analytic ground truth for the reference projectile.
const APEX_T = VY0 / G; // 0.667 s
const APEX = { x: X0 + VX * APEX_T, y: Y0 - (VY0 * VY0) / (2 * G) }; // (200, 300)
const RELEASE_ANGLE = (Math.atan2(VY0, VX) * 180) / Math.PI; // 75.96°
const PLANE_Y = 400;
// Descending root of 0.5*G*t² - VY0*t + (Y0 - PLANE_Y) = 0.
const T_CROSS = (VY0 + Math.sqrt(VY0 * VY0 - 2 * G * (Y0 - PLANE_Y))) / G;
const X_CROSS = X0 + VX * T_CROSS; // 270.71
const VY_AT_CROSS = G * T_CROSS - VY0; // 424.26 px/s downward
const ENTRY_ANGLE = (Math.atan2(VY_AT_CROSS, VX) * 180) / Math.PI; // 70.53°

interface ProjOpts {
  frames?: number;
  startFrame?: number;
  score?: number;
  noiseY?: (i: number) => number;
}

function projectile(opts: ProjOpts = {}): BallSample[] {
  const { frames = 40, startFrame = 0, score = 0.9, noiseY } = opts;
  const out: BallSample[] = [];
  for (let i = startFrame; i < startFrame + frames; i++) {
    const t = i / FPS;
    out.push({
      cx: X0 + VX * t,
      cy: Y0 - VY0 * t + 0.5 * G * t * t + (noiseY ? noiseY(i) : 0),
      r: 12,
      t,
      score,
      predicted: false,
    });
  }
  return out;
}

describe('fitArc', () => {
  test('clean projectile recovers exact coefficients', () => {
    const fit = fitArc(projectile());
    expect(fit).not.toBeNull();
    expect(fit!.ya).toBeCloseTo(G / 2, 4);
    expect(fit!.yb).toBeCloseTo(-VY0, 4);
    expect(fit!.yc).toBeCloseTo(Y0, 4);
    expect(fit!.xm).toBeCloseTo(VX, 4);
    expect(fit!.xq).toBeCloseTo(X0, 4);
    expect(fit!.r2y).toBeGreaterThan(0.999);
    expect(fit!.tMin).toBeCloseTo(0, 9);
    expect(fit!.tMax).toBeCloseTo(39 / FPS, 9);
  });

  test('noisy projectile: ya within 5% of g/2, r2y > 0.99', () => {
    const fit = fitArc(
      projectile({ noiseY: (i) => 1.5 * Math.sin(i * 1.7) }),
    );
    expect(fit).not.toBeNull();
    expect(Math.abs(fit!.ya - G / 2) / (G / 2)).toBeLessThan(0.05);
    expect(fit!.r2y).toBeGreaterThan(0.99);
  });

  test('fewer than 5 samples returns null', () => {
    expect(fitArc(projectile({ frames: 3 }))).toBeNull();
    expect(fitArc(projectile({ frames: 4 }))).toBeNull();
    expect(fitArc([])).toBeNull();
    // Boundary: exactly 5 samples fits.
    expect(fitArc(projectile({ frames: 5 }))).not.toBeNull();
  });

  test('flat roll returns null', () => {
    const flat: BallSample[] = [];
    for (let i = 0; i < 30; i++) {
      flat.push({
        cx: 50 + (200 * i) / FPS,
        cy: 500,
        r: 12,
        t: i / FPS,
        score: 0.9,
        predicted: false,
      });
    }
    expect(fitArc(flat)).toBeNull();
  });

  test('degenerate time distribution (all same t) returns null', () => {
    const stuck: BallSample[] = [];
    for (let i = 0; i < 8; i++) {
      stuck.push({
        cx: 100 + i,
        cy: 300 + i * i,
        r: 12,
        t: 1.0,
        score: 0.9,
        predicted: false,
      });
    }
    expect(fitArc(stuck)).toBeNull();
  });

  test('corrupted predicted samples barely move the fit', () => {
    const base = projectile();
    const corrupt = (s: BallSample): BallSample => ({ ...s, cy: s.cy + 40 });
    const asPredicted = base.map((s, i) =>
      i >= 10 && i <= 12
        ? { ...corrupt(s), predicted: true, score: 0 }
        : s,
    );
    const asDetected = base.map((s, i) => (i >= 10 && i <= 12 ? corrupt(s) : s));

    const f0 = fitArc(base)!;
    const fp = fitArc(asPredicted)!;
    const fd = fitArc(asDetected)!;
    expect(f0 && fp && fd).toBeTruthy();

    const apex0 = apexPoint(f0)!;
    const apexP = apexPoint(fp)!;
    const apexD = apexPoint(fd)!;
    const shiftP = Math.abs(apexP.y - apex0.y);
    const shiftD = Math.abs(apexD.y - apex0.y);

    // Down-weighted corruption moves the apex far less than full-weight
    // corruption, and stays visually negligible.
    expect(shiftP).toBeLessThan(shiftD * 0.5);
    expect(shiftP).toBeLessThan(3);
    expect(Math.abs(fp.ya - f0.ya)).toBeLessThan(
      Math.abs(fd.ya - f0.ya) * 0.5,
    );
  });
});

describe('evalArc / sampleArc', () => {
  const manual: ArcFit = {
    ya: 2,
    yb: -3,
    yc: 5,
    xm: 4,
    xq: 1,
    r2y: 1,
    tMin: 0,
    tMax: 10,
  };

  test('evalArc evaluates both polynomials', () => {
    const p = evalArc(manual, 2);
    expect(p.x).toBeCloseTo(4 * 2 + 1);
    expect(p.y).toBeCloseTo(2 * 4 - 3 * 2 + 5);
  });

  test('sampleArc spans [tMin, tMax] evenly', () => {
    const fit = fitArc(projectile())!;
    const pts = sampleArc(fit, 7);
    expect(pts).toHaveLength(7);
    // Endpoints.
    expect(pts[0].x).toBeCloseTo(X0, 3);
    expect(pts[6].x).toBeCloseTo(X0 + VX * fit.tMax, 3);
    // Even spacing in t ⇒ even spacing in x (x is linear in t).
    for (let i = 1; i < 7; i++) {
      expect(pts[i].x - pts[i - 1].x).toBeCloseTo(
        (VX * fit.tMax) / 6,
        3,
      );
    }
    // Points lie on the fitted parabola: y(x) consistency at the apex sample.
    const mid = pts[3];
    const tMid = fit.tMin + (3 * (fit.tMax - fit.tMin)) / 6;
    expect(mid.y).toBeCloseTo(evalArc(fit, tMid).y, 9);
  });

  test('sampleArc edge counts', () => {
    expect(sampleArc(manual, 0)).toHaveLength(0);
    expect(sampleArc(manual, -3)).toHaveLength(0);
    const one = sampleArc(manual, 1);
    expect(one).toHaveLength(1);
    expect(one[0]).toEqual(evalArc(manual, manual.tMin));
  });
});

describe('apexPoint', () => {
  test('matches analytic apex within 3px (with noise)', () => {
    const fit = fitArc(
      projectile({ noiseY: (i) => 1.5 * Math.sin(i * 1.7) }),
    )!;
    const apex = apexPoint(fit)!;
    expect(apex).not.toBeNull();
    expect(Math.abs(apex.x - APEX.x)).toBeLessThan(3);
    expect(Math.abs(apex.y - APEX.y)).toBeLessThan(3);
  });

  test('null when vertex is outside the observed window', () => {
    // Descending-only tail: frames 24..39 → t ∈ [0.8, 1.3], apex at 0.667.
    const fit = fitArc(projectile({ startFrame: 24, frames: 16 }))!;
    expect(fit).not.toBeNull();
    expect(fit.ya).toBeCloseTo(G / 2, 3);
    expect(apexPoint(fit)).toBeNull();
  });

  test('null when the parabola has no upward apex (ya ≤ 0)', () => {
    const flatFit: ArcFit = {
      ya: 0,
      yb: 1,
      yc: 0,
      xm: 1,
      xq: 0,
      r2y: 1,
      tMin: 0,
      tMax: 1,
    };
    expect(apexPoint(flatFit)).toBeNull();
    expect(apexPoint({ ...flatFit, ya: -450 })).toBeNull();
  });
});

describe('releaseAngleDeg', () => {
  test('within 2° of analytic release angle', () => {
    const angle = releaseAngleDeg(projectile());
    expect(angle).not.toBeNull();
    expect(Math.abs(angle! - RELEASE_ANGLE)).toBeLessThan(2);
  });

  test('default n comes from SHOT_FSM.releaseAngleSamples', () => {
    const samples = projectile();
    expect(releaseAngleDeg(samples)).toBeCloseTo(
      releaseAngleDeg(samples, SHOT_FSM.releaseAngleSamples)!,
      9,
    );
  });

  test('predicted samples are skipped entirely', () => {
    const clean = projectile();
    // Corrupt some early samples wildly but mark them predicted: they must
    // not affect the result at all.
    const withPredicted: BallSample[] = clean.map((s, i) =>
      i === 1 || i === 4
        ? { ...s, cy: s.cy + 200, cx: s.cx - 300, predicted: true, score: 0 }
        : s,
    );
    const expected = releaseAngleDeg(clean.filter((_, i) => i !== 1 && i !== 4));
    expect(releaseAngleDeg(withPredicted)).toBeCloseTo(expected!, 9);
  });

  test('null with fewer than 2 usable samples', () => {
    expect(releaseAngleDeg([])).toBeNull();
    expect(releaseAngleDeg(projectile({ frames: 1 }))).toBeNull();
    const allPredicted = projectile({ frames: 10 }).map((s) => ({
      ...s,
      predicted: true,
      score: 0,
    }));
    expect(releaseAngleDeg(allPredicted)).toBeNull();
    const onlyOneReal = projectile({ frames: 10 }).map((s, i) =>
      i === 0 ? s : { ...s, predicted: true, score: 0 },
    );
    expect(releaseAngleDeg(onlyOneReal)).toBeNull();
  });
});

describe('entryAngleDegAtPlane', () => {
  test('within 2° of analytic entry angle, absolute value', () => {
    const angle = entryAngleDegAtPlane(projectile(), PLANE_Y);
    expect(angle).not.toBeNull();
    expect(angle!).toBeGreaterThan(0); // absolute, despite downward motion
    expect(Math.abs(angle! - ENTRY_ANGLE)).toBeLessThan(2);
  });

  test('null when the ball only ascends through the plane', () => {
    // Frames 0..11 (t ≤ 0.367 < apex time): strictly ascending.
    expect(entryAngleDegAtPlane(projectile({ frames: 12 }), PLANE_Y)).toBeNull();
  });

  test('null when the ball never reaches the plane', () => {
    // Plane above the apex (y smaller than apex y).
    expect(entryAngleDegAtPlane(projectile(), APEX.y - 50)).toBeNull();
  });

  test('null for empty / single-sample input', () => {
    expect(entryAngleDegAtPlane([], PLANE_Y)).toBeNull();
    expect(entryAngleDegAtPlane(projectile({ frames: 1 }), PLANE_Y)).toBeNull();
  });
});

describe('xAtPlaneY', () => {
  test('within 2px of analytic crossing x', () => {
    const x = xAtPlaneY(projectile(), PLANE_Y);
    expect(x).not.toBeNull();
    expect(Math.abs(x! - X_CROSS)).toBeLessThan(2);
  });

  test('null when there is no descending crossing', () => {
    expect(xAtPlaneY(projectile({ frames: 12 }), PLANE_Y)).toBeNull();
    expect(xAtPlaneY(projectile(), APEX.y - 50)).toBeNull();
    expect(xAtPlaneY([], PLANE_Y)).toBeNull();
  });
});

describe('predictLanding', () => {
  test('predicts the FUTURE crossing from early-flight samples only', () => {
    // 12 frames = t 0..0.367s, far before the analytic crossing at ~1.138s —
    // this is the mid-flight "where will it come down" projection.
    const fit = fitArc(projectile({ frames: 12 }));
    expect(fit).not.toBeNull();
    const p = predictLanding(fit!, PLANE_Y);
    expect(p).not.toBeNull();
    expect(Math.abs(p!.x - X_CROSS)).toBeLessThan(2);
    expect(p!.y).toBe(PLANE_Y);
    expect(p!.t).toBeCloseTo(T_CROSS, 2);
  });

  test('tolerates measurement noise', () => {
    const fit = fitArc(
      projectile({ frames: 14, noiseY: (i) => ((i * 37) % 7) - 3 }),
    );
    expect(fit).not.toBeNull();
    const p = predictLanding(fit!, PLANE_Y);
    expect(p).not.toBeNull();
    expect(Math.abs(p!.x - X_CROSS)).toBeLessThan(12);
  });

  test('null when the arc apex never reaches the plane', () => {
    const fit = fitArc(projectile({ frames: 12 }));
    // A plane ABOVE the apex (smaller y than apex.y) is unreachable.
    expect(predictLanding(fit!, APEX.y - 50)).toBeNull();
  });

  test('null for a fit without a gravity signature', () => {
    const flat: Parameters<typeof predictLanding>[0] = {
      ya: -10, yb: 0, yc: 500, xm: 100, xq: 0, r2y: 0.9, tMin: 0, tMax: 1,
    };
    expect(predictLanding(flat, 400)).toBeNull();
  });
});

describe('backfillPredictedGap', () => {
  /** True parabola point at frame i. */
  const truthAt = (i: number) => {
    const t = i / FPS;
    return { x: X0 + VX * t, y: Y0 - VY0 * t + 0.5 * G * t * t, t };
  };

  /** Build [reals 0..9] + [WRONG straight-line coasts 10..15] + [reals 16..19]. */
  function gappedFlight(): BallSample[] {
    const out: BallSample[] = [];
    for (let i = 0; i < 10; i++) {
      const p = truthAt(i);
      out.push({ cx: p.x, cy: p.y, r: 12, t: p.t, score: 0.8, predicted: false });
    }
    // Constant-velocity coast from frame 9 (what the Kalman does in a gap):
    const p9 = truthAt(9);
    const vy9 = -VY0 + G * (9 / FPS); // dy/dt at frame 9 (+y down)
    for (let i = 10; i <= 15; i++) {
      const dt = (i - 9) / FPS;
      out.push({
        cx: p9.x + VX * dt,
        cy: p9.y + vy9 * dt, // straight line — drifts off the true arc
        r: 12,
        t: i / FPS,
        score: 0,
        predicted: true,
      });
    }
    for (let i = 16; i < 20; i++) {
      const p = truthAt(i);
      out.push({ cx: p.x, cy: p.y, r: 12, t: p.t, score: 0.8, predicted: false });
    }
    return out;
  }

  test('rewrites the straight-line coast onto the two-sided parabola', () => {
    const traj = gappedFlight();
    // Sanity: the coast is genuinely wrong before the fix (curvature error).
    const worstBefore = Math.max(
      ...traj.filter((s) => s.predicted).map((s) => Math.abs(s.cy - truthAt(Math.round(s.t * FPS)).y)),
    );
    expect(worstBefore).toBeGreaterThan(5);

    expect(backfillPredictedGap(traj)).toBe(true);

    for (const s of traj) {
      const truth = truthAt(Math.round(s.t * FPS));
      expect(Math.abs(s.cy - truth.y)).toBeLessThan(1);
      expect(Math.abs(s.cx - truth.x)).toBeLessThan(1);
    }
    // Flags untouched: the samples stay marked predicted.
    expect(traj.filter((s) => s.predicted)).toHaveLength(6);
  });

  test('no-op while the gap is still open (trailing predicted sample)', () => {
    const traj = gappedFlight().slice(0, 14); // ends mid-coast
    expect(traj[traj.length - 1]!.predicted).toBe(true);
    expect(backfillPredictedGap(traj)).toBe(false);
  });

  test('no-op without enough real samples for a fit', () => {
    const traj = gappedFlight().slice(7); // only 3 reals on the left
    expect(backfillPredictedGap(traj.slice(0, 3 + 6 + 1))).toBe(false);
  });
});

describe('plausibleArcCurvature', () => {
  const RIM_W = 40; // px
  // Real gravity ~g/2 ≈ 11 rim-widths/s². Face-on ya ≈ 11 * 40 = ~440 px/s².
  const realYa = 11 * RIM_W;

  test('accepts a real ballistic curvature (~g/2)', () => {
    expect(plausibleArcCurvature(realYa, RIM_W, 60)).toBe(true);
  });

  test('accepts a shallow (foreshortened) curvature', () => {
    expect(plausibleArcCurvature(2 * RIM_W, RIM_W, 60)).toBe(true);
  });

  test('rejects a rim-rattle-scale curvature (huge ya = near-vertical arc)', () => {
    // 100 rim-widths/s² is ~9x real gravity — the degenerate 90° rattle fit.
    expect(plausibleArcCurvature(100 * RIM_W, RIM_W, 60)).toBe(false);
  });

  test('is scale-invariant: same verdict for a far (small) rim', () => {
    const farRim = 12; // px, distant hoop
    expect(plausibleArcCurvature(11 * farRim, farRim, 60)).toBe(true);
    expect(plausibleArcCurvature(100 * farRim, farRim, 60)).toBe(false);
  });

  test('never rejects when the scene scale is unknown', () => {
    expect(plausibleArcCurvature(99999, 0, 60)).toBe(true);
    expect(plausibleArcCurvature(99999, -5, 60)).toBe(true);
  });
});
