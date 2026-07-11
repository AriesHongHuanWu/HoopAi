/**
 * ghostAimRect — the pre-lock live tour spotlights the ghost-rim aim zone with
 * PURE math (no measureInWindow), so these tests pin the geometry exactly:
 * the rect must mirror AimingOverlay's drawing math (rim width from the
 * SHORTER view side, centered horizontally, upper-third vertically) padded by
 * AIM_RECT_PAD_FRAC x rim width per side. If the ghost-rim constants or the
 * padding drift, the spotlight stops framing what is actually drawn — these
 * numbers are the contract.
 */
// Skia's native canvas can't load under jest — stub the primitives
// PlacementGrade.tsx (the constants' home module) renders with. Everything
// under test here is pure math.
jest.mock('@shopify/react-native-skia', () => ({
  __esModule: true,
  Canvas: () => null,
  DashPathEffect: () => null,
  Oval: () => null,
}));

import {
  GHOST_RIM_ASPECT,
  GHOST_RIM_CENTER_Y_FRAC,
  GHOST_RIM_WIDTH_FRAC,
} from '../../hud/PlacementGrade';
import { AIM_RECT_PAD_FRAC, ghostAimRect } from '../liveTourRects';

describe('ghost-rim constants (upstream drift guard)', () => {
  // The tour rect is only correct because these match what AimingOverlay
  // draws. If PlacementGrade retunes them, the exact-value tests below must
  // be retuned WITH them — fail loudly here first.
  it('match the values the tour math was derived from', () => {
    expect(GHOST_RIM_WIDTH_FRAC).toBe(0.115);
    expect(GHOST_RIM_ASPECT).toBe(0.4);
    expect(GHOST_RIM_CENTER_Y_FRAC).toBe(1 / 3);
    expect(AIM_RECT_PAD_FRAC).toBe(0.6);
  });
});

describe('ghostAimRect', () => {
  it('returns the exact padded aim zone for portrait 390x844', () => {
    // rimW = 390 * 0.115 = 44.85, rimH = 17.94, pad = 26.91
    const r = ghostAimRect(390, 844);
    expect(r.x).toBeCloseTo(145.665, 10);
    expect(r.y).toBeCloseTo(844 / 3 - 8.97 - 26.91, 10);
    expect(r.width).toBeCloseTo(98.67, 10);
    expect(r.height).toBeCloseTo(71.76, 10);
  });

  it('returns the exact padded aim zone for landscape 844x390', () => {
    // Shorter side is still 390 → SAME rim + pad sizes as portrait
    // (AimingOverlay sizes the ghost off Math.min(width, height)); only the
    // center moves: centerX = 422, centerY = 130.
    const r = ghostAimRect(844, 390);
    expect(r.x).toBeCloseTo(372.665, 10);
    expect(r.y).toBeCloseTo(94.12, 10);
    expect(r.width).toBeCloseTo(98.67, 10);
    expect(r.height).toBeCloseTo(71.76, 10);
  });

  it('uses the shorter view side, so box size is orientation-invariant', () => {
    const portrait = ghostAimRect(390, 844);
    const landscape = ghostAimRect(844, 390);
    expect(landscape.width).toBeCloseTo(portrait.width, 10);
    expect(landscape.height).toBeCloseTo(portrait.height, 10);
  });

  it('is symmetric around the horizontal center', () => {
    for (const [w, h] of [
      [390, 844],
      [844, 390],
      [430, 932],
    ] as const) {
      const r = ghostAimRect(w, h);
      expect(r.x + r.width / 2).toBeCloseTo(w / 2, 10);
      // Vertical center sits on the ghost-rim center (upper third).
      expect(r.y + r.height / 2).toBeCloseTo(h * GHOST_RIM_CENTER_Y_FRAC, 10);
    }
  });

  it('scales linearly with view size', () => {
    const base = ghostAimRect(390, 844);
    const doubled = ghostAimRect(780, 1688);
    expect(doubled.x).toBeCloseTo(base.x * 2, 10);
    expect(doubled.y).toBeCloseTo(base.y * 2, 10);
    expect(doubled.width).toBeCloseTo(base.width * 2, 10);
    expect(doubled.height).toBeCloseTo(base.height * 2, 10);
  });

  it('always frames the raw rim box with positive padding on every side', () => {
    const r = ghostAimRect(390, 844);
    const rimW = 390 * GHOST_RIM_WIDTH_FRAC;
    const rimH = rimW * GHOST_RIM_ASPECT;
    // Padded box strictly contains the drawn silhouette.
    expect(r.x).toBeLessThan(195 - rimW / 2);
    expect(r.y).toBeLessThan(844 / 3 - rimH / 2);
    expect(r.x + r.width).toBeGreaterThan(195 + rimW / 2);
    expect(r.y + r.height).toBeGreaterThan(844 / 3 + rimH / 2);
  });
});
