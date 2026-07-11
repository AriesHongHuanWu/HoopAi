/**
 * Wiring tests for the FT-seed pipeline seam (armFtSeed / onFtSeed /
 * the ftSeed rung of the 2-3pt provenance cascade in shotPipeline.ts).
 *
 * Harness modeled on dribbleWiring.test.ts: a real ShotPipeline instance fed
 * scripted FramePayload sequences — a manually locked rim, a synthetic person
 * whose box bottom is the shooter's foot, and a scripted gravity-true ball
 * flight that arms the FSM and resolves a shot. All timestamps are scripted
 * camera seconds (no Date.now anywhere — the pure-core iron rule).
 *
 * Pinned here (the integrator spec; if implementation and spec disagree, this
 * file encodes the spec):
 * 1. ARM→SEED: an armed FT shot derives the seed from its own origin foot and
 *    classifies ITSELF through it — courtPos ≈ (0, 4.19), value 2, source
 *    'ftSeed', confidence ≤ 0.75.
 * 2. LADDER: court registration outranks the seed; seed outranks metric;
 *    metric now carries an honest capped confidence; manual override wins all.
 * 3. JUDGMENT INVARIANCE (iron rule 1): outcome/signals/rimBounce/xCross/
 *    tStart/tResolved are byte-identical with the seed armed vs never armed —
 *    only value/provenance fields may differ.
 * 4. ATTEMPTS: rejected anchors consume the 3-attempt budget (shotsLeft
 *    2→1→0), the arm disarms at 0, and a null origin consumes an attempt
 *    with reason 'no-origin'.
 * 5. LIFECYCLE: rim-scale drift (> 15 %) clears the seed quietly; reAim() and
 *    reset() clear seed + arm; the tracker's session ball-size cap follows
 *    (set on success, nulled on every clear).
 * 6. OUTCOME-INDEPENDENCE: a missed free throw still derives the seed.
 */
import {
  ShotPipeline,
  type FramePayload,
  type FtSeedFeedback,
  type PipelineFrameState,
} from '../shotPipeline';
import type { CourtRegistration } from '../../core/courtRegistration';
import type { Homography } from '../../core/courtHomography';
import type { Box, Detection, ResolvedShot } from '../../core/types';

// ---------------------------------------------------------------------------
// Scene fixtures
// ---------------------------------------------------------------------------

const FRAME = { width: 640, height: 640 };
const DT = 1 / 30;
/** Manual rim: planeY = 200, cx = 320, span 304..336, belowY = 230. */
const RIM_BOX: Box = { x: 300, y: 200, width: 40, height: 20 };
/** +20 % rim width — beyond the seed's 15 % staleness sentinel. */
const RIM_BOX_WIDER: Box = { x: 296, y: 200, width: 48, height: 20 };

/**
 * Synthetic projectile (same family as shotFsm.test.ts): +y DOWN,
 * y(τ) = 400 − 700τ + 450τ², x(τ) = x0 + 60τ. It rises through the up-zone
 * (~τ = 0.38), crosses the rim plane downward at τ = T_CROSS_DOWN and falls
 * below belowY (~τ = 1.25) — a full arm→resolve cycle inside 48 frames.
 */
const G = 900;
const VY0 = -700;
const Y0 = 400;
const VX = 60;
const T_CROSS_DOWN =
  (700 + Math.sqrt(700 * 700 - 4 * (G / 2) * (Y0 - 200))) / (2 * (G / 2));
const SHOT_FRAMES = 48;
/** Idle frames between shots — clears the 1.5 s FSM cooldown + the track. */
const GAP_FRAMES = 51;

/**
 * The synthetic free-throw spot: the shooter's foot pixel whose pinhole solve
 * (default focal prior 850 px, level camera, regulation rim) lands at an
 * uncalibrated ~3.14 m — inside the FT accept band [2, 9] — dead-center under
 * the rim laterally (u = 0), so the derived yaw is 0 and the anchor maps to
 * exactly (0, ftLineDistanceM) in the seeded court frame.
 */
