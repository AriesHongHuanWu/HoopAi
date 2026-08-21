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
  computeRepMetricsDetailed,
  DIP_EPS_PX,
  dipEpsFor,
  estimateTilt,
  FOLLOW_TAIL_SEC,
  FORM_MOTION,
  FormCheckSession,
  FormMotionDetector,
  followThroughHeldFull,
  FPS_OVERRIDE_MIN,
  frameVisibility,
  FT_ELBOW_MIN_DEG,
  GATHER_MAX_ELBOW_DEG,
  GATHER_WRIST_BELOW_HIP_FRAC,
  heightScaleOf,
  MIN_POSE_FPS,
  MIN_SPREAD_REPS,
  MOTION_MAX_VY_GAP_SEC,
  NOSE_TO_ANKLE_STATURE_FRAC,
  pickBestRep,
  PRE_RELEASE_SEC,
  readinessOf,
  REP_BUFFER_SEC,
  REP_CONFIDENCE_REASONS,
  savedLowConfidenceOf,
  sessionSpreads,
  READINESS_WINDOW_SEC,
  READY_LATCH_SEC,
  SHADOW_REPS_TARGET,
  SIDE_PROFILE_MIN,
  SIDE_PROFILE_TRUSTED,
  sideProfileOf,
  TILT_MAX_COMP_DEG,
  TILT_STD_MAX_DEG,
  type FormCheckRep,
  type ReadinessSample,
} from '@/core/formCheck';
import { FORM, RELEASE } from '@/core/config';
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

  // RE-PINNED (v3 demo hardening): the gate used to demand BOTH hips and an
  // ANKLE. At a true side profile the far hip routinely scores under the
  // keypoint floor, and a cramped room may not have the floor space the
  // centre-square crop needs before head AND feet both fit — both bricked
  // the whole screen with no override. It now needs a head, ONE hip and a
  // lower-body base (ankle or knee). The refusals below are the ones that
  // still matter: no anchor at all, and the wrong arm.
  test('frameVisibility needs a head, a hip, a lower-body base and the shooting arm', () => {
    const full = poseAt(0, 0, 20);
    expect(frameVisibility(full, 'right')).toEqual({ fullBody: true, arm: true });

    // Far-side hip missing → still measurable (pairMid falls back to one hip).
    const noLeftHip = poseAt(0, 0, 20);
    delete noLeftHip.keypoints.left_hip;
    expect(frameVisibility(noLeftHip, 'right').fullBody).toBe(true);

    // BOTH hips missing → no trunk anchor at all → refuses.
    const noHips = poseAt(0, 0, 20);
    delete noHips.keypoints.left_hip;
    delete noHips.keypoints.right_hip;
    expect(frameVisibility(noHips, 'right').fullBody).toBe(false);

    // Ankles out of frame but knees visible → knees are an honest base
    // (bodyHeightOf already falls back to them; kneeFlexionDeg goes null).
    const noAnkles = poseAt(0, 0, 20);
    delete noAnkles.keypoints.left_ankle;
    delete noAnkles.keypoints.right_ankle;
    expect(frameVisibility(noAnkles, 'right').fullBody).toBe(true);

    // Nothing below the hips at all → refuses.
    const noLegs = poseAt(0, 0, 20);
    delete noLegs.keypoints.left_ankle;
    delete noLegs.keypoints.right_ankle;
    delete noLegs.keypoints.left_knee;
    delete noLegs.keypoints.right_knee;
    expect(frameVisibility(noLegs, 'right').fullBody).toBe(false);

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

  // RE-PINNED (v3 demo hardening): the debounce moved off the live-game
  // RELEASE cooldown (1.5 s) onto FORM_MOTION.debounceSec (0.8 s) — a
  // presenter fires three or four motions in four seconds and the counter
  // has to move. The ASSERTION is unchanged (a repeat signature inside the
  // debounce mints nothing); only the fixture's spacing tracks the new
  // value, and the companion test below pins the case the old value ate.
  test('a repeat signature inside FORM_MOTION.debounceSec cannot mint a second rep', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME, calibrate: false });
    const reps: FormCheckRep[] = [];
    // First signature completes at f13 (0.433 s); the second at f27
    // (0.900 s) — 0.467 s later, inside the 0.8 s debounce.
    reps.push(...runRep(session, { t0: 0, dipFrames: 10, parkFrames: 3 }));
    reps.push(...runRep(session, { t0: 18 / 30, dipFrames: 6, parkFrames: 8 }));
    // Trailing frames so the first rep's follow tail can complete.
    for (let i = 0; i < 20; i++) {
      const rep = session.push(poseAt(37 / 30 + i / 30, 25, 10));
      if (rep != null) reps.push(rep);
    }
    expect(reps).toHaveLength(1);
    expect(session.reps).toHaveLength(1);
  });

  test('two deliberate motions a second apart BOTH count', () => {
    // The live-game 1.5 s cooldown ate the second one, so the counter read 2
    // when the room had watched 4. The debounce must still clear the
    // follow-through tail, or a pending rep would swallow the next event.
    expect(FORM_MOTION.debounceSec).toBeGreaterThan(FOLLOW_TAIL_SEC);

    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME, calibrate: false });
    const reps: FormCheckRep[] = [];
    // Signatures at f13 (0.433 s) and f43 (1.433 s): exactly 1.0 s apart.
    reps.push(...runRep(session, { t0: 0, dipFrames: 10, parkFrames: 15 }));
    reps.push(...runRep(session, { t0: 1, dipFrames: 10, parkFrames: 20 }));
    expect(reps).toHaveLength(2);
    expect(session.reps).toHaveLength(2);
    expect(reps[1]!.releaseT - reps[0]!.releaseT).toBeCloseTo(1, 6);
  });

  test('sub-15 fps pose refuses to count reps at all', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME, calibrate: false });
    const reps = runRep(session, { fps: 10, dipFrames: 20, parkFrames: 20 });
    expect(reps).toHaveLength(0);
    expect(session.reps).toHaveLength(0);
    expect(session.readiness.fpsOk).toBe(false);
    expect(session.readiness.ready).toBe(false);
  });

  // RE-PINNED (v3 demo hardening): the old fixture kept both KNEES, which
  // the relaxed gate now honestly accepts as a lower-body base. The refusal
  // being pinned is unchanged — a body with no anchor below the hips cannot
  // be measured — so the fixture drops the knees too.
  test('a shooter with nothing below the hips in frame counts zero reps', () => {
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME, calibrate: false });
    for (let i = 0; i < 45; i++) {
      const pose = poseAt(i * DT, i, 20);
      // Legs out of frame (too close to the camera): no ankles, no knees.
      delete pose.keypoints.left_ankle;
      delete pose.keypoints.right_ankle;
      delete pose.keypoints.left_knee;
      delete pose.keypoints.right_knee;
      expect(session.push(pose)).toBeNull();
    }
    expect(session.reps).toHaveLength(0);
    expect(session.readiness.fullBodyOk).toBe(false);
  });

  test('ankles out of frame: the rep counts and the knee angle stays NULL', () => {
    // The relaxation buys back a shooter standing too close for the centre-
    // square crop to hold their feet. It must not buy back a NUMBER: every
    // ankle-dependent metric refuses rather than being estimated from knees.
    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME, calibrate: false });
    const reps: FormCheckRep[] = [];
    for (let i = 0; i < 45; i++) {
      const pose = poseAt(i * DT, i, 20);
      delete pose.keypoints.left_ankle;
      delete pose.keypoints.right_ankle;
      delete pose.keypoints.left_hip; // far hip lost at a true side profile
      const rep = session.push(pose);
      if (rep != null) reps.push(rep);
    }
    expect(session.readiness.fullBodyOk).toBe(true);
    expect(reps).toHaveLength(1);
    expect(reps[0]!.metrics.kneeFlexionDeg).toBeNull();
    expect(reps[0]!.releaseHeightM).toBeNull();
    // The arm metrics it COULD measure are still measured.
    expect(reps[0]!.metrics.setPointElbowDeg).not.toBeNull();
    expectNoNaN(reps[0]!.metrics);
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

// ---------------------------------------------------------------------------
// V3 demo hardening — the slow, ball-free, room-distance demo motion
// ---------------------------------------------------------------------------

/**
 * Fixture: a shooter standing far enough back that the whole body is ~128 px
 * of the 192 analysis square (the stage case — 2.5-3 m from the phone), side
 * on, performing a DELIBERATE ball-free shooting motion: the wrist rises
 * ~59 px and the elbow opens to ~138° in a push that never fully extends.
 *
 * This is the motion the live-game RELEASE tuning refuses outright, with
 * every readiness chip green — the fixture exists to pin that it now counts.
 */
const FAR_BODY: Partial<Record<PoseKeypointName, [number, number]>> = {
  nose: [100, 30],
  right_shoulder: [98, 50],
  left_shoulder: [94, 50],
  right_hip: [99, 100],
  left_hip: [96, 100],
  right_knee: [99, 128],
  left_knee: [96, 128],
  right_ankle: [99, 158],
  left_ankle: [96, 158],
};
/** Set point: elbow under the shoulder, forearm out — elbow ~90°. */
const SLOW_DIP = { elbow: [101, 76] as const, wrist: [118, 74] as const };
/** Top of the push: elbow flared forward, wrist overhead — elbow ~138°. */
const SLOW_TOP = { elbow: [104, 38] as const, wrist: [97.6, 14.9] as const };
/** Wrist rise over the whole motion, px (74 -> 14.9). */
const SLOW_RISE_PX = SLOW_DIP.wrist[1] - SLOW_TOP.wrist[1];
/** The upward-speed floor in px/s for this frame size. */
const VY_FLOOR_PX = FORM_MOTION.minUpwardWristVyFracPerSec * FRAME;

