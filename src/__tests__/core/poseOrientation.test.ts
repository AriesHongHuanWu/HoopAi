/**
 * Pose orientation core — the detector that decides whether the pose buffer
 * arrived 180°-rotated, and the correction applied at the parse boundary.
 *
 * What these tests pin, and why:
 *  - An upright standing skeleton reads 'upright'; the SAME skeleton put
 *    through a 180° buffer rotation reads 'flipped'. Those two cases are the
 *    whole product requirement.
 *  - Every abstain gate: a crouch, a mid-jump, a missing nose, a low-score
 *    nose, missing ankles, a missing torso, and a marginal head-to-ankle
 *    separation must all yield 'unknown'. A wrong verdict flips every metric
 *    in a session, so refusing has to be cheaper than guessing.
 *  - Agreement is required across consecutive qualifying frames, the verdict
 *    LATCHES once committed, and reset() clears it. Agreement is counted in
 *    QUALIFYING FRAMES, not seconds, and a manual override reports no run at
 *    all — it invents neither a count nor a pending vote.
 *  - The correction is a 180° rotation (BOTH axes) that leaves body-side
 *    labels alone, round-trips exactly, and is a no-op BY REFERENCE for
 *    'upright' / 'unknown' so callers can detect it did nothing.
 *
 * Fixture coordinates are integers in a 192 analysis square, so `192 - x` is
 * exact in binary floating point and the round-trip can be asserted with
 * toBe rather than toBeCloseTo. One test deliberately uses a non-dyadic
 * coordinate to state what the float reality actually is.
 */
import { SEQ_KEYPOINT_ORDER } from '@/core/formSequence';
import {
  correctPoseFrame,
  ORIENTATION_AGREE_FRAMES,
  ORIENTATION_MAX_DT_SEC,
  ORIENTATION_SEPARATION_MIN_FRAC,
  ORIENTATION_SPAN_TORSO_MIN,
  ORIENTATION_STILL_MAX_SPANS_PER_SEC,
  ORIENTATION_VOTE_STALE_SEC,
  PoseOrientationDetector,
} from '@/core/poseOrientation';
import type { PoseFrame, PoseKeypointName } from '@/core/types';

/** Analysis square (MoveNet input side) — the space every keypoint lives in. */
const FRAME = 192;
const DT = 1 / 30;

type Layout = Partial<Record<PoseKeypointName, readonly [number, number]>>;

interface FrameOpts {
  /** Uniform y offset applied to every landmark (a body that moved). */
  dy?: number;
  /** Per-keypoint score overrides (default 0.9, above FORM.keypointScoreMin). */
  scores?: Partial<Record<PoseKeypointName, number>>;
  /** Landmarks to leave out of the frame entirely. */
  drop?: readonly PoseKeypointName[];
}

function frameOf(layout: Layout, t: number, opts: FrameOpts = {}): PoseFrame {
  const { dy = 0, scores = {}, drop = [] } = opts;
  const keypoints: PoseFrame['keypoints'] = {};
  for (const [name, xy] of Object.entries(layout) as [
    PoseKeypointName,
    readonly [number, number],
  ][]) {
    if (drop.includes(name)) continue;
    keypoints[name] = { x: xy[0], y: xy[1] + dy, score: scores[name] ?? 0.9 };
  }
  return { t, keypoints };
}

/**
 * THE BUG, applied to a fixture: a 180° buffer rotation reports a point that
 * truly sits at (x, y) as (W − x, H − y). The fix is the same map (it is its
 * own inverse), which is exactly why the round-trip test can exist.
 */
function rotate180(pose: PoseFrame): PoseFrame {
  const keypoints: PoseFrame['keypoints'] = {};
  for (const name of SEQ_KEYPOINT_ORDER) {
    const kp = pose.keypoints[name];
    if (kp == null) continue;
    keypoints[name] = { x: FRAME - kp.x, y: FRAME - kp.y, score: kp.score };
  }
  return { t: pose.t, keypoints };
}

/**
 * Upright, side-on standing shooter in the 192 square. nose→ankle span 144
 * px over a 48 px torso (3.0 torsos, well past ORIENTATION_SPAN_TORSO_MIN)
 * and 0.97 of the 148 px vertical extent (past
 * ORIENTATION_SEPARATION_MIN_FRAC).
 */
