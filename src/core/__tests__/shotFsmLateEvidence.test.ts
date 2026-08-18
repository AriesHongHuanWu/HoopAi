/**
 * LATE-EVIDENCE pins — "the ball clearly goes in, but the shot ended too early".
 *
 * WHY THIS SUITE EXISTS. A real-device report: made shots were being scored as
 * misses because the attempt was sealed before the evidence that proves a make
 * could arrive. Five independent mechanisms conspired, and each one is pinned
 * here with a BEFORE/AFTER pair so the fix cannot silently regress:
 *
 *  (B) A Kalman GHOST could both END and DECIDE a shot. `belowY - planeY` is
 *      ~1.5 rim-box heights — less than one inter-frame descent at 15 fps — so
 *      a coast (up to TRACKER.maxPredictedSec = 0.5 s) routinely "fell past the
 *      rim" while the real ball was still at the hoop, and the same ghost pair
 *      then supplied the interpolated crossing x the geo channel scored.
 *  (A+D) "The ball left the rim band" and "stop collecting evidence" were the
 *      same event, and the one mechanism that extends observation (the settle
 *      window) was gated on `touchedRim` — which at low fps never latches,
 *      because the first below-rim sample overshoots the whole band.
 *  (F) A net channel that had never sampled the FORWARD half of its own
 *      acceptance window still reported "no swish", and fuse() turns
 *      geo === true && net === false into a hard MISS.
 *  (E) The `vy > 0` escape bypassed wasAbovePlane, so a release-armed attempt
 *      seeded at the shooter's HANDS died on the first frame the gravity-biased
 *      Kalman velocity read downward.
 *  (C) The apex was architecturally unreachable, and the global FlightArc — the
 *      only buffer spanning the whole flight — never reached make/miss.
 *
 * EVERY assertion here is either a suppression-removal or a corroborator that
 * already had to clear the pinned "never without net or cls" contract. The two
 * NEW refusals in this file (the apex sanity guard, the ghost-crossing refusal)
 * only ever take a make away or hand a decision back to 'unsure'.
 */
