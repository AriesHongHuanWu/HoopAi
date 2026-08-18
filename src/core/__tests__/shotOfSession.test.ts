/**
 * shotOfSession contract tests.
 *
 * WHY these cases: the picker is the one place in the app that decides, with
 * no human in the loop, which rep gets a full coaching report. Two things can
 * go wrong and both are product failures rather than style bugs:
 *
 *  1. It picks a shot the analysis cannot actually read, and the report below
 *     it becomes confident noise. So the ORDER is pinned: pose analysability
 *     outranks flight completeness and call confidence COMBINED, and the two
 *     lesser terms are pinned as real tie-breakers (not decoration).
 *  2. It invents a pick when there is nothing to analyse. So every refusal
 *     path is pinned by the gap it must name — no shots, no makes, makes with
 *     no captured pose, makes whose pose capture is too thin.
 *
 * Sequences here are built as raw {@link FormSequence} blobs rather than via
 * the streaming buffer, so each test states exactly which keypoints existed in
 * which frames — the thing the picker actually measures.
 */
import {
  SEQ_KEYPOINT_ORDER,
  SEQ_MISSING,
  SEQ_TARGET_FRAMES,
} from '../formSequence';
import {
  MIN_USABLE_FRAMES,
  describeCandidate,
  pickShotOfSession,
  rankMadeShots,
  scoreCandidate,
} from '../shotOfSession';
import type {
  FormMetrics,
  FormSequence,
  PoseKeypointName,
  ResolvedShot,
  ShootingHand,
  ShotOutcome,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures

const ALL_KEYPOINTS = SEQ_KEYPOINT_ORDER;

/** Right shooting arm — the triple every arm cue needs at a phase. */
const RIGHT_ARM: PoseKeypointName[] = ['right_shoulder', 'right_elbow', 'right_wrist'];
const LEFT_ARM: PoseKeypointName[] = ['left_shoulder', 'left_elbow', 'left_wrist'];

/**
 * Seven keypoints that deliberately EXCLUDE both arms: enough coverage to pass
 * the coverage floor (7/17 ≈ 41%) while giving the cue engine no arm to read.
 */
const NO_ARM_KEYPOINTS: PoseKeypointName[] = [
  'nose',
  'left_eye',
  'right_eye',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
];

/** Pack explicit per-frame keypoint sets into a FormSequence blob. */
function sequenceOf(
  rows: readonly (readonly PoseKeypointName[])[],
  hand: ShootingHand = 'right',
): FormSequence {
  const data: number[] = [];
  for (const row of rows) {
    for (const name of ALL_KEYPOINTS) {
      if (row.includes(name)) data.push(1000, 2000);
      else data.push(SEQ_MISSING, SEQ_MISSING);
    }
  }
  return { v: 1, hand, frames: rows.length, durationSec: 1.2, data };
}

/** `n` frames that all carry the same keypoint set. */
function uniformSequence(
  n: number,
  keypoints: readonly PoseKeypointName[],
  hand: ShootingHand = 'right',
): FormSequence {
  return sequenceOf(Array.from({ length: n }, () => keypoints), hand);
}

/** A fully tracked capture: every frame, every keypoint. */
function perfectSequence(hand: ShootingHand = 'right'): FormSequence {
  return uniformSequence(SEQ_TARGET_FRAMES, ALL_KEYPOINTS, hand);
}

const NO_METRICS: FormMetrics = {
  setPointElbowDeg: null,
  kneeFlexionDeg: null,
  releaseAngleDeg: null,
  entryAngleDeg: null,
  releaseTimeMs: null,
  followThroughHeldMs: null,
  followThroughElbowDeg: null,
  releaseHeightNorm: null,
};

interface ShotOpts {
  outcome?: ShotOutcome;
  sequence?: FormSequence | null;
  releaseAngleDeg?: number | null;
  entryAngleDeg?: number | null;
  /** How many of geo/net/cls voted make. */
  agree?: 0 | 1 | 2 | 3;
  corrected?: boolean;
  holds?: ResolvedShot['holds'];
}

function shot(id: number, opts: ShotOpts = {}): ResolvedShot {
  const agree = opts.agree ?? 3;
  const sequence = opts.sequence === undefined ? perfectSequence() : opts.sequence;
  return {
    id,
    tStart: id,
    tResolved: id + 0.9,
    outcome: opts.outcome ?? 'make',
    signals: { geo: agree >= 1, net: agree >= 2, cls: agree >= 3 },
    rimBounce: false,
    xCross: null,
    // `?? 45` would resurrect an explicitly-null angle, which is exactly the
    // case the flight tie-break test needs to express.
    entryAngleDeg: opts.entryAngleDeg === undefined ? 45 : opts.entryAngleDeg,
    releaseAngleDeg: opts.releaseAngleDeg === undefined ? 52 : opts.releaseAngleDeg,
    releasePoint: null,
    originX: 0.5,
    originY: 0.8,
    trajectory: [],
    ...(opts.corrected != null ? { corrected: opts.corrected } : {}),
    ...(opts.holds != null ? { holds: opts.holds } : {}),
    ...(sequence != null
      ? { form: { metrics: NO_METRICS, tips: [], sequence } }
      : {}),
  };
}

/** Ids in ranked order, so ordering assertions read as the story they tell. */
function idsOf(shots: readonly ResolvedShot[]): number[] {
  return shots.map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Ranking

describe('pickShotOfSession — ranking', () => {
  it('ranks the richer pose capture first even when the thin one has better flight and call data', () => {
    // The thin shot is handed EVERY advantage the lesser terms can give:
    // both flight angles and a hand-confirmed make. It still loses, because
    // the sequence term outweighs flight + confidence combined.
    const rich = shot(1, {
      sequence: perfectSequence(),
      releaseAngleDeg: null,
      entryAngleDeg: null,
      agree: 1,
    });
    const thin = shot(2, {
      sequence: uniformSequence(8, [...RIGHT_ARM, 'left_hip', 'right_hip', 'nose']),
      corrected: true,
    });

    const { pick, ranked } = pickShotOfSession([thin, rich]);
    expect(pick).toBe(rich);
    expect(idsOf(ranked)).toEqual([1, 2]);
  });

  it('breaks a pose-quality tie on flight completeness', () => {
    const both = shot(7, { releaseAngleDeg: 51, entryAngleDeg: 44 });
    const neither = shot(3, { releaseAngleDeg: null, entryAngleDeg: null });

    const { pick, ranked } = pickShotOfSession([neither, both]);
    expect(pick).toBe(both);
    expect(idsOf(ranked)).toEqual([7, 3]);
  });

  it('breaks a pose-and-flight tie on how confidently the make was called', () => {
    const allThree = shot(9, { agree: 3 });
    const oneSignal = shot(2, { agree: 1 });

    const { ranked } = pickShotOfSession([oneSignal, allThree]);
    expect(idsOf(ranked)).toEqual([9, 2]);
  });

  it('treats a hand-corrected make as fully confident and docks demotion holds', () => {
    const corrected = scoreCandidate(shot(1, { agree: 0, corrected: true }));
    const clean = scoreCandidate(shot(2, { agree: 3 }));
    const held = scoreCandidate(shot(3, { agree: 3, holds: ['passThrough', 'rattleOut'] }));

    expect(corrected.callScore).toBe(1);
    expect(clean.callScore).toBe(1);
    expect(held.callScore).toBeCloseTo(0.8, 10);
  });

  it('is deterministic and breaks exact ties on ascending shot id', () => {
    const a = shot(5);
    const b = shot(2);
    const c = shot(9);

    const first = pickShotOfSession([c, a, b]);
    const second = pickShotOfSession([c, a, b]);

    expect(idsOf(first.ranked)).toEqual([2, 5, 9]);
    expect(first.pick).toBe(b);
    expect(idsOf(second.ranked)).toEqual(idsOf(first.ranked));
    expect(second.reason).toBe(first.reason);
  });

  it('caps `ranked` at maxRanked without changing the pick', () => {
    const shots = Array.from({ length: 6 }, (_, i) => shot(i + 1));
    const { pick, ranked } = pickShotOfSession(shots, { maxRanked: 2 });
    expect(pick!.id).toBe(1);
    expect(idsOf(ranked)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Makes only

describe('pickShotOfSession — makes only', () => {
  it('excludes misses and unsure shots from `ranked` even with perfect capture', () => {
    const miss = shot(1, { outcome: 'miss' });
    const unsure = shot(2, { outcome: 'unsure' });
    const make = shot(3);

    const { pick, ranked } = pickShotOfSession([miss, unsure, make]);
    expect(pick).toBe(make);
    expect(idsOf(ranked)).toEqual([3]);
    expect(rankMadeShots([miss, unsure, make]).map((c) => c.shot.id)).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// Honest refusals

describe('pickShotOfSession — refusals', () => {
  it('says there are no shots at all', () => {
    const { pick, ranked, reason } = pickShotOfSession([]);
    expect(pick).toBeNull();
    expect(ranked).toEqual([]);
    expect(reason).toBe('No shots logged in this session yet.');
  });

  it('says there is no made shot, and counts what there was instead', () => {
    const shots = [
      shot(1, { outcome: 'miss' }),
      shot(2, { outcome: 'miss' }),
      shot(3, { outcome: 'unsure' }),
    ];
    const { pick, ranked, reason } = pickShotOfSession(shots);
    expect(pick).toBeNull();
    expect(ranked).toEqual([]);
    expect(reason).toContain('No made shot to analyse');
    expect(reason).toContain('2 misses');
    expect(reason).toContain('1 unsure shot');
  });

  it('says the makes captured no pose sequence, and names the setting', () => {
    const shots = [shot(1, { sequence: null }), shot(2, { sequence: null })];
    const { pick, reason } = pickShotOfSession(shots);
    expect(pick).toBeNull();
    expect(reason).toContain('2 made shots');
    expect(reason).toContain('none captured a pose sequence');
    expect(reason).toContain('Shooting form analysis in Settings');
  });

  it('says the capture was too thin, with the numbers that made it too thin', () => {
    const shots = [shot(4, { sequence: uniformSequence(3, ALL_KEYPOINTS) })];
    const { pick, reason } = pickShotOfSession(shots);
    expect(pick).toBeNull();
    expect(reason).toContain('Shot 4 captured only 3 usable pose frames');
    expect(reason).toContain('too thin to analyse');
  });

  it('refuses a capture that never shows the shooting arm at any cue phase', () => {
    // Long enough and covered enough — but posturePlan would have no arm to
    // compare, so calling it analysable would be a lie.
    const shots = [shot(6, { sequence: uniformSequence(SEQ_TARGET_FRAMES, NO_ARM_KEYPOINTS) })];
    const candidate = scoreCandidate(shots[0]!);

    expect(candidate.coverage).toBeGreaterThan(0.3);
    expect(candidate.armPhases).toEqual([]);
    expect(candidate.usable).toBe(false);
    expect(pickShotOfSession(shots).pick).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Thresholds + measurement

describe('scoreCandidate — measurement', () => {
  it('accepts exactly MIN_USABLE_FRAMES and rejects one frame fewer', () => {
    const atFloor = scoreCandidate(shot(1, { sequence: uniformSequence(MIN_USABLE_FRAMES, ALL_KEYPOINTS) }));
    const belowFloor = scoreCandidate(shot(2, { sequence: uniformSequence(MIN_USABLE_FRAMES - 1, ALL_KEYPOINTS) }));

    expect(atFloor.usable).toBe(true);
    expect(belowFloor.usable).toBe(false);
  });

  it('does not count all-missing rows as usable frames', () => {
    const rows: PoseKeypointName[][] = [
      ...Array.from({ length: 4 }, () => [...ALL_KEYPOINTS]),
      ...Array.from({ length: 8 }, (): PoseKeypointName[] => []),
    ];
    const candidate = scoreCandidate(shot(1, { sequence: sequenceOf(rows) }));

    expect(candidate.totalFrames).toBe(12);
    expect(candidate.usableFrames).toBe(4);
    expect(candidate.usable).toBe(false);
  });

  it('reads the shooting arm the sequence was captured for, not a fixed side', () => {
    const leftHanded = uniformSequence(SEQ_TARGET_FRAMES, [...LEFT_ARM, ...NO_ARM_KEYPOINTS], 'left');
    const candidate = scoreCandidate(shot(1, { sequence: leftHanded }));

    expect(candidate.hand).toBe('left');
    expect(candidate.armPhases).toEqual(['DIP', 'SET', 'RELEASE', 'FOLLOW']);
    expect(candidate.usable).toBe(true);

    // The SAME keypoints labelled as a right-handed capture have no arm.
    const mislabelled = uniformSequence(SEQ_TARGET_FRAMES, [...LEFT_ARM, ...NO_ARM_KEYPOINTS], 'right');
    expect(scoreCandidate(shot(2, { sequence: mislabelled })).armPhases).toEqual([]);
  });

  it('scores a fully tracked capture at the top of the sequence scale', () => {
    const candidate = scoreCandidate(shot(1));
    expect(candidate.coverage).toBe(1);
    expect(candidate.sequenceScore).toBeCloseTo(1, 10);
    expect(candidate.flightScore).toBe(1);
  });

  it('carries the decoded sequence so callers do not decode the blob twice', () => {
    const candidate = scoreCandidate(shot(1));
    expect(candidate.sequence).toHaveLength(SEQ_TARGET_FRAMES);
    expect(candidate.sequence[0]!.right_wrist).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Reason copy

describe('describeCandidate', () => {
  it('names the evidence behind an analysable pick', () => {
    const line = describeCandidate(scoreCandidate(shot(3)));
    expect(line).toContain('Shot 3');
    expect(line).toContain(`${SEQ_TARGET_FRAMES} usable pose frames`);
    expect(line).toContain('100% keypoint coverage');
    expect(line).toContain('all four phases');
    expect(line).toContain('release and entry angle both measured');
    expect(line).toContain('3 of 3 make signals agreed');
  });

  it('says a made shot carried no sequence at all', () => {
    const line = describeCandidate(scoreCandidate(shot(8, { sequence: null })));
    expect(line).toContain('Shot 8 went in, but no pose sequence was captured');
  });

  it('is the sentence pickShotOfSession reports for its pick', () => {
    const target = shot(2);
    const { reason } = pickShotOfSession([target]);
    expect(reason).toBe(`Picked the most analysable make. ${describeCandidate(scoreCandidate(target))}`);
  });
});