const STANDING: Layout = {
  nose: [100, 20],
  left_eye: [102, 16],
  right_eye: [98, 16],
  left_ear: [96, 18],
  right_ear: [94, 18],
  left_shoulder: [96, 44],
  right_shoulder: [92, 44],
  left_elbow: [94, 70],
  right_elbow: [90, 70],
  left_wrist: [92, 96],
  right_wrist: [88, 96],
  left_hip: [96, 92],
  right_hip: [92, 92],
  left_knee: [96, 128],
  right_knee: [92, 128],
  left_ankle: [98, 164],
  right_ankle: [94, 164],
};

/**
 * Deep crouch: the trunk leans forward so the nose→ankle span folds to 96 px
 * while the torso keeps its real 48 px length — 2.0 torsos, under the
 * standing threshold, so the frame must abstain.
 */
const CROUCH: Layout = {
  nose: [124, 68],
  left_eye: [126, 64],
  right_eye: [122, 64],
  left_ear: [120, 66],
  right_ear: [118, 66],
  left_shoulder: [116, 84],
  right_shoulder: [112, 84],
  left_elbow: [118, 104],
  right_elbow: [114, 104],
  left_wrist: [120, 116],
  right_wrist: [116, 116],
  left_hip: [84, 120],
  right_hip: [80, 120],
  left_knee: [112, 140],
  right_knee: [108, 140],
  left_ankle: [86, 164],
  right_ankle: [82, 164],
};

/**
 * Mid shooting motion: the shooting wrist is up past the head, so the
 * nose→ankle span is only 0.77 of the body's vertical extent — extended
 * enough to pass the standing gate, too ambiguous to vote.
 */
const REACH: Layout = {
  nose: [100, 40],
  left_eye: [102, 36],
  right_eye: [98, 36],
  left_ear: [96, 38],
  right_ear: [94, 38],
  left_shoulder: [96, 60],
  right_shoulder: [92, 60],
  left_elbow: [94, 42],
  right_elbow: [90, 44],
  left_wrist: [92, 8],
  right_wrist: [88, 12],
  left_hip: [96, 104],
  right_hip: [92, 104],
  left_knee: [96, 128],
  right_knee: [92, 128],
  left_ankle: [98, 150],
  right_ankle: [94, 150],
};

/** Push n frames built by `make`, returning the last verdict. */
function feed(
  det: PoseOrientationDetector,
  n: number,
  make: (i: number) => PoseFrame,
): void {
  for (let i = 0; i < n; i++) det.push(make(i));
}

