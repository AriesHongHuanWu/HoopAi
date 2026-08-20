/**
 * Metric 2/3 estimator tests — synthetic pinhole scenes where every pixel is
 * generated FROM known world geometry, so the estimator must recover the
 * ground-truth distance (and the 2-vs-3 call) exactly.
 */
import { estimateShotValueMetric, type MetricShotInput } from '../courtGeometric';

const F = 850;
const S = 640;
const C = S / 2;
const RIM_H = 3.05;
const RIM_D = 0.45;

/**
 * Render a scene: camera at height `camH` (level, pitch 0), rim `zRim` meters
 * ahead (lateral xRim), shooter's feet on the floor at (`zFeet`, `xFeet`).
 * `rimH` is the rim's real height above the floor — the pixel geometry is
 * generated from it, and a matching estimate must be told the same value.
 */
function scene(opts: {
  camH: number;
  zRim: number;
  zFeet: number;
  xRim?: number;
  xFeet?: number;
  pitchDeg?: number | null;
  rimH?: number;
}): MetricShotInput {
  const { camH, zRim, zFeet, xRim = 0, xFeet = 0, rimH = RIM_H } = opts;
  const wRim = (F * RIM_D) / zRim;
  const yRim = C - (F * (rimH - camH)) / zRim;
  const xRimPx = C + (F * xRim) / zRim;
  const footY = C + (F * camH) / zFeet;
  const footX = C + (F * xFeet) / zFeet;
  return {
    rimBox: { x: xRimPx - wRim / 2, y: yRim - wRim / 4, width: wRim, height: wRim / 2 },
    footX,
    footY,
    frameSize: S,
    pitchDeg: opts.pitchDeg ?? 0,
    focalPx: F,
    ...(rimH !== RIM_H ? { rimHeightM: rimH } : {}),
  };
}

