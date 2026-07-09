import type { Point } from '../../../core/types';
import { partialPolyline, replayDurationMs } from '../miniArcReplayGeometry';

const p = (x: number, y: number): Point => ({ x, y });

/** Three collinear, equally spaced points — lerp results are exact. */
const LINE = [p(0, 0), p(10, 10), p(20, 20)];

describe('partialPolyline', () => {
  it('returns [] for empty or single-point input', () => {
    expect(partialPolyline([], 0.5)).toEqual([]);
    expect(partialPolyline([p(1, 2)], 0.5)).toEqual([]);
  });

  it('returns just the first point at progress 0', () => {
    expect(partialPolyline(LINE, 0)).toEqual([p(0, 0)]);
  });

  it('returns a copy of all points at progress 1', () => {
    const out = partialPolyline(LINE, 1);
    expect(out).toEqual(LINE);
    expect(out).not.toBe(LINE);
  });

  it('lands exactly on an interior point when f = progress·(n−1) is integral', () => {
    // f = 0.5 * (3 - 1) = 1 → head is points[1], no extra interpolated point.
    expect(partialPolyline(LINE, 0.5)).toEqual([p(0, 0), p(10, 10)]);
  });

  it('interpolates the head linearly inside a segment', () => {
    // f = 0.75 * 2 = 1.5 → head exactly at the midpoint of segment 2.
    const out = partialPolyline(LINE, 0.75);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(p(0, 0));
    expect(out[1]).toEqual(p(10, 10));
    expect(out[2]!.x).toBeCloseTo(15);
    expect(out[2]!.y).toBeCloseTo(15);
  });

  it('clamps progress below 0 and above 1', () => {
    expect(partialPolyline(LINE, -0.5)).toEqual([p(0, 0)]);
    expect(partialPolyline(LINE, 1.5)).toEqual(LINE);
  });
});

describe('replayDurationMs', () => {
  it('clamps a short span up to the 600ms floor', () => {
    expect(replayDurationMs([{ t: 10 }, { t: 10.3 }])).toBe(600);
  });

  it('clamps a long span down to the 2000ms ceiling', () => {
    expect(replayDurationMs([{ t: 0 }, { t: 5 }])).toBe(2000);
  });

  it('uses the real first→last span between the clamps', () => {
    expect(replayDurationMs([{ t: 2 }, { t: 2.6 }, { t: 3.2 }])).toBeCloseTo(1200);
  });

  it('falls back to 900ms for fewer than 2 samples', () => {
    expect(replayDurationMs([])).toBe(900);
    expect(replayDurationMs([{ t: 5 }])).toBe(900);
  });

  it('falls back to 900ms for a non-finite or non-positive span', () => {
    expect(replayDurationMs([{ t: NaN }, { t: 1 }])).toBe(900);
    expect(replayDurationMs([{ t: 3 }, { t: 3 }])).toBe(900);
    expect(replayDurationMs([{ t: 4 }, { t: 2 }])).toBe(900);
  });
});