/** A still standing shooter: the same layout at the camera rate. */
function still(layout: Layout, i: number, t0 = 0): PoseFrame {
  return frameOf(layout, t0 + i * DT);
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

describe('PoseOrientationDetector — verdict', () => {
  it('reads an upright standing skeleton as upright', () => {
    const det = new PoseOrientationDetector();
    feed(det, 12, (i) => still(STANDING, i));
    expect(det.verdict).toBe('upright');
    expect(det.committed).toBe(true);
    expect(det.state().source).toBe('auto');
  });

  it('reads the same skeleton, 180°-rotated, as flipped', () => {
    const det = new PoseOrientationDetector();
    feed(det, 12, (i) => rotate180(still(STANDING, i)));
    expect(det.verdict).toBe('flipped');
    expect(det.state().source).toBe('auto');
  });

  it('needs ORIENTATION_AGREE_FRAMES qualifying frames before committing', () => {
    const det = new PoseOrientationDetector();
    // The FIRST frame has no previous frame to verify stillness against, so
    // it abstains: n pushes yield n-1 qualifying frames.
    feed(det, ORIENTATION_AGREE_FRAMES, (i) => still(STANDING, i));
    expect(det.verdict).toBe('unknown');
    expect(det.state().qualified).toBe(ORIENTATION_AGREE_FRAMES - 1);
    expect(det.state().pending).toBe('upright');

    det.push(still(STANDING, ORIENTATION_AGREE_FRAMES));
    expect(det.verdict).toBe('upright');
    expect(det.state().qualified).toBe(ORIENTATION_AGREE_FRAMES);
  });

  it('never commits from a single frame', () => {
    const det = new PoseOrientationDetector();
    expect(det.push(still(STANDING, 0))).toBe('unknown');
    expect(det.state().lastAbstain).toBe('noBaseline');
  });

  it('tolerates keypoint jitter without calling it motion', () => {
    const det = new PoseOrientationDetector();
    // 1 px of body-wide jitter per frame at 30 fps is 0.21 spans/s, under
    // ORIENTATION_STILL_MAX_SPANS_PER_SEC — a still shooter must still vote.
    expect(ORIENTATION_STILL_MAX_SPANS_PER_SEC).toBeGreaterThan(30 / 144);
    feed(det, 12, (i) => frameOf(STANDING, i * DT, { dy: i % 2 }));
    expect(det.verdict).toBe('upright');
  });
});

// ---------------------------------------------------------------------------
// The gates — every one of these must abstain
// ---------------------------------------------------------------------------

describe('PoseOrientationDetector — abstains', () => {
  it('abstains on a crouch (body not extended)', () => {
    const det = new PoseOrientationDetector();
    feed(det, 12, (i) => still(CROUCH, i));
    expect(det.verdict).toBe('unknown');
    expect(det.state().lastAbstain).toBe('notExtended');
    expect(det.state().qualified).toBe(0);
    // The fixture is a genuine crouch, not a borderline one.
    expect(96 / Math.hypot(32, 36)).toBeLessThan(ORIENTATION_SPAN_TORSO_MIN);
  });

  it('abstains mid-motion (a jump / a step)', () => {
    const det = new PoseOrientationDetector();
    // 8 px per frame at 30 fps is 1.67 spans/s once the filter converges —
    // a real translation of the body, not landmark noise.
    feed(det, 10, (i) => frameOf(STANDING, i * DT, { dy: -8 * i }));
    expect(det.verdict).toBe('unknown');
    expect(det.state().lastAbstain).toBe('moving');
    expect(det.state().qualified).toBeLessThan(ORIENTATION_AGREE_FRAMES);
  });

  it('abstains on a marginal head-to-ankle separation', () => {
    const det = new PoseOrientationDetector();
    feed(det, 12, (i) => still(REACH, i));
    expect(det.verdict).toBe('unknown');
    expect(det.state().lastAbstain).toBe('lowSeparation');
    // 110 px of span inside a 142 px extent — under the required fraction.
    expect(110 / 142).toBeLessThan(ORIENTATION_SEPARATION_MIN_FRAC);
  });

  it('abstains without a nose', () => {
    const det = new PoseOrientationDetector();
    feed(det, 12, (i) => frameOf(STANDING, i * DT, { drop: ['nose'] }));
    expect(det.verdict).toBe('unknown');
    expect(det.state().lastAbstain).toBe('noHead');
  });

  it('abstains on a nose below the keypoint score gate', () => {
    const det = new PoseOrientationDetector();
    feed(det, 12, (i) =>
      frameOf(STANDING, i * DT, { scores: { nose: 0.2 } }),
    );
    expect(det.verdict).toBe('unknown');
    expect(det.state().lastAbstain).toBe('noHead');
  });

  it('abstains without either ankle', () => {
    const det = new PoseOrientationDetector();
    feed(det, 12, (i) =>
      frameOf(STANDING, i * DT, { drop: ['left_ankle', 'right_ankle'] }),
    );
    expect(det.verdict).toBe('unknown');
    expect(det.state().lastAbstain).toBe('noAnkle');
  });

  it('abstains without a torso to scale by', () => {
    const det = new PoseOrientationDetector();
    feed(det, 12, (i) =>
      frameOf(STANDING, i * DT, { drop: ['left_hip', 'right_hip'] }),
    );
    expect(det.verdict).toBe('unknown');
    expect(det.state().lastAbstain).toBe('noTorso');
  });

  it('abstains when the previous frame is too old to verify stillness', () => {
    const det = new PoseOrientationDetector();
    det.push(still(STANDING, 0));
    det.push(frameOf(STANDING, ORIENTATION_MAX_DT_SEC * 2));
    expect(det.verdict).toBe('unknown');
    expect(det.state().lastAbstain).toBe('noBaseline');
  });
});

// ---------------------------------------------------------------------------
// Agreement, the latch, and reset
// ---------------------------------------------------------------------------

describe('PoseOrientationDetector — agreement and latch', () => {
  it('does not let one noisy frame commit or grow the run', () => {
    const det = new PoseOrientationDetector();
    feed(det, ORIENTATION_AGREE_FRAMES - 1, (i) => still(STANDING, i));
    const before = det.state().agreeing;
    expect(before).toBe(ORIENTATION_AGREE_FRAMES - 2);

    // A single frame reporting the body at the other end of the square is a
    // teleport: it is rejected as motion, so it neither votes nor commits.
    det.push(rotate180(still(STANDING, ORIENTATION_AGREE_FRAMES - 1)));
    expect(det.verdict).toBe('unknown');
    expect(det.state().lastAbstain).toBe('moving');
    expect(det.state().agreeing).toBe(before);
  });

  it('restarts the run after a stale gap between qualifying frames', () => {
    const det = new PoseOrientationDetector();
    feed(det, 4, (i) => still(STANDING, i));
    expect(det.state().agreeing).toBe(3);

    // Same shooter, same orientation, but a second of unobserved time: that
    // is two observations, not one run.
    const t0 = 3 * DT + ORIENTATION_VOTE_STALE_SEC + 1;
    feed(det, ORIENTATION_AGREE_FRAMES, (i) => still(STANDING, i, t0));
    expect(det.verdict).toBe('unknown');
    expect(det.state().agreeing).toBe(ORIENTATION_AGREE_FRAMES - 1);

    det.push(still(STANDING, ORIENTATION_AGREE_FRAMES, t0));
    expect(det.verdict).toBe('upright');
  });

  it('restarts the run at 1 when a qualifying frame disagrees', () => {
    const det = new PoseOrientationDetector();
    feed(det, 4, (i) => still(STANDING, i));
    expect(det.state().pending).toBe('upright');

    // The gap is what lets the opposite reading qualify at all — without it
    // the jump between the two poses is rejected as motion first.
    const t0 = 3 * DT + ORIENTATION_VOTE_STALE_SEC + 1;
    det.push(rotate180(still(STANDING, 0, t0)));
    det.push(rotate180(still(STANDING, 1, t0)));
    expect(det.state().pending).toBe('flipped');
    expect(det.state().agreeing).toBe(1);
    expect(det.verdict).toBe('unknown');
  });

  it('latches the verdict and stops re-evaluating', () => {
    const det = new PoseOrientationDetector();
    feed(det, 12, (i) => still(STANDING, i));
    expect(det.verdict).toBe('upright');
    const frozen = det.state().frames;

    // A whole session of the opposite reading must not flip a committed
    // verdict: half a capture analysed one way up and half the other is
    // worse than either answer.
    feed(det, 60, (i) => rotate180(still(STANDING, i, 10)));
    expect(det.verdict).toBe('upright');
    expect(det.state().frames).toBe(frozen);
  });

  it('reset clears the latch and lets a new verdict form', () => {
    const det = new PoseOrientationDetector();
    feed(det, 12, (i) => still(STANDING, i));
    expect(det.verdict).toBe('upright');

    det.reset();
    expect(det.verdict).toBe('unknown');
    expect(det.committed).toBe(false);
    expect(det.state()).toMatchObject({
      source: null,
      pending: null,
      agreeing: 0,
      frames: 0,
      qualified: 0,
      lastAbstain: null,
    });

    feed(det, 12, (i) => rotate180(still(STANDING, i, 30)));
    expect(det.verdict).toBe('flipped');
  });

  it('accepts a human override and records it as manual', () => {
    const det = new PoseOrientationDetector();
    det.override('flipped');
    expect(det.verdict).toBe('flipped');
    expect(det.state().source).toBe('manual');
    // The override latches like any other verdict.
    feed(det, 12, (i) => still(STANDING, i));
    expect(det.verdict).toBe('flipped');
    // Overriding back to 'unknown' is a reset, not a third verdict.
    det.override('unknown');
    expect(det.verdict).toBe('unknown');
    expect(det.state().source).toBeNull();
  });

  it('an override reports NO agreement run, because none happened', () => {
    // `agreeing` and `pending` are published diagnostics. Filling them in for
    // a verdict no frame voted on would be an invented count in a module
    // whose contract is that it invents nothing; `source: 'manual'` is what
    // carries the truth, and the latch reads neither field.
    const det = new PoseOrientationDetector();
    det.override('flipped');
    expect(det.state()).toMatchObject({
      verdict: 'flipped',
      source: 'manual',
      pending: null,
      agreeing: 0,
      qualified: 0,
    });

    // Still latched: a whole session of the opposite reading changes nothing,
    // and the counts stay honestly at zero.
    feed(det, 12, (i) => still(STANDING, i));
    expect(det.verdict).toBe('flipped');
    expect(det.state().agreeing).toBe(0);
  });

  it('counts QUALIFYING frames, not elapsed time', () => {
    // ORIENTATION_AGREE_FRAMES is a frame count. Abstains never break a run
    // (a keypoint dropout must not cost the shooter their verdict), so the
    // same 8 frames can be stitched across seconds — which is why the
    // constant's doc no longer claims a duration.
    const det = new PoseOrientationDetector();
    const GAP = ORIENTATION_VOTE_STALE_SEC * 0.9;
    for (let i = 0; i < ORIENTATION_AGREE_FRAMES; i++) {
      // A PAIR per observation: the first frame re-establishes the stillness
      // baseline (the previous one is far older than ORIENTATION_MAX_DT_SEC,
      // so it abstains 'noBaseline'), the second votes against it.
      det.push(frameOf(STANDING, i * GAP));
      det.push(frameOf(STANDING, i * GAP + DT));
    }
    expect(det.verdict).toBe('upright');
    expect(det.state().qualified).toBe(ORIENTATION_AGREE_FRAMES);
    // The committing run spanned over six seconds, not the ≈0.53 s that
    // 8 contiguous frames at the fps floor would take.
    expect((ORIENTATION_AGREE_FRAMES - 1) * GAP).toBeGreaterThan(6);
  });
});

// ---------------------------------------------------------------------------
// The correction
// ---------------------------------------------------------------------------

describe('correctPoseFrame', () => {
  const size = { width: FRAME, height: FRAME };

  it('is a no-op BY REFERENCE for upright and unknown', () => {
    const f = still(STANDING, 0);
    expect(correctPoseFrame(f, 'upright', size)).toBe(f);
    expect(correctPoseFrame(f, 'unknown', size)).toBe(f);
  });

  it('leaves the frame alone when the size cannot define a rotation', () => {
    const f = still(STANDING, 0);
    expect(correctPoseFrame(f, 'flipped', { width: 0, height: FRAME })).toBe(f);
    expect(correctPoseFrame(f, 'flipped', { width: FRAME, height: NaN })).toBe(f);
  });

  it('corrects BOTH axes — a flipped frame round-trips exactly', () => {
    const original = still(STANDING, 1.5);
    const bugged = rotate180(original);
    const fixed = correctPoseFrame(bugged, 'flipped', size);

    expect(fixed).not.toBe(bugged);
    expect(fixed.t).toBe(original.t);
    for (const name of SEQ_KEYPOINT_ORDER) {
      const a = original.keypoints[name];
      const b = fixed.keypoints[name];
      expect(b).toBeDefined();
      expect(b!.x).toBe(a!.x);
      expect(b!.y).toBe(a!.y);
      expect(b!.score).toBe(a!.score);
    }
  });

  it('is its own inverse on a non-dyadic coordinate too (to float precision)', () => {
    const f: PoseFrame = {
      t: 0.1,
      keypoints: { nose: { x: 100.1, y: 20.3, score: 0.9 } },
    };
    const back = correctPoseFrame(
      correctPoseFrame(f, 'flipped', size),
      'flipped',
      size,
    );
    expect(back.keypoints.nose!.x).toBeCloseTo(100.1, 10);
    expect(back.keypoints.nose!.y).toBeCloseTo(20.3, 10);
  });

  it('does NOT swap body-side labels', () => {
    // A 180° rotation preserves chirality, so MoveNet's anatomical left is
    // still the anatomical left. Renaming the sides here would corrupt the
    // shooting-hand logic — a worse bug than the flip itself.
    const original = still(STANDING, 0);
    const fixed = correctPoseFrame(rotate180(original), 'flipped', size);
    expect(fixed.keypoints.left_wrist!.x).toBe(
      original.keypoints.left_wrist!.x,
    );
    expect(fixed.keypoints.right_wrist!.x).toBe(
      original.keypoints.right_wrist!.x,
    );
    expect(fixed.keypoints.left_wrist!.x).not.toBe(
      original.keypoints.right_wrist!.x,
    );
  });

  it('does not mutate the frame it was given', () => {
    const bugged = rotate180(still(STANDING, 0));
    const noseBefore = { ...bugged.keypoints.nose! };
    correctPoseFrame(bugged, 'flipped', size);
    expect(bugged.keypoints.nose).toEqual(noseBefore);
  });

  it('drops nothing: every present landmark survives the correction', () => {
    const bugged = rotate180(still(STANDING, 0));
    const fixed = correctPoseFrame(bugged, 'flipped', size);
    expect(Object.keys(fixed.keypoints).sort()).toEqual(
      Object.keys(bugged.keypoints).sort(),
    );
  });

  it('corrected frames read as upright end to end', () => {
    // The whole point: a flipped session, corrected at the parse boundary,
    // presents the same anatomy an unflipped session does.
    const det = new PoseOrientationDetector();
    feed(det, 12, (i) => rotate180(still(STANDING, i)));
    expect(det.verdict).toBe('flipped');

    const after = new PoseOrientationDetector();
    feed(after, 12, (i) =>
      correctPoseFrame(rotate180(still(STANDING, i)), det.verdict, size),
    );
    expect(after.verdict).toBe('upright');
  });
});
