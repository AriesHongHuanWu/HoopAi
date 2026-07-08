/**
 * True 3-point-line classifier tests. Constants are hand-derived from the FIBA
 * (arc 6.75 / corner 6.60, junction Y = sqrt(6.75²−6.60²) ≈ 1.415) and NBA
 * (arc 7.24 / corner 6.70, junction Y ≈ 2.744) specs so a spec change surfaces
 * here. The headline cases are the CORNER shots a single radial threshold
 * mis-calls.
 */
import { classifyCourtPoint, classificationConfidence } from '../threePointLine';
import { FIBA_COURT, NBA_COURT, cornerJunctionY } from '../courtModel';

describe('cornerJunctionY', () => {
  test('is sqrt(arc² − corner²) per spec', () => {
    expect(cornerJunctionY(FIBA_COURT)).toBeCloseTo(Math.sqrt(6.75 ** 2 - 6.6 ** 2), 6);
    expect(cornerJunctionY(NBA_COURT)).toBeCloseTo(Math.sqrt(7.24 ** 2 - 6.7 ** 2), 6);
  });
});

describe('classifyCourtPoint (FIBA)', () => {
  test('top of the key just beyond the arc is a 3', () => {
    const c = classifyCourtPoint(0, 6.8, FIBA_COURT);
    expect(c.value).toBe(3);
    expect(c.region).toBe('arc');
    expect(c.marginM).toBeCloseTo(0.05, 6);
  });

  test('top of the key just inside the arc is a 2', () => {
    const c = classifyCourtPoint(0, 6.7, FIBA_COURT);
    expect(c.value).toBe(2);
    expect(c.region).toBe('arc');
    expect(c.marginM).toBeCloseTo(-0.05, 6);
  });

  test('CORNER 3 the radial method misses: closer than the arc yet still a 3', () => {
    // (6.65, 0.5): |x| 6.65 > corner 6.60 → a 3. But radial distance is
    // hypot(6.65, 0.5) ≈ 6.669 m < 6.75 arc → a single threshold calls it a 2.
    const c = classifyCourtPoint(6.65, 0.5, FIBA_COURT);
    expect(c.value).toBe(3);
    expect(c.region).toBe('corner');
    expect(Math.hypot(6.65, 0.5)).toBeLessThan(FIBA_COURT.arcRadiusM); // proves radial would err
  });

  test('inside the corner line is a 2', () => {
    const c = classifyCourtPoint(6.5, 0.5, FIBA_COURT);
    expect(c.value).toBe(2);
    expect(c.region).toBe('corner');
    expect(c.marginM).toBeCloseTo(-0.1, 6);
  });

  test('symmetric across the baseline center (±x)', () => {
    expect(classifyCourtPoint(-6.65, 0.5, FIBA_COURT).value).toBe(3);
    expect(classifyCourtPoint(6.65, 0.5, FIBA_COURT).value).toBe(3);
  });

  test('deep wing is a 3 via the arc', () => {
    const c = classifyCourtPoint(5, 5, FIBA_COURT); // r ≈ 7.07 > 6.75
    expect(c.value).toBe(3);
    expect(c.region).toBe('arc');
  });

  test('mid-range and layup are 2s', () => {
    expect(classifyCourtPoint(3, 3, FIBA_COURT).value).toBe(2); // r ≈ 4.24
    expect(classifyCourtPoint(0, 0, FIBA_COURT).value).toBe(2); // under the rim
  });

  test('right on the corner line counts as a 3 (margin 0)', () => {
    const c = classifyCourtPoint(6.6, 1.0, FIBA_COURT);
    expect(c.value).toBe(3);
    expect(c.marginM).toBeCloseTo(0, 6);
  });

  test('the corner→arc handoff is continuous at the junction', () => {
    const yj = cornerJunctionY(FIBA_COURT);
    const below = classifyCourtPoint(6.6, yj - 0.001, FIBA_COURT); // corner region
    const above = classifyCourtPoint(6.6, yj + 0.001, FIBA_COURT); // arc region
    expect(below.region).toBe('corner');
    expect(above.region).toBe('arc');
    // both land within a millimetre of the line, same call
    expect(below.value).toBe(3);
    expect(above.value).toBe(3);
    expect(Math.abs(below.marginM)).toBeLessThan(0.01);
    expect(Math.abs(above.marginM)).toBeLessThan(0.01);
  });
});

describe('classifyCourtPoint (NBA — bigger arc/corner gap)', () => {
  test('a 22-ft corner shot is a 3 though radial says otherwise', () => {
    // (6.75, 1.0): |x| 6.75 > corner 6.70 → 3. Radial hypot(6.75,1)=6.82 < 7.24.
    const c = classifyCourtPoint(6.75, 1.0, NBA_COURT);
    expect(c.value).toBe(3);
    expect(c.region).toBe('corner');
    expect(Math.hypot(6.75, 1.0)).toBeLessThan(NBA_COURT.arcRadiusM);
  });

  test('a shot inside the NBA arc up top is a 2', () => {
    expect(classifyCourtPoint(0, 7.0, NBA_COURT).value).toBe(2); // < 7.24
  });
});

describe('classificationConfidence', () => {
  test('0 on the line, saturates ~band away, floored at 0.5', () => {
    expect(classificationConfidence(0)).toBeCloseTo(0.5, 6);
    expect(classificationConfidence(0.6)).toBeCloseTo(1, 6);
    expect(classificationConfidence(0.3)).toBeCloseTo(0.75, 6);
    expect(classificationConfidence(-0.6)).toBeCloseTo(1, 6); // magnitude only
    expect(classificationConfidence(5)).toBe(1); // clamped
  });
});
