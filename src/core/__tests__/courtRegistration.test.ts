/**
 * Court-registration classifier tests. Uses a simple, known image→court map
 * (court.x = (u−320)/50, court.y = (500−v)/50) so a foot pixel's court position
 * is exact by hand, then checks corner-accurate 2/3 + the implausibility bail.
 */
import { classifyByRegistration, type CourtRegistration } from '../courtRegistration';
import { FIBA_COURT } from '../courtModel';
import type { Homography } from '../courtHomography';

// image (u,v) → court: x=(u−320)/50, y=(500−v)/50. Bottom of frame ≈ baseline.
const H: Homography = [0.02, 0, -6.4, 0, -0.02, 10, 0, 0, 1];
const REG: CourtRegistration = { homography: H, spec: FIBA_COURT };

// Invert the map to place a foot pixel at a desired court point.
function pixelAt(courtX: number, courtY: number): { u: number; v: number } {
  return { u: courtX * 50 + 320, v: 500 - courtY * 50 };
}

describe('classifyByRegistration', () => {
  test('a corner shot closer than the arc is still a 3', () => {
    const { u, v } = pixelAt(6.65, 0.5); // corner: |x| 6.65 > 6.60, radial < 6.75
    const est = classifyByRegistration(REG, u, v)!;
    expect(est.value).toBe(3);
    expect(est.region).toBe('corner');
    expect(est.courtX).toBeCloseTo(6.65, 6);
    expect(est.courtY).toBeCloseTo(0.5, 6);
    expect(est.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test('a top-of-key shot beyond the arc is a 3', () => {
    const { u, v } = pixelAt(0, 6.9);
    expect(classifyByRegistration(REG, u, v)!.value).toBe(3);
  });

  test('a mid-range shot is a 2', () => {
    const { u, v } = pixelAt(3, 3);
    const est = classifyByRegistration(REG, u, v)!;
    expect(est.value).toBe(2);
    expect(est.distanceM).toBeCloseTo(Math.hypot(3, 3), 6);
  });

  test('a foot mapping absurdly far bails to null (caller falls back)', () => {
    const { u, v } = pixelAt(20, 0); // 20 m out → beyond MAX_PLACE_DISTANCE_M
    expect(classifyByRegistration(REG, u, v)).toBeNull();
  });

  test('a foot mapping well behind the baseline bails to null', () => {
    const { u, v } = pixelAt(0, -4); // 4 m behind the basket point
    expect(classifyByRegistration(REG, u, v)).toBeNull();
  });

  test('non-finite foot input → null', () => {
    expect(classifyByRegistration(REG, NaN, 100)).toBeNull();
  });
});
