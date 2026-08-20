/**
 * Wiring tests for the tracking-gap acquisition funnel seam
 * (PipelineFrameState.funnel / trackHistory + ShotPipeline.setTrackerRescue).
 *
 * Pinned here:
 * - The per-frame funnel rides PipelineFrameState, assembled from values the
 *   frame actually used: raw ball count (pre-tracker, score-blind), the
 *   tracker's per-step gate telemetry, the track state (real/coast/none),
 *   the FSM's arm refusal ('no-rim' before the FSM exists), the dribble
 *   latch and the arc fit/suppression flags.
 * - armRefusal walks the documented vocabulary across a full resolved shot:
 *   no-ball → no-branch → armed → live → cooldown.
 * - trackHistory is the tracker's LIVE history view (BallTracker.getHistory).
 * - setTrackerRescue forwards to BallTracker.setRescue — a detection-side
 *   recall switch only.
 * - RECORDING ONLY (iron rule): the funnel observes the pipeline, it never
 *   steers it — resolved shots are byte-identical with rescue on vs off, and
 *   with the funnel consumed vs ignored (it is derived state either way).
 *
 * Deterministic: scripted camera timestamps, no Date.now.
 */
import {
  ShotPipeline,
  type FramePayload,
  type PipelineFrameState,
} from '../shotPipeline';
import { DETECTION } from '../../core/config';
import type { Box, Detection, ResolvedShot } from '../../core/types';

// ---------------------------------------------------------------------------
// Fixtures (same synthetic scene family as ftSeedWiring/dribbleWiring)
// ---------------------------------------------------------------------------

const FRAME = { width: 640, height: 640 };
const DT = 1 / 30;
/** Manual rim: planeY = 200, cx = 320, span 304..336, belowY = 230. */
const RIM_BOX: Box = { x: 300, y: 200, width: 40, height: 20 };

const G = 900;
const VY0 = -700;
const Y0 = 400;
const VX = 60;
const T_CROSS_DOWN =
  (700 + Math.sqrt(700 * 700 - 4 * (G / 2) * (Y0 - 200))) / (2 * (G / 2));
const SHOT_FRAMES = 48;

function ballDet(cx: number, cy: number, score = 0.8): Detection {
  return {
    cls: 'ball',
    score,
    box: { x: cx - 15, y: cy - 15, width: 30, height: 30 },
  };
}

function framePayload(t: number, detections: Detection[]): FramePayload {
  return {
    frame: {
      t,
      frameWidth: FRAME.width,
      frameHeight: FRAME.height,
      detections,
    },
    netMotionScore: 0,
  };
}

/** The scripted make: rises through the up-zone, crosses at rim center. */
function shotDetections(i: number, score = 0.8): Detection[] {
  const tau = i * DT;
  const x0 = 320 - VX * T_CROSS_DOWN;
  return [ballDet(x0 + VX * tau, Y0 + VY0 * tau + (G / 2) * tau * tau, score)];
}

function runScript(
  pipeline: ShotPipeline,
  script: Detection[][],
  t0 = 0,
): PipelineFrameState[] {
  const states: PipelineFrameState[] = [];
  for (let i = 0; i < script.length; i++) {
    states.push(pipeline.step(framePayload(t0 + i * DT, script[i]!)));
  }
  return states;
}

// ---------------------------------------------------------------------------
// Funnel assembly
// ---------------------------------------------------------------------------

