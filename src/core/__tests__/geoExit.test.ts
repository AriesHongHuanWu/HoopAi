/**
 * geoExitObserved tests — the geometric discriminator at the heart of the
 * rim-roll make recovery. It must catch a genuine deep-through-the-bottom exit
 * while rejecting a front-lip graze, a bounce-out (re-ascent), an out-of-span
 * exit, an airball (no matter below the rim), and a purely-predicted "exit".
 *
 * Screen coords, +y DOWN. Rim TOP = planeY, rim BOTTOM + margin = belowY, so
 * belowY > planeY. A ball "below the rim bottom in-span" has cy > belowY and
 * spanLeft <= cx <= spanRight.
 */
import { geoExitObserved } from '../shotFsm';
import type { BallSample, Box, RimGeometry } from '../types';

const box: Box = { x: 280, y: 90, width: 80, height: 30 };
const RIM: RimGeometry = {
  box,
  cx: 320,
  cy: 105,
  planeY: 100, // rim TOP
  spanLeft: 290,
  spanRight: 350,
  belowY: 140, // rim BOTTOM + margin
  upZone: box,
  hoopRoi: box,
  netRoi: box,
};

let t = 0;
function s(cx: number, cy: number, predicted = false): BallSample {
  return { cx, cy, r: 12, t: (t += 1 / 30), score: predicted ? 0 : 0.8, predicted };
}

beforeEach(() => {
  t = 0;
});

describe('geoExitObserved', () => {
  test('catches a deep in-span descending exit with no re-ascent', () => {
    // 60 -> 110 -> 160: descends from above the rim to well below belowY, in-span.
    const traj = [s(320, 60), s(320, 110), s(320, 160)];
    expect(geoExitObserved(traj, RIM)).toBe(true);
  });

  test('rejects a front-lip graze that never reaches the rim bottom in-span', () => {
    // Dips below planeY (100) but never below belowY (140).
    const traj = [s(320, 60), s(320, 110), s(320, 130)];
    expect(geoExitObserved(traj, RIM)).toBe(false);
  });

  test('rejects a bounce-out that re-ascends above the rim plane', () => {
    // Goes deep (160 in-span) then bounces back up above planeY (70).
    const traj = [s(320, 60), s(320, 160), s(325, 70)];
    expect(geoExitObserved(traj, RIM)).toBe(false);
  });

  test('rejects a deep sample that is OUT of span (rolled off the side)', () => {
    // cx 400 is right of spanRight (350) — off the rim, not through it.
    const traj = [s(320, 60), s(400, 160)];
    expect(geoExitObserved(traj, RIM)).toBe(false);
  });

  test('rejects a purely-predicted (coasted) deep sample', () => {
    // The only deep in-span sample is a Kalman prediction — cannot fabricate an exit.
    const traj = [s(320, 60), s(320, 160, true)];
    expect(geoExitObserved(traj, RIM)).toBe(false);
  });

  test('requires an observed descent into the deep point', () => {
    // A lone deep sample with no earlier real sample above it — descent unseen.
    const traj = [s(320, 160)];
    expect(geoExitObserved(traj, RIM)).toBe(false);
  });

  test('predicted samples interspersed do not break a real deep exit', () => {
    // Real 60, predicted 120, real 160 in-span: descent is read across the reals.
    const traj = [s(320, 60), s(320, 120, true), s(320, 160)];
    expect(geoExitObserved(traj, RIM)).toBe(true);
  });

  test('a predicted re-ascent does NOT disqualify (only real re-ascent counts)', () => {
    const traj = [s(320, 60), s(320, 160), s(325, 70, true)];
    expect(geoExitObserved(traj, RIM)).toBe(true);
  });

  test('empty trajectory is not an exit', () => {
    expect(geoExitObserved([], RIM)).toBe(false);
  });
});
