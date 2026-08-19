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
 *
 * V2 RE-PIN: sessions now open in a shadow-rep calibration phase, so every
 * v1 suite that pins the SCORING engine constructs its session with
 * `calibrate: false` (pure v1 behavior by contract) — the calibration state
 * machine and its confidence-gated gauges get their own suites below.
 */
import {
  computePhaseTiming,
  computeRepMetrics,
  estimateTilt,
  FormCheckSession,
  frameVisibility,
  heightScaleOf,
  MIN_POSE_FPS,
  MIN_SPREAD_REPS,
  NOSE_TO_ANKLE_STATURE_FRAC,
  pickBestRep,
  readinessOf,
  sessionSpreads,
  SHADOW_REPS_TARGET,
  SIDE_PROFILE_MIN,
  sideProfileOf,
  TILT_MAX_COMP_DEG,
  TILT_STD_MAX_DEG,
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
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME, calibrate: false });
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
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME, calibrate: false });
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
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME, calibrate: false });
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
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME, calibrate: false });
    const reps = runRep(session, { fps: 10, dipFrames: 20, parkFrames: 20 });
    expect(reps).toHaveLength(0);
    expect(session.reps).toHaveLength(0);
    expect(session.readiness.fpsOk).toBe(false);
    expect(session.readiness.ready).toBe(false);
  });

  test('a shooter without the full body in frame counts zero reps', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME, calibrate: false });
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
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME, calibrate: false });
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
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME, calibrate: false });
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
    phases: { dipMs: null, riseMs: null, releaseMs: null, followMs: null },
    releaseHeightM: null,
    flags: [],
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

// ═══════════════════════════════════════════════════════════════════════════
// V2 — calibration gauges + state machine, phase timing, best rep
// ═══════════════════════════════════════════════════════════════════════════

/** PoseFrame from partial [x, y] keypoints at a uniform score. */
function poseOf(
  t: number,
  pts: Partial<Record<PoseKeypointName, readonly [number, number]>>,
  score = 0.9,
): PoseFrame {
  const keypoints: PoseFrame['keypoints'] = {};
  for (const [name, p] of Object.entries(pts) as [
    PoseKeypointName,
    readonly [number, number],
  ][]) {
    keypoints[name] = { x: p[0], y: p[1], score };
  }
  return { t, keypoints };
}

/** Rotate a point by `deg` about the analysis-frame center (96, 96) using
 *  the same screen-space convention the core's tilt compensation inverts. */
function rot(p: readonly [number, number], deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  const c = FRAME / 2;
  const dx = p[0] - c;
  const dy = p[1] - c;
  return [
    c + dx * Math.cos(rad) - dy * Math.sin(rad),
    c + dx * Math.sin(rad) + dy * Math.cos(rad),
  ];
}

// ---------------------------------------------------------------------------
// sideProfileOf — the side-on gauge
// ---------------------------------------------------------------------------

