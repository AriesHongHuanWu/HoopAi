/**
 * FT-seed tests — synthetic pinhole scenes (same family as courtGeometric /
 * ftCalibration tests) where every pixel is rendered FROM known court-plane
 * geometry, so the derived transform must recover ground-truth positions.
 *
 * CHIRALITY PIN: the app's court frame is anchored to the camera's viewpoint
 * (the registration ritual labels corners by where they appear in the IMAGE),
 * so +courtX maps to image-right for a camera on the up-court side facing the
 * basket. The renderer below implements exactly that convention
 * (right = (-fwd.y, fwd.x)); the both-wings tests pin the recovered sign.
 */
import { COURT, DETECTION } from '../config';
import {
  estimateShotValueMetric,
  type MetricShotEstimate,
} from '../courtGeometric';
import { FIBA_COURT, NBA_COURT } from '../courtModel';
import {
  FT_LINE_DISTANCE_M,
  deriveFtCalibration,
  type FtAnchor,
} from '../ftCalibration';
import {
  FT_SEED_MAX_CONFIDENCE,
  METRIC_MAX_CONFIDENCE,
  classifyByFtSeed,
  deriveFtSeed,
  ftSeedBallSizeCapFrac,
  metricValueConfidence,
  type FtSeed,
} from '../ftSeed';
import { classificationConfidence } from '../threePointLine';
import { computeRimGeometry } from '../rimLock';

const F = 850; // the estimator's focal prior (DEPTH_GATE.focalPxDefault)
const S = 640;
const C = S / 2;
const RIM_H = 3.05;
const RIM_D = 0.45;
const FT_POINT = { x: 0, y: FT_LINE_DISTANCE_M };

/** A level (pitch-0) camera standing on the court plane. */
interface Cam {
  /** Camera position on the court plane, meters (courtModel frame). */
  pos: { x: number; y: number };
  /** Camera height above the floor, meters. */
  camH: number;
  /** Ground point the optical axis passes over. Defaults to the rim (0,0). */
  aim?: { x: number; y: number };
  /** TRUE lens focal, analysis px. Defaults to the estimator's 850 prior. */
  f?: number;
}

/** Court→camera ground axes (fwd = optical axis, right = image-right). */
function frameOf(cam: Cam) {
  const aim = cam.aim ?? { x: 0, y: 0 };
  const dx = aim.x - cam.pos.x;
  const dy = aim.y - cam.pos.y;
  const n = Math.hypot(dx, dy);
  const fwd = { x: dx / n, y: dy / n };
  // Image-right in the app's viewpoint-anchored court convention (see header).
  const right = { x: -fwd.y, y: fwd.x };
  return { fwd, right };
}

/** Court ground point → camera-ground (depth z, lateral x), meters. */
function toCamGround(cam: Cam, p: { x: number; y: number }) {
  const { fwd, right } = frameOf(cam);
  const dx = p.x - cam.pos.x;
  const dy = p.y - cam.pos.y;
  return { z: dx * fwd.x + dy * fwd.y, x: dx * right.x + dy * right.y };
}

/** Pinhole-project a world point at height h above court point p. */
function project(cam: Cam, p: { x: number; y: number }, h: number) {
  const f = cam.f ?? F;
  const g = toCamGround(cam, p);
  return { x: C + (f * g.x) / g.z, y: C - (f * (h - cam.camH)) / g.z };
}

/** The rim box as this camera sees it (center at RIM_H, width from depth). */
function rimBoxOf(cam: Cam) {
  const f = cam.f ?? F;
  const { z } = toCamGround(cam, { x: 0, y: 0 });
  const w = (f * RIM_D) / z;
  const center = project(cam, { x: 0, y: 0 }, RIM_H);
  return { x: center.x - w / 2, y: center.y - w / 4, width: w, height: w / 2 };
}

