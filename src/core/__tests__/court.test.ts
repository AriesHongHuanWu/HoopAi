import { COURT } from '../config';
import { adjust3ptThreshold, estimateShotValue } from '../court';
import type { Box, RimGeometry } from '../types';

const FRAME = { width: 640, height: 640 };

/** Minimal rim geometry from a box; only box/cx/cy matter for court.ts. */
function rimFromBox(box: Box): RimGeometry {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return {
    box,
    cx,
    cy,
    planeY: box.y,
    spanLeft: cx - box.width / 2,
    spanRight: cx + box.width / 2,
    belowY: box.y + box.height,
    upZone: { x: cx, y: box.y, width: box.width, height: box.height },
    hoopRoi: { x: cx, y: box.y, width: box.width, height: box.height },
    netRoi: { x: box.x, y: box.y, width: box.width, height: box.height },
  };
}

// Rim 40px wide, centered at (320, 210). Default 3pt threshold = 9 rim widths
// ⇒ 9 * 40 = 360 px from under-the-rim classifies as a 3.
const RIM = rimFromBox({ x: 300, y: 200, width: 40, height: 20 });

/** Normalize an analysis-frame pixel coord back to 0..1 for origin inputs. */
function nx(px: number): number {
  return px / FRAME.width;
}
function ny(px: number): number {
  return px / FRAME.height;
}

describe('court / estimateShotValue', () => {
  test('null origin ⇒ 2, distance 0, confidence 0', () => {
    const r = estimateShotValue(RIM, null, null, FRAME);
    expect(r.value).toBe(2);
    expect(r.distanceRimWidths).toBe(0);
    expect(r.confidence).toBe(0);
  });

  test('degenerate rim width ⇒ safe 2/0/0 fallback', () => {
    const zeroRim = rimFromBox({ x: 320, y: 200, width: 0, height: 20 });
    const r = estimateShotValue(zeroRim, nx(100), ny(400), FRAME);
    expect(r.value).toBe(2);
    expect(r.distanceRimWidths).toBe(0);
    expect(r.confidence).toBe(0);
  });

  test('close shooter under the rim ⇒ 2-pointer', () => {
    // Foot directly under rim center, a little below: tiny distance.
    const r = estimateShotValue(RIM, nx(320), ny(230), FRAME);
    expect(r.value).toBe(2);
    expect(r.distanceRimWidths).toBeLessThan(COURT.default3ptRimWidths);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  test('far shooter (>= threshold rim widths) ⇒ 3-pointer', () => {
    // Horizontal offset of 400px from rim center = 10 rim widths (> 9).
    const r = estimateShotValue(RIM, nx(320 - 400), ny(210), FRAME);
    expect(r.distanceRimWidths).toBeCloseTo(10, 6);
    expect(r.value).toBe(3);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  test('distance is expressed in rim widths (Euclidean when originY present)', () => {
    // dx = 120px (3 rim widths), dy = 160px (4 rim widths) ⇒ hypot = 200px = 5.
    const r = estimateShotValue(RIM, nx(320 + 120), ny(210 + 160), FRAME);
    expect(r.distanceRimWidths).toBeCloseTo(5, 6);
    expect(r.value).toBe(2);
  });

  test('missing originY ⇒ horizontal-only distance and halved confidence', () => {
    const withY = estimateShotValue(RIM, nx(320 - 400), ny(210), FRAME);
    const noY = estimateShotValue(RIM, nx(320 - 400), null, FRAME);
    // Horizontal-only distance is the same here (dy was 0), value still 3.
    expect(noY.distanceRimWidths).toBeCloseTo(10, 6);
    expect(noY.value).toBe(3);
    // Confidence is halved relative to the y-known case.
    expect(noY.confidence).toBeCloseTo(withY.confidence * 0.5, 6);
  });

  test('custom threshold flips the classification', () => {
    // 10 rim widths out: a 2 under a threshold of 12, a 3 under 8.
    const originX = nx(320 - 400);
    expect(estimateShotValue(RIM, originX, ny(210), FRAME, 12).value).toBe(2);
    expect(estimateShotValue(RIM, originX, ny(210), FRAME, 8).value).toBe(3);
  });

  test('confidence sits in [0,1]', () => {
    for (const px of [320, 360, 500, 100, 640, 0]) {
      const r = estimateShotValue(RIM, nx(px), ny(300), FRAME);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('court / adjust3ptThreshold', () => {
  test('clamps into the config band', () => {
    expect(adjust3ptThreshold(0)).toBe(COURT.min3ptRimWidths);
    expect(adjust3ptThreshold(1000)).toBe(COURT.max3ptRimWidths);
    expect(adjust3ptThreshold(7)).toBe(7);
  });

  test('non-finite falls back to the default', () => {
    expect(adjust3ptThreshold(NaN)).toBe(COURT.default3ptRimWidths);
    expect(adjust3ptThreshold(Infinity)).toBe(COURT.default3ptRimWidths);
  });
});