describe('sideProfileOf', () => {
  /** Body of height 140 px (nose y25 → ankle y165) with given x-separations. */
  const body = (shoulderSep: number, hipSep: number) =>
    poseOf(0, {
      nose: [100, 25],
      left_shoulder: [100 - shoulderSep / 2, 45],
      right_shoulder: [100 + shoulderSep / 2, 45],
      left_hip: [100 - hipSep / 2, 95],
      right_hip: [100 + hipSep / 2, 95],
      left_ankle: [100, 165],
    });

  test('perfect side-on (zero separation) reads 1', () => {
    expect(sideProfileOf(body(0, 0))).toBeCloseTo(1, 6);
  });

  test('face-on (full front separation) clamps to 0', () => {
    // 40/140 + 30/140 → mean 0.25 ≥ the 0.24 front-facing separation.
    expect(sideProfileOf(body(40, 30))).toBeCloseTo(0, 6);
  });

  test('half separation reads 0.5', () => {
    // mean sepN = 0.12 body-heights = exactly half of FRONT_SEP_N.
    const sep = 0.12 * 140;
    expect(sideProfileOf(body(sep, sep))).toBeCloseTo(0.5, 6);
  });

  test('a missing shoulder abstains (null), never guesses', () => {
    const p = body(10, 10);
    delete p.keypoints.left_shoulder;
    expect(sideProfileOf(p)).toBeNull();
  });

  test('no body-height estimate abstains (null)', () => {
    // Shoulders only: no head/ankle span, no trunk fallback (no hips).
    const p = poseOf(0, {
      left_shoulder: [90, 45],
      right_shoulder: [110, 45],
    });
    expect(sideProfileOf(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readinessOf — the v2 side gate degrades to PASS when unmeasurable
// ---------------------------------------------------------------------------

describe('readiness side gate', () => {
  const sample = (t: number, sideness: number | null): ReadinessSample => ({
    t,
    fullBody: true,
    arm: true,
    sideness,
  });

  test('a measured face-on stance fails the side gate and pauses reps', () => {
    const samples = Array.from({ length: 30 }, (_, i) => sample(i * DT, 0.3));
    const r = readinessOf(samples);
    expect(r.sideness).toBeCloseTo(0.3, 6);
    expect(r.sideOk).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.fpsOk && r.fullBodyOk && r.armOk).toBe(true);
  });

  test('a measured side-on stance passes', () => {
    const samples = Array.from({ length: 30 }, (_, i) =>
      sample(i * DT, SIDE_PROFILE_MIN + 0.1),
    );
    const r = readinessOf(samples);
    expect(r.sideOk).toBe(true);
    expect(r.ready).toBe(true);
  });

  test('under 40% voting frames the gauge is null and the gate PASSES', () => {
    // Occlusion is not evidence of facing the camera: 30% of frames vote
    // (all face-on!) but the gauge refuses and the gate does not block.
    const samples = Array.from({ length: 30 }, (_, i) =>
      sample(i * DT, i % 10 < 3 ? 0.1 : null),
    );
    const r = readinessOf(samples);
    expect(r.sideness).toBeNull();
    expect(r.sideOk).toBe(true);
    expect(r.ready).toBe(true);
  });

  test('legacy samples without a sideness field still compile and pass', () => {
    const samples: ReadinessSample[] = Array.from({ length: 30 }, (_, i) => ({
      t: i * DT,
      fullBody: true,
      arm: true,
    }));
    const r = readinessOf(samples);
    expect(r.sideness).toBeNull();
    expect(r.sideOk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// estimateTilt — confidence-gated camera roll
// ---------------------------------------------------------------------------

describe('estimateTilt', () => {
  /** A perfectly vertical standing body, rotated rigidly by `deg`. */
  const tiltedBody = (t: number, deg: number): RawSeqFrame =>
    raw(t, {
      left_shoulder: rot([98, 45], deg),
      right_shoulder: rot([102, 45], deg),
      left_hip: rot([98, 95], deg),
      right_hip: rot([102, 95], deg),
      left_ankle: rot([98, 155], deg),
      right_ankle: rot([102, 155], deg),
    });

  test('a 5° rolled camera reads ≈5°, steady, confident', () => {
    const frames = Array.from({ length: 12 }, (_, i) => tiltedBody(i * DT, 5));
    const est = estimateTilt(frames);
    expect(est).not.toBeNull();
    expect(est!.tiltDeg).toBeCloseTo(5, 1);
    expect(est!.stdDeg).toBeLessThanOrEqual(TILT_STD_MAX_DEG);
    expect(est!.frames).toBe(12);
    expect(est!.confident).toBe(true);
  });

  test('a roll past the compensation ceiling is measured but NOT confident', () => {
    const frames = Array.from({ length: 12 }, (_, i) => tiltedBody(i * DT, 20));
    const est = estimateTilt(frames);
    expect(est).not.toBeNull();
    expect(Math.abs(est!.tiltDeg)).toBeGreaterThan(TILT_MAX_COMP_DEG);
    expect(est!.confident).toBe(false);
  });

  test('a noisy estimate (large std) is NOT confident even when small', () => {
    const frames = Array.from({ length: 12 }, (_, i) =>
      tiltedBody(i * DT, i % 2 === 0 ? 8 : -8),
    );
    const est = estimateTilt(frames);
    expect(est).not.toBeNull();
    expect(Math.abs(est!.tiltDeg)).toBeLessThanOrEqual(TILT_MAX_COMP_DEG);
    expect(est!.stdDeg).toBeGreaterThan(TILT_STD_MAX_DEG);
    expect(est!.confident).toBe(false);
  });

  test('fewer than 10 voting frames yields no estimate at all', () => {
    const frames = Array.from({ length: 9 }, (_, i) => tiltedBody(i * DT, 5));
    expect(estimateTilt(frames)).toBeNull();
  });

  test('frames missing the hips do not vote', () => {
    const frames = Array.from({ length: 12 }, (_, i) => {
      const f = tiltedBody(i * DT, 5);
      f.pts.delete('left_hip');
      f.pts.delete('right_hip');
      return f;
    });
    expect(estimateTilt(frames)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// heightScaleOf — metres only with a height and a stable standing span
// ---------------------------------------------------------------------------

describe('heightScaleOf', () => {
  const standing = (t: number, ankleY = 165): RawSeqFrame =>
    raw(t, {
      nose: [100, 25],
      left_ankle: [95, ankleY],
      right_ankle: [105, ankleY],
    });

  test('a stable span + profile height yields the documented scale', () => {
    const frames = Array.from({ length: 12 }, (_, i) => standing(i * DT));
    const scale = heightScaleOf(frames, 190);
    expect(scale).not.toBeNull();
    expect(scale!.standingSpanPx).toBeCloseTo(140, 6);
    expect(scale!.heightCm).toBe(190);
    // metersPerPx = (heightCm/100) / (span / NOSE_TO_ANKLE_STATURE_FRAC).
    expect(scale!.metersPerPx).toBeCloseTo(
      1.9 / (140 / NOSE_TO_ANKLE_STATURE_FRAC),
      9,
    );
  });

  test('no profile height ⇒ no scale (degrades to normalized units)', () => {
    const frames = Array.from({ length: 12 }, (_, i) => standing(i * DT));
    expect(heightScaleOf(frames, null)).toBeNull();
  });

  test('fewer than 10 usable frames ⇒ no scale', () => {
    const frames = Array.from({ length: 8 }, (_, i) => standing(i * DT));
    expect(heightScaleOf(frames, 190)).toBeNull();
  });

  test('a swaying span (std > 2%) ⇒ no scale rather than a wrong one', () => {
    const frames = Array.from({ length: 12 }, (_, i) =>
      standing(i * DT, i % 2 === 0 ? 155 : 175),
    );
    expect(heightScaleOf(frames, 190)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeRepMetrics — tilt compensation is gated and pinned
// ---------------------------------------------------------------------------

describe('computeRepMetrics tilt compensation', () => {
  function metricWindow(): { frames: RawSeqFrame[]; releaseT: number } {
    const frames: RawSeqFrame[] = [];
    for (let i = 0; i < 38; i++) frames.push(rawAt(i * DT, i, 20));
    return { frames, releaseT: 27 * DT };
  }

  test('REGRESSION PIN: tiltDeg absent / null / 0 are all v1-identical', () => {
    const { frames, releaseT } = metricWindow();
    const base = computeRepMetrics(frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT,
    });
    const withNull = computeRepMetrics(frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT,
      tiltDeg: null,
    });
    const withZero = computeRepMetrics(frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT,
      tiltDeg: 0,
    });
    expect(withNull).toEqual(base);
    expect(withZero).toEqual(base);
  });

  test('a confident tilt un-rotates a rolled capture back to level numbers', () => {
    const { frames, releaseT } = metricWindow();
    const level = computeRepMetrics(frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT,
    });
    // Roll the whole capture by +12° (a tilted phone) and compensate.
    const rolled = frames.map((f) => {
      const pts = new Map<PoseKeypointName, { x: number; y: number }>();
      for (const [name, p] of f.pts) {
        const [x, y] = rot([p.x, p.y], 12);
        pts.set(name, { x, y });
      }
      return { t: f.t, pts };
    });
    const compensated = computeRepMetrics(rolled, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT,
      tiltDeg: 12,
    });
    // Angles are rotation-invariant; y-derived numbers recover to the level
    // capture (filtering does not perfectly commute with rotation — small
    // tolerance, not exact bytes).
    expect(
      Math.abs(compensated.setPointElbowDeg! - level.setPointElbowDeg!),
    ).toBeLessThan(1.5);
    expect(
      Math.abs(compensated.releaseHeightNorm! - level.releaseHeightNorm!),
    ).toBeLessThan(0.02);

    // Uncompensated rolled numbers genuinely differ — the gate matters.
    const uncomp = computeRepMetrics(rolled, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT,
    });
    expect(
      Math.abs(uncomp.releaseHeightNorm! - level.releaseHeightNorm!),
    ).toBeGreaterThan(0.004);
  });
});

// ---------------------------------------------------------------------------
// computePhaseTiming — dip / rise / release / follow segments
// ---------------------------------------------------------------------------

describe('computePhaseTiming', () => {
  /**
   * Scripted motion with a REAL descent: 6 standing frames (wrist 70),
   * 8-frame descent 70→85, 4-frame set-point hold at 85, 5-frame snap to
   * (95, 15), then parked follow-through. Release at the last snap frame.
   */
  function phaseFrame(i: number): RawSeqFrame {
    let wrist: [number, number];
    let elbow: [number, number];
    if (i < 6) {
      wrist = [110, 70];
      elbow = [95, 70];
    } else if (i < 14) {
      const u = (i - 5) / 8;
      wrist = [110 + 10 * u, 70 + 15 * u];
      elbow = [95, 70 + 15 * u];
    } else if (i < 18) {
      wrist = [120, 85];
      elbow = [95, 85];
    } else if (i < 23) {
      const u = (i - 17) / 5;
      wrist = [120 - 25 * u, 85 - 70 * u];
      elbow = [95, 85 - 55 * u];
    } else {
      wrist = [95, 15];
      elbow = [95, 30];
    }
    return raw(i * DT, { ...STATIC, right_wrist: wrist, right_elbow: elbow });
  }

  test('measures all four segments on a full motion', () => {
    const frames = Array.from({ length: 41 }, (_, i) => phaseFrame(i));
    // Release 3 parked frames after the snap (the v1 fixtures' "filters have
    // settled" choice) — the detector's event time is always a frame time.
    const releaseT = 25 * DT;
    const p = computePhaseTiming(frames, { hand: 'right', releaseT });

    // Descent onset ≈ f5 (last standing frame), dip ≈ f17 (set-point end).
    expect(p.dipMs).not.toBeNull();
    expect(p.dipMs!).toBeGreaterThanOrEqual(((10 / 30) * 1000) - 1);
    expect(p.dipMs!).toBeLessThanOrEqual(((14 / 30) * 1000) + 1);

    // Raw wrist crosses the raw shoulder (y 45) on snap frame f20 (y 43).
    expect(p.riseMs).not.toBeNull();
    expect(p.riseMs!).toBeCloseTo((3 / 30) * 1000, 5);
    expect(p.releaseMs).not.toBeNull();
    expect(p.releaseMs!).toBeCloseTo((5 / 30) * 1000, 5);

    // Parked collinear arm holds the full follow-through window.
    expect(p.followMs).toBeCloseTo(300, 5);
  });

  test('a window opening at dip depth has NO observed descent → dipMs null', () => {
    // Set-point hold from frame 0 (no descent on record), then snap + park.
    const frames: RawSeqFrame[] = [];
    for (let i = 0; i < 30; i++) {
      let wrist: [number, number];
      let elbow: [number, number];
      if (i < 6) {
        wrist = [120, 85];
        elbow = [95, 85];
      } else if (i < 11) {
        const u = (i - 5) / 5;
        wrist = [120 - 25 * u, 85 - 70 * u];
        elbow = [95, 85 - 55 * u];
      } else {
        wrist = [95, 15];
        elbow = [95, 30];
      }
      frames.push(raw(i * DT, { ...STATIC, right_wrist: wrist, right_elbow: elbow }));
    }
    const releaseT = 13 * DT; // settled, 3 parked frames after the snap
    const p = computePhaseTiming(frames, { hand: 'right', releaseT });
    expect(p.dipMs).toBeNull();
    expect(p.riseMs).not.toBeNull();
    expect(p.followMs).not.toBeNull();
  });

  test('a missing shoulder leaves rise/release/follow unmeasured, never guessed', () => {
    const frames = Array.from({ length: 41 }, (_, i) => {
      const f = phaseFrame(i);
      f.pts.delete('right_shoulder');
      return f;
    });
    const p = computePhaseTiming(frames, { hand: 'right', releaseT: 25 * DT });
    expect(p.riseMs).toBeNull();
    expect(p.releaseMs).toBeNull();
    expect(p.followMs).toBeNull();
    // The dip only needs the wrist — still measured.
    expect(p.dipMs).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pickBestRep — gated, real-number reasons
// ---------------------------------------------------------------------------

describe('pickBestRep', () => {
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
    phases: { dipMs: null, riseMs: null, releaseMs: null, followMs: null },
    releaseHeightM: null,
    flags: [],
    tips: [],
    poseFps: 30,
  });

  test('picks the rep with the most in-band metrics; reason carries real numbers', () => {
    const reps = [
      mkRep(1, {
        setPointElbowDeg: 84,
        kneeFlexionDeg: 120,
        followThroughHeldMs: 300,
        releaseTimeMs: 500,
      }),
      mkRep(2, {
        setPointElbowDeg: 60,
        kneeFlexionDeg: 90,
        followThroughHeldMs: 100,
        releaseTimeMs: 600,
      }),
      mkRep(3, {
        setPointElbowDeg: 80,
        kneeFlexionDeg: 140,
        followThroughHeldMs: 300,
        releaseTimeMs: 700,
      }),
    ];
    const best = pickBestRep(reps, sessionSpreads(reps));
    expect(best).not.toBeNull();
    expect(best!.index).toBe(1);
    expect(best!.reason).toContain('elbow 84° in band');
    expect(best!.reason).toContain('knee 120° in band');
    expect(best!.reason).toContain('follow-through held 300 ms');
    // Rep 2's tempo is closer to the median — no "closest" claim for rep 1.
    expect(best!.reason).not.toContain('median');
  });

  test('band ties break by tempo closest to the session median', () => {
    const reps = [
      mkRep(1, { setPointElbowDeg: 84, releaseTimeMs: 500 }),
      mkRep(2, { setPointElbowDeg: 85, releaseTimeMs: 640 }),
      mkRep(3, { setPointElbowDeg: 60, releaseTimeMs: 600 }),
    ];
    const best = pickBestRep(reps, sessionSpreads(reps));
    // Median tempo = 600; rep 2 (|40|) beats rep 1 (|100|) on the tiebreak.
    expect(best).not.toBeNull();
    expect(best!.index).toBe(2);
  });

  test('fewer than 2 reps → null', () => {
    const reps = [mkRep(1, { setPointElbowDeg: 84, releaseTimeMs: 500 })];
    expect(pickBestRep(reps, sessionSpreads(reps))).toBeNull();
  });

  test('a winner with fewer than 2 measured metrics → null (never best by default)', () => {
    const reps = [
      mkRep(1, { setPointElbowDeg: 84 }),
      mkRep(2, { setPointElbowDeg: 95 }),
    ];
    expect(pickBestRep(reps, sessionSpreads(reps))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FormCheckSession v2 — the calibration state machine
// ---------------------------------------------------------------------------

describe('FormCheckSession calibration', () => {
  /** Resting pose: full static body + a still right arm below the shoulder. */
  const standingPose = (t: number): PoseFrame =>
    poseOf(t, {
      ...STATIC,
      right_elbow: [95, 70],
      right_wrist: [110, 90],
    });

  /** Feed `n` standing frames from t0 (the READY-frame pool). */
  function feedStanding(session: FormCheckSession, t0: number, n = 30): void {
    for (let i = 0; i < n; i++) {
      expect(session.push(standingPose(t0 + i * DT))).toBeNull();
    }
  }

  /** Pose with BOTH arms running the same snap script (mirror-ghost rig).
   *  The left arm is the right arm translated onto the LEFT shoulder
   *  (x − 10) so its own elbow-extension geometry matches exactly and both
   *  detectors fire on the same frames. */
  function poseBothArms(
    t: number,
    i: number,
    dipFrames: number,
    leftScore: number,
  ): PoseFrame {
    const pose = poseAt(t, i, dipFrames);
    const arm = armAt(i, dipFrames);
    pose.keypoints.left_elbow = {
      x: arm.elbow[0] - 10,
      y: arm.elbow[1],
      score: leftScore,
    };
    pose.keypoints.left_wrist = {
      x: arm.wrist[0] - 10,
      y: arm.wrist[1],
      score: leftScore,
    };
    return pose;
  }

  test('a session opens collecting; shadow motions are NEVER scored', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    expect(session.armed).toBe(false);
    expect(session.calibration.phase).toBe('collecting');
    const reps = runRep(session, { dipFrames: 20, parkFrames: 20 });
    expect(reps).toHaveLength(0);
    expect(session.reps).toHaveLength(0);
    expect(session.calibration.shadowReps).toBe(1);
  });

  test('SHADOW_REPS_TARGET motions complete calibration and arm scoring', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    runRep(session, { t0: 0, dipFrames: 20, parkFrames: 20 });
    runRep(session, { t0: 2, dipFrames: 20, parkFrames: 20 });
    expect(session.calibration.phase).toBe('done');
    expect(session.calibration.shadowReps).toBe(SHADOW_REPS_TARGET);
    expect(session.armed).toBe(true);
    // The next motion scores normally.
    const reps = runRep(session, { t0: 4, dipFrames: 20, parkFrames: 20 });
    expect(reps).toHaveLength(1);
    expect(session.reps).toHaveLength(1);
  });

  test('auto-handedness fixes a wrong Settings hand and reads handSource auto', () => {
    // Settings said LEFT; the shooter's motion is right-armed (the fixture
    // has no left elbow/wrist at all) — the dual-detector vote must commit
    // 'right' with full confidence.
    const session = new FormCheckSession({ hand: 'left', frameHeight: FRAME });
    runRep(session, { t0: 0, dipFrames: 20, parkFrames: 20 });
    runRep(session, { t0: 2, dipFrames: 20, parkFrames: 20 });
    expect(session.calibration.phase).toBe('done');
    expect(session.hand).toBe('right');
    expect(session.calibration.handSource).toBe('auto');
    // Scoring now works on the corrected arm. The trailing readiness window
    // still holds pre-flip samples taken while watching the (invisible) left
    // arm, so a longer dip-hold lets the arm gate refill honestly before the
    // snap — the gate pausing until then is correct refuse-don't-guess.
    const reps = runRep(session, { t0: 4, dipFrames: 55, parkFrames: 16 });
    expect(reps).toHaveLength(1);
  });

  test('mirror-ghost double fire with near-tied scores ABSTAINS (stays assumed)', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    // Both arms fire on every motion; scores 0.85 vs 0.9 are inside the 10%
    // tie band → every vote abstains → no auto commit.
    const run = (t0: number) => {
      for (let i = 0; i < 45; i++) {
        session.push(poseBothArms(t0 + i * DT, i, 20, 0.85));
      }
    };
    run(0);
    run(2);
    expect(session.calibration.phase).toBe('done');
    expect(session.calibration.handSource).toBe('settings');
    expect(session.hand).toBe('right');
  });

  test('mirror-ghost double fire with a clear score gap votes the higher arm', () => {
    const session = new FormCheckSession({ hand: 'left', frameHeight: FRAME });
    // Left is a low-score ghost (0.5 vs 0.9 — a 44% gap): the vote goes to
    // the right arm each motion and commits.
    const run = (t0: number) => {
      for (let i = 0; i < 45; i++) {
        session.push(poseBothArms(t0 + i * DT, i, 20, 0.5));
      }
    };
    run(0);
    run(2);
    expect(session.calibration.phase).toBe('done');
    expect(session.hand).toBe('right');
    expect(session.calibration.handSource).toBe('auto');
  });

  test('a manual hand choice wins permanently — auto never overrides it', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    session.setHand('left'); // the tap-to-flip chip: source defaults 'manual'
    expect(session.calibration.handSource).toBe('manual');
    runRep(session, { t0: 0, dipFrames: 20, parkFrames: 20 });
    runRep(session, { t0: 2, dipFrames: 20, parkFrames: 20 });
    expect(session.calibration.phase).toBe('done');
    // The vote said right, but manual wins.
    expect(session.hand).toBe('left');
    expect(session.calibration.handSource).toBe('manual');
  });

  test('skipCalibration arms immediately with every calibration field null', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    session.skipCalibration();
    expect(session.armed).toBe(true);
    const c = session.calibration;
    expect(c.phase).toBe('skipped');
    expect(c.shadowReps).toBe(0);
    expect(c.sidenessAvg).toBeNull();
    expect(c.tilt).toBeNull();
    expect(c.scale).toBeNull();
    expect(c.standingWristY).toBeNull();
    expect(c.stanceWidthN).toBeNull();
    expect(c.setPointWristY).toBeNull();
    // Pure v1 behavior: the next motion scores.
    const reps = runRep(session, { dipFrames: 20, parkFrames: 20 });
    expect(reps).toHaveLength(1);
  });

  test('completeCalibration locks after 1 shadow rep; no-op with zero', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    session.completeCalibration(); // nothing collected — must stay collecting
    expect(session.calibration.phase).toBe('collecting');
    runRep(session, { t0: 0, dipFrames: 20, parkFrames: 20 });
    expect(session.calibration.shadowReps).toBe(1);
    session.completeCalibration();
    expect(session.calibration.phase).toBe('done');
    expect(session.armed).toBe(true);
  });

  test('recalibrate re-enters collecting and KEEPS scored reps', () => {
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    runRep(session, { t0: 0, dipFrames: 20, parkFrames: 20 });
    expect(session.reps).toHaveLength(1);
    session.recalibrate();
    expect(session.armed).toBe(false);
    // Motions during re-collection are shadow reps, not scored ones.
    const shadow = runRep(session, { t0: 3, dipFrames: 20, parkFrames: 20 });
    expect(shadow).toHaveLength(0);
    expect(session.reps).toHaveLength(1);
    runRep(session, { t0: 5, dipFrames: 20, parkFrames: 20 });
    expect(session.calibration.phase).toBe('done');
    const reps = runRep(session, { t0: 7, dipFrames: 20, parkFrames: 20 });
    expect(reps).toHaveLength(1);
    expect(session.reps).toHaveLength(2);
  });

  test('recalibrate drops a stale auto vote back to ASSUMED until the new lock', () => {
    // First calibration commits 'auto' (Settings said left, motion is right-
    // armed). Recalibrating discards that vote with the other locked fields:
    // until the NEW lock re-votes (and it may abstain), the chip must read
    // ASSUMED — never a stale "detected". The watched arm keeps its side.
    const session = new FormCheckSession({ hand: 'left', frameHeight: FRAME });
    runRep(session, { t0: 0, dipFrames: 20, parkFrames: 20 });
    runRep(session, { t0: 2, dipFrames: 20, parkFrames: 20 });
    expect(session.calibration.handSource).toBe('auto');
    expect(session.hand).toBe('right');
    session.recalibrate();
    expect(session.calibration.phase).toBe('collecting');
    expect(session.calibration.handSource).toBe('settings');
    expect(session.hand).toBe('right');
    // A mid-recollection Skip locks nothing — still ASSUMED.
    session.skipCalibration();
    expect(session.calibration.phase).toBe('skipped');
    expect(session.calibration.handSource).toBe('settings');
  });

  test('a manual pick survives recalibrate and skip (no vote involved)', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    session.setHand('left'); // the tap-to-flip chip: source defaults 'manual'
    session.recalibrate();
    expect(session.calibration.handSource).toBe('manual');
    session.skipCalibration();
    expect(session.calibration.handSource).toBe('manual');
    expect(session.hand).toBe('left');
  });

  test('a long motionless stand keeps the standing collectors bounded', () => {
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      heightCm: 190,
    });
    // 900 frames (30 s) of standing perfectly still — ONE contiguous run
    // that never flushes. Without the in-progress cap this run grows one
    // RawSeqFrame per camera frame for as long as the shooter stands there.
    feedStanding(session, 0, 900);
    // Private peek (STANDING_FRAMES_CAP = 300): the memory bound has no
    // public observable, and this is exactly what it must bound.
    const s = session as unknown as {
      standingRun: RawSeqFrame[];
      standingFrames: RawSeqFrame[];
    };
    expect(s.standingRun.length).toBeLessThanOrEqual(300);
    expect(s.standingFrames.length).toBeLessThanOrEqual(300);
    // The gauges still lock normally from the capped pool.
    runRep(session, { t0: 31, dipFrames: 20, parkFrames: 20 });
    runRep(session, { t0: 33, dipFrames: 20, parkFrames: 20 });
    const c = session.calibration;
    expect(c.phase).toBe('done');
    expect(c.tilt).not.toBeNull();
    expect(c.scale).not.toBeNull();
    expect(c.standingWristY).not.toBeNull();
  });

  test('shadow-rep baselines lock into the receipt (standing pool + dips)', () => {
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      heightCm: 190,
    });
    feedStanding(session, 0, 30);
    runRep(session, { t0: 1.5, dipFrames: 20, parkFrames: 20 });
    runRep(session, { t0: 3.5, dipFrames: 20, parkFrames: 20 });
    const c = session.calibration;
    expect(c.phase).toBe('done');
    // The set point is the deepest shadow dip: the fixture holds (120, 80).
    expect(c.setPointWristY).not.toBeNull();
    expect(c.setPointWristY!).toBeCloseTo(80, 0);
    expect(c.standingWristY).not.toBeNull();
    expect(c.stanceWidthN).not.toBeNull();
    expect(c.stanceWidthN!).toBeGreaterThan(0);
    expect(c.sidenessAvg).not.toBeNull();
    // The static fixture stands perfectly still → a tilt estimate exists.
    expect(c.tilt).not.toBeNull();
    expect(c.tilt!.stdDeg).toBeLessThanOrEqual(TILT_STD_MAX_DEG);
    // Height was given + span stable → metres scale exists.
    expect(c.scale).not.toBeNull();
    expect(c.scale!.heightCm).toBe(190);
  });

  test('releaseHeightM appears only with a profile height, as a plausible estimate', () => {
    const withHeight = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      heightCm: 190,
    });
    feedStanding(withHeight, 0, 30);
    runRep(withHeight, { t0: 1.5, dipFrames: 20, parkFrames: 20 });
    runRep(withHeight, { t0: 3.5, dipFrames: 20, parkFrames: 20 });
    const reps = runRep(withHeight, { t0: 6, dipFrames: 20, parkFrames: 20 });
    expect(reps).toHaveLength(1);
    expect(reps[0]!.releaseHeightM).not.toBeNull();
    // ~125 px shooter releasing overhead — the estimate must be a plausible
    // human release height, not a fabricated precision number.
    expect(reps[0]!.releaseHeightM!).toBeGreaterThan(1.0);
    expect(reps[0]!.releaseHeightM!).toBeLessThan(3.2);

    // No profile height ⇒ the row keeps v1's normalized unit only.
    const noHeight = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    feedStanding(noHeight, 0, 30);
    runRep(noHeight, { t0: 1.5, dipFrames: 20, parkFrames: 20 });
    runRep(noHeight, { t0: 3.5, dipFrames: 20, parkFrames: 20 });
    const reps2 = runRep(noHeight, { t0: 6, dipFrames: 20, parkFrames: 20 });
    expect(reps2).toHaveLength(1);
    expect(reps2[0]!.releaseHeightM).toBeNull();
    expect(reps2[0]!.metrics.releaseHeightNorm).not.toBeNull();
  });

  test('a scored rep dipping well short of the shadow set point is FLAGGED, not modified', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    feedStanding(session, 0, 30);
    // Calibrate on deep dips (wrist y 80).
    runRep(session, { t0: 1.5, dipFrames: 20, parkFrames: 20 });
    runRep(session, { t0: 3.5, dipFrames: 20, parkFrames: 20 });
    expect(session.calibration.phase).toBe('done');

    // Scored rep with a shallow dip (wrist y 55): 25 px short of the 80 px
    // set point > 15% of the ~140 px body height.
    const shallowArm = (i: number): { elbow: [number, number]; wrist: [number, number] } => {
      const k = i - 20;
      if (k < 0) return { elbow: [95, 55], wrist: [120, 55] };
      if (k >= 5) return { elbow: [95, 30], wrist: [95, 15] };
      const u = (k + 1) / 5;
      return { elbow: [95, 55 - 25 * u], wrist: [120 - 25 * u, 55 - 40 * u] };
    };
    const reps: FormCheckRep[] = [];
    for (let i = 0; i < 45; i++) {
      const arm = shallowArm(i);
      const pose = poseOf(6 + i * DT, {
        ...STATIC,
        right_elbow: arm.elbow,
        right_wrist: arm.wrist,
      });
      const rep = session.push(pose);
      if (rep != null) reps.push(rep);
    }
    expect(reps).toHaveLength(1);
    expect(reps[0]!.flags).toContain('shallowDip');
    expect(reps[0]!.flags).not.toContain('stanceDrift');
    // ANNOTATE-ONLY: metrics are still measured normally.
    expect(reps[0]!.metrics.setPointElbowDeg).not.toBeNull();
  });

  test('a matching scored rep carries no flags', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    feedStanding(session, 0, 30);
    runRep(session, { t0: 1.5, dipFrames: 20, parkFrames: 20 });
    runRep(session, { t0: 3.5, dipFrames: 20, parkFrames: 20 });
    const reps = runRep(session, { t0: 6, dipFrames: 20, parkFrames: 20 });
    expect(reps).toHaveLength(1);
    expect(reps[0]!.flags).toEqual([]);
  });

  test('finalizeSession carries the calibration receipt + verdict counts', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    runRep(session, { t0: 0, dipFrames: 20, parkFrames: 20 });
    runRep(session, { t0: 2, dipFrames: 20, parkFrames: 20 });
    runRep(session, { t0: 4, dipFrames: 20, parkFrames: 20 });
    runRep(session, { t0: 6, dipFrames: 20, parkFrames: 20 });
    const report = session.finalizeSession();
    expect(report.repCount).toBe(2);
    expect(report.calibration.phase).toBe('done');
    // 2 scored reps < MIN_SPREAD_REPS ⇒ nothing measured, nothing steady.
    expect(report.verdict).toEqual({ steady: 0, measured: 0 });
    // pickBestRep may still gate to null on 2 reps' measured metrics —
    // whatever it returns must match the pure function on the same inputs.
    expect(report.best).toEqual(pickBestRep(session.reps, report.spreads));
  });

  test('a skipped session finalizes with a pure v1-shaped report (nulls, honest)', () => {
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    const reps = runRep(session, { dipFrames: 20, parkFrames: 20 });
    expect(reps).toHaveLength(1);
    expect(reps[0]!.releaseHeightM).toBeNull();
    expect(reps[0]!.flags).toEqual([]);
    const report = session.finalizeSession();
    expect(report.calibration.phase).toBe('skipped');
    expect(report.calibration.tilt).toBeNull();
    expect(report.calibration.scale).toBeNull();
  });
});