/** FT anchor: the shooter's feet at the FT point (0, 4.19). */
function anchorOf(cam: Cam): FtAnchor {
  return {
    footPx: project(cam, FT_POINT, 0),
    rim: computeRimGeometry(rimBoxOf(cam)),
    frameSize: S,
    pitchDeg: 0,
  };
}

/** Per-shot metric estimate for a shooter standing at court point p. */
function shotEstimateAt(cam: Cam, p: { x: number; y: number }) {
  const foot = project(cam, p, 0);
  return estimateShotValueMetric({
    rimBox: rimBoxOf(cam),
    footX: foot.x,
    footY: foot.y,
    frameSize: S,
    pitchDeg: 0,
  });
}

/** Derive a seed for a camera and fail the test loudly if rejected. */
function seedFor(cam: Cam): FtSeed {
  const r = deriveFtSeed(anchorOf(cam), FIBA_COURT);
  if (!r.ok) throw new Error(`expected an accepted FT seed, got ${r.reason}`);
  return r.seed;
}

/** Seed → recovered court point for a shooter at ground-truth p. */
function recover(cam: Cam, seed: FtSeed, p: { x: number; y: number }) {
  const est = shotEstimateAt(cam, p);
  expect(est).not.toBeNull();
  const placed = classifyByFtSeed(seed, est!);
  expect(placed).not.toBeNull();
  return placed!;
}

/** Hand-built MetricShotEstimate for contract tests of classifyByFtSeed. */
function mkEst(o: { zRim: number; zFeet: number; lateral: number }): MetricShotEstimate {
  return {
    value: 2,
    distanceM: Math.hypot(o.zFeet - o.zRim, o.lateral),
    zRimM: o.zRim,
    zFeetM: o.zFeet,
    camHeightM: 1,
    lateralM: o.lateral,
  };
}

/** Identity-transform seed (yaw 0, scale 1) for contract tests. */
function mkSeed(over: Partial<FtSeed> = {}): FtSeed {
  return {
    correctionFactor: 1,
    uncalibratedM: FT_LINE_DISTANCE_M,
    yawRad: 0,
    anchorRimWidthPx: 40,
    spec: FIBA_COURT,
    ...over,
  };
}

// Three camera placements per the design: behind the FT line, 30° off-axis,
// near-baseline side-on — plus a deep elevated camera for the in-frame
// corner-3 scene.
const CAM_BEHIND_FT: Cam = { pos: { x: 0, y: 10 }, camH: 0.8 };
const CAM_OFF_AXIS_30: Cam = {
  pos: { x: 10 * Math.sin(Math.PI / 6), y: 10 * Math.cos(Math.PI / 6) },
  camH: 1.2,
};
const CAM_SIDE_ON: Cam = { pos: { x: 7.5, y: 1.0 }, camH: 1.0, aim: { x: 0, y: 2.6 } };
const CAM_DEEP: Cam = { pos: { x: 2, y: 12 }, camH: 1.4, aim: { x: 3, y: 2 } };