/** The slow motion frozen at progress `u` (0 = set point, 1 = top). */
function slowPose(t: number, u: number, score = 0.9): PoseFrame {
  const c = Math.max(0, Math.min(1, u));
  const lerp = (a: number, b: number) => a + (b - a) * c;
  return poseOf(
    t,
    {
      ...FAR_BODY,
      right_elbow: [
        lerp(SLOW_DIP.elbow[0], SLOW_TOP.elbow[0]),
        lerp(SLOW_DIP.elbow[1], SLOW_TOP.elbow[1]),
      ],
      right_wrist: [
        lerp(SLOW_DIP.wrist[0], SLOW_TOP.wrist[0]),
        lerp(SLOW_DIP.wrist[1], SLOW_TOP.wrist[1]),
      ],
    },
    score,
  );
}

/**
 * The slow motion rising at EXACTLY `vyPxPerSec`: `holdSec` at the set
 * point, the rise, then `tailSec` held at the top. `maxU` stops the motion
 * short of full extension (a push that never opens the elbow).
 */
function slowMotion(opts: {
  vyPxPerSec: number;
  t0?: number;
  fps?: number;
  holdSec?: number;
  tailSec?: number;
  maxU?: number;
}): PoseFrame[] {
  const { vyPxPerSec, t0 = 0, fps = 30, holdSec = 1, tailSec = 1, maxU = 1 } = opts;
  const hold = Math.round(holdSec * fps);
  const rise = Math.round((SLOW_RISE_PX * maxU) / (vyPxPerSec / fps));
  const tail = Math.round(tailSec * fps);
  const frames: PoseFrame[] = [];
  for (let i = 0; i < hold + rise + tail; i++) {
    const u =
      i <= hold
        ? 0
        : Math.min(maxU, ((i - hold) * (vyPxPerSec / fps)) / SLOW_RISE_PX);
    frames.push(slowPose(t0 + i / fps, u));
  }
  return frames;
}

function feed(
  session: FormCheckSession,
  frames: readonly PoseFrame[],
): FormCheckRep[] {
  const reps: FormCheckRep[] = [];
  for (const f of frames) {
    const rep = session.push(f);
    if (rep != null) reps.push(rep);
  }
  return reps;
}

/** Peak elbow angle of the slow fixture at progress `u`. */
function slowElbowDeg(u: number): number {
  const p = slowPose(0, u);
  return angleAtDeg(
    p.keypoints.right_shoulder!,
    p.keypoints.right_elbow!,
    p.keypoints.right_wrist!,
  )!;
}

describe('the slow ball-free demo motion', () => {
  test('the live-game RELEASE tuning refuses it — that is why FORM_MOTION exists', () => {
    // The motion's own numbers, measured off the fixture: both sit under the
    // live tuning's floors, so the shared detector fires NOTHING while every
    // readiness chip reads green. This is the demo-killer being fixed, and
    // this assertion is what breaks if anyone re-points Form Check at
    // RELEASE (or narrows FORM_MOTION back toward it).
    expect(slowElbowDeg(1)).toBeLessThan(RELEASE.minElbowExtensionDeg);
    expect(slowElbowDeg(1)).toBeGreaterThanOrEqual(
      FORM_MOTION.minElbowExtensionDeg,
    );

    // A 1.2 s rise — an unhurried demonstration motion.
    const vy = SLOW_RISE_PX / 1.2;
    expect(vy).toBeLessThan(RELEASE.minUpwardWristVyFracPerSec * FRAME);
    expect(vy).toBeGreaterThan(VY_FLOOR_PX);
  });

  test('it is fully READY — nothing on screen would explain a zero count', () => {
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    feed(session, slowMotion({ vyPxPerSec: SLOW_RISE_PX / 1.2 }));
    const r = session.readiness;
    expect(r.fpsOk).toBe(true);
    expect(r.fullBodyOk).toBe(true);
    expect(r.armOk).toBe(true);
    expect(r.sideOk).toBe(true);
    expect(r.sideTrusted).toBe(true);
    expect(r.ready).toBe(true);
  });

  test('it counts exactly one rep, with honest metrics and no ball numbers', () => {
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    const reps = feed(session, slowMotion({ vyPxPerSec: SLOW_RISE_PX / 1.2 }));
    expect(reps).toHaveLength(1);
    expect(reps[0]!.metrics.releaseAngleDeg).toBeNull();
    expect(reps[0]!.metrics.entryAngleDeg).toBeNull();
    expect(reps[0]!.lowConfidence).toEqual([]);
    expectNoNaN(reps[0]!.metrics);
  });

  test('a push that never opens the elbow past the floor counts NOTHING', () => {
    // maxU 0.8 tops out under FORM_MOTION.minElbowExtensionDeg. The floor is
    // relaxed, not removed: an arm that only half-lifts is still not a
    // shooting motion.
    expect(slowElbowDeg(0.8)).toBeLessThan(FORM_MOTION.minElbowExtensionDeg);
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    const reps = feed(
      session,
      slowMotion({ vyPxPerSec: SLOW_RISE_PX / 1.2, maxU: 0.8 }),
    );
    expect(session.readiness.ready).toBe(true);
    expect(reps).toHaveLength(0);
  });

  test('above the upward-speed floor it counts; below it, it does not', () => {
    const run = (vyPxPerSec: number) => {
      const session = new FormCheckSession({
        hand: 'right',
        frameHeight: FRAME,
        calibrate: false,
      });
      return feed(session, slowMotion({ vyPxPerSec, holdSec: 1, tailSec: 1.5 }));
    };
    // +8% over the floor: a ~2.4 s rise. Counted.
    expect(run(VY_FLOOR_PX * 1.08)).toHaveLength(1);
    // -8% under it: a ~2.8 s rise, slower than any shooting motion. Refused,
    // because a wrist drifting that slowly is not a release signature.
    expect(run(VY_FLOOR_PX * 0.92)).toHaveLength(0);
  });
});

