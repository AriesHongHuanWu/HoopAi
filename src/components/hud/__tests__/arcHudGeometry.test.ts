/**
 * Verifies the pure worklet arc math behind the live arc HUD. Fixtures are
 * analytic parabolas in analysis-frame px with +y DOWN — a shot arc has its
 * MINIMUM y at the apex, and y grows away from it on both sides.
 */
import { describe, expect, test } from '@jest/globals';

import {
  ARC_ENTRY_IDEAL_MAX,
  ARC_ENTRY_IDEAL_MIN,
  apexOfFlatArc,
  arcQuality,
  entryAngleDegFromFlat,
  releaseAngleDegFromFlat,
  splitFlatTail,
} from '../arcHudGeometry';

const DEG = 180 / Math.PI;

/**
 * Sample y = apexY + a * (x - apexX)^2 at n evenly spaced x across
 * [apexX - spanX, apexX + spanX]. With +y down and a > 0 this is a shot-shaped
 * arc: rising (y decreasing) into the apex, then falling (y increasing).
 */
function parabolaPts(
  n: number,
  opts: { apexX: number; apexY: number; a: number; spanX: number },
): number[] {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = opts.apexX - opts.spanX + (2 * opts.spanX * i) / (n - 1);
    pts.push(x, opts.apexY + opts.a * (x - opts.apexX) ** 2);
  }
  return pts;
}

describe('apexOfFlatArc', () => {
  test('finds the screen apex within one sample of the analytic apex', () => {
    // Even n so no sample lands exactly on the apex.
    const n = 16;
    const spanX = 150;
    const spacing = (2 * spanX) / (n - 1);
    const pts = parabolaPts(n, { apexX: 208, apexY: 90, a: 0.01, spanX });
    const apex = apexOfFlatArc(pts);
    expect(apex).not.toBeNull();
    expect(Math.abs(apex!.x - 208)).toBeLessThanOrEqual(spacing);
    expect(apex!.y).toBeGreaterThanOrEqual(90);
    expect(apex!.y - 90).toBeLessThanOrEqual(0.01 * spacing * spacing);
    expect(pts[apex!.i * 2]).toBe(apex!.x);
    expect(pts[apex!.i * 2 + 1]).toBe(apex!.y);
  });

  test('null for fewer than 5 points', () => {
    const pts = parabolaPts(4, { apexX: 100, apexY: 50, a: 0.01, spanX: 60 });
    expect(apexOfFlatArc(pts)).toBeNull();
  });

  test('null when the ball only descends (min y sits on the first point)', () => {
    // +y down: descending ball = y strictly increasing.
    const pts: number[] = [];
    for (let i = 0; i < 6; i++) pts.push(i * 10, 100 + i * 15);
    expect(apexOfFlatArc(pts)).toBeNull();
  });

  test('null when the ball only rises (min y sits on the last point)', () => {
    const pts: number[] = [];
    for (let i = 0; i < 6; i++) pts.push(i * 10, 200 - i * 15);
    expect(apexOfFlatArc(pts)).toBeNull();
  });
});

describe('releaseAngleDegFromFlat', () => {
  test('recovers the analytic tangent at the first point on an evenly sampled parabola', () => {
    const a = 0.005;
    const spanX = 150;
    const pts = parabolaPts(33, { apexX: 208, apexY: 90, a, spanX });
    // dy/dx at the first sample x = apexX - spanX is -2a*spanX (ascending).
    const expected = Math.atan(2 * a * spanX) * DEG;
    const deg = releaseAngleDegFromFlat(pts);
    expect(deg).not.toBeNull();
    expect(deg!).toBeCloseTo(expected, 8);
  });

  test('stays exact at the real fullArc sampling density (K=16 → 17 points)', () => {
    // Regression: the old 3-segment secant averaged over ~19% of the flight
    // and read a ~56° release as ~51° at this density.
    const a = 0.005;
    const spanX = 150;
    const pts = parabolaPts(17, { apexX: 208, apexY: 90, a, spanX });
    const expected = Math.atan(2 * a * spanX) * DEG;
    expect(releaseAngleDegFromFlat(pts)!).toBeCloseTo(expected, 8);
  });

  test('falls back to the first-segment chord for a 2-point trail', () => {
    // Single ascending segment (dx 10, dy -10) → 45°.
    expect(releaseAngleDegFromFlat([0, 100, 10, 90])!).toBeCloseTo(45, 8);
  });

  test('null when the first segment has no ascent', () => {
    // Descending ball: y increasing across the whole window.
    expect(releaseAngleDegFromFlat([0, 0, 10, 5, 20, 12, 30, 25])).toBeNull();
  });

  test('null for fewer than 2 points', () => {
    expect(releaseAngleDegFromFlat([])).toBeNull();
    expect(releaseAngleDegFromFlat([5, 5])).toBeNull();
  });

  test('null for a zero-length window (dx and dy both zero)', () => {
    expect(releaseAngleDegFromFlat([5, 5, 5, 5])).toBeNull();
  });
});