describe('deriveFtSeed', () => {
  test('behind the FT line: yaw 0, factor ≈ 1, anchor rim width recorded', () => {
    const r = deriveFtSeed(anchorOf(CAM_BEHIND_FT), FIBA_COURT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.seed.yawRad).toBeCloseTo(0, 6);
    expect(r.seed.correctionFactor).toBeCloseTo(1.0, 3);
    expect(r.seed.uncalibratedM).toBeCloseTo(FT_LINE_DISTANCE_M, 2);
    expect(r.seed.anchorRimWidthPx).toBeCloseTo((F * RIM_D) / 10, 6);
    expect(r.seed.spec).toBe(FIBA_COURT);
  });

  test('30° off-axis camera: yaw recovers the camera bearing exactly', () => {
    const seed = seedFor(CAM_OFF_AXIS_30);
    expect(seed.yawRad).toBeCloseTo(-Math.PI / 6, 6);
    expect(seed.correctionFactor).toBeCloseTo(1.0, 3);
  });

  test('near-baseline side-on camera: |yaw| beyond 90° and still accepted', () => {
    const seed = seedFor(CAM_SIDE_ON);
    expect(seed.yawRad).toBeLessThan(-Math.PI / 2);
    expect(seed.yawRad).toBeGreaterThan(-2.1);
    expect(seed.correctionFactor).toBeCloseTo(1.0, 3);
  });

  test('reuses deriveFtCalibration verbatim (same factor object values)', () => {
    const anchor = anchorOf(CAM_BEHIND_FT);
    const seedR = deriveFtSeed(anchor, FIBA_COURT);
    const calR = deriveFtCalibration(anchor);
    expect(seedR.ok).toBe(true);
    expect(calR.ok).toBe(true);
    if (!seedR.ok || !calR.ok) return;
    expect(seedR.calibration).toEqual(calR.calibration);
    expect(seedR.seed.correctionFactor).toBe(calR.calibration.correctionFactor);
    expect(seedR.seed.uncalibratedM).toBe(calR.calibration.uncalibratedM);
  });

  test('rejects a malformed anchor: invalid-anchor', () => {
    const a = anchorOf(CAM_BEHIND_FT);
    expect(
      deriveFtSeed({ ...a, footPx: { x: NaN, y: a.footPx.y } }, FIBA_COURT),
    ).toEqual({ ok: false, reason: 'invalid-anchor' });
  });

  test('rejects when the estimator refuses the scene (tiny rim): no-metric-estimate', () => {
    // Rim 20 m away → ~19 px, under the estimator's 30 px enablement floor.
    const far: Cam = { pos: { x: 0, y: 20 }, camH: 0.8 };
    expect(deriveFtSeed(anchorOf(far), FIBA_COURT)).toEqual({
      ok: false,
      reason: 'no-metric-estimate',
    });
  });

  test('rejects an anchor placed off the plausible FT band: estimate-out-of-range', () => {
    // "FT shot" actually taken 1.2 m from the rim — nobody's free-throw line.
    const a: FtAnchor = {
      ...anchorOf(CAM_BEHIND_FT),
      footPx: project(CAM_BEHIND_FT, { x: 0, y: 1.2 }, 0),
    };
    expect(deriveFtSeed(a, FIBA_COURT)).toEqual({
      ok: false,
      reason: 'estimate-out-of-range',
    });
  });
});

