import { RELEASE } from '../config';
import { ReleaseDetector } from '../releaseDetector';
import type { PoseFrame, PoseKeypointName } from '../types';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const FPS = 30;
const FRAME_H = 640;

/** Build a PoseFrame from [x, y] (score defaults 0.9) or [x, y, score]. */
function pose(
  t: number,
  kps: Partial<Record<PoseKeypointName, [number, number] | [number, number, number]>>,
): PoseFrame {
  const keypoints: PoseFrame['keypoints'] = {};
  for (const [name, v] of Object.entries(kps) as [
    PoseKeypointName,
    [number, number] | [number, number, number],
  ][]) {
    keypoints[name] = { x: v[0], y: v[1], score: v[2] ?? 0.9 };
  }
  return { t, keypoints };
}

function newDet(hand: 'left' | 'right' = 'right'): ReleaseDetector {
  return new ReleaseDetector({ hand, frameHeight: FRAME_H });
}

/**
 * A clean right-handed release snap starting at time `t0` (3 frames):
 *   f0: set point — wrist below the shoulder, elbow bent ~90°.
 *   f1: snap — wrist jumps 40 px up in one frame (vy = -1200 px/s, far past
 *       the 0.3 × 640 = 192 px/s floor) but is only level with the shoulder.
 *   f2: extension — wrist above the shoulder on a near-straight arm
 *       (elbow ≈ 172°), still snapping upward.
 * All three signature conditions co-occur within RELEASE.windowSec at f2.
 */
function snapFrames(t0: number, side: 'left' | 'right' = 'right'): PoseFrame[] {
  const S = `${side}_shoulder` as PoseKeypointName;
  const E = `${side}_elbow` as PoseKeypointName;
  const W = `${side}_wrist` as PoseKeypointName;
  return [
    pose(t0, { [S]: [300, 300], [E]: [300, 340], [W]: [340, 340] }),
    pose(t0 + 1 / FPS, { [S]: [300, 300], [E]: [305, 325], [W]: [330, 300] }),
    pose(t0 + 2 / FPS, { [S]: [300, 300], [E]: [310, 280], [W]: [320, 250] }),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReleaseDetector', () => {
  test('emits exactly once on a clean release snap, with the wrist as payload', () => {
    const det = newDet();
    const [f0, f1, f2] = snapFrames(0);
    expect(det.push(f0)).toBeNull();
    expect(det.push(f1)).toBeNull();
    const ev = det.push(f2);
    expect(ev).not.toBeNull();
    expect(ev!.t).toBeCloseTo(2 / FPS, 6);
    // Payload = the shooting wrist at the completing frame (the ball's
    // launch locus — what the tracker seeds its reacquisition around).
    expect(ev!.wristX).toBe(320);
    expect(ev!.wristY).toBe(250);
    // Follow-through drift does not re-emit (debounce holds).
    const f3 = pose(3 / FPS, {
      right_shoulder: [300, 300],
      right_elbow: [312, 272],
      right_wrist: [322, 242],
    });
    expect(det.push(f3)).toBeNull();
  });

  test('handedness: a right-side snap never fires a left-configured detector', () => {
    const det = newDet('left');
    for (const f of snapFrames(0, 'right')) expect(det.push(f)).toBeNull();
    // The mirrored left-side snap fires the same detector.
    const det2 = newDet('left');
    const frames = snapFrames(1.0, 'left');
    expect(det2.push(frames[0])).toBeNull();
    expect(det2.push(frames[1])).toBeNull();
    expect(det2.push(frames[2])).not.toBeNull();
  });

  test('no emit on a dribble: fast wrist, straight arm, but never above the shoulder', () => {
    // Dribbling: the arm hangs nearly straight (elbow ~160°) and the wrist
    // pumps up/down at speeds well past the vy floor — the above-shoulder
    // condition is the discriminator and must hold the line alone.
    const det = newDet();
    for (let i = 0; i < 30; i++) {
      const t = i / FPS;
      const wristY = i % 2 === 0 ? 420 : 460; // ±1200 px/s, both directions
      const ev = det.push(
        pose(t, {
          right_shoulder: [300, 300],
          right_elbow: [300, 360],
          right_wrist: [320, wristY],
        }),
      );
      expect(ev).toBeNull();
    }
  });

  test('no emit on a slow arm raise (calling for a pass): no velocity spike', () => {
    // Wrist ends high on a straight arm — two of three conditions — but the
    // 100 px/s rise sits far under the 192 px/s snap floor for a 640 frame.
    const det = newDet();
    for (let i = 0; i <= 45; i++) {
      const t = i / FPS;
      const wristY = 400 - 100 * t; // reaches 250 (< shoulder 300) at t=1.5
      const ev = det.push(
        pose(t, {
          right_shoulder: [300, 300],
          right_elbow: [310, (300 + wristY) / 2],
          right_wrist: [320, wristY],
        }),
      );
      expect(ev).toBeNull();
    }
  });

  test('debounce: a second snap within debounceSec is swallowed, a later one fires', () => {
    const det = newDet();
    const first = snapFrames(0);
    det.push(first[0]);
    det.push(first[1]);
    expect(det.push(first[2])).not.toBeNull(); // emits at t ≈ 0.067

    // Full second snap 0.5 s later: signature completes again but sits
    // inside RELEASE.debounceSec of the first emit.
    for (const f of snapFrames(0.5)) expect(det.push(f)).toBeNull();

    // Third snap past the debounce window fires normally.
    const third = snapFrames(0.067 + RELEASE.debounceSec + 0.2);
    det.push(third[0]);
    det.push(third[1]);
    expect(det.push(third[2])).not.toBeNull();
  });

  test('missing / low-score keypoints are handled gracefully (no crash, no emit)', () => {
    // No keypoints at all.
    const det = newDet();
    expect(det.push(pose(0, {}))).toBeNull();

    // Shoulder present but below the score gate on every frame: the
    // above-shoulder and elbow conditions can never refresh.
    const det2 = newDet();
    for (const f of snapFrames(0)) {
      const sh = f.keypoints.right_shoulder!;
      f.keypoints.right_shoulder = { x: sh.x, y: sh.y, score: 0.1 };
      expect(det2.push(f)).toBeNull();
    }

    // Wrist dropout mid-snap: a long gap makes Δy/Δt meaningless, so the
    // reappearing high wrist must NOT count as a velocity spike.
    const det3 = newDet();
    det3.push(snapFrames(0)[0]);
    // 0.3 s with no wrist (elbow/shoulder still tracked).
    for (let i = 1; i <= 9; i++) {
      det3.push(
        pose(i / FPS, { right_shoulder: [300, 300], right_elbow: [305, 325] }),
      );
    }
    const late = pose(10 / FPS, {
      right_shoulder: [300, 300],
      right_elbow: [310, 280],
      right_wrist: [320, 250],
    });
    expect(det3.push(late)).toBeNull();
  });
});