import { RIM, SHOT_FSM } from '../config';
import { ShotFsm } from '../shotFsm';
import type {
  Box,
  FlightLanding,
  FsmFrameInput,
  ResolvedShot,
  RimGeometry,
  TrackedBall,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures & helpers (same rim and frame as shotFsm.test.ts)
// ---------------------------------------------------------------------------

const FRAME = { width: 640, height: 640 };

/** Rim box: planeY=200, cx=320, span 304..336, belowY=230, hoopRoi 270..370 × 185..235. */
const RIM_BOX: Box = { x: 300, y: 200, width: 40, height: 20 };

function rimFromBox(box: Box): RimGeometry {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const planeY = box.y;
  const halfSpan = (box.width * RIM.spanFraction) / 2;
  const upW = box.width * RIM.upZoneWidthFactor;
  const upH = box.height * RIM.upZoneHeightFactor;
  const roiW = box.width * RIM.hoopRoiFactor;
  const roiH = box.height * RIM.hoopRoiFactor;
  return {
    box,
    cx,
    cy,
    planeY,
    spanLeft: cx - halfSpan,
    spanRight: cx + halfSpan,
    belowY: box.y + box.height + RIM.belowMarginFactor * box.height,
    upZone: { x: cx - upW / 2, y: planeY - upH, width: upW, height: upH },
    hoopRoi: { x: cx - roiW / 2, y: cy - roiH / 2, width: roiW, height: roiH },
    netRoi: {
      x: box.x,
      y: box.y + box.height,
      width: box.width,
      height: box.height * RIM.netRoiHeightFactor,
    },
  };
}

/** Conservative constructor baseline (both make-suppressing levers OFF). */
function baselineFsm(): ShotFsm {
  return new ShotFsm(rimFromBox(RIM_BOX), FRAME);
}

/** The LIVE app configuration (settle window + rattle-out guard ON). */
function liveFsm(): ShotFsm {
  return new ShotFsm(rimFromBox(RIM_BOX), FRAME, {
    useSettleWindow: true,
    useRattleGuard: true,
  });
}

function tb(
  cx: number,
  cy: number,
  t: number,
  vy: number,
  opts: Partial<TrackedBall> = {},
): TrackedBall {
  return { cx, cy, r: 10, t, score: 0.8, predicted: false, vx: 0, vy, ...opts };
}

function fin(
  t: number,
  ball: TrackedBall | null,
  opts: Partial<Omit<FsmFrameInput, 't' | 'ball'>> = {},
): FsmFrameInput {
  return { t, ball, ballInBasketScore: 0, netMotionScore: 0, personBox: null, ...opts };
}

function run(fsm: ShotFsm, frames: readonly FsmFrameInput[]): ResolvedShot[] {
  const out: ResolvedShot[] = [];
  for (const f of frames) {
    const r = fsm.step(f);
    if (r.resolved) out.push(r.resolved);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Synthetic projectile, identical physics to shotFsm.test.ts
// (y down: y(t) = Y0 + VY0*t + 0.5*G*t², VY0 < 0 = rising)
// ---------------------------------------------------------------------------

const G = 900;
const VY0 = -700;
const Y0 = 400;
const VX = 60;
const FPS = 30;

/** Descending crossing time of the rim plane (y = 200). */
const T_CROSS_DOWN =
  (700 + Math.sqrt(700 * 700 - 4 * (G / 2) * (Y0 - 200))) / (2 * (G / 2));
/** x0 placing that crossing exactly on the rim center. */
const X0_CENTER = 320 - VX * T_CROSS_DOWN;

const arcY = (t: number): number => Y0 + VY0 * t + 0.5 * G * t * t;
const arcX = (t: number, x0: number = X0_CENTER): number => x0 + VX * t;

// ===========================================================================
// (B) A Kalman GHOST may neither END nor DECIDE a shot
// ===========================================================================

/**
 * A textbook swish whose ball is LOST exactly at the rim — the single most
 * common presentation of a made shot, because rim and net occlude the ball at
 * precisely the moment it passes through. The tracker coasts for four frames,
 * and because a coast carries stale horizontal velocity the ghost drifts
 * sideways out of the rim span while dropping past belowY on schedule.
 *
 * OLD behaviour: the ghost's below-rim sample ENDED the attempt, and the ghost
 * pair supplied the crossing the geo channel scored — an out-of-span
 * "crossing" that fuse() reads as a hard MISS. The made shot was recorded as a
 * miss from positions no camera ever observed.
 *
 * @param net net-motion score by camera time (the real swish burst).
 */
function ghostAtRimFrames(net: (t: number) => number): FsmFrameInput[] {
  const frames: FsmFrameInput[] = [];
  // Real flight: release → last clean sample 15px above the plane.
  for (let i = 0; i <= 34; i++) {
    const t = i / FPS;
    frames.push(
      fin(t, tb(arcX(t), arcY(t), t, VY0 + G * t, { vx: VX }), {
        netMotionScore: net(t),
      }),
    );
  }
  // Occlusion at the rim: four Kalman coasts. Vertically they follow the true
  // flight (the filter's y model is right); horizontally they drift, which is
  // exactly how a coast fabricates an out-of-span crossing x.
  for (let i = 35; i <= 38; i++) {
    const t = i / FPS;
    frames.push(
      fin(
        t,
        tb(arcX(t) + 40 * (i - 34), arcY(t), t, VY0 + G * t, {
          vx: VX,
          predicted: true,
          score: 0,
        }),
        { netMotionScore: net(t) },
      ),
    );
  }
  // Ball never reacquired: the attempt ends on lostBallResolveSec (1.5 s).
  for (let i = 39; i <= 84; i++) {
    const t = i / FPS;
    frames.push(fin(t, null, { netMotionScore: net(t) }));
  }
  return frames;
}

/** The genuine swish burst, at and just after the true crossing (t≈1.178). */
const swishBurst = (t: number): number =>
  t >= T_CROSS_DOWN && t <= T_CROSS_DOWN + 0.12 ? 0.6 : 0;

describe('(B) a Kalman ghost may neither end nor decide a shot', () => {
  test('a made shot lost at the rim is no longer sealed by the coast — it stays live and resolves a MAKE', () => {
    const resolved = run(liveFsm(), ghostAtRimFrames(swishBurst));
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];

    // The attempt outlived the ghost's below-rim sample (t=1.267) and ended on
    // the honest ball-lost timeout instead.
    expect(shot.tResolved).toBeGreaterThan(2.5);

    // No fabricated crossing: the geo channel refuses a pair containing a
    // coast, so `xCross` (the OBSERVED crossing) stays null…
    expect(shot.xCross).toBeNull();
    // …and the make is carried by the corroborator that reads REAL samples
    // only — a strict, gravity-checked parabola fitted over the observed
    // descent, agreeing with a net burst above threshold.
    expect(shot.virtualCross).toBeDefined();
    expect(shot.virtualCross!.r2y).toBeGreaterThanOrEqual(0.9);
    expect(Math.abs(shot.virtualCross!.xCross - 320)).toBeLessThan(6);
    expect(shot.signals.net).toBe(true);
    expect(shot.signals.geo).toBe(true);
    expect(shot.outcome).toBe('make');
  });

  test('BREAD-BALL: strip the corroboration and the same ghost yields UNSURE, never a make and never a fabricated miss', () => {
    // Identical flight, silent net, no ball_in_basket. The projection still
    // runs (diagnostics present) but has nothing to agree with, so geo stays
    // null. Crucially it is NOT a miss either: convicting on a crossing x that
    // came out of the filter is precisely what this fix removes.
    const resolved = run(liveFsm(), ghostAtRimFrames(() => 0));
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    expect(shot.virtualCross).toBeDefined();
    expect(shot.signals.geo).toBeNull();
    expect(shot.xCross).toBeNull();
    expect(shot.outcome).toBe('unsure');
  });

  test('a ghost dropping past belowY does not end the attempt even when it is the only ball on screen', () => {
    // Minimal, direct pin of the trigger itself: arm, one real above-plane
    // sample, then a coast well past belowY. The old trigger resolved on that
    // coast; now the attempt is still SHOT_LIVE and ends only when a REAL
    // sample is seen deep.
    const fsm = baselineFsm();
    const seq: FsmFrameInput[] = [
      fin(0 / 30, tb(320, 180, 0 / 30, -100)), // arm (jump)
      fin(1 / 30, tb(320, 190, 1 / 30, 250)),
      fin(2 / 30, tb(322, 260, 2 / 30, 500, { predicted: true, score: 0 })),
      fin(3 / 30, tb(324, 330, 3 / 30, 600, { predicted: true, score: 0 })),
    ];
    const results = seq.map((f) => fsm.step(f));
    expect(results.map((r) => r.phase)).toEqual([
      'SHOT_LIVE',
      'SHOT_LIVE',
      'SHOT_LIVE',
      'SHOT_LIVE',
    ]);
    expect(results.every((r) => r.resolved === null)).toBe(true);

    // …and a REAL deep sample still ends it immediately.
    const last = fsm.step(fin(4 / 30, tb(325, 340, 4 / 30, 620)));
    expect(last.resolved).not.toBeNull();
  });
});

// ===========================================================================
// (A+D+F) the 15 fps made shot whose net burst arrives after the crossing
// ===========================================================================

/**
 * THE USER-REPORTED SHOT, at 15 fps. The ball descends ~55 px per frame at the
 * rim, so a single sample carries it from above the plane (187) to well below
 * the rim bottom (242) — straddling the entire rim band without ever sampling
 * inside it, so `touchedRim` never latches. The genuine net burst lands one and
 * two frames LATER, which is where a swish's net motion always is: the net ROI
 * hangs below the rim BOTTOM, i.e. entirely after the crossing.
 *
 * OLD behaviour: the settle window refused to arm (no rim contact), the shot
 * froze on the below-rim sample, the burst was never sampled, and
 * geo === true && net === false is a hard MISS.
 */
const lowFpsRows: Array<[number, number, number, number, number]> = [
  // [t, cx, cy, vy, netScore] — 15 fps. The 0.05 baseline is ambient net
  // shimmer: far below netMotionThreshold (0.25), but enough that the channel
  // counts as AVAILABLE, so this test exercises the net path and not the
  // netless one.
  [0.0, 250, 190, -500, 0.05], // arm (jump: rising through the up-zone)
  [1 / 15, 262, 152, -380, 0.05],
  [2 / 15, 274, 130, -160, 0.05], // apex region, far above the rim
  [3 / 15, 286, 126, 80, 0.05],
  [4 / 15, 298, 148, 400, 0.05],
  [5 / 15, 310, 187, 700, 0.05], // last sample above the plane, clear of the rim band
  [6 / 15, 321, 242, 950, 0.05], // straddles the WHOLE rim band → no rim contact
  [7 / 15, 332, 310, 1050, 0.6], // the swish burst — AFTER the old resolve point
  [8 / 15, 343, 385, 1150, 0.6],
];

function lowFpsFrames(): FsmFrameInput[] {
  const out = lowFpsRows.map(([t, cx, cy, vy, net]) =>
    fin(t, tb(cx, cy, t, vy), { netMotionScore: net }),
  );
  // Ball out of shot; the deferred resolve fires 0.30 s after the below-rim
  // sample at t=0.4.
  for (let i = 9; i <= 11; i++) out.push(fin(i / 15, null));
  return out;
}

describe('(A+D) 15 fps: the settle window arms without rim contact, so the late net burst is sampled', () => {
  test('the made shot is a MAKE — the burst that proves it now arrives inside the observation window', () => {
    const resolved = run(liveFsm(), lowFpsFrames());
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    // The ball never sampled inside the rim band: the precondition that used
    // to disarm the window is genuinely absent here.
    expect(shot.rimBounce).toBe(false);
    // Observed, in-span crossing…
    expect(shot.signals.geo).toBe(true);
    expect(shot.xCross).not.toBeNull();
    expect(shot.xCross!).toBeGreaterThan(304);
    expect(shot.xCross!).toBeLessThan(336);
    // …plus the burst that only the deferred window could see.
    expect(shot.signals.net).toBe(true);
    expect(shot.outcome).toBe('make');
    expect(shot.holds).toBeUndefined();
    // Latency is capped at settleWindowSec: the resolve is the first frame
    // past 0.4 + 0.30 (with the pinned GATE_EPS_SEC half-frame boundary).
    expect(shot.tResolved).toBeGreaterThan(0.4);
    expect(shot.tResolved).toBeLessThanOrEqual(0.4 + SHOT_FSM.settleWindowSec + 1 / 15);
  });

  test('BREAD-BALL: a genuinely silent net on the same flight is still not a make', () => {
    // Same geometry, ambient shimmer only — never a burst above threshold. The
    // window observed the forward half of the acceptance window in full and saw
    // nothing, so net === false stands and fuse() calls the miss it always did.
    const silent = lowFpsFrames().map((f) =>
      f.netMotionScore > 0 ? { ...f, netMotionScore: 0.05 } : f,
    );
    const resolved = run(liveFsm(), silent);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].signals.geo).toBe(true);
    expect(resolved[0].signals.net).toBe(false);
    expect(resolved[0].outcome).toBe('miss');
  });
});