describe('classifyByFtSeed — ground-truth recovery', () => {
  test('the anchor itself maps to (0, 4.19) from every placement', () => {
    for (const cam of [CAM_BEHIND_FT, CAM_OFF_AXIS_30, CAM_SIDE_ON, CAM_DEEP]) {
      const placed = recover(cam, seedFor(cam), FT_POINT);
      expect(placed.courtX).toBeCloseTo(0, 6);
      expect(placed.courtY).toBeCloseTo(FT_LINE_DISTANCE_M, 6);
      expect(placed.distanceM).toBeCloseTo(FT_LINE_DISTANCE_M, 6);
      expect(placed.value).toBe(2);
    }
  });

  test('both-wings chirality: recovered courtX sign matches ground truth', () => {
    const seed = seedFor(CAM_BEHIND_FT);
    const right = recover(CAM_BEHIND_FT, seed, { x: 1.5, y: 5 });
    const left = recover(CAM_BEHIND_FT, seed, { x: -1.5, y: 5 });
    expect(right.courtX).toBeCloseTo(1.5, 6);
    expect(right.courtY).toBeCloseTo(5, 6);
    expect(left.courtX).toBeCloseTo(-1.5, 6);
    expect(left.courtY).toBeCloseTo(5, 6);
    expect(right.value).toBe(2);
    expect(left.value).toBe(2);
  });

  test('30° off-axis camera recovers an off-line shooter exactly', () => {
    const placed = recover(CAM_OFF_AXIS_30, seedFor(CAM_OFF_AXIS_30), { x: 2, y: 4 });
    expect(placed.courtX).toBeCloseTo(2, 6);
    expect(placed.courtY).toBeCloseTo(4, 6);
    expect(placed.value).toBe(2);
    expect(placed.region).toBe('arc');
  });

  test('side-on camera recovers a wing 2 exactly', () => {
    const placed = recover(CAM_SIDE_ON, seedFor(CAM_SIDE_ON), { x: 3, y: 3 });
    expect(placed.courtX).toBeCloseTo(3, 6);
    expect(placed.courtY).toBeCloseTo(3, 6);
    expect(placed.value).toBe(2);
  });

  test('top-of-key 3 classifies via the arc with a positive margin', () => {
    const placed = recover(CAM_BEHIND_FT, seedFor(CAM_BEHIND_FT), { x: 0, y: 7 });
    expect(placed.courtY).toBeCloseTo(7, 6);
    expect(placed.value).toBe(3);
    expect(placed.region).toBe('arc');
    expect(placed.marginM).toBeCloseTo(7 - FIBA_COURT.arcRadiusM, 6);
  });

  test('CORNER 3 the radial metric mis-calls: seed places it and calls 3', () => {
    // (6.65, 0.5) — mirror of threePointLine.test.ts: |x| 6.65 > corner 6.60
    // is a 3, but the radial distance ≈ 6.669 m < 6.75 → the plain metric
    // path calls it a 2. All pixels of this scene sit inside the 640 frame.
    const target = { x: 6.65, y: 0.5 };
    const est = shotEstimateAt(CAM_DEEP, target);
    expect(est).not.toBeNull();
    expect(est!.distanceM).toBeLessThan(FIBA_COURT.arcRadiusM);
    expect(est!.value).toBe(2); // the honest radial mis-call

    const placed = classifyByFtSeed(seedFor(CAM_DEEP), est!);
    expect(placed).not.toBeNull();
    expect(placed!.courtX).toBeCloseTo(6.65, 4);
    expect(placed!.courtY).toBeCloseTo(0.5, 4);
    expect(placed!.value).toBe(3);
    expect(placed!.region).toBe('corner');
    expect(placed!.marginM).toBeCloseTo(0.05, 4);
  });

  test('inside the corner line stays a 2', () => {
    const placed = recover(CAM_DEEP, seedFor(CAM_DEEP), { x: 6.5, y: 0.5 });
    expect(placed.value).toBe(2);
    expect(placed.region).toBe('corner');
    expect(placed.marginM).toBeCloseTo(-0.1, 4);
  });

  test('spec is a parameter: the same point is a FIBA 3 but an NBA 2', () => {
    // Identity seed, shooter mapped to (6.65, 0.5): FIBA corner 6.60 → 3;
    // NBA corner 6.70 → 2.
    const est = mkEst({ zRim: 5.5, zFeet: 5.0, lateral: 6.65 });
    const fiba = classifyByFtSeed(mkSeed(), est);
    const nba = classifyByFtSeed(mkSeed({ spec: NBA_COURT }), est);
    expect(fiba!.value).toBe(3);
    expect(nba!.value).toBe(2);
  });
});