const FT_FOOT = { x: 320, y: 560 };

function ballDet(cx: number, cy: number): Detection {
  return {
    cls: 'ball',
    score: 0.8,
    box: { x: cx - 15, y: cy - 15, width: 30, height: 30 },
  };
}

/** Person whose box BOTTOM midpoint is the given foot pixel (the FSM's
 *  origin convention: originX/Y = person-box foot midpoint, normalized). */
function personDet(footX: number, footY: number): Detection {
  return {
    cls: 'person',
    score: 0.9,
    box: { x: footX - 30, y: footY - 100, width: 60, height: 100 },
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

/**
 * One scripted session: a real pipeline with a manually locked rim, a running
 * scripted camera clock, and captured onShot / onFtSeed events.
 */
class Session {
  clock = 0;
  readonly states: PipelineFrameState[] = [];
  readonly shots: ResolvedShot[] = [];
  readonly feedbacks: FtSeedFeedback[] = [];
  readonly pipeline: ShotPipeline;

  constructor() {
    this.pipeline = new ShotPipeline({
      onShot: (s) => this.shots.push(s),
      onFtSeed: (r) => this.feedbacks.push(r),
    });
    this.pipeline.setManualRim(RIM_BOX, FRAME);
  }

  step(detections: Detection[]): PipelineFrameState {
    const state = this.pipeline.step(framePayload(this.clock, detections));
    this.states.push(state);
    this.clock += DT;
    return state;
  }

  /**
   * Drive one full shot: the projectile crossing the rim plane at `xCross`
   * (inside span 304..336 = make, outside = miss), with an optional person in
   * every frame supplying the shooter origin.
   */
  driveShot(xCross: number, person: Detection | null): void {
    const x0 = xCross - VX * T_CROSS_DOWN;
    for (let i = 0; i < SHOT_FRAMES; i++) {
      const tau = i * DT;
      const cy = Y0 + VY0 * tau + (G / 2) * tau * tau;
      const cx = x0 + VX * tau;
      const dets = [ballDet(cx, cy)];
      if (person) dets.push(person);
      this.step(dets);
    }
  }

  /** Empty-frame gap: cooldown expires, the ball track dies cleanly. */
  driveGap(frames = GAP_FRAMES): void {
    for (let i = 0; i < frames; i++) this.step([]);
  }
}

/** Test-only introspection of the pipeline's private seed state. */
function seedState(p: ShotPipeline): {
  ftSeed: unknown;
  ftSeedArm: unknown;
} {
  const priv = p as unknown as { ftSeed: unknown; ftSeedArm: unknown };
  return { ftSeed: priv.ftSeed, ftSeedArm: priv.ftSeedArm };
}

function trackerCapSpy(p: ShotPipeline): jest.SpyInstance {
  const tracker = (p as unknown as {
    tracker: { setSessionBallSizeCap: (f: number | null) => void };
  }).tracker;
  return jest.spyOn(tracker, 'setSessionBallSizeCap');
}

// Simple, exactly-invertible image→court homography (same style as
// courtRegistration.test.ts): court.x = (u − 320)/50, court.y = (500 − v)/50.
// The FT foot (320, 560) maps to (0, −1.2) — a valid (plausible) 2-pt
// placement, so classifyByRegistration returns non-null and MUST outrank the
// seed for the same shot.
const H: Homography = [0.02, 0, -6.4, 0, -0.02, 10, 0, 0, 1];

// FIBA is armFtSeed's default spec; only the registration needs one here.
const REG: CourtRegistration = {
  homography: H,
  spec: {
    standard: 'fiba',
    arcRadiusM: 6.75,
    cornerDistanceM: 6.6,
    basketFromBaselineM: 1.575,
    ftLineDistanceM: 4.19,
  },
};

// ---------------------------------------------------------------------------
// 1. ARM → SEED
// ---------------------------------------------------------------------------

describe('ftSeed wiring — arm → seed derivation', () => {
  test('an armed FT make derives the seed and classifies ITSELF through it', () => {
    const s = new Session();
    s.pipeline.armFtSeed();
    s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));

    // The shot resolved and the seed feedback fired exactly once, ok.
    expect(s.shots).toHaveLength(1);
    expect(s.feedbacks).toHaveLength(1);
    const fb = s.feedbacks[0]!;
    expect(fb.ok).toBe(true);
    if (fb.ok) {
      // Uncalibrated anchor distance sits inside the FT accept band [2, 9].
      expect(fb.anchoredAtM).toBeGreaterThan(2);
      expect(fb.anchoredAtM).toBeLessThan(9);
    }

    // Self-consistent receipt: the FT shot lands at the FT spot by
    // construction of the similarity transform (the anchor maps to exactly
    // (0, ftLineDistanceM)), well inside the arc → a 2.
    const shot = s.shots[0]!;
    expect(shot.valueSource).toBe('ftSeed');
    expect(shot.shotValue).toBe(2);
    expect(shot.courtPos).toBeDefined();
    expect(Math.abs(shot.courtPos!.x - 0)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(shot.courtPos!.y - 4.19)).toBeLessThanOrEqual(0.3);
    // Honest confidence: a single-anchor transform can never read 'high'.
    expect(shot.valueConfidence).toBeDefined();
    expect(shot.valueConfidence!).toBeGreaterThan(0);
    expect(shot.valueConfidence!).toBeLessThanOrEqual(0.75);

    // Success disarms; the seed itself stays for the rest of the session.
    expect(seedState(s.pipeline).ftSeedArm).toBeNull();
    expect(seedState(s.pipeline).ftSeed).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. LADDER (provenance cascade)
// ---------------------------------------------------------------------------

describe('ftSeed wiring — 2/3 provenance ladder', () => {
  test('court registration outranks the seed; seed reclaims when registration clears', () => {
    const s = new Session();
    s.pipeline.armFtSeed();
    s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));
    expect(s.shots[0]!.valueSource).toBe('ftSeed');
    expect(s.feedbacks[0]!.ok).toBe(true);

    // Registration set → the SAME shot script now reads 'court'.
    s.driveGap();
    s.pipeline.setCourtRegistration(REG);
    s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));
    expect(s.shots).toHaveLength(2);
    expect(s.shots[1]!.valueSource).toBe('court');

    // Registration cleared, seed still alive → 'ftSeed' again.
    s.driveGap();
    s.pipeline.setCourtRegistration(null);
    s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));
    expect(s.shots).toHaveLength(3);
    expect(s.shots[2]!.valueSource).toBe('ftSeed');
  });

  test('no seed + metric23 → valueSource metric with capped honest confidence', () => {
    const s = new Session();
    s.pipeline.setMetric23(true);
    s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));

    expect(s.shots).toHaveLength(1);
    const shot = s.shots[0]!;
    expect(shot.valueSource).toBe('metric');
    // Metric shots now carry a confidence — capped at the 0.7 metric ceiling
    // (below the 0.75 ftSeed tier, below the 0.8 'high' boundary).
    expect(shot.valueConfidence).toBeDefined();
    expect(shot.valueConfidence!).toBeGreaterThan(0);
    expect(shot.valueConfidence!).toBeLessThanOrEqual(0.7);
  });

  test("courtRange '3pt' still forces valueSource 'manual' over a live seed", () => {
    const s = new Session();
    s.pipeline.armFtSeed();
    s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));
    expect(s.feedbacks[0]!.ok).toBe(true);

    s.driveGap();
    s.pipeline.setCourtRange('3pt');
    s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));
    const shot = s.shots[1]!;
    expect(shot.valueSource).toBe('manual');
    expect(shot.shotValue).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. JUDGMENT INVARIANCE (iron rule 1)