// ===========================================================================
// (F) an UNOBSERVED forward net window is 'unavailable', not 'no swish'
// ===========================================================================

describe('(F) the net channel reports null when its forward window was never sampled', () => {
  /**
   * Arm, cross the plane in-span, and end on the very next sample — the shape
   * every fast low-fps drop and every ball-lost-at-the-rim resolve takes. Only
   * ONE net sample exists after the crossing, so the half of the window where a
   * swish's net motion has to live was never observed.
   */
  const abruptRows: Array<[number, number, number, number, number]> = [
    [0.0, 320, 180, -100, 0.05], // arm (jump)
    [1 / 30, 320, 178, -50, 0.05],
    [2 / 30, 320, 190, 200, 0.05], // last above the plane
    [3 / 30, 321, 245, 900, 0.05], // crossing pair partner AND first below belowY
  ];

  test('one post-crossing net sample ⇒ net is UNAVAILABLE (null), never a fabricated "no swish"', () => {
    const resolved = run(
      baselineFsm(),
      abruptRows.map(([t, cx, cy, vy, net]) =>
        fin(t, tb(cx, cy, t, vy), { netMotionScore: net }),
      ),
    );
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    expect(shot.signals.geo).toBe(true);
    expect(shot.signals.net).toBeNull();
    // fuse()'s netless branch: an OBSERVED in-span crossing decides it. That is
    // the same rule a netless hoop has always used — no new make term.
    expect(shot.outcome).toBe('make');
  });

  test('BREAD-BALL: once the forward window IS observed, a silent net still convicts', () => {
    // The identical crossing on the LIVE configuration, whose settle window
    // keeps the shot live for settleWindowSec and therefore keeps sampling the
    // net — ten post-crossing samples, all demonstrably quiet. `false` is an
    // OBSERVATION again, so the miss stands. This is the assertion that stops
    // the fix from blanket-disabling the miss path: `null` means unobserved,
    // not "benefit of the doubt".
    const rows: Array<[number, number, number, number, number]> = [...abruptRows];
    for (let i = 4; i <= 12; i++) {
      rows.push([i / 30, 320 + i, 245 + 55 * (i - 3), 950, 0.05]);
    }
    const resolved = run(
      liveFsm(),
      rows.map(([t, cx, cy, vy, net]) =>
        fin(t, tb(cx, cy, t, vy), { netMotionScore: net }),
      ),
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].signals.geo).toBe(true);
    expect(resolved[0].signals.net).toBe(false);
    expect(resolved[0].outcome).toBe('miss');
  });
});