describe('acquisition funnel — per-frame assembly', () => {
  test("pre-lock frame: armRefusal 'no-rim', score-blind rawBall, active floor + reject counters", () => {
    const pipeline = new ShotPipeline();
    // NO rim lock. One confident ball + one sub-floor ball in the same frame.
    const state = pipeline.step(
      framePayload(0, [ballDet(100, 400, 0.8), ballDet(500, 100, 0.1)]),
    );

    const f = state.funnel;
    // rawBall counts EVERY ball-class detection, score-blind (pre-tracker).
    expect(f.rawBall).toBe(2);
    expect(f.ballDets).toBe(2);
    // No FSM yet — the funnel says so instead of faking a refusal.
    expect(f.armRefusal).toBe('no-rim');
    // The active cold floor is the open-court default here.
    expect(f.floor).toBeCloseTo(DETECTION.ballScoreMin, 5);
    // The 0.8 ball was accepted (a real track), the 0.1 died at the floor.
    expect(f.accepted).toBe(true);
    expect(f.track).toBe('real');
    expect(f.rejScore).toBeGreaterThanOrEqual(1);
    expect(f.rescued).toBe(false);
  });

  test('track states walk real → coast → none across a detection gap', () => {
    const pipeline = new ShotPipeline();
    // 4 real sightings of a slowly-moving ball, then a long silence.
    const script: Detection[][] = [];
    for (let i = 0; i < 4; i++) script.push([ballDet(100 + 4 * i, 400)]);
    for (let i = 0; i < 30; i++) script.push([]);
    const states = runScript(pipeline, script);

    const tracks = states.map((s) => s.funnel.track);
    expect(tracks[0]).toBe('real');
    expect(tracks[3]).toBe('real');
    // The frames right after the dropout coast on the Kalman bridge…
    expect(tracks[4]).toBe('coast');
    // …and the tail of the long gap has no live track at all.
    expect(tracks[tracks.length - 1]).toBe('none');
    // All three states appeared, in that order (first occurrences ascend).
    expect(tracks.indexOf('real')).toBeLessThan(tracks.indexOf('coast'));
    expect(tracks.indexOf('coast')).toBeLessThan(tracks.indexOf('none'));
  });

  test('armRefusal walks no-ball → no-branch → armed → live → cooldown across a resolved shot', () => {
    const shots: ResolvedShot[] = [];
    const pipeline = new ShotPipeline({ onShot: (s) => shots.push(s) });
    pipeline.setManualRim(RIM_BOX, FRAME);

    const script: Detection[][] = [];
    // A locked-rim frame with no ball at all.
    script.push([]);
    for (let i = 0; i < SHOT_FRAMES; i++) script.push(shotDetections(i));
    const states = runScript(pipeline, script);

    expect(shots).toHaveLength(1); // the script really resolves
    const refusals = states.map((s) => s.funnel.armRefusal);
    // Empty frame, FSM exists → evaluated, no ball.
    expect(refusals[0]).toBe('no-ball');
    // Low early flight: ball seen + evaluated, but no arm branch fires yet.
    expect(refusals).toContain('no-branch');
    // The arm frame, the live flight, and the post-resolve cooldown all show.
    expect(refusals).toContain('armed');
    expect(refusals).toContain('live');
    expect(refusals).toContain('cooldown');
    // Order sanity: first no-branch < first armed < first cooldown.
    expect(refusals.indexOf('no-branch')).toBeLessThan(
      refusals.indexOf('armed'),
    );
    expect(refusals.indexOf('armed')).toBeLessThan(
      refusals.indexOf('cooldown'),
    );
    // The armed frame itself reports SHOT_LIVE on the frame state.
    expect(states[refusals.indexOf('armed')]!.phase).toBe('SHOT_LIVE');
  });

  test('arc diagnostics: a confident flight publishes arcR2y without suppression; the latch stays quiet', () => {
    const pipeline = new ShotPipeline();
    pipeline.setManualRim(RIM_BOX, FRAME);
    const script: Detection[][] = [];
    for (let i = 0; i < SHOT_FRAMES; i++) script.push(shotDetections(i));
    const states = runScript(pipeline, script);

    // Some mid-flight frame carries a confident arc fit in the funnel.
    const withArc = states.filter((s) => s.funnel.arcR2y != null);
    expect(withArc.length).toBeGreaterThan(0);
    for (const s of withArc) {
      expect(s.funnel.arcR2y!).toBeGreaterThan(0);
      expect(s.funnel.arcR2y!).toBeLessThanOrEqual(1);
    }
    // A clean single arc never latches the dribble gate or suppresses.
    expect(states.every((s) => !s.funnel.dribbleLatch)).toBe(true);
    expect(states.every((s) => !s.funnel.arcSuppressed)).toBe(true);
  });

  test("trackHistory is the tracker's live history view", () => {
    const pipeline = new ShotPipeline();
    const s1 = pipeline.step(framePayload(0, [ballDet(100, 400)]));
    expect(s1.trackHistory.length).toBeGreaterThan(0);
    const last = s1.trackHistory[s1.trackHistory.length - 1]!;
    expect(last.predicted).toBe(false);
    expect(last.cx).toBeCloseTo(s1.ball!.cx, 5);
    expect(last.cy).toBeCloseTo(s1.ball!.cy, 5);

    // Identity: the exact object BallTracker.getHistory() returns (a live
    // view to be consumed synchronously — the documented contract).
    const tracker = (pipeline as unknown as {
      tracker: { getHistory: () => readonly unknown[] };
    }).tracker;
    const s2 = pipeline.step(framePayload(DT, [ballDet(104, 398)]));
    expect(s2.trackHistory).toBe(tracker.getHistory());
    expect(s2.trackHistory.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Rescue wiring
// ---------------------------------------------------------------------------

describe('acquisition funnel — persistence-rescue wiring', () => {
  test('setTrackerRescue forwards to BallTracker.setRescue', () => {
    const pipeline = new ShotPipeline();
    const tracker = (pipeline as unknown as {
      tracker: { setRescue: (b: boolean) => void };
    }).tracker;
    const spy = jest.spyOn(tracker, 'setRescue');

    pipeline.setTrackerRescue(false);
    expect(spy).toHaveBeenLastCalledWith(false);
    pipeline.setTrackerRescue(true);
    expect(spy).toHaveBeenLastCalledWith(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('default gate: resolved shots are byte-identical with rescue on vs off (the band is empty)', () => {
    // At the DEFAULT cold gate the rescue band [ballScoreMin, coldFloor) is
    // empty by construction, so this pins the documented no-op — the raised-
    // gate iron-rule coverage lives in the describe below.
    const run = (rescue: boolean): ResolvedShot[] => {
      const shots: ResolvedShot[] = [];
      const pipeline = new ShotPipeline({ onShot: (s) => shots.push(s) });
      pipeline.setTrackerRescue(rescue);
      pipeline.setManualRim(RIM_BOX, FRAME);
      const script: Detection[][] = [];
      for (let i = 0; i < SHOT_FRAMES; i++) script.push(shotDetections(i));
      runScript(pipeline, script);
      return shots;
    };

    const on = run(true);
    const off = run(false);
    expect(on).toHaveLength(1);
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });
});

// ---------------------------------------------------------------------------
// Rescue under a RAISED cold gate — the band is actually non-empty here, so
// these tests exercise the pipeline-level rescue path end-to-end through
// fsm.step (the default-gate byte-identity test above cannot).
// ---------------------------------------------------------------------------

describe('acquisition funnel — persistence rescue under a raised cold gate (nano-v2)', () => {
  /** In [ballScoreMin, ballScoreMinNanoV2): visible to DetectionBoxes, below
   *  the raised cold floor — the exact population the rescue exists for. */
  const BAND_SCORE = 0.3;

  /**
   * Steeper make (same vertical profile, vx = 90): the default vx-60 arc
   * grazes the hoop ROI (x 270..370, y 185..235) on the way UP, where the
   * relaxed ballScoreMinHoopRoi floor acquires a banded ball WITHOUT the
   * rescue. This arc keeps the whole up-flight left of the ROI (x < 270 while
   * y is in the ROI band) yet still rises through the up-zone (x ≥ 240) and
   * crosses down at rim center — so cold acquisition and the rescue are the
   * ONLY ways the up-flight can ever be tracked.
   */
  const VX_STEEP = 90;
  function steepShotDetections(i: number, score: number): Detection[] {
    const tau = i * DT;
    const x0 = 320 - VX_STEEP * T_CROSS_DOWN;
    return [
      ballDet(x0 + VX_STEEP * tau, Y0 + VY0 * tau + (G / 2) * tau * tau, score),
    ];
  }

  test('the banded fixture really sits inside the rescue band (guards test vacuity)', () => {
    expect(BAND_SCORE).toBeGreaterThanOrEqual(DETECTION.ballScoreMin);
    expect(BAND_SCORE).toBeLessThan(DETECTION.ballScoreMinNanoV2);
  });

  function raisedPipeline(rescue: boolean, shots: ResolvedShot[]): ShotPipeline {
    const pipeline = new ShotPipeline({ onShot: (s) => shots.push(s) });
    pipeline.setColdBallGate(DETECTION.ballScoreMinNanoV2);
    pipeline.setTrackerRescue(rescue);
    pipeline.setManualRim(RIM_BOX, FRAME);
    return pipeline;
  }

  test('a static banded phantom is never adopted and never resolves — even with rescue ON', () => {
    const shots: ResolvedShot[] = [];
    const pipeline = raisedPipeline(true, shots);
    // A stationary 0.3-score box away from the hoop ROI (a gym light, a
    // background hoop): coherent sightings but ZERO net travel.
    const script: Detection[][] = [];
    for (let i = 0; i < 40; i++) script.push([ballDet(100, 500, BAND_SCORE)]);
    const states = runScript(pipeline, script);

    // The raised floor is live and the phantom was seen + score-rejected —
    // the band is genuinely populated in this run.
    expect(states[0]!.funnel.floor).toBeCloseTo(DETECTION.ballScoreMinNanoV2, 5);
    expect(states.every((s) => s.funnel.ballDets === 1)).toBe(true);
    expect(states[states.length - 1]!.funnel.rejScore).toBeGreaterThanOrEqual(1);
    // Travel gate holds: no adoption, no track, no shot. Ever.
    expect(states.every((s) => !s.funnel.rescued)).toBe(true);
    expect(states.every((s) => s.funnel.track !== 'real')).toBe(true);
    expect(shots).toHaveLength(0);
  });

  test('rescue ON adopts the banded arc that rescue OFF never arms on (recall, not judgment)', () => {
    const bandedScript: Detection[][] = [];
    for (let i = 0; i < SHOT_FRAMES; i++) bandedScript.push(steepShotDetections(i, BAND_SCORE));

    const offShots: ResolvedShot[] = [];
    runScript(raisedPipeline(false, offShots), bandedScript);
    // With rescue off the whole UP-flight dies at the raised floor. The ball
    // is only picked up on descent when it drops into the hoop ROI (the 0.1
    // ROI floor needs no rescue), so the FSM late-arms over a four-sample
    // glimpse — and honestly refuses to call it: unsure, never a minted make.
    expect(offShots).toHaveLength(1);
    expect(offShots[0]!.outcome).toBe('unsure');
    expect(offShots[0]!.tStart).toBeGreaterThan(1); // descent-only pickup

    const onShots: ResolvedShot[] = [];
    const onStates = runScript(raisedPipeline(true, onShots), bandedScript);
    // The rescue chain matured on the banded up-flight and adopted the ball…
    expect(onStates.some((s) => s.funnel.rescued)).toBe(true);
    expect(onStates.some((s) => s.funnel.track === 'real')).toBe(true);
    // …so the FSM armed on the REAL rise and judged the whole flight.
    expect(onShots).toHaveLength(1);
    expect(onShots[0]!.tStart).toBeLessThan(0.6); // armed on the up-flight
  });

  test('iron rule: the rescued shot carries the same judgment as the arc at an above-gate score', () => {
    // The rescue may only ADD recall — the judgment fields of the rescued
    // resolve must equal those of the identical arc scored above the raised
    // gate (where the rescue path never runs). A rescue that mis-seeded the
    // tracker and minted a different outcome/signals would fail here.
    const run = (score: number): ResolvedShot[] => {
      const shots: ResolvedShot[] = [];
      const pipeline = raisedPipeline(true, shots);
      const script: Detection[][] = [];
      for (let i = 0; i < SHOT_FRAMES; i++) script.push(steepShotDetections(i, score));
      runScript(pipeline, script);
      return shots;
    };

    const rescued = run(BAND_SCORE);
    const normal = run(0.8);
    expect(rescued).toHaveLength(1);
    expect(normal).toHaveLength(1);
    expect(rescued[0]!.outcome).toBe(normal[0]!.outcome);
    expect(rescued[0]!.signals).toEqual(normal[0]!.signals);
    expect(rescued[0]!.rimBounce).toBe(normal[0]!.rimBounce);
  });
});