// ---------------------------------------------------------------------------

describe('ftSeed wiring — judgment invariance', () => {
  test('identical frame script, seed armed+derived vs never armed: every judgment field is deepEqual', () => {
    const run = (armed: boolean): { shots: ResolvedShot[]; fbs: FtSeedFeedback[] } => {
      const s = new Session();
      if (armed) s.pipeline.armFtSeed();
      // Two shots: the FT (derives the seed in the armed run) and a follow-up
      // classified THROUGH the seed in the armed run only.
      s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));
      s.driveGap();
      s.driveShot(360, personDet(FT_FOOT.x, FT_FOOT.y));
      return { shots: s.shots, fbs: s.feedbacks };
    };

    const withSeed = run(true);
    const without = run(false);

    // Non-vacuous: the armed run really derived + used the seed.
    expect(withSeed.fbs).toHaveLength(1);
    expect(withSeed.fbs[0]!.ok).toBe(true);
    expect(withSeed.shots.map((x) => x.valueSource)).toEqual([
      'ftSeed',
      'ftSeed',
    ]);
    expect(without.fbs).toHaveLength(0);
    expect(without.shots.every((x) => x.valueSource !== 'ftSeed')).toBe(true);

    // Iron rule: the seed may only relabel value/position — every judgment
    // field of every resolved shot is byte-identical across the two runs.
    expect(withSeed.shots).toHaveLength(without.shots.length);
    for (let i = 0; i < withSeed.shots.length; i++) {
      const a = withSeed.shots[i]!;
      const b = without.shots[i]!;
      expect(a.outcome).toEqual(b.outcome);
      expect(a.signals).toEqual(b.signals);
      expect(a.rimBounce).toEqual(b.rimBounce);
      expect(a.xCross).toEqual(b.xCross);
      expect(a.tStart).toEqual(b.tStart);
      expect(a.tResolved).toEqual(b.tResolved);
      // The trajectory the judgment was made from is identical too.
      expect(a.trajectory).toEqual(b.trajectory);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. ATTEMPTS budget
// ---------------------------------------------------------------------------

describe('ftSeed wiring — attempt budget', () => {
  test('three rejected anchors count down 2,1,0 and the arm disarms (a 4th shot is silent)', () => {
    const s = new Session();
    s.pipeline.armFtSeed();
    // Foot ABOVE the horizon (person high in frame): the metric estimator
    // refuses the anchor scene every time.
    const highPerson = personDet(320, 160);
    for (let i = 0; i < 4; i++) {
      s.driveShot(320, highPerson);
      s.driveGap();
    }

    expect(s.shots).toHaveLength(4);
    // Exactly three feedbacks — the disarmed 4th shot emits nothing.
    expect(s.feedbacks).toHaveLength(3);
    expect(s.feedbacks).toEqual([
      { ok: false, reason: 'no-metric-estimate', shotsLeft: 2 },
      { ok: false, reason: 'no-metric-estimate', shotsLeft: 1 },
      { ok: false, reason: 'no-metric-estimate', shotsLeft: 0 },
    ]);
    expect(seedState(s.pipeline).ftSeedArm).toBeNull();
    expect(seedState(s.pipeline).ftSeed).toBeNull();
  });

  test("a shot with a null origin consumes an attempt with reason 'no-origin'", () => {
    const s = new Session();
    s.pipeline.armFtSeed();
    // No person anywhere → the FSM never captures an origin.
    s.driveShot(320, null);

    expect(s.shots).toHaveLength(1);
    expect(s.shots[0]!.originX).toBeNull();
    expect(s.feedbacks).toEqual([
      { ok: false, reason: 'no-origin', shotsLeft: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. LIFECYCLE (staleness / reAim / reset / tracker cap)
// ---------------------------------------------------------------------------

describe('ftSeed wiring — lifecycle', () => {
  test('rim-width drift > 15% clears the seed quietly and the next shot falls back to metric', () => {
    const s = new Session();
    const cap = trackerCapSpy(s.pipeline);
    s.pipeline.armFtSeed();
    s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));
    expect(s.feedbacks[0]!.ok).toBe(true);
    // Success set a real (positive, shrink-only) session ball-size cap.
    expect(cap).toHaveBeenCalledTimes(1);
    const capFrac = cap.mock.calls[0]![0] as number | null;
    expect(capFrac).not.toBeNull();
    expect(capFrac!).toBeGreaterThan(0);
    expect(capFrac!).toBeLessThanOrEqual(0.22);

    // The rim geometry re-locks 20% wider (driven by a new manual lock —
    // RimLock mutates geometry in place, so only a re-lock moves the width).
    s.driveGap();
    s.pipeline.setManualRim(RIM_BOX_WIDER, FRAME);
    const fbCount = s.feedbacks.length;
    s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));

    // Stale-clear was QUIET (no feedback event) and nulled the tracker cap.
    expect(s.feedbacks).toHaveLength(fbCount);
    expect(cap).toHaveBeenLastCalledWith(null);
    expect(seedState(s.pipeline).ftSeed).toBeNull();
    // The shot after the drift falls back: the session ftCalibration is still
    // active (documented force-enable semantics) so the metric label wins.
    expect(s.shots).toHaveLength(2);
    expect(s.shots[1]!.valueSource).toBe('metric');
  });

  test('reAim() clears seed + arm + tracker cap', () => {
    const s = new Session();
    const cap = trackerCapSpy(s.pipeline);
    s.pipeline.armFtSeed();
    s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));
    expect(seedState(s.pipeline).ftSeed).not.toBeNull();

    s.pipeline.reAim();
    expect(seedState(s.pipeline).ftSeed).toBeNull();
    expect(seedState(s.pipeline).ftSeedArm).toBeNull();
    expect(cap).toHaveBeenLastCalledWith(null);
  });

  test('reset() clears seed + arm + tracker cap', () => {
    const s = new Session();
    const cap = trackerCapSpy(s.pipeline);
    s.pipeline.armFtSeed();
    s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));
    expect(seedState(s.pipeline).ftSeed).not.toBeNull();

    s.pipeline.reset();
    expect(seedState(s.pipeline).ftSeed).toBeNull();
    expect(seedState(s.pipeline).ftSeedArm).toBeNull();
    expect(cap).toHaveBeenLastCalledWith(null);
  });

  test('cancelFtSeed() drops a pending arm without touching a derived seed', () => {
    const s = new Session();
    s.pipeline.armFtSeed();
    expect(seedState(s.pipeline).ftSeedArm).not.toBeNull();
    s.pipeline.cancelFtSeed();
    expect(seedState(s.pipeline).ftSeedArm).toBeNull();
    // No shot resolved while armed → no feedback of any kind.
    expect(s.feedbacks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. OUTCOME INDEPENDENCE
// ---------------------------------------------------------------------------

describe('ftSeed wiring — FT outcome independence', () => {
  test('a MISSED free throw still derives the seed (the shooter stood at the line either way)', () => {
    const s = new Session();
    s.pipeline.armFtSeed();
    // Crossing at x = 360, right of spanRight = 336 → geo false → miss.
    s.driveShot(360, personDet(FT_FOOT.x, FT_FOOT.y));

    expect(s.shots).toHaveLength(1);
    expect(s.shots[0]!.outcome).toBe('miss');
    expect(s.feedbacks).toHaveLength(1);
    expect(s.feedbacks[0]!.ok).toBe(true);
    expect(seedState(s.pipeline).ftSeed).not.toBeNull();
    // The missed FT still receipts as an FT-anchored 2 at the line.
    expect(s.shots[0]!.valueSource).toBe('ftSeed');
    expect(Math.abs(s.shots[0]!.courtPos!.y - 4.19)).toBeLessThanOrEqual(0.3);
  });
});