// ===========================================================================
// (E) a release-armed attempt must not die on its first live frame
// ===========================================================================

/**
 * The release path arms at the shooter's HANDS — far below belowY and far
 * outside the rim span — because that is the whole point of the path: the ball
 * is too faint at release for the three ball-kinematic branches to fire. A
 * freshly seeded Kalman track carries a gravity-biased downward velocity, so
 * the very first live frame could read `cy > belowY && vy > 0` and end the
 * attempt before the ball had left head height. Worse, the junk resolve then
 * started shotCooldownSec, which swallowed the real shot that followed.
 */
function releaseArmedRows(): FsmFrameInput[] {
  const y = (t: number): number => 380 - 700 * t + 450 * t * t;
  const x = (t: number): number => 200 + 97.5 * t;
  const out: FsmFrameInput[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / FPS;
    // Frame 1 carries the artifact: the filter reports vy > 0 (falling) while
    // the OBSERVED position is still climbing (380 → 357).
    const vy = i === 1 ? 40 : -700 + 900 * t;
    out.push(
      fin(t, tb(x(t), y(t), t, vy, { vx: 97.5 }), {
        netMotionScore: t >= 1.2 && t <= 1.33 ? 0.6 : 0,
        ...(i === 0 ? { releaseEventT: 0 } : {}),
      }),
    );
  }
  return out;
}