describe('classifyByFtSeed — sanity bails and confidence honesty', () => {
  test('bails (null) beyond 15 m — falls through to the metric label', () => {
    // Identity seed: y = zRim − zFeet = 16 m → hypot > 15 → null.
    expect(classifyByFtSeed(mkSeed(), mkEst({ zRim: 20, zFeet: 4, lateral: 0 }))).toBeNull();
  });

  test('bails (null) more than 3 m behind the baseline', () => {
    // y = 4 − 7.5 = −3.5 < −3 → null.
    expect(classifyByFtSeed(mkSeed(), mkEst({ zRim: 4, zFeet: 7.5, lateral: 0 }))).toBeNull();
  });

  test('just inside both bounds still classifies', () => {
    const nearBaseline = classifyByFtSeed(mkSeed(), mkEst({ zRim: 4, zFeet: 6.9, lateral: 0 }));
    expect(nearBaseline).not.toBeNull();
    expect(nearBaseline!.value).toBe(2);
    const deep = classifyByFtSeed(mkSeed(), mkEst({ zRim: 18.9, zFeet: 4, lateral: 0 }));
    expect(deep).not.toBeNull();
    expect(deep!.value).toBe(3);
  });

  test('confidence is capped at 0.75 even for a decisive margin', () => {
    // (0, 9): 2.25 m beyond the arc — raw classificationConfidence saturates
    // at 1, the seed reports exactly the cap.
    const placed = recover(CAM_BEHIND_FT, seedFor(CAM_BEHIND_FT), { x: 0, y: 9 });
    expect(placed.confidence).toBe(FT_SEED_MAX_CONFIDENCE);
    expect(FT_SEED_MAX_CONFIDENCE).toBe(0.75);
  });

  test('never reaches the high tier (≥ 0.8) anywhere on the court', () => {
    const seed = seedFor(CAM_BEHIND_FT);
    const points = [FT_POINT, { x: 0, y: 7 }, { x: 1.5, y: 5 }, { x: 0, y: 9 }];
    for (const p of points) {
      const placed = recover(CAM_BEHIND_FT, seed, p);
      expect(placed.confidence).toBeLessThanOrEqual(0.75);
      expect(placed.confidence).toBeLessThan(0.8);
    }
  });

  test('a borderline corner call reports a modest confidence', () => {
    // margin 0.05 m → 0.5 + (0.05/0.6)·0.5 ≈ 0.542 — honestly near the floor.
    const placed = recover(CAM_DEEP, seedFor(CAM_DEEP), { x: 6.65, y: 0.5 });
    expect(placed.confidence).toBeCloseTo(0.5417, 3);
  });
});

describe('end-to-end: wrong lens (true f=1000 vs 850 prior)', () => {
  const cam: Cam = { pos: { x: 0, y: 10 }, camH: 0.6, f: 1000 };

  test('anchor accepted with a factor > 1.1 that fixes the straight-on 3', () => {
    const r = deriveFtSeed(anchorOf(cam), FIBA_COURT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.seed.correctionFactor).toBeGreaterThan(1.1);
    expect(r.seed.yawRad).toBeCloseTo(0, 6);

    // A true 7.0 m top-of-key 3: the biased metric path calls it a 2; the
    // seeded position recovers the truth.
    const est = shotEstimateAt(cam, { x: 0, y: 7 });
    expect(est).not.toBeNull();
    expect(est!.value).toBe(2); // the focal error costs the correct call
    const placed = classifyByFtSeed(r.seed, est!);
    expect(placed).not.toBeNull();
    expect(placed!.courtY).toBeCloseTo(7.0, 1);
    expect(placed!.courtX).toBeCloseTo(0, 6);
    expect(placed!.value).toBe(3);
  });

  test('chirality survives the wrong lens; lateral residual stays bounded', () => {
    // A wrong focal scales DEPTHS but not LATERALS, so the single-anchor
    // similarity over-corrects laterals (a known, honest residual — one
    // reason confidence is capped). The sign and the y recovery stay exact.
    const seed = seedFor(cam);
    const right = recover(cam, seed, { x: 1.5, y: 5 });
    const left = recover(cam, seed, { x: -1.5, y: 5 });
    expect(right.courtY).toBeCloseTo(5.0, 6);
    expect(left.courtY).toBeCloseTo(5.0, 6);
    expect(right.courtX).toBeGreaterThan(0);
    expect(left.courtX).toBeLessThan(0);
    expect(Math.abs(right.courtX - 1.5)).toBeLessThan(0.35);
    expect(Math.abs(left.courtX + 1.5)).toBeLessThan(0.35);
    expect(left.courtX).toBeCloseTo(-right.courtX, 6);
  });
});

