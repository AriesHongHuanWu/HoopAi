/**
 * Calibration-engine tests. Taps are generated from a ground-truth court→image
 * transform Gci so a consistent set recovers the court exactly, and a corrupted
 * tap is caught by the (now overdetermined, 5-point) reprojection gate.
 */
import {
  startCalibration,
  withTap,
  withoutTap,
  missingLandmarks,
  isComplete,
  buildRegistration,
} from '../courtCalibration';
import { classifyByRegistration } from '../courtRegistration';
import { FIBA_COURT, courtLandmarks, CALIBRATION_LANDMARK_IDS, type LandmarkId } from '../courtModel';
import { applyHomography, type Homography } from '../courtHomography';

// Ground-truth COURT→IMAGE affine: u = 40x + 320, v = −45y + 500.
const GCI: Homography = [40, 0, 320, 0, -45, 500, 0, 0, 1];
const LANDMARKS = courtLandmarks(FIBA_COURT);
const courtOf = (id: LandmarkId) => LANDMARKS.find((l) => l.id === id)!.court;
const tapFor = (id: LandmarkId) => {
  const c = courtOf(id);
  return applyHomography(GCI, c.x, c.y)!;
};

function fullSession() {
  let s = startCalibration(FIBA_COURT);
  for (const id of CALIBRATION_LANDMARK_IDS) s = withTap(s, id, tapFor(id));
  return s;
}

describe('calibration session state', () => {
  test('missingLandmarks shrinks as taps are placed; isComplete flips at the end', () => {
    let s = startCalibration(FIBA_COURT);
    expect(missingLandmarks(s)).toHaveLength(CALIBRATION_LANDMARK_IDS.length);
    expect(isComplete(s)).toBe(false);
    s = withTap(s, 'basket', { x: 320, y: 500 });
    expect(missingLandmarks(s)).not.toContain('basket');
    s = fullSession();
    expect(isComplete(s)).toBe(true);
  });

  test('re-tapping a landmark replaces it (never duplicates)', () => {
    let s = startCalibration(FIBA_COURT);
    s = withTap(s, 'basket', { x: 1, y: 1 });
    s = withTap(s, 'basket', { x: 320, y: 500 });
    expect(s.taps.filter((t) => t.landmarkId === 'basket')).toHaveLength(1);
    expect(s.taps.find((t) => t.landmarkId === 'basket')!.image).toEqual({ x: 320, y: 500 });
  });

  test('withoutTap removes a placed landmark', () => {
    let s = fullSession();
    s = withoutTap(s, 'ftCenter');
    expect(missingLandmarks(s)).toEqual(['ftCenter']);
    expect(isComplete(s)).toBe(false);
  });
});

describe('buildRegistration', () => {
  test('an incomplete session is rejected', () => {
    let s = startCalibration(FIBA_COURT);
    s = withTap(s, 'basket', tapFor('basket'));
    const r = buildRegistration(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('incomplete');
  });

  test('consistent taps register the court with ~zero reprojection error', () => {
    const r = buildRegistration(fullSession());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reprojectionErrorM).toBeLessThan(1e-4);
      // And the registration classifies a corner shot correctly.
      const cornerPx = applyHomography(GCI, 6.65, 0.5)!; // a corner 3
      const est = classifyByRegistration(r.registration, cornerPx.x, cornerPx.y)!;
      expect(est.value).toBe(3);
      expect(est.region).toBe('corner');
    }
  });

  test('a single badly-placed tap is caught by the reprojection gate', () => {
    let s = fullSession();
    // Shove the FT tap 90 px off — inconsistent with the other four.
    const good = tapFor('ftCenter');
    s = withTap(s, 'ftCenter', { x: good.x + 90, y: good.y });
    const r = buildRegistration(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('high-error');
  });

  test('collinear taps are rejected as degenerate', () => {
    let s = startCalibration(FIBA_COURT);
    // All taps on one image line — no valid homography to a non-collinear court.
    let k = 0;
    for (const id of CALIBRATION_LANDMARK_IDS) {
      s = withTap(s, id, { x: 100 + k * 40, y: 100 + k * 40 });
      k += 1;
    }
    const r = buildRegistration(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('degenerate');
  });
});
