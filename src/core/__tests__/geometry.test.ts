import {
  angleAtDeg,
  boxCenter,
  boxContains,
  boxesIntersect,
  clamp,
  elevationAngleDeg,
  interpolateXAtY,
} from '../geometry';

describe('geometry', () => {
  test('boxCenter', () => {
    expect(boxCenter({ x: 10, y: 20, width: 4, height: 6 })).toEqual({ x: 12, y: 23 });
  });

  test('boxContains', () => {
    const b = { x: 0, y: 0, width: 10, height: 10 };
    expect(boxContains(b, { x: 5, y: 5 })).toBe(true);
    expect(boxContains(b, { x: 11, y: 5 })).toBe(false);
  });

  test('boxesIntersect', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(boxesIntersect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(boxesIntersect(a, { x: 20, y: 20, width: 5, height: 5 })).toBe(false);
  });

  test('clamp', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  test('angleAtDeg right angle', () => {
    expect(angleAtDeg({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90);
  });

  test('angleAtDeg degenerate returns null', () => {
    expect(angleAtDeg({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  test('elevationAngleDeg: upward motion is positive (screen y down)', () => {
    expect(elevationAngleDeg(1, -1)).toBeCloseTo(45);
    expect(elevationAngleDeg(1, 1)).toBeCloseTo(-45);
  });

  test('interpolateXAtY', () => {
    expect(interpolateXAtY({ x: 0, y: 0 }, { x: 10, y: 10 }, 5)).toBeCloseTo(5);
    expect(interpolateXAtY({ x: 0, y: 3 }, { x: 10, y: 3 }, 3)).toBeNull();
  });
});
