import { sequenceGroundY, wristTrail } from '../trail';
import type { Frame3D, Joint3D, LiftedSequence } from '../lift';

const joint = (x: number, y: number, z: number, c = 1): Joint3D => ({ x, y, z, c });

const seqOf = (frames: Frame3D[]): LiftedSequence => ({
  frames,
  confidence: 0.8,
  azimuthDeg: 12,
});

describe('wristTrail', () => {
  test('returns [] for an empty sequence or negative upToFrame', () => {
    expect(wristTrail(seqOf([]), 'right', 5)).toEqual([]);
    const seq = seqOf([{ right_wrist: joint(0.1, -0.4, 0, 0.9) }]);
    expect(wristTrail(seq, 'right', -1)).toEqual([]);
    expect(wristTrail(seq, 'right', -0.001)).toEqual([]);
  });

  test('skips frames where the wrist is missing — gaps stay gaps (honesty)', () => {
    const seq = seqOf([
      { right_wrist: joint(0.1, -0.4, 0.02, 0.9) },
      {}, // unliftable frame: wrist absent, must NOT be interpolated
      { right_wrist: joint(0.3, -0.6, 0.04, 0.7) },
    ]);
    const trail = wristTrail(seq, 'right', 2);
    expect(trail).toHaveLength(2);
    expect(trail[0]!.frame).toBe(0);
    expect(trail[1]!.frame).toBe(2);
    // The gap frame contributed nothing — no fabricated midpoint.
    expect(trail.some((p) => p.frame === 1)).toBe(false);
  });

  test('includes frames only up to upToFrame, flooring fractional values', () => {
    const seq = seqOf([
      { right_wrist: joint(0, -0.4, 0, 1) },
      { right_wrist: joint(0.1, -0.45, 0, 1) },
      { right_wrist: joint(0.2, -0.5, 0, 1) },
    ]);
    expect(wristTrail(seq, 'right', 0)).toHaveLength(1);
    expect(wristTrail(seq, 'right', 1.9)).toHaveLength(2); // floors to 1
    expect(wristTrail(seq, 'right', 2)).toHaveLength(3);
  });

  test('clamps upToFrame beyond the sequence length', () => {
    const seq = seqOf([
      { right_wrist: joint(0, -0.4, 0, 1) },
      { right_wrist: joint(0.1, -0.45, 0, 1) },
    ]);
    const trail = wristTrail(seq, 'right', 99);
    expect(trail).toHaveLength(2);
    expect(trail[1]!.frame).toBe(1);
  });

  test('passes coordinates and lift confidence through untouched', () => {
    const seq = seqOf([{ right_wrist: joint(0.12, -0.43, 0.056, 0.37) }]);
    const trail = wristTrail(seq, 'right', 0);
    expect(trail).toEqual([{ x: 0.12, y: -0.43, z: 0.056, c: 0.37, frame: 0 }]);
  });

  test('hand selects the wrist: left hand reads left_wrist only', () => {
    const seq = seqOf([
      {
        left_wrist: joint(-0.2, -0.4, 0.01, 0.8),
        right_wrist: joint(0.2, -0.4, 0.02, 0.9),
      },
      { right_wrist: joint(0.25, -0.5, 0.03, 0.9) }, // no left wrist here
    ]);
    const left = wristTrail(seq, 'left', 1);
    expect(left).toHaveLength(1);
    expect(left[0]!.x).toBe(-0.2);
    expect(left[0]!.c).toBe(0.8);
    const right = wristTrail(seq, 'right', 1);
    expect(right).toHaveLength(2);
    expect(right[0]!.x).toBe(0.2);
  });

  test('never mutates the sequence', () => {
    const frames: Frame3D[] = [
      { right_wrist: joint(0.1, -0.4, 0.02, 0.9) },
      { right_wrist: joint(0.2, -0.5, 0.03, 0.8) },
    ];
    const seq = seqOf(frames);
    const snapshot = JSON.parse(JSON.stringify(seq));
    wristTrail(seq, 'right', 1);
    expect(seq).toEqual(snapshot);
  });
});

describe('sequenceGroundY', () => {
  test('takes the max (lowest, +y is DOWN) ankle over the first 3 frames', () => {
    const seq = seqOf([
      { left_ankle: joint(-0.1, 0.44, 0, 1), right_ankle: joint(0.1, 0.46, 0, 1) },
      { right_ankle: joint(0.1, 0.48, 0, 1) },
      { left_ankle: joint(-0.1, 0.45, 0, 1) },
      // Frame 3 is outside the first-3 window and must be ignored.
      { left_ankle: joint(-0.1, 9, 0, 1) },
    ]);
    expect(sequenceGroundY(seq)).toBe(0.48);
  });

  test('works with fewer than 3 frames', () => {
    const seq = seqOf([{ right_ankle: joint(0.1, 0.47, 0, 1) }]);
    expect(sequenceGroundY(seq)).toBe(0.47);
  });

  test('falls back to 0.5 when no ankle exists in the first frames', () => {
    expect(sequenceGroundY(seqOf([]))).toBe(0.5);
    const noAnkles = seqOf([
      { right_wrist: joint(0.1, -0.4, 0, 1) },
      {},
      { nose: joint(0, -0.8, 0, 1) },
      // An ankle at frame 3 does not rescue the window — rule reads frames 0-2.
      { left_ankle: joint(-0.1, 0.5, 0, 1) },
    ]);
    expect(sequenceGroundY(noAnkles)).toBe(0.5);
  });
});