describe('(E) a release-armed shot survives the first gravity-biased velocity sample', () => {
  test('the attempt lives to the rim and scores the MAKE instead of dying at t=0.033', () => {
    const resolved = run(baselineFsm(), releaseArmedRows());
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    // ONE shot, resolved at the rim — not a 2-sample stub at the hands.
    expect(shot.tResolved).toBeGreaterThan(1.2);
    expect(shot.trajectory.length).toBeGreaterThan(30);
    expect(shot.signals.geo).toBe(true);
    expect(shot.signals.net).toBe(true);
    expect(shot.outcome).toBe('make');
  });

  test('BREAD-BALL: a ball genuinely SEEN falling below the rim still ends the attempt promptly', () => {
    // The honest airball: a release-armed ball that never rises, with two
    // consecutive REAL samples moving down. Observation, not filter state, so
    // the prompt end is preserved — and the outcome is 'unsure', never a make.
    const fsm = baselineFsm();
    const seq: FsmFrameInput[] = [
      fin(0, tb(200, 380, 0, -600), { releaseEventT: 0 }), // arm (release path)
      fin(1 / 30, tb(206, 400, 1 / 30, 500)), // REAL descent observed…
      fin(2 / 30, tb(212, 430, 2 / 30, 600)), // …and confirmed → resolve here
    ];
    const results = seq.map((f) => fsm.step(f));
    expect(results[1].resolved).not.toBeNull();
    expect(results[1].resolved!.outcome).toBe('unsure');
  });
});

// ===========================================================================
// (C) the apex sanity guard — a ball that peaked below the rim is not a make
// ===========================================================================

