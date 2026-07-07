/**
 * FT-line calibration tests — synthetic pinhole scenes (same generator family
 * as courtGeometric.test.ts) where every pixel is rendered FROM known world
 * geometry, so accept / reject / correction math are all deterministic.
 */
import { estimateShotValueMetric } from '../courtGeometric';
import {
  FT_LINE_DISTANCE_M,
  deriveFtCalibration,
  medianFootPoint,
  type FtAnchor,
} from '../ftCalibration';
import { computeRimGeometry } from '../rimLock';

const S = 640;
const C = S / 2;
const RIM_H = 3.05;
const RIM_D = 0.45;
/** The estimator's focal prior when focalPx is omitted (DEPTH_GATE default). */
const F_PRIOR = 850;

/**
 * Level-camera anchor scene rendered with TRUE focal `f`: camera at height
 * `camH`, rim `zRim` meters ahead (lateral 0), shooter's feet on the floor at
 * `zFeet`. The derivation always runs on the estimator's own focal prior, so
 * passing f !== 850 emulates a device whose real lens differs from the prior —
 * exactly the error family this calibration exists to cancel.
 */
function anchorScene(opts: {
  camH: number;
  zRim: number;
  zFeet: number;
  xFeet?: number;
  f?: number;
}): FtAnchor {
  const { camH, zRim, zFeet, xFeet = 0, f = F_PRIOR } = opts;
  const wRim = (f * RIM_D) / zRim;
  const yRim = C - (f * (RIM_H - camH)) / zRim;
  return {
    footPx: { x: C + (f * xFeet) / zFeet, y: C + (f * camH) / zFeet },
    rim: computeRimGeometry({
      x: C - wRim / 2,
      y: yRim - wRim / 4,
      width: wRim,
      height: wRim / 2,
    }),
    frameSize: S,
    pitchDeg: 0,
  };
}