describe('entryAngleDegFromFlat', () => {
  test('matches the analytic tangent at the plane within 0.1 degrees', () => {
    const a = 0.005;
    const apexY = 90;
    const planeY = 150; // below the apex on screen (+y down)
    const pts = parabolaPts(65, { apexX: 208, apexY, a, spanX: 150 });
    // dy/dx at the descending crossing: 2a*(x-apexX) with x-apexX = sqrt((planeY-apexY)/a).
    const expected = Math.atan(2 * Math.sqrt(a * (planeY - apexY))) * DEG;
    const deg = entryAngleDegFromFlat(pts, planeY);
    expect(deg).not.toBeNull();
    expect(Math.abs(deg! - expected)).toBeLessThan(0.1);
  });

  test('band-edge high arc grades ideal where the whole-segment chord read flat', () => {
    // 17 points (real fullArc density). Geometry tuned so the crossing sits
    // near the END of its segment (u≈0.95): the analytic entry is ~43.6°
    // (inside the 43–52 ideal band) while the crossing segment's chord —
    // the old return value — reads ~41.4° ('flat').
    const n = 17;
    const spanX = 150;
    const apexY = 80;
    const xc = 111.5625; // offset from apex: segment start 93.75 + 0.95 * 18.75
    const a = Math.tan(43.6 / DEG) / (2 * xc);
    const planeY = apexY + a * xc * xc;
    const pts = parabolaPts(n, { apexX: 208, apexY, a, spanX });
    const expected = Math.atan(2 * Math.sqrt(a * (planeY - apexY))) * DEG;
    const deg = entryAngleDegFromFlat(pts, planeY);
    expect(deg).not.toBeNull();
    expect(Math.abs(deg! - expected)).toBeLessThan(0.15);
    expect(arcQuality(deg)).toBe('ideal');
    // Document the old chord bias this fix removes: the crossing segment's
    // own chord sits below the ideal band.
    const i = 13; // segment offsets 93.75 → 112.5 contain the crossing
    const chordDeg =
      Math.atan2(pts[i * 2 + 3] - pts[i * 2 + 1], Math.abs(pts[i * 2 + 2] - pts[i * 2])) * DEG;
    expect(chordDeg).toBeLessThan(ARC_ENTRY_IDEAL_MIN);
  });

  test('falls back to the chord for a single-segment trail', () => {
    // One descending segment crossing planeY 95: dx 10, dy 10 → 45°.
    expect(entryAngleDegFromFlat([0, 90, 10, 100], 95)!).toBeCloseTo(45, 8);
  });

  test('null when the plane is above the whole arc', () => {
    const pts = parabolaPts(33, { apexX: 208, apexY: 90, a: 0.005, spanX: 150 });
    expect(entryAngleDegFromFlat(pts, 80)).toBeNull();
  });

  test('null for an empty trail', () => {
    expect(entryAngleDegFromFlat([], 100)).toBeNull();
  });

  test('picks the LAST descending crossing on a double-dip trail', () => {
    const planeY = 150;
    // Steep first arc (entry ~67°) then a flatter second arc (entry ~48°).
    // Both endpoints sit above planeY in y so the joining segment between the
    // arcs cannot itself register as a crossing.
    const arcA = parabolaPts(33, { apexX: 100, apexY: 80, a: 0.02, spanX: 80 });
    const arcB = parabolaPts(65, { apexX: 300, apexY: 90, a: 0.005, spanX: 150 });
    const angleA = Math.atan(2 * Math.sqrt(0.02 * (planeY - 80))) * DEG;
    const angleB = Math.atan(2 * Math.sqrt(0.005 * (planeY - 90))) * DEG;
    const deg = entryAngleDegFromFlat([...arcA, ...arcB], planeY);
    expect(deg).not.toBeNull();
    expect(Math.abs(deg! - angleB)).toBeLessThan(3);
    expect(Math.abs(deg! - angleA)).toBeGreaterThan(5);
  });
});

describe('arcQuality', () => {
  test('grades the band edges', () => {
    expect(ARC_ENTRY_IDEAL_MIN).toBe(43);
    expect(ARC_ENTRY_IDEAL_MAX).toBe(52);
    expect(arcQuality(42.9)).toBe('flat');
    expect(arcQuality(43)).toBe('ideal');
    expect(arcQuality(52)).toBe('ideal');
    expect(arcQuality(52.1)).toBe('steep');
    expect(arcQuality(null)).toBeNull();
  });
});

describe('splitFlatTail', () => {
  test('duplicates the joint so tail + head reconstruct the input', () => {
    const pts = parabolaPts(12, { apexX: 100, apexY: 50, a: 0.01, spanX: 80 });
    const { tail, head } = splitFlatTail(pts, 0.4);
    // Newest ceil(12 * 0.4) = 5 points in the head.
    expect(head.length).toBe(5 * 2);
    // Joint point equal in both halves.
    expect(tail.slice(-2)).toEqual(head.slice(0, 2));
    // Dropping the duplicated joint from the tail reconstructs the input.
    expect(tail.slice(0, -2).concat(head)).toEqual(pts);
  });

  test('clamps the head to at least 2 points', () => {
    const pts = parabolaPts(10, { apexX: 100, apexY: 50, a: 0.01, spanX: 80 });
    const { tail, head } = splitFlatTail(pts, 0.01);
    expect(head.length).toBe(2 * 2);
    expect(tail.slice(0, -2).concat(head)).toEqual(pts);
  });

  test('returns everything as head for degenerate input', () => {
    expect(splitFlatTail([], 0.5)).toEqual({ tail: [], head: [] });
    expect(splitFlatTail([1, 2, 3, 4], 0.5)).toEqual({ tail: [], head: [1, 2, 3, 4] });
    // headFrac swallowing the whole trail also yields no tail.
    const pts = parabolaPts(5, { apexX: 100, apexY: 50, a: 0.01, spanX: 80 });
    expect(splitFlatTail(pts, 1)).toEqual({ tail: [], head: pts });
  });
});
