import type { BallSample } from '../../../core/types';
import { buildSparklinePoints, SPARK_HEIGHT, SPARK_WIDTH } from '../shotSparkline';

function sample(cx: number, cy: number, t = 0): BallSample {
  return { cx, cy, r: 6, t, score: 0.9, predicted: false };
}

/** Launch → apex → land, in analysis-frame px (+y down: apex has min cy). */
const ARC = [sample(100, 500, 0), sample(150, 300, 0.2), sample(200, 500, 0.4)];

describe('buildSparklinePoints', () => {
  it('returns [] for fewer than 2 samples', () => {
    expect(buildSparklinePoints([], 72, 36)).toEqual([]);
    expect(buildSparklinePoints([sample(100, 500)], 72, 36)).toEqual([]);
  });

  it('returns [] when the box is too small for the inset', () => {
    expect(buildSparklinePoints(ARC, 4, 36, 2)).toEqual([]);
    expect(buildSparklinePoints(ARC, 72, 0, 2)).toEqual([]);
  });

  it('maps the sample bounds onto the inset box edges', () => {
    const pts = buildSparklinePoints(ARC, 72, 36, 2);
    expect(pts).toHaveLength(3);
    // x: minX → left inset, maxX → right inset.
    expect(pts[0]!.x).toBeCloseTo(2);
    expect(pts[2]!.x).toBeCloseTo(70);
    // y: both endpoints share maxY → bottom inset.
    expect(pts[0]!.y).toBeCloseTo(34);
    expect(pts[2]!.y).toBeCloseTo(34);
  });

  it('keeps +y down: the shot apex (min cy) renders at the top of the box', () => {
    const pts = buildSparklinePoints(ARC, 72, 36, 2);
    expect(pts[1]!.y).toBeCloseTo(2);
    expect(pts[1]!.y).toBeLessThan(pts[0]!.y);
  });

  it('centers a flat axis instead of dividing by zero', () => {
    const flat = [sample(100, 400), sample(150, 400), sample(200, 400)];
    const pts = buildSparklinePoints(flat, 72, 36, 2);
    for (const p of pts) expect(p.y).toBeCloseTo(18);
    // x still spreads across the box.
    expect(pts[0]!.x).toBeCloseTo(2);
    expect(pts[2]!.x).toBeCloseTo(70);

    const vertical = [sample(150, 300), sample(150, 500)];
    const vpts = buildSparklinePoints(vertical, 72, 36, 2);
    for (const p of vpts) expect(p.x).toBeCloseTo(36);
  });

  it('keeps every point inside the default box', () => {
    const dense: BallSample[] = [];
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      // Parabolic arc: 320 px wide, apex 240 px above the endpoints.
      dense.push(sample(80 + u * 320, 520 - 240 * (1 - (2 * u - 1) ** 2), u * 0.6));
    }
    const pts = buildSparklinePoints(dense);
    expect(pts).toHaveLength(dense.length);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(SPARK_WIDTH);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(SPARK_HEIGHT);
    }
  });
});