describe('deriveFtCalibration', () => {
  test('accepts a clean FT-line anchor (factor ≈ 1 when the prior is right)', () => {
    // Shooter exactly at the FT line, true focal == prior → nothing to fix.
    const r = deriveFtCalibration(
      anchorScene({ camH: 0.6, zRim: 9, zFeet: 9 - FT_LINE_DISTANCE_M }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.calibration.correctionFactor).toBeCloseTo(1.0, 2);
      expect(r.calibration.uncalibratedM).toBeCloseTo(FT_LINE_DISTANCE_M, 1);
    }
  });

  test('correction math: factor = 4.19 / uncalibrated estimate', () => {
    // Anchor whose uncalibrated estimate is exactly 5.2375 m → factor 0.8.
    const r = deriveFtCalibration(
      anchorScene({ camH: 0.6, zRim: 9, zFeet: 9 - 5.2375 }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.calibration.uncalibratedM).toBeCloseTo(5.2375, 3);
      expect(r.calibration.correctionFactor).toBeCloseTo(0.8, 3);
    }
  });

  test('rejects an anchor the estimator places too CLOSE (< 2 m)', () => {
    // True 1.5 m — nobody's FT line; deriving a factor from it would poison
    // every later shot.
    const r = deriveFtCalibration(anchorScene({ camH: 0.6, zRim: 6, zFeet: 4.5 }));
    expect(r).toEqual({ ok: false, reason: 'estimate-out-of-range' });
  });

  test('rejects an anchor the estimator places too FAR (> 9 m)', () => {
    const r = deriveFtCalibration(anchorScene({ camH: 0.6, zRim: 12, zFeet: 2.5 }));
    expect(r).toEqual({ ok: false, reason: 'estimate-out-of-range' });
  });

  test('rejects when the estimator itself refuses the scene (tiny rim)', () => {
    // zRim 20 → rim ~19 px, under the estimator's 30 px enablement floor.
    const r = deriveFtCalibration(
      anchorScene({ camH: 0.6, zRim: 20, zFeet: 20 - FT_LINE_DISTANCE_M }),
    );
    expect(r).toEqual({ ok: false, reason: 'no-metric-estimate' });
  });

  test('rejects when the feet sit at/above the horizon', () => {
    const a = anchorScene({ camH: 0.6, zRim: 9, zFeet: 4.81 });
    const r = deriveFtCalibration({ ...a, footPx: { x: a.footPx.x, y: C - 10 } });
    expect(r).toEqual({ ok: false, reason: 'no-metric-estimate' });
  });

  test('rejects malformed anchors before touching the estimator', () => {
    const a = anchorScene({ camH: 0.6, zRim: 9, zFeet: 4.81 });
    expect(
      deriveFtCalibration({ ...a, footPx: { x: NaN, y: a.footPx.y } }),
    ).toEqual({ ok: false, reason: 'invalid-anchor' });
    expect(deriveFtCalibration({ ...a, frameSize: 0 })).toEqual({
      ok: false,
      reason: 'invalid-anchor',
    });
    expect(
      deriveFtCalibration({ ...a, footPx: { x: -4, y: a.footPx.y } }),
    ).toEqual({ ok: false, reason: 'invalid-anchor' });
    expect(
      deriveFtCalibration({ ...a, footPx: { x: a.footPx.x, y: S + 1 } }),
    ).toEqual({ ok: false, reason: 'invalid-anchor' });
  });

  test('end-to-end: cancels a wrong focal prior and fixes the 2/3 call', () => {
    // Device lens: TRUE f = 1000 px; the estimator only knows the 850 prior.
    // 1) Calibrate at the FT line (true 4.19 m; the biased estimator reads
    //    ~3.56 m, inside the accept band, so the anchor is taken).
    const r = deriveFtCalibration(
      anchorScene({ camH: 0.6, zRim: 10, zFeet: 10 - FT_LINE_DISTANCE_M, f: 1000 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected the FT anchor to be accepted');
    const { calibration } = r;
    expect(calibration.correctionFactor).toBeGreaterThan(1.1);

    // 2) A true 7.0 m three-pointer through the same wrong lens: uncalibrated
    //    it reads ~5.95 m → mis-called a 2. Calibrated: ~7.0 m → correct 3.
    const f = 1000;
    const zRim = 10;
    const zFeet = 3;
    const camH = 0.6;
    const wRim = (f * RIM_D) / zRim;
    const yRim = C - (f * (RIM_H - camH)) / zRim;
    const shot = {
      rimBox: { x: C - wRim / 2, y: yRim - wRim / 4, width: wRim, height: wRim / 2 },
      footX: C,
      footY: C + (f * camH) / zFeet,
      frameSize: S,
      pitchDeg: 0,
    };
    const uncal = estimateShotValueMetric(shot);
    expect(uncal).not.toBeNull();
    expect(uncal!.value).toBe(2); // the focal error costs the correct call
    const cal = estimateShotValueMetric({ ...shot, calibration });
    expect(cal).not.toBeNull();
    expect(cal!.distanceM).toBeCloseTo(7.0, 1);
    expect(cal!.value).toBe(3);
  });
});

describe('medianFootPoint', () => {
  test('null on an empty sample set', () => {
    expect(medianFootPoint([])).toBeNull();
  });

  test('odd count → the middle sample per axis', () => {
    expect(
      medianFootPoint([
        { x: 10, y: 5 },
        { x: 30, y: 1 },
        { x: 20, y: 9 },
      ]),
    ).toEqual({ x: 20, y: 5 });
  });

  test('even count → mean of the two central samples per axis', () => {
    expect(
      medianFootPoint([
        { x: 10, y: 0 },
        { x: 20, y: 10 },
        { x: 30, y: 20 },
        { x: 40, y: 30 },
      ]),
    ).toEqual({ x: 25, y: 15 });
  });

  test('shrugs off a single wild outlier (mis-latched person box)', () => {
    const cluster = Array.from({ length: 7 }, (_, i) => ({ x: 100 + i, y: 200 + i }));
    const m = medianFootPoint([...cluster, { x: 600, y: 20 }]);
    expect(m).not.toBeNull();
    expect(m!.x).toBeGreaterThanOrEqual(100);
    expect(m!.x).toBeLessThanOrEqual(107);
    expect(m!.y).toBeGreaterThanOrEqual(200);
    expect(m!.y).toBeLessThanOrEqual(207);
  });
});
