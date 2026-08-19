/**
 * Form Check core — the hoop-free rep engine (src/core/formCheck.ts).
 *
 * What these tests pin, and why:
 *  - A scripted dip → rise → release → follow motion yields exactly ONE rep
 *    with the dip-frame elbow/knee geometry, a dip→release tempo, and null
 *    releaseAngleDeg/entryAngleDeg — the ball-derived numbers this mode must
 *    NEVER fabricate.
 *  - computeRepMetrics mirrors FormAnalyzer's semantics (One-Euro filtering,
 *    dip = max filtered wrist y, follow-through windows) on filter-friendly
 *    fixtures where the expected values are exact.
 *  - The 1.5 s ReleaseDetector debounce means a second snap right after the
 *    first cannot mint a second rep.
 *  - Readiness refuses below 15 fps and without the full body / shooting arm
 *    in frame — refuse-don't-guess, so a sub-15fps session counts ZERO reps.
 *  - Degraded keypoints produce nulls, never NaN.
 *  - Consistency spreads are null (with a reason) under 3 measured reps and
 *    a correct sample std at 4.
 *  - The packed sequence carries the release marker near the release time.
 */
import {
  computeRepMetrics,
  FormCheckSession,
  frameVisibility,
  MIN_POSE_FPS,
  MIN_SPREAD_REPS,
  readinessOf,
  sessionSpreads,
  type FormCheckRep,
  type ReadinessSample,
} from '@/core/formCheck';
import { decodeSequence, type RawSeqFrame } from '@/core/formSequence';
import { angleAtDeg } from '@/core/geometry';
import type {
  FormMetrics,
  PoseFrame,
  PoseKeypointName,
} from '@/core/types';

const DT = 1 / 30;
/** Analysis square (MoveNet input side) — the space every keypoint lives in. */
const FRAME = 192;

// ---------------------------------------------------------------------------
// Fixture: a right-handed shooter, ~125 px tall in the 192 square.
// ---------------------------------------------------------------------------

/** Static landmarks (never move during a rep). */
const STATIC: Partial<Record<PoseKeypointName, [number, number]>> = {
  nose: [100, 25],
  right_shoulder: [95, 45],
  left_shoulder: [85, 45],
  right_hip: [100, 95],
  left_hip: [92, 95],
  // 120.00° at the right knee: hip (100,95) → knee (100,130) → ankle.
  right_knee: [100, 130],
  right_ankle: [131.18, 148],
  left_knee: [92, 130],
  left_ankle: [92, 165],
};

/** The dip (set point): elbow directly below the shoulder, wrist level with
 *  the elbow → elbow angle exactly 90°. */
const DIP_ARM = { elbow: [95, 80] as const, wrist: [120, 80] as const };

/** Fully extended overhead: shoulder→elbow→wrist near-vertical, collinear. */
const EXT_ARM = { elbow: [95, 30] as const, wrist: [95, 15] as const };

/** Arm positions per script frame index (dip hold → 5-frame snap → park). */
function armAt(
  i: number,
  dipFrames: number,
): { elbow: [number, number]; wrist: [number, number] } {
  const k = i - dipFrames; // 0-based snap frame
  if (k < 0) return { elbow: [...DIP_ARM.elbow], wrist: [...DIP_ARM.wrist] };
  if (k >= 5) return { elbow: [...EXT_ARM.elbow], wrist: [...EXT_ARM.wrist] };
  // Linear 5-step snap: elbow y 80→30, wrist (120,80)→(95,15).
  const u = (k + 1) / 5;
  return {
    elbow: [95, 80 - 50 * u],
    wrist: [120 - 25 * u, 80 - 65 * u],
  };
}

function poseAt(t: number, i: number, dipFrames: number): PoseFrame {
  const keypoints: PoseFrame['keypoints'] = {};
  for (const [name, [x, y]] of Object.entries(STATIC) as [
    PoseKeypointName,
    [number, number],
  ][]) {
    keypoints[name] = { x, y, score: 0.9 };
  }
  const arm = armAt(i, dipFrames);
  keypoints.right_elbow = { x: arm.elbow[0], y: arm.elbow[1], score: 0.9 };
  keypoints.right_wrist = { x: arm.wrist[0], y: arm.wrist[1], score: 0.9 };
  return { t, keypoints };
}

