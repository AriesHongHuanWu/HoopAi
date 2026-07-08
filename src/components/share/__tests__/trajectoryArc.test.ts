import { describe, expect, test } from '@jest/globals';

import { layoutTrajectoryArc, arcToSvgPath } from '../trajectoryArc';
import type { BallSample } from '../../../core/types';

function s(t: number, cx: number, cy: number, predicted = false): BallSample {
  return { cx, cy, r: 12, t, score: 0.6, predicted };
}

const BOX = { x: 100, y: 200, width: 880, height: 500 };

describe('layoutTrajectoryArc', () => {
  test('returns null for fewer than two samples', () => {
    expect(layoutTrajectoryArc([], BOX)).toBeNull();
    expect(layoutTrajectoryArc([s(0, 10, 10)], BOX)).toBeNull();
  });

  test('returns null for a degenerate (all-coincident) cloud', () => {
    expect(layoutTrajectoryArc([s(0, 50, 50), s(1, 50, 50), s(2, 50, 50)], BOX)).toBeNull();
  });

  test('fits all points inside the target box', () => {
    const arc = layoutTrajectoryArc(
      [s(0, 0, 300), s(1, 100, 50), s(2, 200, 280), s(3, 300, 320)],
      BOX,
    );
    expect(arc).not.toBeNull();
    for (const p of arc!.points) {
      expect(p.x).toBeGreaterThanOrEqual(BOX.x);
      expect(p.x).toBeLessThanOrEqual(BOX.x + BOX.width);
      expect(p.y).toBeGreaterThanOrEqual(BOX.y);
      expect(p.y).toBeLessThanOrEqual(BOX.y + BOX.height);
    }
  });

  test('orders points chronologically: release = first time, ball = last time', () => {
    // Deliberately out of order in the input.
    const arc = layoutTrajectoryArc(
      [s(2, 200, 280), s(0, 0, 300), s(3, 300, 320), s(1, 100, 50)],
      BOX,
    );
    expect(arc).not.toBeNull();
    // release corresponds to the smallest-t sample (cx 0), ball to largest (cx 300).
    // With no flip, smaller cx maps to smaller x.
    expect(arc!.release.x).toBeLessThan(arc!.ball.x);
  });

  test('preserves the arc shape: apex (min cy) stays highest on the card', () => {
    const arc = layoutTrajectoryArc(
      [s(0, 0, 300), s(1, 150, 40), s(2, 300, 300)],
      BOX,
    );
    expect(arc).not.toBeNull();
    // The apex sample (cy 40, index 1) should have the smallest y of the three.
    const ys = arc!.points.map((p) => p.y);
    const apexY = ys[1]!;
    expect(apexY).toBeLessThanOrEqual(Math.min(...ys) + 1e-6);
  });

  test('flip mirrors the horizontal direction', () => {
    const pts = [s(0, 0, 300), s(1, 100, 50), s(2, 200, 300)];
    const normal = layoutTrajectoryArc(pts, BOX, { flip: false })!;
    const flipped = layoutTrajectoryArc(pts, BOX, { flip: true })!;
    // First point's x is on opposite sides of the box center.
    const cx = BOX.x + BOX.width / 2;
    expect(Math.sign(normal.release.x - cx)).toBe(-Math.sign(flipped.release.x - cx));
  });

  test('uniform scale keeps aspect (a flat flight is not stretched tall)', () => {
    // Very wide, barely-rising flight.
    const arc = layoutTrajectoryArc(
      [s(0, 0, 100), s(1, 400, 90), s(2, 800, 100)],
      BOX,
    )!;
    const spanY = Math.max(...arc.points.map((p) => p.y)) - Math.min(...arc.points.map((p) => p.y));
    // Small source rise (10px over 800px) must not fill the box height.
    expect(spanY).toBeLessThan(BOX.height * 0.5);
  });
});

describe('arcToSvgPath', () => {
  test('empty for no points', () => {
    expect(arcToSvgPath([])).toBe('');
  });

  test('single point is a lone moveto', () => {
    expect(arcToSvgPath([{ x: 5, y: 6 }])).toBe('M5 6');
  });

  test('two points draw a straight line', () => {
    expect(arcToSvgPath([{ x: 0, y: 0 }, { x: 10, y: 20 }])).toBe('M0 0 L10 20');
  });

  test('three+ points produce a smooth cubic path starting at the first point', () => {
    const d = arcToSvgPath([
      { x: 0, y: 0 },
      { x: 10, y: -10 },
      { x: 20, y: 0 },
    ]);
    expect(d.startsWith('M0 0')).toBe(true);
    expect(d).toContain('C');
  });
});