describe('(C) apex sanity: a flight whose fitted vertex is below the rim plane cannot be a make', () => {
  /**
   * A ball travelling just UNDER the rim — a bounce pass out of the paint, a
   * ball rattling around beneath the net — on a clean gravity parabola whose
   * VERTEX sits at cy≈210, below the rim plane (200). ONE jittery detection at
   * cy=198 pokes a single sample above the plane, and that is all the 2D
   * channels need: that sample plus the next form an in-span descending
   * "crossing" (geo=true), and the ball brushing the net supplies a burst
   * (net=true). A textbook geo+net make out of a ball that physically never
   * reached the hoop — invisible to every existing channel, because they all
   * read the flight only from the rim onwards.
   *
   * Armed via the release path: the ball is below the rim plane throughout, so
   * no ball-kinematic branch can start it, which is exactly the situation the
   * pose-gated path exists for (and exactly why the pose event alone is never
   * enough).
   */
  function underRimFrames(): FsmFrameInput[] {
    const y = (t: number): number => 210 + 1800 * (t - 0.15) ** 2;
    const out: FsmFrameInput[] = [];
    for (let i = 0; i <= 17; i++) {
      const t = i / 30;
      // Frame 4 is the jitter: one detection box shoved 12px above the plane.
      const cy = i === 4 ? 198 : y(t);
      out.push(
        fin(t, tb(320, cy, t, 3600 * (t - 0.15)), {
          netMotionScore: t >= 0.1 && t <= 0.24 ? 0.6 : 0,
          ...(i === 0 ? { releaseEventT: 0 } : {}),
        }),
      );
    }
    return out;
  }

  test('the geo+net "make" is demoted to unsure and tagged apexBelowRim', () => {
    const resolved = run(liveFsm(), underRimFrames());
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    // The 2D channels genuinely read a make — that is the point.
    expect(shot.signals.geo).toBe(true);
    expect(shot.signals.net).toBe(true);
    // …and the arc says the ball never got up to the rim.
    expect(shot.apex).toBeDefined();
    expect(shot.apex!.aboveRimPlanePx).toBeLessThan(0);
    // The fit had to clear the STRICT R² bar before the guard was allowed to
    // act (SHOT_FSM.apexSanity.minR2y); a noisy arc leaves the guard inert.
    expect(shot.apex!.r2y).toBeGreaterThanOrEqual(0.9);
    expect(shot.outcome).toBe('unsure');
    expect(shot.holds).toContain('apexBelowRim');
  });

  test('BREAD-BALL: a genuine swish reports an apex WELL above the rim and is untouched', () => {
    const frames: FsmFrameInput[] = [];
    for (let i = 0; i <= 45; i++) {
      const t = i / FPS;
      frames.push(
        fin(t, tb(arcX(t), arcY(t), t, VY0 + G * t, { vx: VX }), {
          netMotionScore: swishBurst(t),
        }),
      );
    }
    const resolved = run(baselineFsm(), frames);
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    // The apex is finally visible at all — and it comes from the pre-arm
    // APPROACH plus the flight, since the judgment buffer starts at the rim.
    expect(shot.apex).toBeDefined();
    expect(shot.apex!.aboveRimPlanePx).toBeGreaterThan(50);
    expect(shot.apex!.nSamples).toBeGreaterThan(shot.trajectory.length);
    expect(shot.outcome).toBe('make');
    expect(shot.holds).toBeUndefined();
  });
});

// ===========================================================================
// (C) the global FlightArc landing as a SECOND virtual-crossing corroborator
// ===========================================================================

/**
 * An occluded shot whose live tail is too short for the FSM's own local
 * projection (projectVirtualCross needs a run of real, above-plane, descending
 * samples ending at the hoop — a tail the detector very often does not
 * deliver, because that IS the occlusion). The pipeline's global arc, fitted
 * over the whole flight, still has a confident landing.
 *
 * @param landing what the pipeline delivers (null = no trustworthy fit).
 * @param clsScore ball_in_basket score during the flight.
 */