/**
 * One full scripted rep at `fps`: `dipFrames` of set-point hold, a 5-frame
 * snap to full overhead extension, then `parkFrames` of held follow-through.
 * At 30 fps the ReleaseDetector fires on the 4th snap frame (wrist above the
 * shoulder + fresh vy spike + elbow ≥ 150°).
 */
function runRep(
  session: FormCheckSession,
  opts: { t0?: number; fps?: number; dipFrames?: number; parkFrames?: number } = {},
): FormCheckRep[] {
  const { t0 = 0, fps = 30, dipFrames = 20, parkFrames = 16 } = opts;
  const reps: FormCheckRep[] = [];
  const total = dipFrames + 5 + parkFrames;
  for (let i = 0; i < total; i++) {
    const rep = session.push(poseAt(t0 + i / fps, i, dipFrames));
    if (rep != null) reps.push(rep);
  }
  return reps;
}

/** RawSeqFrame from partial [x, y] keypoints (score already gated away). */
function raw(
  t: number,
  pts: Partial<Record<PoseKeypointName, readonly [number, number]>>,
): RawSeqFrame {
  const m = new Map<PoseKeypointName, { x: number; y: number }>();
  for (const [name, p] of Object.entries(pts) as [
    PoseKeypointName,
    readonly [number, number],
  ][]) {
    m.set(name, { x: p[0], y: p[1] });
  }
  return { t, pts: m };
}

/** Full-body raw frame with the scripted arm at script index `i`. */
function rawAt(t: number, i: number, dipFrames: number): RawSeqFrame {
  const arm = armAt(i, dipFrames);
  return raw(t, {
    ...STATIC,
    right_elbow: arm.elbow,
    right_wrist: arm.wrist,
  });
}

const expectNoNaN = (m: FormMetrics) => {
  for (const v of Object.values(m)) {
    expect(v === null || Number.isFinite(v)).toBe(true);
  }
};

// ---------------------------------------------------------------------------
// computeRepMetrics — exact semantics on filter-friendly fixtures
// ---------------------------------------------------------------------------

describe('computeRepMetrics', () => {
  /** 20 dip frames, 5 snap frames, 13 parked frames; release = 3rd parked
   *  frame (f27) so the filters have settled at both measured instants. */
  function metricWindow(): { frames: RawSeqFrame[]; releaseT: number } {
    const frames: RawSeqFrame[] = [];
    for (let i = 0; i < 38; i++) frames.push(rawAt(i * DT, i, 20));
    return { frames, releaseT: 27 * DT };
  }

  test('dip-frame elbow/knee, dip→release tempo, follow-through, height', () => {
    const { frames, releaseT } = metricWindow();
    const m = computeRepMetrics(frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT,
    });

    // Set point: the dip pose was held 20 frames, so the filtered geometry
    // converged to the constructed 90°/120° exactly.
    expect(m.setPointElbowDeg).not.toBeNull();
    expect(Math.abs(m.setPointElbowDeg! - 90)).toBeLessThanOrEqual(2);
    const expectedKnee = angleAtDeg(
      { x: 100, y: 95 },
      { x: 100, y: 130 },
      { x: 131.18, y: 148 },
    )!;
    expect(m.kneeFlexionDeg).not.toBeNull();
    expect(Math.abs(m.kneeFlexionDeg! - expectedKnee)).toBeLessThanOrEqual(2);

    // Dip = LAST held set-point frame (f19); release at f27 → 8 frames.
    expect(m.releaseTimeMs).not.toBeNull();
    expect(m.releaseTimeMs!).toBeCloseTo((8 / 30) * 1000, 6);

    // Parked collinear arm after release: elbow ≈ 180°, held the full window.
    expect(m.followThroughElbowDeg).not.toBeNull();
    expect(m.followThroughElbowDeg!).toBeGreaterThan(165);
    expect(m.followThroughHeldMs).toBeCloseTo(300, 5);

    // Wrist parked near y=15 at the release → norm ≈ 0.9 (filter lag ok).
    expect(m.releaseHeightNorm).not.toBeNull();
    expect(m.releaseHeightNorm!).toBeGreaterThan(0.85);
    expect(m.releaseHeightNorm!).toBeLessThan(0.95);

    // THE honesty pin: ball-derived numbers are null BY CONSTRUCTION.
    expect(m.releaseAngleDeg).toBeNull();
    expect(m.entryAngleDeg).toBeNull();
    expectNoNaN(m);
  });

  test('missing far-side / leg keypoints → graceful nulls, never NaN', () => {
    // Same motion but the shooting-side leg never resolves (side-view
    // occlusion): knee flexion must be null, arm metrics still measured.
    const frames: RawSeqFrame[] = [];
    for (let i = 0; i < 38; i++) {
      const arm = armAt(i, 20);
      frames.push(
        raw(i * DT, {
          nose: STATIC.nose,
          right_shoulder: STATIC.right_shoulder,
          right_elbow: arm.elbow,
          right_wrist: arm.wrist,
          right_hip: STATIC.right_hip,
        }),
      );
    }
    const m = computeRepMetrics(frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT: 27 * DT,
    });
    expect(m.kneeFlexionDeg).toBeNull();
    expect(m.setPointElbowDeg).not.toBeNull();
    expect(m.releaseTimeMs).not.toBeNull();
    expectNoNaN(m);
  });

  test('wrist-free window → all-null metrics, never NaN', () => {
    const frames: RawSeqFrame[] = [];
    for (let i = 0; i < 20; i++) {
      frames.push(raw(i * DT, { right_shoulder: [95, 45], right_hip: [100, 95] }));
    }
    const m = computeRepMetrics(frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT: 10 * DT,
    });
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

  test('empty window → all-null metrics', () => {
    const m = computeRepMetrics([], {
      hand: 'right',
      frameHeight: FRAME,
      releaseT: 1,
    });
    expect(m.setPointElbowDeg).toBeNull();
    expect(m.releaseHeightNorm).toBeNull();
    expectNoNaN(m);
  });
});