describe('metricValueConfidence', () => {
  test('caps at 0.7 for a decisive distance (never the high tier)', () => {
    expect(metricValueConfidence(12)).toBe(METRIC_MAX_CONFIDENCE);
    expect(METRIC_MAX_CONFIDENCE).toBe(0.7);
    for (let d = 0; d <= 15; d += 0.25) {
      expect(metricValueConfidence(d)).toBeLessThanOrEqual(0.7);
      expect(metricValueConfidence(d)).toBeGreaterThanOrEqual(0.5);
    }
  });

  test('uses the wider 0.9 m band (focal prior dominates the metric error)', () => {
    // margin 0.18 m: band 0.9 → 0.5 + (0.18/0.9)·0.5 = 0.6, strictly below
    // the default-band 0.6 → 0.65 a court position would earn.
    const d = COURT.threePtDistanceM + 0.18;
    expect(metricValueConfidence(d)).toBeCloseTo(0.6, 6);
    expect(metricValueConfidence(d)).toBeLessThan(classificationConfidence(0.18));
    // Symmetric inside the arc.
    expect(metricValueConfidence(COURT.threePtDistanceM - 0.18)).toBeCloseTo(0.6, 6);
  });

  test('floors at 0.5 right on the line and for non-finite input', () => {
    expect(metricValueConfidence(COURT.threePtDistanceM)).toBe(0.5);
    expect(metricValueConfidence(NaN)).toBe(0.5);
    expect(metricValueConfidence(Infinity)).toBe(0.5);
  });
});

describe('ftSeedBallSizeCapFrac', () => {
  const rim = (w: number) =>
    computeRimGeometry({ x: 300, y: 200, width: w, height: w / 2 });
  const BALL_7 = 0.243; // size-7 outer diameter (config BALL_SIZES_M[7])

  test('mid-range rim: 2.5 × (expected-at-rim × 2) / frameWidth', () => {
    // rim 40 px → expected ball 40·(0.243/0.45) = 21.6 px; ×2 / 640 = 0.0675;
    // ×2.5 headroom = 0.16875 — inside both clamps.
    const cap = ftSeedBallSizeCapFrac(mkSeed(), rim(40), S, BALL_7);
    expect(cap).toBeCloseTo(0.16875, 6);
  });

  test('clamps to the 0.08 floor for a tiny/far rim', () => {
    expect(ftSeedBallSizeCapFrac(mkSeed(), rim(12), S, BALL_7)).toBe(0.08);
  });

  test('never exceeds DETECTION.ballMaxSizeFraction (shrink-only)', () => {
    expect(ftSeedBallSizeCapFrac(mkSeed(), rim(300), S, BALL_7)).toBe(
      DETECTION.ballMaxSizeFraction,
    );
    for (const w of [10, 20, 40, 80, 160, 320, 640]) {
      const cap = ftSeedBallSizeCapFrac(mkSeed(), rim(w), S, BALL_7);
      expect(cap).not.toBeNull();
      expect(cap!).toBeLessThanOrEqual(DETECTION.ballMaxSizeFraction);
      expect(cap!).toBeGreaterThanOrEqual(0.08);
    }
  });

  test('null (= keep the default, never gate) on unusable inputs', () => {
    expect(ftSeedBallSizeCapFrac(mkSeed(), rim(0), S, BALL_7)).toBeNull();
    expect(ftSeedBallSizeCapFrac(mkSeed(), rim(40), 0, BALL_7)).toBeNull();
    expect(ftSeedBallSizeCapFrac(mkSeed(), rim(40), S, NaN)).toBeNull();
    expect(ftSeedBallSizeCapFrac(mkSeed(), rim(40), S, 0)).toBeNull();
    expect(
      ftSeedBallSizeCapFrac(mkSeed({ correctionFactor: 0 }), rim(40), S, BALL_7),
    ).toBeNull();
  });
});