function occludedShortTailFrames(
  landing: FlightLanding | null,
  clsScore: number,
): FsmFrameInput[] {
  const rows: Array<[number, number, number, number]> = [
    [0 / 30, 300, 180, -100], // arm (jump: rising in the up-zone)
    [1 / 30, 305, 172, -50],
    [2 / 30, 310, 174, 100],
    [3 / 30, 315, 180, 250], // last real sample — still ABOVE the plane, then gone
  ];
  const extra = landing !== null ? { flightLanding: landing } : {};
  const out = rows.map(([t, cx, cy, vy]) =>
    fin(t, tb(cx, cy, t, vy), { ballInBasketScore: clsScore, ...extra }),
  );
  for (let i = 4; i <= 50; i++) {
    const t = i / FPS;
    out.push(fin(t, null, { ballInBasketScore: i <= 6 ? clsScore : 0, ...extra }));
  }
  return out;
}

/** A confident in-span landing from the global 64-sample parabola. */
const IN_SPAN_LANDING: FlightLanding = { x: 320, t: 0.25, r2y: 0.95 };

describe('(C) the global flight-arc landing corroborates an occluded crossing', () => {
  test('netless hoop + ball_in_basket + an in-span global landing ⇒ MAKE', () => {
    const resolved = run(
      baselineFsm(),
      occludedShortTailFrames(IN_SPAN_LANDING, 0.5),
    );
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    // The FSM's own local projection could not run (tail too short).
    expect(shot.virtualCross).toBeUndefined();
    // The global arc did, and it is surfaced as diagnostics.
    expect(shot.flightCross).toBeDefined();
    expect(shot.flightCross!.xCross).toBeCloseTo(320, 6);
    expect(shot.signals.net).toBeNull();
    expect(shot.signals.cls).toBe(true);
    expect(shot.signals.geo).toBe(true);
    expect(shot.outcome).toBe('make');
  });

  test('WITHOUT the landing the very same shot is unsure — the corroborator is what decided it', () => {
    const resolved = run(baselineFsm(), occludedShortTailFrames(null, 0.5));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].flightCross).toBeUndefined();
    expect(resolved[0].signals.geo).toBeNull();
    expect(resolved[0].outcome).toBe('unsure');
  });

  test('BREAD-BALL: it never acts alone — an in-span landing with no net and no cls stays unsure', () => {
    const resolved = run(
      baselineFsm(),
      occludedShortTailFrames(IN_SPAN_LANDING, 0),
    );
    expect(resolved).toHaveLength(1);
    // The diagnostic is still recorded; the upgrade is refused.
    expect(resolved[0].flightCross).toBeDefined();
    expect(resolved[0].signals.geo).toBeNull();
    expect(resolved[0].outcome).toBe('unsure');
  });

  test('BREAD-BALL: an OUT-of-span landing leaves geo null — a projection never convicts either', () => {
    const resolved = run(
      baselineFsm(),
      occludedShortTailFrames({ x: 250, t: 0.25, r2y: 0.95 }, 0.5),
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].signals.geo).toBeNull();
    expect(resolved[0].outcome).not.toBe('make');
    expect(resolved[0].outcome).not.toBe('miss');
  });

  test('BREAD-BALL: a loose global fit is refused outright (strict R² bar)', () => {
    const resolved = run(
      baselineFsm(),
      occludedShortTailFrames({ x: 320, t: 0.25, r2y: 0.7 }, 0.5),
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].flightCross).toBeUndefined();
    expect(resolved[0].signals.geo).toBeNull();
    expect(resolved[0].outcome).toBe('unsure');
  });

  test('BREAD-BALL: it can never flip a SEEN out-of-span crossing into a make', () => {
    // A front-rim brick: a real, observed crossing at x≈290, outside the span
    // (304..336), with a net burst AND a (wrong) in-span global landing. The
    // corroborator only ever upgrades geo === null; an explicit false stands.
    const x0 = 290 - VX * T_CROSS_DOWN;
    const frames: FsmFrameInput[] = [];
    for (let i = 0; i <= 45; i++) {
      const t = i / FPS;
      frames.push(
        fin(t, tb(arcX(t, x0), arcY(t), t, VY0 + G * t, { vx: VX }), {
          netMotionScore: swishBurst(t),
          flightLanding: { x: 320, t: T_CROSS_DOWN, r2y: 0.99 },
        }),
      );
    }
    const resolved = run(baselineFsm(), frames);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].signals.geo).toBe(false);
    expect(resolved[0].outcome).toBe('miss');
  });
});