describe('FormMotionDetector thresholds', () => {
  const detect = (frames: readonly PoseFrame[]) => {
    const d = new FormMotionDetector({ hand: 'right', frameHeight: FRAME });
    let fired = 0;
    for (const f of frames) if (d.push(f) != null) fired++;
    return fired;
  };

  test('fires AT the upward-speed floor and refuses a hair below it', () => {
    expect(detect(slowMotion({ vyPxPerSec: VY_FLOOR_PX * 1.001 }))).toBe(1);
    expect(detect(slowMotion({ vyPxPerSec: VY_FLOOR_PX * 0.999 }))).toBe(0);
  });

  test('fires AT the elbow floor and refuses a hair below it', () => {
    // Walk the motion's progress until its elbow angle brackets the floor.
    let atU = 1;
    for (let u = 0.8; u <= 1.0001; u += 0.005) {
      if (slowElbowDeg(u) >= FORM_MOTION.minElbowExtensionDeg) {
        atU = u;
        break;
      }
    }
    expect(slowElbowDeg(atU)).toBeGreaterThanOrEqual(
      FORM_MOTION.minElbowExtensionDeg,
    );
    expect(slowElbowDeg(atU - 0.02)).toBeLessThan(
      FORM_MOTION.minElbowExtensionDeg,
    );
    const fast = SLOW_RISE_PX / 1.2;
    expect(detect(slowMotion({ vyPxPerSec: fast, maxU: atU }))).toBe(1);
    expect(detect(slowMotion({ vyPxPerSec: fast, maxU: atU - 0.02 }))).toBe(0);
  });

  test('a completed signature is CONSUMED — a still wrist never re-fires it', () => {
    // The shortened debounce made a standing set of conditions dangerous: it
    // would mint a rep the instant the cooldown lapsed, off a wrist that had
    // been motionless for hundreds of ms. Hold the top for 3 s (well past
    // FORM_MOTION.debounceSec) and nothing more may fire.
    expect(detect(slowMotion({ vyPxPerSec: SLOW_RISE_PX / 1.2, tailSec: 3 }))).toBe(
      1,
    );
  });

  test('a wrist sampled further apart than the velocity gap cannot fire', () => {
    // The gap guard is what makes FPS_OVERRIDE_MIN a real floor rather than a
    // promise: past it no two samples make a velocity, so no relaxation
    // anywhere can rescue the session.
    expect(FPS_OVERRIDE_MIN).toBeGreaterThanOrEqual(1 / MOTION_MAX_VY_GAP_SEC);
    const fps = 5; // dt 0.2 s > MOTION_MAX_VY_GAP_SEC
    expect(detect(slowMotion({ vyPxPerSec: SLOW_RISE_PX / 1.2, fps }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// V3 demo hardening — relaxed gates and the confidence they cost
// ---------------------------------------------------------------------------

describe('the fps floor and its labeled override', () => {
  const at = (fps: number) =>
    Array.from({ length: 20 }, (_, i) => ({
      t: i / fps,
      fullBody: true,
      arm: true,
      sideness: 0.9,
    }));

  test('the floor itself never moves', () => {
    // The override is relief, not a redefinition: MIN_POSE_FPS is shared
    // with Jump Lab's refuse-don't-guess contract and stays where it is.
    expect(MIN_POSE_FPS).toBe(15);
    expect(readinessOf(at(12)).fpsOk).toBe(false);
    expect(readinessOf(at(12)).ready).toBe(false);
  });

  test('with the override the session counts, and SAYS the rate is low', () => {
    const r = readinessOf(at(12), { fpsFloorOverride: true });
    expect(r.ready).toBe(true);
    expect(r.fpsOk).toBe(true);
    expect(r.fpsOverridden).toBe(true);
    // The measured rate is reported unchanged — no rounding it up to the
    // floor, no pretending the timing is worth what 30 fps timing is worth.
    expect(r.fps).toBeCloseTo(12, 6);
  });

  test('a healthy rate is never marked overridden', () => {
    const r = readinessOf(at(30), { fpsFloorOverride: true });
    expect(r.fpsOk).toBe(true);
    expect(r.fpsOverridden).toBe(false);
  });

  test('the override refuses below FPS_OVERRIDE_MIN and on an empty window', () => {
    // Below the velocity-gap floor nothing can fire however open the gate
    // is, so the honest answer is to keep refusing rather than promise a
    // rescue that cannot arrive.
    const tooSlow = readinessOf(at(6), { fpsFloorOverride: true });
    expect(tooSlow.fpsOk).toBe(false);
    expect(tooSlow.fpsOverridden).toBe(false);
    expect(tooSlow.ready).toBe(false);

    // fps 0 is "no data yet", not "a slow camera" — never override it.
    const empty = readinessOf([], { fpsFloorOverride: true });
    expect(empty.fps).toBe(0);
    expect(empty.fpsOk).toBe(false);
    expect(empty.ready).toBe(false);
  });

  test('a session at 10 fps counts nothing until the presenter overrides', () => {
    const strict = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    expect(runRep(strict, { fps: 10, dipFrames: 20, parkFrames: 20 })).toHaveLength(0);

    const relaxed = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    relaxed.overrideFpsFloor();
    expect(relaxed.fpsFloorOverridden).toBe(true);
    const reps = runRep(relaxed, { fps: 10, dipFrames: 20, parkFrames: 20 });

    expect(reps).toHaveLength(1);
    expect(relaxed.readiness.fpsOverridden).toBe(true);
    // The rep is real and its numbers were measured — they are just coarse,
    // and the rep says so rather than passing as a clean capture.
    expect(reps[0]!.lowConfidence).toContain('lowPoseFps');
    expect(reps[0]!.poseFps).toBeLessThan(MIN_POSE_FPS);
    expect(reps[0]!.metrics.releaseTimeMs).not.toBeNull();

    const report = relaxed.finalizeSession();
    expect(report.lowConfidence).toEqual({ reps: 1, reasons: ['lowPoseFps'] });
  });

  test('switching the override back off restores the refusal', () => {
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    session.overrideFpsFloor();
    runRep(session, { fps: 10, dipFrames: 20, parkFrames: 20 });
    expect(session.reps).toHaveLength(1);
    session.overrideFpsFloor(false);
    expect(session.fpsFloorOverridden).toBe(false);
    runRep(session, { t0: 10, fps: 10, dipFrames: 20, parkFrames: 20 });
    expect(session.reps).toHaveLength(1);
    expect(session.readiness.fpsOk).toBe(false);
  });
});

describe('the readiness latch around a keypoint dropout', () => {
  /** The same pose with everything below the shoulders lost. */
  const dropLowerBody = (pose: PoseFrame): PoseFrame => {
    delete pose.keypoints.left_hip;
    delete pose.keypoints.right_hip;
    delete pose.keypoints.left_knee;
    delete pose.keypoints.right_knee;
    delete pose.keypoints.left_ankle;
    delete pose.keypoints.right_ankle;
    return pose;
  };

  test('a dropout at the top of the motion no longer swallows the rep', () => {
    // The gates are trailing-window fractions, so ~0.4 s of lost keypoints
    // flips them — and the top of a shooting motion is exactly when
    // keypoints go missing. A hard gate stopped feeding the detector
    // mid-signature and the rep vanished with nothing on screen to explain
    // it. The latch carries the feed through; the rep is REPORTED as caught
    // through a dropout, and the strict verdict stays false so the strip
    // cannot go green on a capture it did not have.
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    const reps: FormCheckRep[] = [];
    for (let i = 0; i < 45; i++) {
      const pose = poseAt(i * DT, i, 20);
      if (i >= 10 && i <= 30) dropLowerBody(pose);
      const rep = session.push(pose);
      if (rep != null) reps.push(rep);
    }
    expect(reps).toHaveLength(1);
    expect(reps[0]!.lowConfidence).toContain('gateDropout');
    expect(session.finalizeSession().lowConfidence).toEqual({
      reps: 1,
      reasons: ['gateDropout'],
    });
  });

  test('the latch is finite — a long dropout still refuses', () => {
    // READY_LATCH_SEC buys a motion through a blink, not a session through a
    // shooter who has walked out of frame.
    expect(READY_LATCH_SEC).toBeLessThanOrEqual(READINESS_WINDOW_SEC);
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    const reps: FormCheckRep[] = [];
    // Clean until f29, then lost for the rest — the snap lands at f78,
    // more than READY_LATCH_SEC after the gates last passed.
    for (let i = 0; i < 100; i++) {
      const pose = poseAt(i * DT, i, 75);
      if (i >= 30) dropLowerBody(pose);
      const rep = session.push(pose);
      if (rep != null) reps.push(rep);
    }
    expect(reps).toHaveLength(0);
    expect(session.readiness.fullBodyOk).toBe(false);
  });
});

describe('the side-profile gate and the angle confidence it costs', () => {
  test('the floor brackets: 0.34 refuses, 0.36 counts', () => {
    const win = (sideness: number) =>
      readinessOf(
        Array.from({ length: 30 }, (_, i) => ({
          t: i * DT,
          fullBody: true,
          arm: true,
          sideness,
        })),
      );
    expect(SIDE_PROFILE_MIN).toBeLessThan(SIDE_PROFILE_TRUSTED);
    expect(win(SIDE_PROFILE_MIN - 0.01).sideOk).toBe(false);
    expect(win(SIDE_PROFILE_MIN + 0.01).sideOk).toBe(true);
    // Counting is not the same as trusting the angles.
    expect(win(SIDE_PROFILE_MIN + 0.01).sideTrusted).toBe(false);
    expect(win(SIDE_PROFILE_TRUSTED + 0.05).sideTrusted).toBe(true);
  });

  /** The fixture turned ~40° toward the camera (sideness ≈ 0.45). */
  const angledPose = (t: number, i: number, dipFrames: number): PoseFrame => {
    const pose = poseAt(t, i, dipFrames);
    pose.keypoints.left_shoulder = { x: 76.5, y: 45, score: 0.9 };
    pose.keypoints.left_hip = { x: 81.5, y: 95, score: 0.9 };
    return pose;
  };

  /** Square to the camera (sideness ≈ 0.2) — still a measured refusal. */
  const faceOnPose = (t: number, i: number, dipFrames: number): PoseFrame => {
    const pose = poseAt(t, i, dipFrames);
    pose.keypoints.left_shoulder = { x: 68, y: 45, score: 0.9 };
    pose.keypoints.left_hip = { x: 73, y: 95, score: 0.9 };
    return pose;
  };

  const run = (
    build: (t: number, i: number, dipFrames: number) => PoseFrame,
  ): { session: FormCheckSession; reps: FormCheckRep[] } => {
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    const reps: FormCheckRep[] = [];
    for (let i = 0; i < 45; i++) {
      const rep = session.push(build(i * DT, i, 20));
      if (rep != null) reps.push(rep);
    }
    return { session, reps };
  };

  test('an angled stance counts, and every rep carries the foreshortening', () => {
    // At 0.6 the gate paused the whole session with no override, in a room
    // where the shooter stands where the furniture allows. It now counts —
    // and states that the 2D elbow and knee angles read small.
    const { session, reps } = run(angledPose);
    const sideness = session.readiness.sideness!;
    expect(sideness).toBeGreaterThan(SIDE_PROFILE_MIN);
    expect(sideness).toBeLessThan(SIDE_PROFILE_TRUSTED);
    expect(session.readiness.sideOk).toBe(true);
    expect(session.readiness.sideTrusted).toBe(false);
    expect(reps).toHaveLength(1);
    expect(reps[0]!.lowConfidence).toContain('angledStance');
    expect(session.finalizeSession().lowConfidence).toEqual({
      reps: 1,
      reasons: ['angledStance'],
    });
  });

  test('a measured face-on stance is still refused', () => {
    const { session, reps } = run(faceOnPose);
    expect(session.readiness.sideness!).toBeLessThan(SIDE_PROFILE_MIN);
    expect(session.readiness.sideOk).toBe(false);
    expect(reps).toHaveLength(0);
  });

  test('a clean side-on session reports no low-confidence reps at all', () => {
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    runRep(session, { dipFrames: 20, parkFrames: 20 });
    const report = session.finalizeSession();
    expect(report.repCount).toBe(1);
    expect(report.lowConfidence).toEqual({ reps: 0, reasons: [] });
    expect(session.reps[0]!.lowConfidence).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // V5 — the side gate's labeled escape
  // -------------------------------------------------------------------------

  /** The same face-on run, with the presenter's side override switched on. */
  const runOverridden = (): { session: FormCheckSession; reps: FormCheckRep[] } => {
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    session.overrideSideFloor();
    const reps: FormCheckRep[] = [];
    for (let i = 0; i < 45; i++) {
      const rep = session.push(faceOnPose(i * DT, i, 20));
      if (rep != null) reps.push(rep);
    }
    return { session, reps };
  };

  test('the floor itself never moves', () => {
    // The override is relief, not a redefinition — the exact contract the
    // fps floor keeps. A sub-floor stance still refuses on its own.
    expect(SIDE_PROFILE_MIN).toBe(0.35);
    const win = (sideness: number | null, sideFloorOverride?: boolean) =>
      readinessOf(
        Array.from({ length: 30 }, (_, i) => ({
          t: i * DT,
          fullBody: true,
          arm: true,
          sideness,
        })),
        sideFloorOverride == null ? {} : { sideFloorOverride },
      );
    expect(win(0.2).sideOk).toBe(false);
    expect(win(0.2).sideOverridden).toBe(false);
    expect(win(0.2).ready).toBe(false);
  });

  test('with the override the session counts, and SAYS the stance is square', () => {
    const r = readinessOf(
      Array.from({ length: 30 }, (_, i) => ({
        t: i * DT,
        fullBody: true,
        arm: true,
        sideness: 0.2,
      })),
      { sideFloorOverride: true },
    );
    expect(r.ready).toBe(true);
    expect(r.sideOk).toBe(true);
    expect(r.sideOverridden).toBe(true);
    // The measured stance is reported unchanged — no rounding it up to the
    // floor, and it is emphatically not a trusted view.
    expect(r.sideness).toBeCloseTo(0.2, 6);
    expect(r.sideTrusted).toBe(false);
  });

  test('a stance that passes on its own is never marked overridden', () => {
    const at = (sideness: number) =>
      readinessOf(
        Array.from({ length: 30 }, (_, i) => ({
          t: i * DT,
          fullBody: true,
          arm: true,
          sideness,
        })),
        { sideFloorOverride: true },
      );
    expect(at(0.9).sideOverridden).toBe(false);
    expect(at(SIDE_PROFILE_MIN + 0.01).sideOverridden).toBe(false);
  });

  test('an unmeasurable stance is not something to override', () => {
    // The gauge abstaining already PASSES the gate (occlusion is not
    // evidence of facing the camera), so there is nothing here for the
    // override to carry — and it must not claim there was.
    const blind = readinessOf(
      Array.from({ length: 30 }, (_, i) => ({
        t: i * DT,
        fullBody: true,
        arm: true,
        sideness: null,
      })),
      { sideFloorOverride: true },
    );
    expect(blind.sideness).toBeNull();
    expect(blind.sideOk).toBe(true);
    expect(blind.sideOverridden).toBe(false);
  });

  test('a face-on session counts nothing until the presenter overrides', () => {
    expect(run(faceOnPose).reps).toHaveLength(0);

    const { session, reps } = runOverridden();
    expect(session.sideFloorOverridden).toBe(true);
    expect(session.readiness.sideOverridden).toBe(true);
    expect(session.readiness.sideness!).toBeLessThan(SIDE_PROFILE_MIN);
    expect(reps).toHaveLength(1);

    // The rep is real and it says what it cost: the SAME 'angledStance'
    // reason a merely-angled stance carries, extended to the relaxed gate
    // rather than duplicated by a second word for the same fact.
    expect(reps[0]!.lowConfidence).toEqual(['angledStance']);
    expect(session.finalizeSession().lowConfidence).toEqual({
      reps: 1,
      reasons: ['angledStance'],
    });
  });

  test('THE GATE MOVED, THE MATH DID NOT: every 2D joint angle is refused', () => {
    const { reps } = runOverridden();
    const rep = reps[0]!;
    // Below SIDE_PROFILE_MIN a joint angle is the projection of a limb
    // swinging at the lens. Refused with its reason — never reported small.
    expect(rep.metrics.setPointElbowDeg).toBeNull();
    expect(rep.metrics.kneeFlexionDeg).toBeNull();
    expect(rep.metrics.followThroughElbowDeg).toBeNull();
    expect(rep.metrics.followThroughHeldMs).toBeNull();
    const refusal = (rep.refusals ?? []).find((r) => r.kind === 'stanceNotSideOn');
    expect(refusal).toBeDefined();
    expect(refusal!.metrics).toEqual([
      'setPointElbowDeg',
      'kneeFlexionDeg',
      'followThroughElbowDeg',
      'followThroughHeldMs',
    ]);
    expect(refusal!.reason).toContain('side-on');
    expectNoNaN(rep.metrics);
  });

  test('what a yaw cannot distort survives the refusal', () => {
    // The escape has to buy something, or it is not an escape: a duration
    // and a vertical position are the same number at any stance.
    const { reps } = runOverridden();
    const rep = reps[0]!;
    expect(rep.metrics.releaseTimeMs).not.toBeNull();
    expect(rep.metrics.releaseHeightNorm).not.toBeNull();
    expect(rep.phases.riseMs).not.toBeNull();
    expect(rep.phases.releaseMs).not.toBeNull();
    // followMs is the same elbow streak the metric refused — the bar must
    // not draw a hold the number above it declined to report.
    expect(rep.phases.followMs).toBeNull();
  });

  test('a refused follow-through cannot produce a collapse cue', () => {
    // The whole point of refusing rather than reporting small: a straight
    // arm projected at 120° reads as an arm collapse nobody watched, and
    // that cue is the loudest thing this screen says.
    const { reps } = runOverridden();
    expect(reps[0]!.tips.map((t) => t.metric)).not.toContain('followThroughElbowDeg');
    expect(reps[0]!.tips.map((t) => t.metric)).not.toContain('setPointElbowDeg');
  });

  test('the angled-but-passing band is untouched by the escape', () => {
    // REGRESSION PIN: the stance refusal is armed at SIDE_PROFILE_MIN, NOT
    // at SIDE_PROFILE_TRUSTED. The 0.35–0.6 band is a shipped decision —
    // count, report, qualify — and adding an escape below the floor must
    // not quietly tighten the band above it.
    const { reps } = run(angledPose);
    expect(reps[0]!.metrics.setPointElbowDeg).not.toBeNull();
    expect(reps[0]!.metrics.followThroughHeldMs).not.toBeNull();
    expect(reps[0]!.phases.followMs).not.toBeNull();
    expect((reps[0]!.refusals ?? []).map((r) => r.kind)).not.toContain(
      'stanceNotSideOn',
    );
  });

  test('switching the override back off restores the refusal', () => {
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    session.overrideSideFloor();
    for (let i = 0; i < 45; i++) session.push(faceOnPose(i * DT, i, 20));
    expect(session.reps).toHaveLength(1);

    session.overrideSideFloor(false);
    expect(session.sideFloorOverridden).toBe(false);
    for (let i = 0; i < 45; i++) session.push(faceOnPose(10 + i * DT, i, 20));
    expect(session.reps).toHaveLength(1);
    expect(session.readiness.sideOk).toBe(false);
  });

  test('the receipt survives into the SAVED record', () => {
    // A relaxed capture that reappears in history looking as certain as a
    // clean one is the one thing a relaxation may never do.
    const { session } = runOverridden();
    const report = session.finalizeSession();
    const saved = savedLowConfidenceOf({
      summaryJson: JSON.stringify({ lowConfidence: report.lowConfidence }),
      medianPoseFps: report.medianPoseFps,
    });
    expect(saved).toEqual({ reps: 1, reasons: ['angledStance'] });
  });
});

describe('computeRepMetrics under a square stance', () => {
  const frames = Array.from({ length: 38 }, (_, i) => rawAt(i * DT, i, 20));
  const releaseT = 23 * DT;
  const base = { hand: 'right' as const, frameHeight: FRAME, releaseT };

  test('REGRESSION PIN: absent / null / above-floor sideness are identical', () => {
    const plain = computeRepMetricsDetailed(frames, base);
    expect(computeRepMetricsDetailed(frames, { ...base, sideness: null })).toEqual(
      plain,
    );
    expect(
      computeRepMetricsDetailed(frames, { ...base, sideness: SIDE_PROFILE_MIN }),
    ).toEqual(plain);
    expect(computeRepMetricsDetailed(frames, { ...base, sideness: 0.9 })).toEqual(
      plain,
    );
    expect(plain.metrics.setPointElbowDeg).not.toBeNull();
  });

  test('one hundredth below the floor refuses the angles and nothing else', () => {
    const strict = computeRepMetricsDetailed(frames, base);
    const refused = computeRepMetricsDetailed(frames, {
      ...base,
      sideness: SIDE_PROFILE_MIN - 0.01,
    });
    expect(refused.metrics.setPointElbowDeg).toBeNull();
    expect(refused.metrics.kneeFlexionDeg).toBeNull();
    expect(refused.metrics.followThroughElbowDeg).toBeNull();
    expect(refused.metrics.followThroughHeldMs).toBeNull();
    // Untouched: a duration and a normalized height are yaw-invariant.
    expect(refused.metrics.releaseTimeMs).toBe(strict.metrics.releaseTimeMs);
    expect(refused.metrics.releaseHeightNorm).toBe(strict.metrics.releaseHeightNorm);
    expect(refused.refusals.map((r) => r.kind)).toEqual(['stanceNotSideOn']);
  });

  test('phase timing refuses the same hold, and keeps the rest', () => {
    const strict = computePhaseTiming(frames, base);
    const refused = computePhaseTiming(frames, {
      ...base,
      sideness: SIDE_PROFILE_MIN - 0.01,
    });
    expect(refused.followMs).toBeNull();
    expect(refused.dipMs).toBe(strict.dipMs);
    expect(refused.riseMs).toBe(strict.riseMs);
    expect(refused.releaseMs).toBe(strict.releaseMs);
  });
});

describe('calibration under a relaxed gate', () => {
  test('the fps override unsticks a calibration that could never complete', () => {
    // Calibration is the FIRST thing that runs on stage, and its shadow
    // detectors are gated on the same fps verdict — so a room the phone
    // cannot hold 15 fps in freezes the stepper on "practice motion 1 of 2"
    // before a single rep is ever attempted. The override has to reach here
    // too, or the escape hatch arrives after the session is already dead.
    const stuck = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    runRep(stuck, { t0: 0, fps: 10, dipFrames: 20, parkFrames: 20 });
    runRep(stuck, { t0: 10, fps: 10, dipFrames: 20, parkFrames: 20 });
    expect(stuck.calibration.shadowReps).toBe(0);
    expect(stuck.armed).toBe(false);

    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    session.overrideFpsFloor();
    runRep(session, { t0: 0, fps: 10, dipFrames: 20, parkFrames: 20 });
    runRep(session, { t0: 10, fps: 10, dipFrames: 20, parkFrames: 20 });
    expect(session.calibration.shadowReps).toBe(SHADOW_REPS_TARGET);
    expect(session.armed).toBe(true);
  });

  test('the side override unsticks one a front-facing room freezes', () => {
    // Same shape of failure, and the one the owner actually hit on stage:
    // the shadow collector reads the SIDE gate too, so a room that only
    // lets the shooter stand square freezes the stepper on "practice motion
    // 1 of 2" — before a single rep is ever attempted, with a red chip and
    // an instruction ("turn 90°") the floor plan forbids.
    const faceOn = (t: number, i: number, dipFrames: number): PoseFrame => {
      const pose = poseAt(t, i, dipFrames);
      pose.keypoints.left_shoulder = { x: 68, y: 45, score: 0.9 };
      pose.keypoints.left_hip = { x: 73, y: 95, score: 0.9 };
      return pose;
    };
    const shadowRep = (session: FormCheckSession, t0: number) => {
      for (let i = 0; i < 41; i++) session.push(faceOn(t0 + i * DT, i, 20));
    };

    const stuck = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    shadowRep(stuck, 0);
    shadowRep(stuck, 10);
    expect(stuck.readiness.sideOk).toBe(false);
    expect(stuck.calibration.shadowReps).toBe(0);
    expect(stuck.armed).toBe(false);

    const session = new FormCheckSession({ hand: 'right', frameHeight: FRAME });
    session.overrideSideFloor();
    shadowRep(session, 0);
    shadowRep(session, 10);
    expect(session.calibration.shadowReps).toBe(SHADOW_REPS_TARGET);
    expect(session.armed).toBe(true);
    // The calibration receipt keeps the measured stance it was taken at —
    // the gate opened, the gauge did not change its mind.
    expect(session.calibration.sidenessAvg!).toBeLessThan(SIDE_PROFILE_MIN);
  });
});

describe('savedLowConfidenceOf (the receipt after persistence)', () => {
  // The live report shows the relaxed-gate caveat; every surface that renders
  // a SAVED session's numbers has to be able to show it too, or a run counted
  // at 11 fps reappears in history indistinguishable from a clean one.
  const CLEAN = JSON.stringify({ lowConfidence: { reps: 0, reasons: [] } });

  test('a clean saved session qualifies nothing', () => {
    expect(savedLowConfidenceOf({ summaryJson: CLEAN, medianPoseFps: 28 })).toBeNull();
  });

  test('the persisted receipt round-trips reps and reasons', () => {
    const json = JSON.stringify({
      lowConfidence: { reps: 2, reasons: ['lowPoseFps', 'angledStance'] },
    });
    expect(savedLowConfidenceOf({ summaryJson: json, medianPoseFps: 28 })).toEqual({
      reps: 2,
      reasons: ['lowPoseFps', 'angledStance'],
    });
  });

  test('median fps is a SECOND witness — a row with no receipt is still marked', () => {
    // Rows written before the receipt existed carry no lowConfidence key, and
    // a missing key is not evidence of a clean capture. medianPoseFps is its
    // own persisted column, so the commonest case is still recoverable.
    const old = { summaryJson: '{"reps":[]}', medianPoseFps: 11 };
    expect(savedLowConfidenceOf(old)).toEqual({ reps: 0, reasons: ['lowPoseFps'] });
    // ...but it never INVENTS a rep count it did not read.
    expect(savedLowConfidenceOf(old)!.reps).toBe(0);
    // A clean-fps row with no receipt claims nothing either way.
    expect(savedLowConfidenceOf({ summaryJson: '{"reps":[]}', medianPoseFps: 28 })).toBeNull();
  });

  test('the fps witness fires exactly at the floor, and never on a 0-rep row', () => {
    const at = { summaryJson: CLEAN, medianPoseFps: MIN_POSE_FPS };
    expect(savedLowConfidenceOf(at)).toBeNull();
    const under = { summaryJson: CLEAN, medianPoseFps: MIN_POSE_FPS - 1 };
    expect(savedLowConfidenceOf(under)!.reasons).toEqual(['lowPoseFps']);
    // medianPoseFps is 0 with no reps — an absence, not a slow session.
    expect(savedLowConfidenceOf({ summaryJson: CLEAN, medianPoseFps: 0 })).toBeNull();
  });

  test('a corrupt blob falls through to fps instead of throwing', () => {
    const corrupt = '{"lowConfidence": {truncated';
    expect(savedLowConfidenceOf({ summaryJson: corrupt, medianPoseFps: 11 })).toEqual({
      reps: 0,
      reasons: ['lowPoseFps'],
    });
    expect(savedLowConfidenceOf({ summaryJson: corrupt, medianPoseFps: 28 })).toBeNull();
  });

  test('unknown reason strings from a stored blob are dropped, not rendered', () => {
    const json = JSON.stringify({
      lowConfidence: { reps: 1, reasons: ['lowPoseFps', 'nonsense', 7] },
    });
    expect(savedLowConfidenceOf({ summaryJson: json, medianPoseFps: 28 })).toEqual({
      reps: 1,
      reasons: ['lowPoseFps'],
    });
  });

  test('every reason in the union is a valid decode key', () => {
    for (const reason of REP_CONFIDENCE_REASONS) {
      const json = JSON.stringify({ lowConfidence: { reps: 1, reasons: [reason] } });
      expect(savedLowConfidenceOf({ summaryJson: json, medianPoseFps: 28 })!.reasons).toEqual([
        reason,
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// V4 — measure at the right frame, judge against the right band
// ---------------------------------------------------------------------------

/**
 * Fixture: a rep that STARTS FROM REST. The arm hangs at the side, then
 * rises overhead — exactly the ball-free demo motion a presenter performs
 * when they are not already holding a set point.
 *
 * findDip is a global argmax of filtered wrist y, so the frame it selects is
 * the HANGING ARM: its elbow reads ~178° against FORM.elbowSetPoint's 75-90°
 * band, which is what generated "lower your set point" as the headline cue
 * on essentially every rep. The gate below refuses that frame; the argmax is
 * untouched.
 */
const REST_ARM = { elbow: [97, 75] as const, wrist: [99, 105] as const };

/** Hanging → overhead over 8 frames, then parked. */
function restFrame(i: number, hangFrames = 15): RawSeqFrame {
  const k = i - hangFrames;
  let elbow: readonly [number, number];
  let wrist: readonly [number, number];
  if (k < 0) {
    elbow = REST_ARM.elbow;
    wrist = REST_ARM.wrist;
  } else if (k >= 8) {
    elbow = EXT_ARM.elbow;
    wrist = EXT_ARM.wrist;
  } else {
    const u = (k + 1) / 8;
    elbow = [
      REST_ARM.elbow[0] + (EXT_ARM.elbow[0] - REST_ARM.elbow[0]) * u,
      REST_ARM.elbow[1] + (EXT_ARM.elbow[1] - REST_ARM.elbow[1]) * u,
    ];
    wrist = [
      REST_ARM.wrist[0] + (EXT_ARM.wrist[0] - REST_ARM.wrist[0]) * u,
      REST_ARM.wrist[1] + (EXT_ARM.wrist[1] - REST_ARM.wrist[1]) * u,
    ];
  }
  return raw(i * DT, { ...STATIC, right_elbow: elbow, right_wrist: wrist });
}

/** A held dip pose (constant from f0, so the filter output IS the pose),
 *  then a snap overhead and a parked tail. */
function dipPoseWindow(
  dip: { elbow: readonly [number, number]; wrist: readonly [number, number] },
  opts: { holdFrames?: number; snapFrames?: number; parkFrames?: number } = {},
): { frames: RawSeqFrame[]; releaseT: number } {
  const { holdFrames = 20, snapFrames = 5, parkFrames = 13 } = opts;
  const frames: RawSeqFrame[] = [];
  const total = holdFrames + snapFrames + parkFrames;
  for (let i = 0; i < total; i++) {
    const k = i - holdFrames;
    let elbow: readonly [number, number];
    let wrist: readonly [number, number];
    if (k < 0) {
      elbow = dip.elbow;
      wrist = dip.wrist;
    } else if (k >= snapFrames) {
      elbow = EXT_ARM.elbow;
      wrist = EXT_ARM.wrist;
    } else {
      const u = (k + 1) / snapFrames;
      elbow = [
        dip.elbow[0] + (EXT_ARM.elbow[0] - dip.elbow[0]) * u,
        dip.elbow[1] + (EXT_ARM.elbow[1] - dip.elbow[1]) * u,
      ];
      wrist = [
        dip.wrist[0] + (EXT_ARM.wrist[0] - dip.wrist[0]) * u,
        dip.wrist[1] + (EXT_ARM.wrist[1] - dip.wrist[1]) * u,
      ];
    }
    frames.push(raw(i * DT, { ...STATIC, right_elbow: elbow, right_wrist: wrist }));
  }
  return { frames, releaseT: (holdFrames + snapFrames + 2) * DT };
}

/** Dip pose whose elbow angle is exactly `deg`, wrist safely above the hip. */
function dipAtElbowDeg(deg: number): {
  elbow: readonly [number, number];
  wrist: readonly [number, number];
} {
  // Elbow 25 px below the shoulder (95, 45); the forearm leaves it at `deg`
  // from the elbow→shoulder direction, 25 px long.
  const elbow = [95, 70] as const;
  // elbow→shoulder points at (0, -1); rotating it by `deg` gives the forearm.
  const rad = (deg * Math.PI) / 180;
  return {
    elbow,
    wrist: [elbow[0] + 25 * Math.sin(rad), elbow[1] - 25 * Math.cos(rad)],
  };
}

/** PoseFrame from a RawSeqFrame (every landmark comfortably above the gate). */
function poseFromRaw(f: RawSeqFrame): PoseFrame {
  const keypoints: PoseFrame['keypoints'] = {};
  for (const [name, p] of f.pts) keypoints[name] = { x: p.x, y: p.y, score: 0.9 };
  return { t: f.t, keypoints };
}

describe('the dip GATHER GATE', () => {
  test('a rep that starts from rest refuses all three dip-frame numbers, with a reason', () => {
    const frames = Array.from({ length: 38 }, (_, i) => restFrame(i));
    const releaseT = 27 * DT;

    // What the ungated argmax would have reported: a hanging arm, far
    // outside FORM's own set-point band. This is the number being suppressed.
    const hanging = angleAtDeg(
      { x: 95, y: 45 },
      { x: REST_ARM.elbow[0], y: REST_ARM.elbow[1] },
      { x: REST_ARM.wrist[0], y: REST_ARM.wrist[1] },
    )!;
    expect(hanging).toBeGreaterThan(FORM.elbowSetPoint.flagAbove);
    expect(hanging).toBeGreaterThan(GATHER_MAX_ELBOW_DEG);

    const { metrics, refusals } = computeRepMetricsDetailed(frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT,
    });
    expect(metrics.setPointElbowDeg).toBeNull();
    expect(metrics.kneeFlexionDeg).toBeNull();
    expect(metrics.releaseTimeMs).toBeNull();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.kind).toBe('dipNotGather');
    expect(refusals[0]!.metrics).toEqual([
      'setPointElbowDeg',
      'kneeFlexionDeg',
      'releaseTimeMs',
    ]);
    // EVERY refusal states its reason — a null with no reason is a bug.
    expect(refusals[0]!.reason).toMatch(/not a gather/);
    expect(refusals[0]!.reason).toMatch(/elbow/);

    // The follow-through is read off the TAIL, not the dip: still measured.
    expect(metrics.followThroughElbowDeg).not.toBeNull();
    expectNoNaN(metrics);
  });

  test('the held set point still measures — the gate refuses frames, not reps', () => {
    // The v1 hold-then-snap fixture: elbow 90° at the dip, wrist above the
    // hip. Nothing about it may change.
    const frames: RawSeqFrame[] = [];
    for (let i = 0; i < 38; i++) frames.push(rawAt(i * DT, i, 20));
    const { metrics, refusals } = computeRepMetricsDetailed(frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT: 27 * DT,
    });
    expect(refusals).toEqual([]);
    expect(Math.abs(metrics.setPointElbowDeg! - 90)).toBeLessThanOrEqual(2);
    expect(metrics.releaseTimeMs).not.toBeNull();
  });

  test('elbow floor: below and AT GATHER_MAX_ELBOW_DEG measure, above refuses', () => {
    const measure = (deg: number) => {
      const { frames, releaseT } = dipPoseWindow(dipAtElbowDeg(deg));
      return computeRepMetricsDetailed(frames, {
        hand: 'right',
        frameHeight: FRAME,
        releaseT,
      });
    };
    // The dip pose is constant from f0, so the One-Euro output at the dip IS
    // the constructed pose — the bracket is exact, not filter-blurred.
    const below = measure(GATHER_MAX_ELBOW_DEG - 0.5);
    expect(below.refusals).toEqual([]);
    // The fixture really does build the angle it claims to (a mis-built
    // bracket would pass this suite while testing nothing).
    expect(below.metrics.setPointElbowDeg!).toBeCloseTo(GATHER_MAX_ELBOW_DEG - 0.5, 6);

    const at = measure(GATHER_MAX_ELBOW_DEG);
    expect(at.refusals).toEqual([]);
    expect(at.metrics.setPointElbowDeg!).toBeCloseTo(GATHER_MAX_ELBOW_DEG, 6);

    const above = measure(GATHER_MAX_ELBOW_DEG + 0.5);
    expect(above.refusals).toHaveLength(1);
    expect(above.metrics.setPointElbowDeg).toBeNull();
    expect(above.metrics.releaseTimeMs).toBeNull();
  });

  test('hip line: at the slack boundary measures, a hair below it refuses', () => {
    // Body height for this fixture is nose(25)→left_ankle(165) = 140 px, so
    // the wrist may sit up to 0.05 × 140 = 7 px below the hip line (y 95).
    const bodyPx = 140;
    const limit = 95 + GATHER_WRIST_BELOW_HIP_FRAC * bodyPx;
    const atWristY = (y: number) =>
      computeRepMetricsDetailed(
        // Forearm horizontal → a 90° elbow, so ONLY the hip line is on trial.
        dipPoseWindow({ elbow: [95, y], wrist: [120, y] }).frames,
        {
          hand: 'right',
          frameHeight: FRAME,
          releaseT: dipPoseWindow({ elbow: [95, y], wrist: [120, y] }).releaseT,
        },
      );

    const above = atWristY(limit - 2);
    expect(above.refusals).toEqual([]);
    expect(above.metrics.setPointElbowDeg).not.toBeNull();

    const at = atWristY(limit);
    expect(at.refusals).toEqual([]);

    const below = atWristY(limit + 0.5);
    expect(below.refusals).toHaveLength(1);
    expect(below.refusals[0]!.reason).toMatch(/wrist below the hip line/);
    expect(below.metrics.releaseTimeMs).toBeNull();
  });

  test('a dip frame with neither check available is UNVERIFIED, not assumed', () => {
    // No elbow (no angle) and no hip (no hip line): nothing observed says
    // this frame was a gather, so no dip-frame number is reported.
    const frames: RawSeqFrame[] = [];
    for (let i = 0; i < 38; i++) {
      const arm = armAt(i, 20);
      frames.push(
        raw(i * DT, {
          nose: STATIC.nose,
          right_shoulder: STATIC.right_shoulder,
          right_wrist: arm.wrist,
          right_knee: STATIC.right_knee,
          right_ankle: STATIC.right_ankle,
        }),
      );
    }
    const { metrics, refusals } = computeRepMetricsDetailed(frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT: 27 * DT,
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.reason).toMatch(/unverified/);
    expect(metrics.releaseTimeMs).toBeNull();
    expectNoNaN(metrics);
  });

  test('computePhaseTiming refuses the same frame — the bars agree with the numbers', () => {
    const frames = Array.from({ length: 38 }, (_, i) => restFrame(i));
    const p = computePhaseTiming(frames, { hand: 'right', releaseT: 27 * DT });
    expect(p.dipMs).toBeNull();
    expect(p.riseMs).toBeNull();
    expect(p.releaseMs).toBeNull();
    // The follow-through segment never depended on the dip.
    expect(p.followMs).not.toBeNull();
  });

  test('a session rep carries its refusals, and counts anyway', () => {
    // The gate suppresses NUMBERS, never the rep: the motion happened.
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    const reps: FormCheckRep[] = [];
    for (let i = 0; i < 45; i++) {
      const rep = session.push(poseFromRaw(restFrame(i)));
      if (rep != null) reps.push(rep);
    }
    expect(reps).toHaveLength(1);
    expect(reps[0]!.metrics.setPointElbowDeg).toBeNull();
    expect(reps[0]!.refusals).toHaveLength(1);
    expect(reps[0]!.refusals![0]!.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The dip epsilon, in body units
// ---------------------------------------------------------------------------

describe('the body-relative dip epsilon', () => {
  test('dipEpsFor: 2% of the body, floored at 1 px, defaulting to the mirror', () => {
    // No body estimate ⇒ the FormAnalyzer-mirrored default, so every direct
    // caller (and every fixture pinned before this change) is untouched.
    expect(dipEpsFor(null)).toBe(DIP_EPS_PX);
    expect(dipEpsFor(undefined)).toBe(DIP_EPS_PX);
    expect(dipEpsFor(0)).toBe(DIP_EPS_PX);
    expect(dipEpsFor(-5)).toBe(DIP_EPS_PX);
    expect(dipEpsFor(Number.NaN)).toBe(DIP_EPS_PX);
    // A demo-distance shooter (~130 px of the 192 square).
    expect(dipEpsFor(130)).toBeCloseTo(2.6, 10);
    // Floor: a tiny/far body never asks for a sub-pixel rise.
    expect(dipEpsFor(40)).toBe(1.0);
  });

  /** A held dip, then an instant rise of `risePx` held long enough for the
   *  One-Euro output to settle (measured: within 0.05 px). */
  function riseWindow(risePx: number): { frames: RawSeqFrame[]; releaseT: number } {
    const frames: RawSeqFrame[] = [];
    for (let i = 0; i < 20; i++) {
      frames.push(raw(i * DT, { ...STATIC, right_elbow: [95, 80], right_wrist: [120, 80] }));
    }
    for (let i = 20; i < 60; i++) {
      frames.push(
        raw(i * DT, {
          ...STATIC,
          right_elbow: [95, 80 - risePx],
          right_wrist: [120, 80 - risePx],
        }),
      );
    }
    return { frames, releaseT: 59 * DT };
  }

  const confirmed = (risePx: number, dipEpsPx?: number) =>
    computeRepMetrics(riseWindow(risePx).frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT: riseWindow(risePx).releaseT,
      dipEpsPx,
    }).releaseTimeMs != null;

  test('a rise below / at / above the epsilon: only above confirms the dip', () => {
    // This fixture's body is nose(25)→left_ankle(165) = 140 px ⇒ eps 2.8 px.
    const eps = dipEpsFor(140);
    expect(eps).toBeCloseTo(2.8, 10);
    expect(confirmed(eps - 0.3, eps)).toBe(false);
    // AT the epsilon does not confirm: the test is a strict >, and a
    // filtered rise settles just short of its target.
    expect(confirmed(eps, eps)).toBe(false);
    expect(confirmed(eps + 0.4, eps)).toBe(true);
  });

  test('THE POINT: a 1 px jitter used to confirm a dip on a 140 px body', () => {
    // Old behavior, still the default for direct callers.
    expect(confirmed(1.0)).toBe(true);
    // Body-relative: 1 px of keypoint noise is not a gather any more, so the
    // three dip-frame numbers are refused rather than read off jitter.
    expect(confirmed(1.0, dipEpsFor(140))).toBe(false);
  });

  test('the session feeds its OWN window body height, not a constant', () => {
    // A rep whose whole window is the far-distance fixture (~128 px body)
    // still measures: the epsilon scales with the shooter, not the room.
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    const reps = feed(session, slowMotion({ vyPxPerSec: SLOW_RISE_PX / 1.2 }));
    expect(reps).toHaveLength(1);
    expect(reps[0]!.metrics.setPointElbowDeg).not.toBeNull();
    expect(reps[0]!.refusals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Follow-through: the right band, at the frame resolution we actually have
// ---------------------------------------------------------------------------

describe('the follow-through band', () => {
  /** Dip → snap → a long tail parked at `tailElbowDeg`, release inside it. */
  function tailWindow(tailElbowDeg: number): {
    frames: RawSeqFrame[];
    releaseT: number;
  } {
    const elbow = [95, 25] as const;
    // elbow→shoulder points at (0, +1) here (the elbow is ABOVE the
    // shoulder); rotate it by the target angle to place the wrist.
    const rad = (tailElbowDeg * Math.PI) / 180;
    const wrist: readonly [number, number] = [
      elbow[0] - 20 * Math.sin(rad),
      elbow[1] + 20 * Math.cos(rad),
    ];
    const frames: RawSeqFrame[] = [];
    const hold = 20;
    const snap = 5;
    const park = 26;
    for (let i = 0; i < hold + snap + park; i++) {
      const k = i - hold;
      let e: readonly [number, number];
      let w: readonly [number, number];
      if (k < 0) {
        e = [95, 80];
        w = [120, 80];
      } else if (k >= snap) {
        e = elbow;
        w = wrist;
      } else {
        const u = (k + 1) / snap;
        e = [95 + (elbow[0] - 95) * u, 80 + (elbow[1] - 80) * u];
        w = [120 + (wrist[0] - 120) * u, 80 + (wrist[1] - 80) * u];
      }
      frames.push(raw(i * DT, { ...STATIC, right_elbow: e, right_wrist: w }));
    }
    // Release 10 parked frames in — the filter has settled on the tail pose,
    // and 0.3 s of tail (9 frames at 30 fps) still fits inside the window.
    return { frames, releaseT: (hold + snap + 10) * DT };
  }

  const heldMs = (tailElbowDeg: number) =>
    computeRepMetrics(tailWindow(tailElbowDeg).frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT: tailWindow(tailElbowDeg).releaseT,
    }).followThroughHeldMs;

  test('config.FORM.followThrough is UNTOUCHED — the live pipeline reads it', () => {
    expect(FORM.followThrough.elbowMinDeg).toBe(155);
    expect(FORM.followThrough.holdSec).toBe(0.3);
    // Form Check judges the hold against the extension that COUNTED the rep.
    expect(FT_ELBOW_MIN_DEG).toBe(FORM_MOTION.minElbowExtensionDeg);
    expect(FT_ELBOW_MIN_DEG).toBeLessThan(FORM.followThrough.elbowMinDeg);
  });

  test('an elbow at / above the floor holds; below it collapses to 0', () => {
    expect(heldMs(FT_ELBOW_MIN_DEG + 1)).toBeGreaterThan(250);
    expect(heldMs(FT_ELBOW_MIN_DEG)).toBeGreaterThan(250);
    expect(heldMs(FT_ELBOW_MIN_DEG - 1)).toBe(0);
  });

  test('RE-PINNED: the 138° demo push no longer reports a collapse it never had', () => {
    // A ball-free push tops out at 130-145°; against config's 155 band this
    // metric read 0 ms on EVERY rep and became the top spoken callout —
    // an arm collapse nobody watched happen. It is a real hold now.
    expect(138).toBeLessThan(FORM.followThrough.elbowMinDeg);
    expect(heldMs(138)).toBeGreaterThan(250);
  });

  test('the slow ball-free demo rep now reports the hold it really had', () => {
    // The stage motion tops out at ~138°: under config's 155 band its hold
    // read 0 ms on every rep. The arm never dropped — nothing was measured
    // differently, only judged against the band that counted the rep.
    expect(slowElbowDeg(1)).toBeLessThan(FORM.followThrough.elbowMinDeg);
    expect(slowElbowDeg(1)).toBeGreaterThanOrEqual(FT_ELBOW_MIN_DEG);
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    const reps = feed(session, slowMotion({ vyPxPerSec: SLOW_RISE_PX / 1.2 }));
    expect(reps).toHaveLength(1);
    expect(reps[0]!.metrics.followThroughHeldMs!).toBeGreaterThan(200);
  });

  test('followThroughHeldFull tolerates exactly one frame period, never more', () => {
    const holdMs = FORM.followThrough.holdSec * 1000;
    // 30 fps: the last SAMPLED instant of a full hold is 300 − 33.3 ms.
    expect(followThroughHeldFull(holdMs, 30)).toBe(true);
    expect(followThroughHeldFull(holdMs - 1000 / 30, 30)).toBe(true);
    expect(followThroughHeldFull(holdMs - 1000 / 30 - 1, 30)).toBe(false);
    // 15 fps (the runbook accepts 15-21 on stage): 66.7 ms of tolerance.
    expect(followThroughHeldFull(holdMs - 66, 15)).toBe(true);
    expect(followThroughHeldFull(holdMs - 70, 15)).toBe(false);
    // Unknown rate ⇒ no tolerance at all, the strict old test.
    expect(followThroughHeldFull(holdMs, 0)).toBe(true);
    expect(followThroughHeldFull(holdMs - 1, 0)).toBe(false);
    // Never measured is never held.
    expect(followThroughHeldFull(null, 30)).toBe(false);
  });

  test('pickBestRep credits a full hold at 15 fps, and prints the REAL ms', () => {
    const mk = (index: number, m: Partial<FormMetrics>, poseFps: number): FormCheckRep => ({
      index,
      releaseT: index,
      sequence: null,
      metrics: {
        setPointElbowDeg: null,
        kneeFlexionDeg: null,
        releaseAngleDeg: null,
        entryAngleDeg: null,
        releaseTimeMs: null,
        followThroughHeldMs: null,
        followThroughElbowDeg: null,
        releaseHeightNorm: null,
        ...m,
      },
      phases: { dipMs: null, riseMs: null, releaseMs: null, followMs: null },
      releaseHeightM: null,
      flags: [],
      tips: [],
      poseFps,
    });
    const reps = [
      mk(1, { setPointElbowDeg: 84, followThroughHeldMs: 234 }, 15),
      mk(2, { setPointElbowDeg: 40, followThroughHeldMs: 0 }, 15),
    ];
    const best = pickBestRep(reps, sessionSpreads(reps));
    expect(best!.index).toBe(1);
    // The tolerance widens the COMPARISON; the printed number stays the
    // measured one (inventing the missing 66 ms is explicitly rejected).
    expect(best!.reason).toContain('follow-through held 234 ms');
  });
});

// ---------------------------------------------------------------------------
// The re-arm gate
// ---------------------------------------------------------------------------

describe('the re-arm gate', () => {
  const detect = (frames: readonly PoseFrame[]) => {
    const d = new FormMotionDetector({ hand: 'right', frameHeight: FRAME });
    let fired = 0;
    for (const f of frames) if (d.push(f) != null) fired++;
    return fired;
  };

  /** A raised, extended arm wobbling ±1 px at `fps` for `sec` — a presenter
   *  admiring their follow-through. Every frame refreshes wrist-above-
   *  shoulder and elbow-extended; the wobble refreshes the vy spike. */
  function admiring(sec: number, fps = 30): PoseFrame[] {
    const frames: PoseFrame[] = [];
    const n = Math.round(sec * fps);
    for (let i = 0; i < n; i++) {
      // First 6 frames: a real rise from below the shoulder (the one rep).
      const rising = i < 6;
      const wristY = rising ? 80 - (i * 70) / 5 : 10 + (i % 2) * 1.2;
      const elbowY = rising ? 80 - (i * 50) / 5 : 30;
      frames.push(
        poseOf(i / fps, {
          ...STATIC,
          right_elbow: [95, elbowY],
          right_wrist: [95, wristY],
        }),
      );
    }
    return frames;
  }

  test('a held follow-through mints exactly ONE rep over 10 s', () => {
    const frames = admiring(10);
    expect(frames.length).toBe(300);
    // NON-VACUOUS: fed the held tail alone, a fresh (armed) detector still
    // completes the signature off the wobble — the wrist never leaves the
    // top, so wrist-above-shoulder and elbow-extended are true every frame
    // and only the vy spike has to re-arrive. That is the phantom-rep
    // mechanism, and the gate below is the only thing refusing it.
    expect(detect(frames.slice(20))).toBeGreaterThanOrEqual(1);
    expect(detect(frames)).toBe(1);
  });

  test('the wrist must reach the shoulder line: at it re-arms, above it does not', () => {
    const shoulderY = STATIC.right_shoulder![1];
    /**
     * One motion, a park at `parkY`, then a second motion rising from that
     * park. Only the park height differs between the three cases — every
     * other frame is identical, so the gate is the only variable.
     */
    const twoReps = (parkY: number): PoseFrame[] => {
      const frames: PoseFrame[] = [];
      let i = 0;
      const push = (elbowY: number, wristY: number) => {
        frames.push(
          poseOf(i / 30, { ...STATIC, right_elbow: [95, elbowY], right_wrist: [95, wristY] }),
        );
        i++;
      };
      /** Rise from `fromY` to the overhead hold, then hold it. */
      const rise = (fromY: number) => {
        for (let k = 1; k <= 6; k++) {
          const u = k / 6;
          push(fromY - 20 - (fromY - 50) * u, fromY - (fromY - 10) * u);
        }
        for (let k = 0; k < 4; k++) push(30, 10);
      };
      rise(80);
      // Come DOWN to the park and hold it — the only thing under test.
      for (let k = 1; k <= 6; k++) push(30 + (parkY - 10) * (k / 6), 10 + (parkY - 10) * (k / 6));
      for (let k = 0; k < 30; k++) push(parkY + 20, parkY);
      rise(parkY);
      return frames;
    };
    // Below the shoulder line (larger y): re-arms, the second rep counts.
    expect(detect(twoReps(shoulderY + 5))).toBe(2);
    // Exactly AT the shoulder line: at-or-below re-arms.
    expect(detect(twoReps(shoulderY))).toBe(2);
    // A hair above it: the arm never came down, so it is still one motion.
    const above = twoReps(shoulderY - 1);
    expect(detect(above)).toBe(1);
    // NON-VACUOUS: the second motion IS a complete signature — fed to a
    // fresh (armed) detector from the park onward it fires. The re-arm gate
    // is the only thing that refused it, not the debounce or a floor.
    expect(detect(above.slice(40))).toBe(1);
  });

  test('it cannot refuse a first rep, even one caught mid-motion', () => {
    // The detector starts ARMED: a session that opens with the arm already
    // rising still counts that rep. The gate only refuses REPEATS.
    const frames: PoseFrame[] = [];
    for (let k = 0; k < 6; k++) {
      frames.push(
        poseOf(k / 30, {
          ...STATIC,
          right_elbow: [95, 80 - (k * 50) / 5],
          right_wrist: [95, 80 - (k * 70) / 5],
        }),
      );
    }
    // Never a frame with the wrist at or below the shoulder after f0.
    expect(detect(frames)).toBe(1);
  });

  test('two real motions with the arm coming down between them BOTH count', () => {
    // The runbook workaround ("keep your arms down between reps") is now the
    // code's own contract — and it is exactly what a real rep does.
    const session = new FormCheckSession({
      hand: 'right',
      frameHeight: FRAME,
      calibrate: false,
    });
    const reps: FormCheckRep[] = [];
    reps.push(...runRep(session, { t0: 0, dipFrames: 10, parkFrames: 15 }));
    reps.push(...runRep(session, { t0: 1, dipFrames: 10, parkFrames: 20 }));
    expect(reps).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Window retention + one rotated space for both dips
// ---------------------------------------------------------------------------

describe('rep window retention', () => {
  test('REP_BUFFER_SEC keeps a full rep window plus a second of slack', () => {
    expect(REP_BUFFER_SEC).toBe(3.0);
    // The prune runs on the CURRENT frame's timestamp, so the slack past the
    // rep window is what absorbs a late delivery without losing the dip.
    expect(REP_BUFFER_SEC - (PRE_RELEASE_SEC + FOLLOW_TAIL_SEC)).toBeGreaterThanOrEqual(1.0);
  });
});

describe('computePhaseTiming tilt compensation', () => {
  function phaseFrames(): { frames: RawSeqFrame[]; releaseT: number } {
    // Same scripted motion the phase suite uses: a real descent, a set-point
    // hold, a snap and a parked tail.
    const frames: RawSeqFrame[] = [];
    for (let i = 0; i < 41; i++) {
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
      frames.push(raw(i * DT, { ...STATIC, right_wrist: wrist, right_elbow: elbow }));
    }
    return { frames, releaseT: 25 * DT };
  }

  test('REGRESSION PIN: no tilt / null / 0 / no frameHeight are v1-identical', () => {
    const { frames, releaseT } = phaseFrames();
    const base = computePhaseTiming(frames, { hand: 'right', releaseT });
    expect(computePhaseTiming(frames, { hand: 'right', releaseT, tiltDeg: null })).toEqual(base);
    expect(
      computePhaseTiming(frames, { hand: 'right', releaseT, tiltDeg: 0, frameHeight: FRAME }),
    ).toEqual(base);
    // A tilt with no frame height has no rotation center — pass through
    // untouched rather than rotating about a guessed one.
    expect(computePhaseTiming(frames, { hand: 'right', releaseT, tiltDeg: 12 })).toEqual(base);
  });

  test('the same roll compensation as the metrics — one dip, one space', () => {
    const { frames, releaseT } = phaseFrames();
    const level = computePhaseTiming(frames, { hand: 'right', releaseT });
    const rolled = frames.map((f) => {
      const pts = new Map<PoseKeypointName, { x: number; y: number }>();
      for (const [name, p] of f.pts) {
        const [x, y] = rot([p.x, p.y], 12);
        pts.set(name, { x, y });
      }
      return { t: f.t, pts };
    });
    const compensated = computePhaseTiming(rolled, {
      hand: 'right',
      releaseT,
      tiltDeg: 12,
      frameHeight: FRAME,
    });
    expect(compensated.riseMs).toBeCloseTo(level.riseMs!, 6);
    expect(compensated.releaseMs).toBeCloseTo(level.releaseMs!, 6);
    expect(compensated.dipMs).not.toBeNull();

    // The metrics and the bars now agree because they share the rotation:
    // the compensated tempo and the compensated dip→cross→release add up.
    const m = computeRepMetrics(rolled, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT,
      tiltDeg: 12,
    });
    expect(m.releaseTimeMs).toBeCloseTo(compensated.riseMs! + compensated.releaseMs!, 6);
  });
});

describe('the follow-through START tolerance', () => {
  /**
   * Dip pose held (the filter settles on it), then the arm opens to an
   * overhead `deg` over `rampFrames` AFTER the release and holds. The
   * release fires on the RAW crossing; the metric reads the FILTERED angle,
   * which is a frame behind it — this fixture puts that lag on trial.
   */
  function rampTail(deg: number, rampFrames: number) {
    const elbow = [95, 25] as const;
    const rad = (deg * Math.PI) / 180;
    const wrist: readonly [number, number] = [
      elbow[0] - 20 * Math.sin(rad),
      elbow[1] + 20 * Math.cos(rad),
    ];
    const hold = 20;
    const frames: RawSeqFrame[] = [];
    for (let i = 0; i < hold; i++) {
      frames.push(raw(i * DT, { ...STATIC, right_elbow: [95, 80], right_wrist: [120, 80] }));
    }
    for (let i = hold; i < hold + 20; i++) {
      const u = Math.min(1, (i - hold) / rampFrames);
      frames.push(
        raw(i * DT, {
          ...STATIC,
          right_elbow: [95 + (elbow[0] - 95) * u, 80 + (elbow[1] - 80) * u],
          right_wrist: [120 + (wrist[0] - 120) * u, 80 + (wrist[1] - 80) * u],
        }),
      );
    }
    return computeRepMetrics(frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT: hold * DT,
    });
  }

  test('one frame of lag is absorbed; two frames is not a hold at all', () => {
    // WITHIN one median frame period of the release: the streak starts where
    // it was really observed extended, and the hold is measured FROM THERE —
    // 300 ms of window minus the frames that were not extended.
    const withinOneFrame = rampTail(170, 1);
    expect(withinOneFrame.followThroughHeldMs!).toBeCloseTo((7 / 30) * 1000, 6);
    expect(withinOneFrame.followThroughHeldMs!).toBeLessThan(300);

    // BEYOND it: the arm was still on its way up two frames after the
    // release. No hold is claimed, and no millisecond is invented to bridge
    // the gap — this is the bound that keeps a real collapse visible.
    expect(rampTail(170, 2).followThroughHeldMs).toBe(0);
    expect(rampTail(170, 4).followThroughHeldMs).toBe(0);
  });

  test('a REAL collapse still reports short — the tolerance cannot launder it', () => {
    // Extended for 4 frames after the release, then the arm drops to 90°.
    const hold = 20;
    const frames: RawSeqFrame[] = [];
    for (let i = 0; i < hold; i++) {
      frames.push(raw(i * DT, { ...STATIC, right_elbow: [95, 80], right_wrist: [120, 80] }));
    }
    for (let i = hold; i < hold + 20; i++) {
      const collapsed = i >= hold + 4;
      frames.push(
        raw(i * DT, {
          ...STATIC,
          right_elbow: [95, 25],
          // Straight up (≈180°) then folded across (≈90°).
          right_wrist: collapsed ? [75, 25] : [95, 5],
        }),
      );
    }
    const m = computeRepMetrics(frames, {
      hand: 'right',
      frameHeight: FRAME,
      releaseT: hold * DT,
    });
    expect(m.followThroughHeldMs!).toBeGreaterThan(0);
    expect(m.followThroughHeldMs!).toBeLessThan(200);
    // And the collapse test agrees at every plausible stage frame rate.
    expect(followThroughHeldFull(m.followThroughHeldMs, 30)).toBe(false);
    expect(followThroughHeldFull(m.followThroughHeldMs, 15)).toBe(false);
  });
});
