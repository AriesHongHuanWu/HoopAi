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
 */
function scene(opts: {
  camH: number;
  zRim: number;
  zFeet: number;
  xRim?: number;
  xFeet?: number;
  pitchDeg?: number | null;
}): MetricShotInput {
  const { camH, zRim, zFeet, xRim = 0, xFeet = 0 } = opts;
  const wRim = (F * RIM_D) / zRim;
  const yRim = C - (F * (RIM_H - camH)) / zRim;
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
});