// ---------------------------------------------------------------------------
// Readiness — the refuse-don't-guess gate
// ---------------------------------------------------------------------------

describe('readiness', () => {
  const sample = (t: number, fullBody = true, arm = true): ReadinessSample => ({
    t,
    fullBody,
    arm,
  });

  test('30 fps + full visibility → ready', () => {
    const samples = Array.from({ length: 30 }, (_, i) => sample(i * DT));
    const r = readinessOf(samples);
    expect(r.fps).toBeCloseTo(30, 0);
    expect(r.ready).toBe(true);
  });

  test('sub-15 fps refuses even with perfect visibility', () => {
    const samples = Array.from({ length: 20 }, (_, i) => sample(i / 10));
    const r = readinessOf(samples);
    expect(r.fps).toBeCloseTo(10, 0);
    expect(r.fps).toBeLessThan(MIN_POSE_FPS);
    expect(r.fpsOk).toBe(false);
    expect(r.ready).toBe(false);
  });

  test('arm visible in only 60% of frames fails the arm gate', () => {
    const samples = Array.from({ length: 30 }, (_, i) =>
      sample(i * DT, true, i % 5 < 3),
    );
    const r = readinessOf(samples);
    expect(r.armOk).toBe(false);
    expect(r.fullBodyOk).toBe(true);
    expect(r.ready).toBe(false);
  });

  test('empty window is not ready', () => {
    expect(readinessOf([]).ready).toBe(false);
  });

  test('frameVisibility needs both hips, an ankle, a head and the shooting arm', () => {
    const full = poseAt(0, 0, 20);
    expect(frameVisibility(full, 'right')).toEqual({ fullBody: true, arm: true });

    // Far-side hip missing → full body fails (can't anchor the sequence).
    const noLeftHip = poseAt(0, 0, 20);
    delete noLeftHip.keypoints.left_hip;
    expect(frameVisibility(noLeftHip, 'right').fullBody).toBe(false);

    // Watching the LEFT arm of a right-armed fixture → arm gate fails.
    expect(frameVisibility(full, 'left').arm).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FormCheckSession — end-to-end rep capture
// ---------------------------------------------------------------------------

describe('FormCheckSession', () => {
  test('one scripted motion → exactly one rep with honest metrics', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    const reps = runRep(session, { dipFrames: 20, parkFrames: 20 });

    expect(reps).toHaveLength(1);
    const rep = reps[0]!;
    expect(rep.index).toBe(1);
    // The detector fires on the 4th snap frame (f23): wrist above shoulder +
    // fresh spike + extended elbow.
    expect(rep.releaseT).toBeCloseTo(23 / 30, 6);
    expect(rep.poseFps).toBeCloseTo(30, 0);

    // Dip-frame geometry survives end-to-end (dip = f19, held 20 frames).
    expect(Math.abs(rep.metrics.setPointElbowDeg! - 90)).toBeLessThanOrEqual(3);
    expect(Math.abs(rep.metrics.kneeFlexionDeg! - 120)).toBeLessThanOrEqual(3);
    // Tempo dip(f19)→release(f23), ±1 frame.
    expect(rep.metrics.releaseTimeMs).not.toBeNull();
    expect(
      Math.abs(rep.metrics.releaseTimeMs! - (4 / 30) * 1000),
    ).toBeLessThanOrEqual(DT * 1000 + 1e-6);
    // Follow-through measured from the tail (exact values pinned in the
    // computeRepMetrics suite — here the point is they exist and are sane).
    expect(rep.metrics.followThroughHeldMs).not.toBeNull();
    expect(rep.metrics.followThroughHeldMs!).toBeGreaterThanOrEqual(0);
    expect(rep.metrics.followThroughHeldMs!).toBeLessThanOrEqual(300 + 1e-6);
    expect(rep.metrics.releaseHeightNorm).not.toBeNull();

    // NEVER a ball number.
    expect(rep.metrics.releaseAngleDeg).toBeNull();
    expect(rep.metrics.entryAngleDeg).toBeNull();
    expectNoNaN(rep.metrics);
  });

  test('the packed sequence decodes and carries the release marker in time', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    const reps = runRep(session, { dipFrames: 20, parkFrames: 20 });
    const seq = reps[0]!.sequence;
    expect(seq).not.toBeNull();
    expect(seq!.hand).toBe('right');

    const decoded = decodeSequence(seq!);
    expect(decoded.length).toBeGreaterThanOrEqual(4);
    expect(decoded.length).toBe(seq!.frames);

    // Release marker points at a sampled frame whose (evenly spaced) time
    // sits near the release — never snapped far away.
    expect(typeof seq!.releaseFrame).toBe('number');
    const k = seq!.releaseFrame!;
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThan(seq!.frames);
    const windowStart = 0; // releaseT − 1.2 < 0 → the window starts at f0
    const markerT =
      windowStart + (k / (seq!.frames - 1)) * seq!.durationSec;
    expect(Math.abs(markerT - reps[0]!.releaseT)).toBeLessThanOrEqual(0.25);
  });

  test('a second snap inside the 1.5 s debounce cannot mint a second rep', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    const reps: FormCheckRep[] = [];
    // Two back-to-back snap cycles: 10-frame dip + 5-frame snap + 8-frame
    // park = 0.767 s per cycle, so the second signature completes well inside
    // RELEASE.debounceSec of the first.
    reps.push(...runRep(session, { t0: 0, dipFrames: 10, parkFrames: 8 }));
    reps.push(...runRep(session, { t0: 23 / 30, dipFrames: 10, parkFrames: 8 }));
    // Trailing frames so the first rep's follow tail can complete.
    for (let i = 0; i < 20; i++) {
      const rep = session.push(poseAt(46 / 30 + i / 30, 25, 10));
      if (rep != null) reps.push(rep);
    }
    expect(reps).toHaveLength(1);
    expect(session.reps).toHaveLength(1);
  });

  test('sub-15 fps pose refuses to count reps at all', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    const reps = runRep(session, { fps: 10, dipFrames: 20, parkFrames: 20 });
    expect(reps).toHaveLength(0);
    expect(session.reps).toHaveLength(0);
    expect(session.readiness.fpsOk).toBe(false);
    expect(session.readiness.ready).toBe(false);
  });

  test('a shooter without the full body in frame counts zero reps', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    for (let i = 0; i < 45; i++) {
      const pose = poseAt(i * DT, i, 20);
      // Legs out of frame (too close to the camera): no ankles, no far hip.
      delete pose.keypoints.left_hip;
      delete pose.keypoints.left_ankle;
      delete pose.keypoints.right_ankle;
      expect(session.push(pose)).toBeNull();
    }
    expect(session.reps).toHaveLength(0);
    expect(session.readiness.fullBodyOk).toBe(false);
  });

  test('finalizeSession flushes a pending rep and reports median fps', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    // Stop right after the snap: the tail never completes on its own.
    runRep(session, { dipFrames: 20, parkFrames: 3 });
    expect(session.reps).toHaveLength(0);
    const report = session.finalizeSession();
    expect(report.repCount).toBe(1);
    expect(session.reps).toHaveLength(1);
    expect(report.medianPoseFps).toBeCloseTo(30, 0);
    // One rep can never fabricate a spread.
    expect(report.spreads.setPointElbowSpreadDeg.value).toBeNull();
  });

  test('setHand resets the trigger without erasing completed reps', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    runRep(session, { dipFrames: 20, parkFrames: 20 });
    expect(session.reps).toHaveLength(1);
    session.setHand('left');
    expect(session.hand).toBe('left');
    expect(session.reps).toHaveLength(1);
    // The fixture's LEFT arm never moves → no further reps.
    const more = runRep(session, { t0: 5, dipFrames: 20, parkFrames: 20 });
    expect(more).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-rep consistency
// ---------------------------------------------------------------------------

describe('sessionSpreads', () => {
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
  const mkRep = (index: number, metrics: Partial<FormMetrics>): FormCheckRep => ({
    index,
    releaseT: index,
    sequence: null,
    metrics: { ...NULLS, ...metrics },
    tips: [],
    poseFps: 30,
  });

  test('two reps → every spread null, with an honest reason', () => {
    const spreads = sessionSpreads([
      mkRep(1, { setPointElbowDeg: 80, releaseTimeMs: 500 }),
      mkRep(2, { setPointElbowDeg: 86, releaseTimeMs: 620 }),
    ]);
    for (const stat of Object.values(spreads)) {
      expect(stat.value).toBeNull();
      expect(stat.reason).toContain(`at least ${MIN_SPREAD_REPS}`);
    }
    expect(spreads.setPointElbowSpreadDeg.measured).toBe(2);
    expect(spreads.kneeSpreadDeg.measured).toBe(0);
  });

  test('four reps → correct sample standard deviation per metric', () => {
    const spreads = sessionSpreads([
      mkRep(1, { setPointElbowDeg: 80, releaseTimeMs: 500, releaseHeightNorm: 0.6 }),
      mkRep(2, { setPointElbowDeg: 84, releaseTimeMs: 700, releaseHeightNorm: 0.62 }),
      mkRep(3, { setPointElbowDeg: 88, releaseTimeMs: 600, releaseHeightNorm: 0.58 }),
      mkRep(4, { setPointElbowDeg: 92, releaseTimeMs: 640, releaseHeightNorm: 0.6 }),
    ]);
    // Sample std of [80,84,88,92] = sqrt(80/3).
    expect(spreads.setPointElbowSpreadDeg.value).toBeCloseTo(Math.sqrt(80 / 3), 6);
    expect(spreads.setPointElbowSpreadDeg.measured).toBe(4);
    expect(spreads.setPointElbowSpreadDeg.reason).toBeNull();
    // Sample std of [500,700,600,640] = sqrt(20800/3† ) — computed directly.
    const tempo = [500, 700, 600, 640];
    const mean = tempo.reduce((a, b) => a + b, 0) / 4;
    const std = Math.sqrt(
      tempo.reduce((a, b) => a + (b - mean) * (b - mean), 0) / 3,
    );
    expect(spreads.tempoSpreadMs.value).toBeCloseTo(std, 6);
    // Knee was never measured → still null even with 4 reps.
    expect(spreads.kneeSpreadDeg.value).toBeNull();
    expect(spreads.kneeSpreadDeg.measured).toBe(0);
  });

  test('a metric measured on only 2 of 4 reps stays null for that metric', () => {
    const spreads = sessionSpreads([
      mkRep(1, { setPointElbowDeg: 80, kneeFlexionDeg: 110 }),
      mkRep(2, { setPointElbowDeg: 84 }),
      mkRep(3, { setPointElbowDeg: 88, kneeFlexionDeg: 118 }),
      mkRep(4, { setPointElbowDeg: 92 }),
    ]);
    expect(spreads.setPointElbowSpreadDeg.value).not.toBeNull();
    expect(spreads.kneeSpreadDeg.value).toBeNull();
    expect(spreads.kneeSpreadDeg.measured).toBe(2);
    expect(spreads.kneeSpreadDeg.reason).toContain('2 of 4');
  });
});