describe('estimateShotValueMetric', () => {
  test('recovers ground truth in a behind-shooter scene (7m → 3PT)', () => {
    // Camera low behind the shooter: rim 10m away, shooter 3m in front of it.
    const est = estimateShotValueMetric(scene({ camH: 0.6, zRim: 10, zFeet: 3 }));
    expect(est).not.toBeNull();
    expect(est!.distanceM).toBeCloseTo(7.0, 1);
    expect(est!.value).toBe(3);
    expect(est!.camHeightM).toBeCloseTo(0.6, 2);
    expect(est!.zRimM).toBeCloseTo(10, 3);
  });

  test('mid-range shot classifies as 2', () => {
    const est = estimateShotValueMetric(scene({ camH: 0.6, zRim: 10, zFeet: 5.5 }));
    expect(est).not.toBeNull();
    expect(est!.distanceM).toBeCloseTo(4.5, 1);
    expect(est!.value).toBe(2);
  });

  test('lateral offset contributes to the ground distance', () => {
    // Shooter 4m short of the rim in depth but 5m to the side → 6.4m → 2PT
    // (just under the 6.75 arc), and the distance must be the hypotenuse.
    const est = estimateShotValueMetric(
      scene({ camH: 1.0, zRim: 9, zFeet: 5, xFeet: 5 }),
    );
    expect(est).not.toBeNull();
    expect(est!.distanceM).toBeCloseTo(Math.hypot(4, 5), 1);
    expect(est!.value).toBe(2);
  });

  test('camera pitch is honored (tilted-down elevated view)', () => {
    // Rendering with pitch means every pixel shifts by the rotation; emulate a
    // 10°-down camera by generating the level scene then telling the
    // estimator the truth — recovered geometry must stay consistent when the
    // SAME pitch is applied to generation and estimation.
    const base = scene({ camH: 1.8, zRim: 8, zFeet: 2.5 });
    // Generate pixel rows as the tilted camera would see them: y' such that
    // atan((C-y')/F) = atan((C-y)/F) - pitch.
    const tilt = (y: number, pitchDeg: number) =>
      C - F * Math.tan(Math.atan((C - y) / F) - pitchDeg * (Math.PI / 180));
    const pitched: MetricShotInput = {
      ...base,
      rimBox: {
        ...base.rimBox,
        y: tilt(base.rimBox.y + base.rimBox.width / 4, -10) - base.rimBox.width / 4,
      },
      footY: tilt(base.footY, -10),
      pitchDeg: -10,
    };
    const est = estimateShotValueMetric(pitched);
    expect(est).not.toBeNull();
    expect(est!.distanceM).toBeCloseTo(5.5, 0);
  });

  test('null when the rim is too small (too far / tiny in frame)', () => {
    const est = estimateShotValueMetric(scene({ camH: 0.6, zRim: 20, zFeet: 13 }));
    expect(est).toBeNull(); // rim ~19px < 30px floor
  });

  test('null when the feet sit at/above the horizon (bad pose or weird view)', () => {
    const s = scene({ camH: 0.6, zRim: 10, zFeet: 3 });
    expect(estimateShotValueMetric({ ...s, footY: C - 10 })).toBeNull();
  });

  test('null on an implausible camera height (bad rim anchor)', () => {
    const s = scene({ camH: 0.6, zRim: 10, zFeet: 3 });
    // Rim drawn far too LOW in frame ⇒ solved camera height goes negative-ish.
    expect(estimateShotValueMetric({ ...s, rimBox: { ...s.rimBox, y: 620 } })).toBeNull();
  });

  test('optional FT calibration scales distanceM and can flip the 2/3 call', () => {
    const base = scene({ camH: 0.6, zRim: 10, zFeet: 3.6 }); // true 6.4 m → 2PT
    const uncal = estimateShotValueMetric(base);
    expect(uncal).not.toBeNull();
    expect(uncal!.value).toBe(2);
    const cal = estimateShotValueMetric({
      ...base,
      calibration: { correctionFactor: 1.1 },
    });
    expect(cal).not.toBeNull();
    expect(cal!.distanceM).toBeCloseTo(uncal!.distanceM * 1.1, 6);
    expect(cal!.value).toBe(3); // 6.4 · 1.1 = 7.04 ≥ 6.75
    // Diagnostics untouched — every gate ran on the RAW geometry.
    expect(cal!.zRimM).toBeCloseTo(uncal!.zRimM, 10);
    expect(cal!.zFeetM).toBeCloseTo(uncal!.zFeetM, 10);
    expect(cal!.camHeightM).toBeCloseTo(uncal!.camHeightM, 10);
  });

  test('absent or invalid calibration leaves the output identical', () => {
    const base = scene({ camH: 0.6, zRim: 10, zFeet: 3 });
    const ref = estimateShotValueMetric(base);
    expect(ref).not.toBeNull();
    expect(estimateShotValueMetric({ ...base, calibration: null })).toEqual(ref);
    expect(
      estimateShotValueMetric({ ...base, calibration: { correctionFactor: 0 } }),
    ).toEqual(ref);
    expect(
      estimateShotValueMetric({ ...base, calibration: { correctionFactor: NaN } }),
    ).toEqual(ref);
    expect(
      estimateShotValueMetric({ ...base, calibration: { correctionFactor: -2 } }),
    ).toEqual(ref);
  });

  // P11 — configurable rim height. A youth (2.6 m) hoop is a different vertical
  // ruler; the estimator must recover ground truth when told the real height,
  // and default (3.05 m) must be byte-identical to the previous constant.
  describe('rim height (P11)', () => {
    test('recovers ground truth on a 2.6m youth hoop', () => {
      // Same layout as the flagship 7m→3PT case but generated for a 2.6m rim.
      const est = estimateShotValueMetric(
        scene({ camH: 0.6, zRim: 10, zFeet: 3, rimH: 2.6 }),
      );
      expect(est).not.toBeNull();
      expect(est!.distanceM).toBeCloseTo(7.0, 1);
      expect(est!.value).toBe(3);
      expect(est!.camHeightM).toBeCloseTo(0.6, 2);
      expect(est!.zRimM).toBeCloseTo(10, 3);
    });

    test('a 2.6m scene solved with the 3.05m default is wrong (why the setting exists)', () => {
      // Generate a youth-hoop scene but omit rimHeightM so the estimator uses
      // its regulation default: the mismatched ruler must shift the distance.
      const youth = scene({ camH: 0.6, zRim: 10, zFeet: 3, rimH: 2.6 });
      const asStandard = estimateShotValueMetric({ ...youth, rimHeightM: undefined });
      const correct = estimateShotValueMetric(youth);
      expect(asStandard).not.toBeNull();
      expect(correct).not.toBeNull();
      // The wrong ruler misplaces the camera height and thus the distance.
      expect(Math.abs(asStandard!.distanceM - correct!.distanceM)).toBeGreaterThan(0.3);
      expect(asStandard!.camHeightM).not.toBeCloseTo(0.6, 1);
    });

    test('explicit 3.05m default equals the omitted-parameter path (no regression)', () => {
      const base = scene({ camH: 0.6, zRim: 10, zFeet: 3 });
      const omitted = estimateShotValueMetric(base);
      const explicit = estimateShotValueMetric({ ...base, rimHeightM: 3.05 });
      expect(omitted).not.toBeNull();
      expect(explicit).toEqual(omitted);
    });

    test('a lower rim classifies a closer 2 correctly', () => {
      const est = estimateShotValueMetric(
        scene({ camH: 0.6, zRim: 10, zFeet: 5.5, rimH: 2.6 }),
      );
      expect(est).not.toBeNull();
      expect(est!.distanceM).toBeCloseTo(4.5, 1);
      expect(est!.value).toBe(2);
    });
  });

  // lateralM — the FT-seed geometry hook (src/core/ftSeed.ts). Additive only:
  // it must recover the ground-truth rim-relative lateral and leave every
  // pre-existing field exactly as before.
  describe('lateralM (FT-seed geometry hook)', () => {
    test('recovers the ground-truth lateral offset', () => {
      const est = estimateShotValueMetric(
        scene({ camH: 1.0, zRim: 9, zFeet: 5, xFeet: 5 }),
      );
      expect(est).not.toBeNull();
      expect(est!.lateralM).toBeCloseTo(5, 6);
    });

    test('is RIM-relative with an image-right positive sign', () => {
      // Rim 1 m right of the axis, shooter 2 m left → lateral = −2 − 1 = −3.
      const est = estimateShotValueMetric(
        scene({ camH: 1.0, zRim: 9, zFeet: 5, xRim: 1, xFeet: -2 }),
      );
      expect(est).not.toBeNull();
      expect(est!.lateralM).toBeCloseTo(-3, 6);
    });

    test('distance identity: uncalibrated distanceM = hypot(zFeet − zRim, lateralM)', () => {
      const est = estimateShotValueMetric(
        scene({ camH: 0.6, zRim: 10, zFeet: 3, xFeet: 2 }),
      );
      expect(est).not.toBeNull();
      expect(est!.distanceM).toBeCloseTo(
        Math.hypot(est!.zFeetM - est!.zRimM, est!.lateralM),
        10,
      );
    });

    test('all pre-existing fields are unchanged in the flagship scene', () => {
      // Byte-identical outputs vs. the pre-lateralM estimator: the exact
      // assertions of the flagship 7m→3PT test must still hold, plus the new
      // field carries the (zero) ground truth without perturbing anything.
      const est = estimateShotValueMetric(scene({ camH: 0.6, zRim: 10, zFeet: 3 }));
      expect(est).not.toBeNull();
      expect(est!.value).toBe(3);
      expect(est!.distanceM).toBeCloseTo(7.0, 1);
      expect(est!.zRimM).toBeCloseTo(10, 3);
      expect(est!.zFeetM).toBeCloseTo(3, 3);
      expect(est!.camHeightM).toBeCloseTo(0.6, 2);
      expect(est!.lateralM).toBeCloseTo(0, 6);
    });

    test('calibration never touches lateralM (raw geometry, like zRim/zFeet)', () => {
      const base = scene({ camH: 0.6, zRim: 10, zFeet: 3.6, xFeet: 1 });
      const uncal = estimateShotValueMetric(base);
      const cal = estimateShotValueMetric({
        ...base,
        calibration: { correctionFactor: 1.1 },
      });
      expect(uncal).not.toBeNull();
      expect(cal).not.toBeNull();
      expect(cal!.lateralM).toBe(uncal!.lateralM);
      expect(cal!.zRimM).toBe(uncal!.zRimM);
      expect(cal!.zFeetM).toBe(uncal!.zFeetM);
    });
  });
});
