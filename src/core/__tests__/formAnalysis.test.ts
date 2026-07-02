import { FormAnalyzer, OneEuroFilter, coachingTips } from '../formAnalysis';
import type {
  FormMetrics,
  FormPhase,
  PoseFrame,
  PoseKeypoint,
  TrackedBall,
} from '../types';

const DT = 1 / 30;
const FRAME_H = 640;

function kp(x: number, y: number, score = 0.9): PoseKeypoint {
  return { x, y, score };
}

function ball(
  cx: number,
  cy: number,
  vy: number,
  t: number,
  r = 25,
): TrackedBall {
  return { cx, cy, r, t, score: 0.9, predicted: false, vx: 0, vy };
}

/** Deterministic pseudo-random in [0,1) (Park–Miller LCG). */
function makeRand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
}

// ---------------------------------------------------------------------------
// OneEuroFilter
// ---------------------------------------------------------------------------

describe('OneEuroFilter', () => {
  test('first sample passes through, constant input converges exactly', () => {
    const f = new OneEuroFilter();
    expect(f.filter(10, 0)).toBe(10);
    let v = 10;
    for (let i = 1; i <= 30; i++) v = f.filter(10, i * DT);
    expect(v).toBeCloseTo(10, 6);
  });

  test('reset clears state: next sample passes through', () => {
    const f = new OneEuroFilter();
    f.filter(100, 0);
    f.filter(100, DT);
    f.reset();
    expect(f.filter(5, 1)).toBe(5);
  });

  test('non-increasing timestamp returns last value unchanged', () => {
    const f = new OneEuroFilter();
    f.filter(10, 0);
    const a = f.filter(20, DT);
    expect(f.filter(999, DT)).toBe(a);
  });

  test('reduces jitter >50% on a noisy sine (second-difference RMS)', () => {
    const f = new OneEuroFilter();
    const rand = makeRand(42);
    const raw: number[] = [];
    const filt: number[] = [];
    for (let i = 0; i < 150; i++) {
      const t = i * DT;
      const clean = 10 * Math.sin(2 * Math.PI * 0.25 * t);
      const noisy = clean + (rand() * 2 - 1) * 3;
      raw.push(noisy);
      filt.push(f.filter(noisy, t));
    }
    const rmsSecondDiff = (xs: number[]): number => {
      let sum = 0;
      let n = 0;
      for (let i = 12; i < xs.length; i++) {
        const d2 = xs[i]! - 2 * xs[i - 1]! + xs[i - 2]!;
        sum += d2 * d2;
        n++;
      }
      return Math.sqrt(sum / n);
    };
    const jitterRaw = rmsSecondDiff(raw);
    const jitterFilt = rmsSecondDiff(filt);
    expect(jitterFilt).toBeLessThan(0.5 * jitterRaw);
  });

  test('step response settles to 90% within 5 frames', () => {
    const f = new OneEuroFilter();
    for (let i = 0; i < 10; i++) f.filter(0, i * DT);
    let framesToSettle = Infinity;
    for (let i = 0; i < 10; i++) {
      const v = f.filter(100, (10 + i) * DT);
      if (v >= 90) {
        framesToSettle = i + 1;
        break;
      }
    }
    expect(framesToSettle).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// FormAnalyzer — synthetic jump shot
// ---------------------------------------------------------------------------

/**
 * Scripted right-handed jump shot at 30 fps.
 *
 * Static: shoulder (300,300), hip (300,400), knee (300,460),
 * ankle (343.30127,485) → knee angle exactly 120°.
 *
 * f0–24  : wrist (350,420), elbow (300,420) → elbow angle exactly 90° (dip).
 * f10    : ball appears at the wrist, below the shoulder → PICKUP.
 * f25–30 : wrist rises 420→280 (ball glued to raw wrist, vy<0) → DIP+RISE.
 * f31–32 : wrist parked at (350,280), ball resting at the wrist (vy 0).
 * f33–34 : ball jumps up and away (>2r from wrist, vy<0) → RELEASE at f33.
 * f33–46 : arm extended: shoulder(300,300)-elbow(325,290)-wrist(350,280)
 *          are collinear → follow-through elbow ≈ 180°, held all window.
 */
function runJumpShot(analyzer: FormAnalyzer): Array<FormPhase | null> {
  const phases: Array<FormPhase | null> = [];
  const riseStep = 140 / 6; // 420 → 280 over frames 25..30

  for (let f = 0; f <= 46; f++) {
    const t = f * DT;
    let wristY: number;
    let elbowX: number;
    let elbowY: number;
    if (f <= 24) {
      wristY = 420;
      elbowX = 300;
      elbowY = 420;
    } else if (f <= 30) {
      wristY = 420 - riseStep * (f - 24);
      elbowX = 325;
      elbowY = (300 + wristY) / 2;
    } else {
      wristY = 280;
      elbowX = 325;
      elbowY = 290;
    }

    const pose: PoseFrame = {
      t,
      keypoints: {
        right_shoulder: kp(300, 300),
        right_elbow: kp(elbowX, elbowY),
        right_wrist: kp(350, wristY),
        right_hip: kp(300, 400),
        right_knee: kp(300, 460),
        right_ankle: kp(343.30127018922193, 485),
      },
    };

    let b: TrackedBall | null = null;
    if (f >= 10 && f <= 24) b = ball(350, 420, 0, t);
    else if (f >= 25 && f <= 30) b = ball(350, wristY, -500, t);
    else if (f === 31 || f === 32) b = ball(350, 280, 0, t);
    else if (f === 33) b = ball(350, 220, -1500, t);
    else if (f === 34) b = ball(350, 170, -1500, t);

    analyzer.push(pose, b);
    phases.push(analyzer.phase);
  }
  return phases;
}

function dedup<T>(xs: T[]): T[] {
  const out: T[] = [];
  for (const x of xs) if (out[out.length - 1] !== x) out.push(x);
  return out;
}

describe('FormAnalyzer', () => {
  test('phase ordering PICKUP → DIP → RISE → RELEASE → FOLLOW_THROUGH', () => {
    const a = new FormAnalyzer({ hand: 'right', frameHeight: FRAME_H });
    const phases = runJumpShot(a);

    expect(phases[9]).toBeNull(); // no ball yet
    expect(phases[10]).toBe('PICKUP');
    expect(dedup(phases.filter((p) => p != null))).toEqual([
      'PICKUP',
      'DIP',
      'RISE',
      'RELEASE',
      'FOLLOW_THROUGH',
    ]);
  });

  test('finalize yields correct angles, timing and passthrough', () => {
    const a = new FormAnalyzer({ hand: 'right', frameHeight: FRAME_H });
    runJumpShot(a);
    const m = a.finalize({ entryAngleDeg: 44, releaseAngleDeg: 50 });

    // Ball-derived angles pass through untouched.
    expect(m.entryAngleDeg).toBe(44);
    expect(m.releaseAngleDeg).toBe(50);

    // Constructed geometry at the dip: elbow 90°, knee 120°.
    expect(m.setPointElbowDeg).not.toBeNull();
    expect(Math.abs(m.setPointElbowDeg! - 90)).toBeLessThanOrEqual(2);
    expect(m.kneeFlexionDeg).not.toBeNull();
    expect(Math.abs(m.kneeFlexionDeg! - 120)).toBeLessThanOrEqual(2);

    // Pickup f10 → release f33 = 23 frames = 766.7 ms (±1 frame).
    expect(m.releaseTimeMs).not.toBeNull();
    expect(Math.abs(m.releaseTimeMs! - (23 / 30) * 1000)).toBeLessThanOrEqual(
      DT * 1000 + 1e-6,
    );

    // Wrist parked near y=280 at release → 1 - 280/640 ≈ 0.56 (filter lag ok).
    expect(m.releaseHeightNorm).not.toBeNull();
    expect(m.releaseHeightNorm!).toBeGreaterThan(0.52);
    expect(m.releaseHeightNorm!).toBeLessThan(0.58);

    // Arm collinear after release → elbow ≈ 180°, held the whole 300ms window.
    expect(m.followThroughElbowDeg).not.toBeNull();
    expect(m.followThroughElbowDeg!).toBeGreaterThan(170);
    expect(m.followThroughHeldMs).toBeCloseTo(300, 5);

    expect(Object.values(m).every((v) => v === null || Number.isFinite(v))).toBe(
      true,
    );
  });

  test('missing / low-score landmarks produce null metrics, never NaN', () => {
    const a = new FormAnalyzer({ hand: 'right', frameHeight: FRAME_H });
    for (let f = 0; f < 20; f++) {
      const t = f * DT;
      const pose: PoseFrame = {
        t,
        // Low-score keypoints must be ignored (below FORM.keypointScoreMin).
        keypoints: f % 2 === 0 ? {} : { right_wrist: kp(300, 400, 0.1) },
      };
      a.push(pose, ball(300, 400, -100, t));
    }
    const m = a.finalize({ entryAngleDeg: null, releaseAngleDeg: null });
    expect(m).toEqual({
      setPointElbowDeg: null,
      kneeFlexionDeg: null,
      releaseAngleDeg: null,
      entryAngleDeg: null,
      releaseTimeMs: null,
      followThroughHeldMs: null,
      followThroughElbowDeg: null,
      releaseHeightNorm: null,
    });
  });

  test('knee flexion falls back to the non-shooting side (130° left leg)', () => {
    const a = new FormAnalyzer({ hand: 'right', frameHeight: FRAME_H });
    for (let f = 0; f <= 18; f++) {
      const t = f * DT;
      const wristY = f <= 14 ? 420 : 420 - 10 * (f - 14); // dip then rise
      const pose: PoseFrame = {
        t,
        keypoints: {
          right_shoulder: kp(300, 300),
          right_elbow: kp(300, 420),
          right_wrist: kp(350, wristY),
          right_hip: kp(300, 400),
          right_knee: kp(300, 460, 0.1), // treated as missing
          // right_ankle absent entirely
          left_hip: kp(260, 400),
          left_knee: kp(260, 460),
          left_ankle: kp(298.30222, 492.13938), // 130° at the left knee
        },
      };
      const b = f >= 5 && f <= 14 ? ball(350, 420, 0, t) : null;
      a.push(pose, b);
    }
    const m = a.finalize({ entryAngleDeg: null, releaseAngleDeg: null });
    expect(m.kneeFlexionDeg).not.toBeNull();
    expect(Math.abs(m.kneeFlexionDeg! - 130)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.setPointElbowDeg! - 90)).toBeLessThanOrEqual(2);
    expect(m.releaseTimeMs).toBeNull(); // no release happened
  });

  test('reset clears state for the next shot', () => {
    const a = new FormAnalyzer({ hand: 'right', frameHeight: FRAME_H });
    runJumpShot(a);
    a.reset();
    expect(a.phase).toBeNull();
    const m = a.finalize({ entryAngleDeg: null, releaseAngleDeg: null });
    expect(m.releaseTimeMs).toBeNull();
    expect(m.setPointElbowDeg).toBeNull();

    // The same instance can analyze a fresh shot after reset.
    const phases = runJumpShot(a);
    expect(dedup(phases.filter((p) => p != null))).toEqual([
      'PICKUP',
      'DIP',
      'RISE',
      'RELEASE',
      'FOLLOW_THROUGH',
    ]);
  });
});

// ---------------------------------------------------------------------------
// coachingTips
// ---------------------------------------------------------------------------

const GOOD: FormMetrics = {
  setPointElbowDeg: 80,
  kneeFlexionDeg: 115,
  releaseAngleDeg: 50,
  entryAngleDeg: 45,
  releaseTimeMs: 600,
  followThroughHeldMs: 300,
  followThroughElbowDeg: 170,
  releaseHeightNorm: 0.6,
};

const NULLS: FormMetrics = {
  setPointElbowDeg: null,
  kneeFlexionDeg: null,
  releaseAngleDeg: null,
  entryAngleDeg: null,
  releaseTimeMs: null,
  followThroughHeldMs: null,
  followThroughElbowDeg: null,
  releaseHeightNorm: null,
};

describe('coachingTips', () => {
  test('all-null metrics and in-band metrics produce no tips', () => {
    expect(coachingTips(NULLS)).toEqual([]);
    expect(coachingTips(GOOD)).toEqual([]);
    expect(coachingTips(GOOD, { releaseAngleStdDeg: 2 })).toEqual([]);
    expect(coachingTips(GOOD, { releaseAngleStdDeg: null })).toEqual([]);
  });

  test('low release angle → "Add arc" promoted to severity 3', () => {
    const tips = coachingTips({ ...GOOD, releaseAngleDeg: 40 });
    expect(tips).toHaveLength(1);
    expect(tips[0]!.title).toBe('Add arc');
    expect(tips[0]!.metric).toBe('releaseAngleDeg');
    expect(tips[0]!.severity).toBe(3);
  });

  test('high release angle → "Flatten slightly"', () => {
    const tips = coachingTips({ ...GOOD, releaseAngleDeg: 62 });
    expect(tips).toHaveLength(1);
    expect(tips[0]!.title).toBe('Flatten slightly');
    expect(tips[0]!.severity).toBe(3);
  });

  test('follow-through collapse → "Hold your follow-through"', () => {
    const tips = coachingTips({
      ...GOOD,
      followThroughElbowDeg: 140,
      followThroughHeldMs: 100,
    });
    expect(tips).toHaveLength(1);
    expect(tips[0]!.title).toBe('Hold your follow-through');
  });

  test('release-angle inconsistency → "Consistency over power"', () => {
    const tips = coachingTips(GOOD, { releaseAngleStdDeg: 6 });
    expect(tips).toHaveLength(1);
    expect(tips[0]!.metric).toBe('consistency');
    expect(tips[0]!.title).toBe('Consistency over power');
  });

  test('slow release is info-only: severity 1, never promoted', () => {
    const tips = coachingTips({ ...GOOD, releaseTimeMs: 1200 });
    expect(tips).toHaveLength(1);
    expect(tips[0]!.metric).toBe('releaseTimeMs');
    expect(tips[0]!.severity).toBe(1);
    expect(coachingTips({ ...GOOD, releaseTimeMs: 900 })).toEqual([]);
  });

  test('mildly-off elbow (between band edge and flag) stays severity 1', () => {
    const tips = coachingTips({ ...GOOD, setPointElbowDeg: 70 });
    expect(tips).toHaveLength(1);
    expect(tips[0]!.severity).toBe(1);
  });

  test('max 3 tips, sorted by severity, exactly one severity-3 (worst dev)', () => {
    const tips = coachingTips({
      ...GOOD,
      setPointElbowDeg: 55, // dev (75-55)/15 ≈ 1.33
      kneeFlexionDeg: 160, // dev (160-130)/30 = 1.0
      releaseAngleDeg: 40, // dev (45-40)/10 = 0.5 → dropped by the cap
      entryAngleDeg: 35, // dev (43-35)/4 = 2.0 → the one cue
    });
    expect(tips).toHaveLength(3);
    expect(tips.filter((t) => t.severity === 3)).toHaveLength(1);
    expect(tips[0]!.metric).toBe('entryAngleDeg');
    expect(tips[0]!.severity).toBe(3);
    expect(tips[1]!.metric).toBe('setPointElbowDeg');
    expect(tips[2]!.metric).toBe('kneeFlexionDeg');
    expect(tips.map((t) => t.metric)).not.toContain('releaseAngleDeg');
    for (let i = 1; i < tips.length; i++) {
      expect(tips[i]!.severity).toBeLessThanOrEqual(tips[i - 1]!.severity);
    }
  });
});
