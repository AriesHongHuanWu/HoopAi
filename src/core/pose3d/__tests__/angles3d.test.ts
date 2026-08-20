import type { DecodedFrame } from '../../formSequence';
import {
  forearmTiltDeg,
  frameAngles,
  jointAngleDeg,
  releaseFrameIndex,
  releaseReadouts,
} from '../angles3d';
import type { Frame3D, Joint3D, LiftedSequence } from '../lift';

function j(x: number, y: number, z: number, c = 1): Joint3D {
  return { x, y, z, c };
}

/** Raw 2D frame with just the named wrist at the given height. */
function wristFrame(name: 'left_wrist' | 'right_wrist', y: number): DecodedFrame {
  return { [name]: { x: 0, y } };
}

describe('jointAngleDeg', () => {
  test('perpendicular rays read 90 degrees with full confidence', () => {
    const r = jointAngleDeg(j(1, 0, 0), j(0, 0, 0), j(0, 1, 0));
    expect(r).not.toBeNull();
    expect(r!.deg).toBeCloseTo(90, 9);
    expect(r!.c).toBe(1);
  });

  test('collinear a-b-c reads 180 degrees', () => {
    const r = jointAngleDeg(j(-1, 0, 0), j(0, 0, 0), j(2, 0, 0));
    expect(r).not.toBeNull();
    expect(r!.deg).toBeCloseTo(180, 9);
  });

  test('uses full 3D (z participates in the angle)', () => {
    // Rays along +x and +z are perpendicular even though 2D-projected
    // (x,y only) they would look collinear-ish.
    const r = jointAngleDeg(j(1, 0, 0), j(0, 0, 0), j(0, 0, 1));
    expect(r!.deg).toBeCloseTo(90, 9);
  });

  test('reading confidence is the minimum of the three joints', () => {
    const r = jointAngleDeg(j(1, 0, 0, 0.9), j(0, 0, 0, 0.5), j(0, 1, 0, 0.7));
    expect(r!.c).toBe(0.5);
  });

  test('any missing joint yields null', () => {
    const a = j(1, 0, 0);
    const b = j(0, 0, 0);
    const c = j(0, 1, 0);
    expect(jointAngleDeg(undefined, b, c)).toBeNull();
    expect(jointAngleDeg(a, undefined, c)).toBeNull();
    expect(jointAngleDeg(a, b, undefined)).toBeNull();
  });

  test('zero-length ray yields null', () => {
    expect(jointAngleDeg(j(0, 0, 0), j(0, 0, 0), j(0, 1, 0))).toBeNull();
    expect(jointAngleDeg(j(1, 0, 0), j(0, 0, 0), j(0, 0, 0))).toBeNull();
  });
});

describe('forearmTiltDeg', () => {
  test('wrist directly above elbow reads 0 degrees (+y is DOWN)', () => {
    const frame: Frame3D = {
      right_elbow: j(0.1, -0.2, 0, 0.9),
      right_wrist: j(0.1, -0.2 - 0.146, 0, 0.8),
    };
    const r = forearmTiltDeg(frame, 'right');
    expect(r).not.toBeNull();
    expect(r!.deg).toBeCloseTo(0, 9);
    expect(r!.c).toBeCloseTo(0.8, 9);
  });

  test('horizontal forearm reads 90 degrees', () => {
    const frame: Frame3D = {
      right_elbow: j(0, -0.3, 0),
      right_wrist: j(0.146, -0.3, 0),
    };
    expect(forearmTiltDeg(frame, 'right')!.deg).toBeCloseTo(90, 9);
  });

  test('left hand uses the left-side joints', () => {
    const frame: Frame3D = {
      left_elbow: j(0, -0.3, 0),
      left_wrist: j(0, -0.45, 0),
      // Right side present but horizontal — must be ignored for hand 'left'.
      right_elbow: j(0, -0.3, 0),
      right_wrist: j(0.2, -0.3, 0),
    };
    expect(forearmTiltDeg(frame, 'left')!.deg).toBeCloseTo(0, 9);
  });

  test('missing wrist or elbow yields null; zero-length segment yields null', () => {
    expect(forearmTiltDeg({ right_elbow: j(0, 0, 0) }, 'right')).toBeNull();
    expect(forearmTiltDeg({ right_wrist: j(0, 0, 0) }, 'right')).toBeNull();
    expect(
      forearmTiltDeg({ right_elbow: j(0, -0.3, 0), right_wrist: j(0, -0.3, 0) }, 'right')
    ).toBeNull();
  });
});

