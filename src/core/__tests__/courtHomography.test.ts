/**
 * Homography solver tests. Strategy: pick a ground-truth image→court transform
 * G (with real perspective — nonzero h31/h32), generate correspondences from
 * it, solve, and require the recovered H to reproduce G on HELD-OUT points.
 * Because the correspondences are exact, recovery should be near machine-exact.
 */
import { solveHomography, applyHomography, type Homography } from '../courtHomography';

// A ground-truth image→court homography with genuine perspective foreshortening.
const G: Homography = [
  0.02, 0.001, -6.0,
  0.0004, 0.025, -2.0,
  0.00003, 0.00006, 1.0,
];

const IMG_PTS = [
  { x: 100, y: 500 },
  { x: 540, y: 520 },
  { x: 320, y: 120 },
  { x: 320, y: 400 },
  { x: 200, y: 300 },
  { x: 450, y: 250 },
];

const CORR = IMG_PTS.map((p) => ({ image: p, court: applyHomography(G, p.x, p.y)! }));

describe('solveHomography', () => {
  test('4 points recover the transform on held-out points', () => {
    const H = solveHomography(CORR.slice(0, 4))!;
    expect(H).not.toBeNull();
    // Held-out points 5 and 6 map the same as the ground truth.
    for (const p of IMG_PTS.slice(4)) {
      const got = applyHomography(H, p.x, p.y)!;
      const exp = applyHomography(G, p.x, p.y)!;
      expect(got.x).toBeCloseTo(exp.x, 4);
      expect(got.y).toBeCloseTo(exp.y, 4);
    }
  });

  test('the 4 fitted points map back to their court coords exactly', () => {
    const H = solveHomography(CORR.slice(0, 4))!;
    for (const c of CORR.slice(0, 4)) {
      const got = applyHomography(H, c.image.x, c.image.y)!;
      expect(got.x).toBeCloseTo(c.court.x, 6);
      expect(got.y).toBeCloseTo(c.court.y, 6);
    }
  });

  test('overdetermined (6 exact points) still recovers the transform', () => {
    const H = solveHomography(CORR)!;
    for (const p of IMG_PTS) {
      const got = applyHomography(H, p.x, p.y)!;
      const exp = applyHomography(G, p.x, p.y)!;
      expect(got.x).toBeCloseTo(exp.x, 4);
      expect(got.y).toBeCloseTo(exp.y, 4);
    }
  });

  test('is robust to small measurement noise (least squares)', () => {
    // Deterministic tiny perturbations on the image taps (±1 px pattern).
    const noise = [0.8, -0.6, 0.5, -0.9, 0.7, -0.4];
    const noisy = CORR.map((c, i) => ({
      image: { x: c.image.x + noise[i]!, y: c.image.y - noise[i]! },
      court: c.court,
    }));
    const H = solveHomography(noisy)!;
    // A ~1px tap error should move the court estimate only centimetres.
    for (const p of IMG_PTS) {
      const got = applyHomography(H, p.x, p.y)!;
      const exp = applyHomography(G, p.x, p.y)!;
      expect(Math.hypot(got.x - exp.x, got.y - exp.y)).toBeLessThan(0.15);
    }
  });

  test('fewer than 4 correspondences → null', () => {
    expect(solveHomography(CORR.slice(0, 3))).toBeNull();
  });

  test('coincident points → null', () => {
    const same = Array.from({ length: 4 }, () => ({ image: { x: 200, y: 200 }, court: { x: 1, y: 1 } }));
    expect(solveHomography(same)).toBeNull();
  });

  test('collinear image points → null (degenerate)', () => {
    const collinear = [
      { image: { x: 0, y: 0 }, court: { x: 0, y: 0 } },
      { image: { x: 100, y: 100 }, court: { x: 1, y: 0 } },
      { image: { x: 200, y: 200 }, court: { x: 2, y: 3 } },
      { image: { x: 300, y: 300 }, court: { x: 3, y: 1 } },
    ];
    expect(solveHomography(collinear)).toBeNull();
  });
});

describe('applyHomography', () => {
  test('maps to null when the point projects to infinity (w ≈ 0)', () => {
    const H: Homography = [1, 0, 0, 0, 1, 0, 1, 0, 0]; // w = u
    expect(applyHomography(H, 0, 5)).toBeNull();
  });
});