describe('releaseFrameIndex', () => {
  test('returns index of minimum wrist y (highest point)', () => {
    const ys = [-0.1, -0.2, -0.25, -0.3, -0.35, -0.42, -0.4, -0.3];
    const frames = ys.map((y) => wristFrame('right_wrist', y));
    expect(releaseFrameIndex(frames, 'right')).toBe(5);
  });

  test('ties resolve to the earliest index', () => {
    const ys = [-0.1, -0.2, -0.3, -0.42, -0.4, -0.42, -0.3, -0.2];
    const frames = ys.map((y) => wristFrame('right_wrist', y));
    expect(releaseFrameIndex(frames, 'right')).toBe(3);
  });

  test('wrist absent everywhere falls back to round(0.75 * (n - 1))', () => {
    const frames: DecodedFrame[] = Array.from({ length: 8 }, () => ({}));
    expect(releaseFrameIndex(frames, 'right')).toBe(5);
  });

  test('empty input returns 0', () => {
    expect(releaseFrameIndex([], 'right')).toBe(0);
  });

  test("hand 'left' tracks the left wrist", () => {
    const frames: DecodedFrame[] = [
      { left_wrist: { x: 0, y: -0.1 }, right_wrist: { x: 0, y: -0.5 } },
      { left_wrist: { x: 0, y: -0.4 }, right_wrist: { x: 0, y: -0.2 } },
      { left_wrist: { x: 0, y: -0.45 }, right_wrist: { x: 0, y: -0.1 } },
      { left_wrist: { x: 0, y: -0.2 }, right_wrist: { x: 0, y: -0.1 } },
    ];
    expect(releaseFrameIndex(frames, 'left')).toBe(2);
    expect(releaseFrameIndex(frames, 'right')).toBe(0);
  });
});

describe('releaseReadouts', () => {
  // Frame 1 is the release frame (wrist highest there in raw 2D).
  const releasePose: Frame3D = {
    right_shoulder: j(0.13, -0.4, 0.05, 0.9),
    right_elbow: j(0.2, -0.55, 0.1, 0.85),
    right_wrist: j(0.18, -0.7, 0.12, 0.8),
    right_hip: j(0.1, 0, 0, 0.95),
    right_knee: j(0.12, 0.24, 0.06, 0.9),
    right_ankle: j(0.11, 0.49, 0.02, 0.85),
  };
  const setupPose: Frame3D = {
    right_shoulder: j(0.13, -0.38, 0, 0.9),
    right_elbow: j(0.22, -0.3, 0, 0.85),
    right_wrist: j(0.2, -0.42, 0, 0.8),
  };
  const lifted: LiftedSequence = {
    frames: [setupPose, releasePose],
    confidence: 0.85,
    azimuthDeg: 12,
  };
  const raw2d: DecodedFrame[] = [
    wristFrame('right_wrist', -0.42),
    wristFrame('right_wrist', -0.7),
  ];

  test('picks the 2D release frame and matches direct angle calls', () => {
    const rr = releaseReadouts(lifted, raw2d, 'right');
    expect(rr.frame).toBe(1);
    expect(rr.elbow).toEqual(
      jointAngleDeg(
        releasePose.right_shoulder,
        releasePose.right_elbow,
        releasePose.right_wrist
      )
    );
    expect(rr.knee).toEqual(
      jointAngleDeg(releasePose.right_hip, releasePose.right_knee, releasePose.right_ankle)
    );
    expect(rr.forearmTilt).toEqual(forearmTiltDeg(releasePose, 'right'));
    expect(rr.elbow).not.toBeNull();
    expect(rr.knee).not.toBeNull();
    expect(rr.forearmTilt).not.toBeNull();
  });

  test('missing ankle nulls the knee while the elbow still reads', () => {
    const { right_ankle: _omit, ...noAnkle } = releasePose;
    const seq: LiftedSequence = {
      frames: [setupPose, noAnkle],
      confidence: 0.8,
      azimuthDeg: 12,
    };
    const rr = releaseReadouts(seq, raw2d, 'right');
    expect(rr.frame).toBe(1);
    expect(rr.knee).toBeNull();
    expect(rr.elbow).not.toBeNull();
  });

  test('release index from raw 2D is clamped into the lifted sequence', () => {
    const longRaw: DecodedFrame[] = [
      wristFrame('right_wrist', -0.1),
      wristFrame('right_wrist', -0.2),
      wristFrame('right_wrist', -0.3),
      wristFrame('right_wrist', -0.8),
    ];
    const rr = releaseReadouts(lifted, longRaw, 'right');
    expect(rr.frame).toBe(1);
  });

  test('is deterministic across repeated calls', () => {
    const first = releaseReadouts(lifted, raw2d, 'right');
    const second = releaseReadouts(lifted, raw2d, 'right');
    expect(second).toEqual(first);
  });
});

describe('frameAngles', () => {
  test('reads shooting-side elbow and knee on one frame', () => {
    const frame: Frame3D = {
      left_shoulder: j(0, -0.4, 0, 0.9),
      left_elbow: j(0, -0.2, 0, 0.8),
      left_wrist: j(0.2, -0.2, 0, 0.7),
      left_hip: j(0, 0, 0, 0.9),
      left_knee: j(0, 0.25, 0, 0.85),
      left_ankle: j(0, 0.5, 0, 0.8),
    };
    const { elbow, knee } = frameAngles(frame, 'left');
    expect(elbow!.deg).toBeCloseTo(90, 9);
    expect(elbow!.c).toBeCloseTo(0.7, 9);
    expect(knee!.deg).toBeCloseTo(180, 9);
    expect(knee!.c).toBeCloseTo(0.8, 9);
  });

  test('missing joints yield nulls, never invented readings', () => {
    const { elbow, knee } = frameAngles({}, 'right');
    expect(elbow).toBeNull();
    expect(knee).toBeNull();
  });
});
