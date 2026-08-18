/**
 * ShotFsm — the realtime make/miss shot state machine (three-signal fusion).
 *
 * One instance lives per session. Feed it one {@link FsmFrameInput} per
 * analysed camera frame via {@link ShotFsm.step}. The machine arms when a
 * ball climbs into the rim's up-zone, a player carries the ball above the
 * rim plane near the hoop (the layup path), a confident ball falls into
 * the hoop ROI off a ballistic arc from outside the zone (the
 * descending-entry / floater path — seeded retroactively from a rolling
 * pre-arm buffer), or a pose-gated release event is corroborated by a real
 * upper-frame ball (the release path — for the dark/small ball the detector
 * misses at release; see RELEASE in config.ts), buffers the live
 * trajectory, and resolves each attempt to make / miss / unsure by fusing
 * three independent signals:
 *
 *  - geo — interpolated x at the rim plane on the FINAL descending crossing
 *    lies within the central rim span. The crossing must be OBSERVED: both
 *    samples of the pair are real detections, never Kalman coasts, because an
 *    extrapolated position is not a sighting. `null` when the ball was never
 *    seen crossing the plane downward — which is the NORMAL state of a made
 *    shot, since rim and net occlude the ball at exactly that moment. Four
 *    corroborators (geoExit / reappearance / virtualCross / flightCross) may
 *    upgrade that null to true, and every one of them requires agreement from
 *    net or cls; none may flip an explicit `false`.
 *  - net — a net-motion burst within `SHOT_FSM.netWindowSec` of the crossing
 *    (threshold raised by `netMotionRimBounceFactor` after a rim bounce).
 *    The channel is `null` (UNAVAILABLE) when every net-motion score during
 *    the live window was exactly 0 (netless hoop or no monitor), or when the
 *    FORWARD half of the acceptance window — the only half a swish's net
 *    motion can occupy, since the net ROI hangs below the rim bottom — was
 *    never sampled (see `SHOT_FSM.netForwardMinSamples`).
 *  - cls — the detector's 'ball_in_basket' class fired at or above
 *    `DETECTION.ballInBasketScoreMin` at any point during the live shot.
 *
 * The apex of the whole flight (pre-arm approach + trajectory) is fitted at
 * resolve and reported as diagnostics; a fitted vertex BELOW the rim plane can
 * only ever demote a make to 'unsure' (`SHOT_FSM.apexSanity`).
 *
 * Pure TypeScript: no I/O, no wall-clock reads — time comes exclusively from
 * camera timestamps in the inputs. Per-frame allocation is bounded (one
 * trajectory sample + one net sample while a shot is live).
 *
 * Coordinates are analysis-frame pixels, +y DOWN (ball moving up ⇒ vy < 0).
 */
import {
  DETECTION,
  FLIGHT,
  NOMINAL_FPS,
  RELEASE,
  SHOT_FSM,
  scaleFrameGate,
  GATE_EPS_SEC,
} from './config';
import { depthRatioGate, type BallSizeSetting, type ViewBandName } from './depthRatioGate';
import { elevationAngleDeg, interpolateXAtY } from './geometry';
import { ReappearanceTest } from './reappearance';
import { selectDepthSamples } from './sampleQuality';
import {
  ABS_MIN_FIT_SAMPLES,
  MIN_FIT_SAMPLES,
  apexPoint,
  backfillPredictedGap,
  fitArc,
  plausibleArcCurvature,
  predictLanding,
} from './trajectory';
import type {
  BallSample,
  Box,
  FlightLanding,
  FsmFrameInput,
  FsmStepResult as FsmStepResultBase,
  ResolvedShot,
  RimGeometry,
  ShotHold,
  ShotOutcome,
  ShotPhase,
  TrackedBall,
} from './types';

/**
 * Analysis-frame dimensions, used to normalize the shooter origin
 * (`ResolvedShot.originX/Y` are documented as 0..1) since `FsmFrameInput`
 * carries pixel-space boxes only.
 */
export interface FrameSize {
  width: number;
  height: number;
}

/**
 * Why the FSM did not need to — or declined to — arm on a given frame.
 * DIAGNOSTIC VOCABULARY ONLY (acquisition-funnel telemetry): it is recorded
 * alongside the existing arming decisions and never feeds one.
 *
 *  - 'live'      — a shot was live entering this frame (still SHOT_LIVE, or
 *                  it resolved into COOLDOWN on this very frame). Arming is
 *                  not applicable.
 *  - 'armed'     — the FSM armed a new attempt THIS frame.
 *  - 'no-ball'   — IDLE with no ball this frame (nothing to evaluate).
 *  - 'lockout'   — canArm refused: multi-ball / rim-drift arm lockout
 *                  (FsmFrameInput.armLockout).
 *  - 'cooldown'  — waiting out the shot cooldown: the COOLDOWN phase frames
 *                  after a resolve, or canArm's (redundant) cooldown guard.
 *  - 'putback'   — canArm refused: inside the putback window after a
 *                  rim-bounce resolve.
 *  - 'resting'   — canArm refused: wedged/resting-ball suppression active.
 *  - 'no-branch' — a ball was evaluated and NO arm branch
 *                  (jump/layup/descend/release) fired. This is the "detected
 *                  but never judged" counter the funnel quantifies.
 */
export type ArmRefusal =
  | 'live'
  | 'armed'
  | 'no-ball'
  | 'lockout'
  | 'cooldown'
  | 'putback'
  | 'resting'
  | 'no-branch';

/**
 * The step result with the additive arm-refusal telemetry field. Extends the
 * shared {@link FsmStepResultBase} shape from types.ts, so every existing
 * consumer typed against that base keeps compiling unchanged.
 */
export interface FsmStepResult extends FsmStepResultBase {
  /**
   * Diagnostic only — mirrors why canArm declined this frame (or that it was
   * inapplicable/succeeded); never feeds state transitions. The arming logic
   * itself is byte-identical with the recording removed.
   */
  armRefusal: ArmRefusal;
}

/** Why a live shot left SHOT_LIVE (internal). */
type ResolveReason = 'belowRim' | 'ballLost' | 'timeout';

/** Which arming branch started the live attempt (internal). */
type ArmVia = 'jump' | 'layup' | 'descend' | 'release';

/**
 * Max samples kept in the live trajectory trail. A release→rim arc at 15–30 fps
 * is ~15–40 samples, so this doesn't clip a real shot; it just bounds a stuck /
 * occluded shot (which can run to maxLiveSec) so the comet never drags too long.
 */
const MAX_TRAJ_SAMPLES = 48;

/**
 * Cap on the rolling pre-arm buffer (descending-entry seeding). 32 covers a
 * full descendingArm.seedWindowSec at 30 fps; the time-based prune is the
 * real limiter on slower devices.
 */
const PRE_ARM_MAX = 32;

/** Nominal inter-frame interval (seconds) — seed for the cadence EMA. */
const NOMINAL_DT = 1 / NOMINAL_FPS;

/**
 * EMA weight of the newest inter-step interval when tracking the mean frame
 * cadence. Low (0.1) so one long stall (occlusion, a dropped frame) barely
 * shifts the device-fps estimate that scales the sample-count fit floors.
 */
const DT_EMA_ALPHA = 0.1;

/** Internal per-frame net-motion sample. */
interface NetSample {
  t: number;
  score: number;
}

/** Point-in-box test on raw numbers (avoids allocating a Point per frame). */
function pointInBox(b: Box, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

/**
 * The make/miss shot state machine. See module doc for the full protocol.
 *
 * Phases: IDLE → (arm) → SHOT_LIVE → (resolve) → COOLDOWN → IDLE.
 * Cooldowns: a new shot cannot arm until `shotCooldownSec` after the last
 * resolve, and a make within `basketCooldownSec` of the previous make is
 * downgraded to 'unsure' (double-count guard).
 */
export class ShotFsm {
  private phase: ShotPhase = 'IDLE';
  private rim!: RimGeometry;
  /** rim.box inflated 20% (touch test), cached on setRim. */
  private rimInflated!: Box;
  /** Lower half of rim.hoopRoi (touch test), cached on setRim. */
  private hoopRoiLowerHalf!: Box;
  /** hoopRoi inflated by layupHoopRoiInflate (layup arming), cached on setRim. */
  private layupZone!: Box;
  private readonly frameW: number;
  private readonly frameH: number;

  private nextId = 1;
  private lastResolveT = -Infinity;
  private lastMakeT = -Infinity;

  /** Timestamp of the previous `step` call, for the cadence EMA. */
  private lastStepT: number | null = null;

  /**
   * EMA of the inter-step interval (seconds) — the FSM's own live estimate of
   * the device frame cadence, used to convert NOMINAL_FPS sample-count fit
   * floors (descend/virtual-crossing arc fits) into a wall-clock-correct
   * count for THIS device (see config.scaleFrameGate). Seeded to the nominal
   * interval so the first shots behave exactly as before until timing accrues.
   */
  private meanStepDt = NOMINAL_DT;
  /** Last resolve that ended with a rim bounce (putback guard). */
  private lastBounceResolveT = -Infinity;

  // --- depth-aware judgment (all inert unless the veto flag is on) ---------
  /** Kill-switch: run the depth-ratio parallax veto in resolve(). */
  private readonly useDepthVeto: boolean;
  /** Kill-switch: gap-crossing reappearance corroborator. */
  private readonly useReappearance: boolean;
  /**
   * Kill-switch: rattle-out make guard (see resolve() + SHOT_FSM.useRattleGuard).
   * MUTABLE so the Settings toggle is real: the FSM is constructed once per rim
   * lock and lives for the whole session, so a constructor-only flag left the
   * escape hatch inert exactly when a user needed it (the ed80a08 levers ate
   * genuine makes and turning them off did nothing until a pipeline reset).
   */
  private useRattleGuard: boolean;
  /** Kill-switch: settle window before the belowRim resolve (see step() +
   *  SHOT_FSM.useSettleWindow). Mutable for the same reason as useRattleGuard. */
  private useSettleWindow: boolean;
  private ballSize: BallSizeSetting = 7;
  private viewBand: ViewBandName = 'side_wing';
  private readonly reapp = new ReappearanceTest();
  private reappCorroborated = false;
  /** Slow EMA of the net-motion score (drives the net-hang TTL extension). */
  private netScoreEma = 0;

  /**
   * Consecutive REAL in-zone ball samples at ≥ layupArmLowScore while IDLE —
   * lets an occluded/blurred at-rim ball (0.12–0.19, the normal presentation
   * of a layup finish) arm via persistence instead of raw confidence.
   */
  private layupLowStreak = 0;

  /**
   * Camera time of the most recent pose-gated release event (latched from
   * FsmFrameInput.releaseEventT; -Infinity = never). Drives the 'release'
   * arm path and the releaseToRimSec metric. Deliberately NOT cleared on
   * resolve: staleness is enforced by time windows (RELEASE.armWindowSec /
   * maxReleaseToRimSec), which is robust against events landing during
   * COOLDOWN just before the next attempt.
   */
  private lastReleaseEventT = -Infinity;

  /**
   * Scratch for the arm-refusal telemetry: canArm writes the reason for each
   * early return / branch fall-through here, and step() reads it only on the
   * frame canArm just returned null. RECORD-ONLY — nothing in the FSM ever
   * branches on this value.
   */
  private lastRefusal: ArmRefusal = 'no-branch';

  // --- stationary-ball suppressor (wedged/resting ball) --------------------
  /** Arming suppressed until the resting ball leaves the layup zone. */
  private restingBallSuppressed = false;
  /** Start of the current still, in-zone run (null = no run in progress). */
  private stationaryStartT: number | null = null;
  /** Last time a REAL ball was seen inside the layup zone (gap lapse). */
  private stationaryLastSeenT = -Infinity;

  /**
   * Rolling buffer of REAL ball samples observed while NOT live (IDLE /
   * COOLDOWN), time-pruned to descendingArm.seedWindowSec. The
   * descending-entry branch fits its approach arc over this and seeds the
   * live trajectory from it on arm, so a retroactive arm still scores the
   * plane crossing with full approach geometry.
   */
  private preArm: BallSample[] = [];

  // --- live-shot state (valid only while phase === 'SHOT_LIVE') ------------
  private tStart = 0;
  /** Which branch armed the live attempt (null outside SHOT_LIVE). */
  private armedVia: ArmVia | null = null;
  private originX: number | null = null;
  private originY: number | null = null;
  private trajectory: BallSample[] = [];
  /**
   * (C) The pre-arm APPROACH: the real samples observed before this attempt
   * armed that were NOT seeded into `trajectory`. Captured at arm time from
   * the rolling pre-arm buffer (which arm() then clears).
   *
   * WHY IT IS A SEPARATE FIELD AND NOT PREPENDED TO `trajectory`. The judgment
   * buffer starts at ARM, and every ball-kinematic arm path fires AT the rim —
   * so `trajectory` has never contained a jump shot's apex, and the apex was
   * architecturally unreachable (trajectory.apexPoint had zero production
   * callers). Prepending the approach would fix that, but it would also move
   * the crossing scan's indices, the exit/carom tests' sample set and fuse()'s
   * evidence — an invisible rewrite of every pinned make/miss call. Keeping it
   * beside the trajectory means the fit that finds the apex can see the whole
   * flight while `trajectory` stays byte-identical for judgment.
   */
  private approach: BallSample[] = [];
  private netSamples: NetSample[] = [];
  private anyNetPositive = false;
  private maxClsScore = 0;
  private touchedRim = false;
  private rimBounce = false;
  private lastBallT = 0;
  /**
   * The live ball has been above the rim plane at least once (seeded
   * trajectory counts). Gates the below-rim resolve: the release path arms
   * at the shooter's HANDS — far below belowY — and without this gate the
   * very next rising frame would read as "ball fell past the rim" and
   * instantly kill the attempt. The three ball-kinematic paths arm at/above
   * the rim band, so they set this at arm time and behave exactly as before.
   */
  private wasAbovePlane = false;
  /**
   * Settle window (flagged): timestamp of the FIRST below-belowY sample while
   * the belowRim resolve is deferred, or null when no resolve is pending (which
   * includes every shot that never touched the rim — see the arming site).
   * Keeping the shot live a few frames past this lets a LATE rim bounce-out be
   * observed instead of freezing the make/miss call on the first below-rim
   * sample. Doubles as the "a belowRim resolve is pending" flag the maxLiveSec
   * force-resolve reads, so the clock cannot relabel that decision 'timeout'.
   * Reset per shot in resolve().
   */
  private belowRimFirstT: number | null = null;
  /**
   * Settle window (flagged): `trajectory.length` frozen at the instant the
   * window armed, i.e. the trajectory PREFIX that ends on the first below-rim
   * sample. null when no resolve is pending.
   *
   * WHY: the settle frames are the noisiest boxes of the entire shot — the ball
   * is inside/behind the net, its detection box centroid drifting on billowing
   * mesh — and appending them to the trajectory that the exit test then judges
   * is what turned the rattle-out guard into a make-eater (one non-monotone cy
   * killed a swish). Those frames exist to feed the EXPLICIT re-ascent detector
   * (settleReascended), which is a rim-diameter-scale test that noise cannot
   * fake; the exit evidence is frozen here so they cannot poison it. Fusion
   * (geo/net/cls) deliberately keeps reading the FULL trajectory — freezing is
   * a narrowing of one demotion, not a change to the evidence.
   */
  private belowRimTrajLen: number | null = null;
  /**
   * (C) Newest trustworthy GLOBAL full-flight landing prediction delivered
   * while THIS attempt was live (FsmFrameInput.flightLanding), or null when
   * none arrived. Latched rather than sampled at resolve because the arc is
   * most complete while the ball is still being detected — by resolve time the
   * track is often already dark. Cleared per shot in resolve(). Consulted by
   * exactly one thing: the second virtual-crossing corroborator, which may
   * only upgrade an occluded geo null -> true with net/cls agreement.
   */
  private flightLanding: FlightLanding | null = null;
  /**
   * Settle window (flagged): a REAL sample climbed back above the rim PLANE
   * (moving up) AT THE HOOP, AFTER the ball had already dropped below the rim
   * bottom — an unambiguous carom / bounce-out. Consumed by resolve() to demote
   * the make.
   */
  private settleReascended = false;

  /**
   * @param rim   Locked rim geometry for the session (swap via setRim).
   * @param frame Analysis-frame dimensions, used to normalize shot origin.
   */
  constructor(
    rim: RimGeometry,
    frame: FrameSize,
    opts: {
      useDepthRatioVeto?: boolean;
      useReappearance?: boolean;
      useRattleGuard?: boolean;
      useSettleWindow?: boolean;
    } = {},
  ) {
    this.frameW = frame.width;
    this.frameH = frame.height;
    this.useDepthVeto = opts.useDepthRatioVeto ?? SHOT_FSM.useDepthRatioVeto;
    this.useReappearance = opts.useReappearance ?? SHOT_FSM.useReappearance;
    this.useRattleGuard = opts.useRattleGuard ?? SHOT_FSM.useRattleGuard;
    this.useSettleWindow = opts.useSettleWindow ?? SHOT_FSM.useSettleWindow;
    this.setRim(rim);
  }

  /** Ball-size setting (7/6/5) feeding the depth-ratio gate. */
  setBallSize(size: BallSizeSetting): void {
    this.ballSize = size;
  }

  /**
   * Live escape hatches for the two make-suppressing levers. Both take effect
   * on the NEXT resolve, so a user who suspects a guard is eating their makes
   * can turn it off mid-session and see the difference on the very next shot.
   * Turning either OFF only removes a demotion — it can never mint a make.
   */
  setRattleGuard(enabled: boolean): void {
    this.useRattleGuard = enabled;
  }

  setSettleWindow(enabled: boolean): void {
    this.useSettleWindow = enabled;
    // A pending settle must not outlive its flag: without this a shot already
    // waiting would stall until maxLiveSec after the window was switched off.
    if (!enabled) this.belowRimFirstT = null;
  }

  /** View band from the placement classifier (default 'side_wing'). */
  setViewBand(band: ViewBandName): void {
    this.viewBand = band;
  }

  /**
   * Swap rim geometry mid-session (e.g. after a rim re-verify shifted the
   * lock). Takes effect on the next step; a live shot keeps its buffered
   * trajectory and is resolved against the new geometry.
   */
  setRim(rim: RimGeometry): void {
    this.rim = rim;
    const b = rim.box;
    this.rimInflated = {
      x: b.x - b.width * 0.1,
      y: b.y - b.height * 0.1,
      width: b.width * 1.2,
      height: b.height * 1.2,
    };
    const hr = rim.hoopRoi;
    this.hoopRoiLowerHalf = {
      x: hr.x,
      y: hr.y + hr.height / 2,
      width: hr.width,
      height: hr.height / 2,
    };
    // Layup arming zone: hoopRoi inflated about its center. The BALL must be
    // here to arm the layup path (ball-first — see canArm). Height gets a
    // floor from the rim WIDTH: on flat side views the rim box (and thus
    // hoopRoi) is only a few px tall, and a height-proportional zone would
    // leave an above-plane band thinner than one ball diameter — real layups
    // would never be sampled inside it.
    const f = SHOT_FSM.layupHoopRoiInflate;
    const zoneH = Math.max(hr.height, rim.box.width) * f;
    this.layupZone = {
      x: hr.x - (hr.width * (f - 1)) / 2,
      y: hr.y + hr.height / 2 - zoneH / 2,
      width: hr.width * f,
      height: zoneH,
    };
  }

  /**
   * Advance the machine by one camera frame. Deterministic; time comes only
   * from `input.t` (seconds, camera timestamps).
   *
   * @returns The current phase, the live trajectory buffer (empty outside
   *   SHOT_LIVE), and — exactly on the frame a shot resolves — the
   *   populated {@link ResolvedShot}.
   */
  step(input: FsmFrameInput): FsmStepResult {
    const t = input.t;

    // Track the device cadence from consecutive step timestamps (forward gaps
    // only). Feeds the fps-scaled arc-fit sample floors below so a slow phone,
    // whose arcs carry far fewer samples, isn't held to the 30 fps count.
    if (this.lastStepT !== null && t > this.lastStepT) {
      this.meanStepDt += DT_EMA_ALPHA * (t - this.lastStepT - this.meanStepDt);
    }
    this.lastStepT = t;

    // Latch a pose-gated release event in EVERY phase: an event arriving
    // during COOLDOWN must still be armable the moment IDLE resumes (the
    // window checks in canArmRelease are what keep it honest, not the phase
    // it happened to arrive in).
    if (input.releaseEventT !== undefined) {
      this.lastReleaseEventT = input.releaseEventT;
    }

    // Wedged/resting-ball tracker — runs in EVERY phase so the stillness
    // observed during a doomed live attempt already suppresses the re-arm
    // after its timeout resolve (see trackStationaryBall).
    this.trackStationaryBall(input);

    if (this.phase === 'COOLDOWN' && t >= this.lastResolveT + SHOT_FSM.shotCooldownSec) {
      this.phase = 'IDLE';
    }

    if (this.phase === 'IDLE') {
      const ball = input.ball;
      // Low-score layup persistence counter (see canArm): consecutive REAL
      // in-zone samples above the plane. Updated BEFORE canArm so the frame
      // that completes the streak can arm.
      if (
        ball !== null &&
        !ball.predicted &&
        ball.score >= SHOT_FSM.layupArmLowScore &&
        ball.cy < this.rim.planeY &&
        pointInBox(this.layupZone, ball.cx, ball.cy)
      ) {
        this.layupLowStreak++;
      } else {
        this.layupLowStreak = 0;
      }
      if (ball !== null && !ball.predicted) this.pushPreArm(ball, t);
      // Arm-refusal telemetry: same canArm/arm calls in the same order as
      // before — only the reason is recorded on the side.
      let armRefusal: ArmRefusal = 'no-ball';
      if (ball !== null) {
        const via = this.canArm(input, ball);
        if (via !== null) {
          this.arm(input, ball, via);
          armRefusal = 'armed';
        } else {
          armRefusal = this.lastRefusal;
        }
      }
      return { phase: this.phase, liveTrajectory: this.trajectory, resolved: null, armRefusal };
    }

    if (this.phase === 'COOLDOWN') {
      // Keep the pre-arm buffer warm: a floater's approach frequently spans
      // the COOLDOWN → IDLE boundary, and the descending-entry branch needs
      // those samples the moment IDLE resumes.
      const ball = input.ball;
      if (ball !== null && !ball.predicted) this.pushPreArm(ball, t);
      return {
        phase: 'COOLDOWN',
        liveTrajectory: this.trajectory,
        resolved: null,
        armRefusal: 'cooldown',
      };
    }

    // ---- SHOT_LIVE ----------------------------------------------------
    // (C) Latch the newest GLOBAL full-flight landing prediction. Only while
    // live, so one attempt's arc can never decide the next one; a null/absent
    // value means "the global fit isn't trustworthy this frame" and simply
    // leaves the previous latch alone. Recording only — nothing here branches
    // on it; the single consumer is the corroborator in resolve(), which
    // obeys the pinned "never without net or cls" contract.
    if (input.flightLanding != null) {
      this.flightLanding = input.flightLanding;
    }
    if (input.ballInBasketScore > this.maxClsScore) {
      this.maxClsScore = input.ballInBasketScore;
    }
    this.netSamples.push({ t, score: input.netMotionScore });
    if (input.netMotionScore > 0) this.anyNetPositive = true;
    this.netScoreEma = this.netScoreEma * 0.8 + input.netMotionScore * 0.2;

    const ball = input.ball;
    let reason: ResolveReason | null = null;

    if (ball !== null) {
      this.trajectory.push({
        cx: ball.cx,
        cy: ball.cy,
        r: ball.r,
        t: ball.t,
        score: ball.score,
        predicted: ball.predicted,
      });
      // Cap the trail so it never drags too long — a normal release→rim arc is
      // well under this, but a stuck/occluded shot that times out at maxLiveSec
      // could otherwise draw a very long, messy comet. Keep only the most recent
      // samples (the visible arc); the oldest drops off the tail.
      if (this.trajectory.length > MAX_TRAJ_SAMPLES) {
        this.trajectory.shift();
        // Keep the frozen exit prefix (belowRimTrajLen) pointing at the SAME
        // sample after the oldest one is dropped: it is an index from the head,
        // so a shift slides every sample down by one. Without this the prefix
        // would silently grow to include settle frames — exactly the poisoning
        // the freeze exists to prevent — on a long shot that hits the cap
        // during the window.
        if (this.belowRimTrajLen !== null && this.belowRimTrajLen > 0) {
          this.belowRimTrajLen--;
        }
      }
      // "前後幀" gap smoothing: the ball just REAPPEARED after a dropout —
      // rewrite the straight-line Kalman coast between the two real sides with
      // the physics-true two-sided parabola. Improves the drawn comet AND the
      // crossing geometry the make/miss call is built on.
      if (!ball.predicted) {
        backfillPredictedGap(this.trajectory, this.minFitSamples(MIN_FIT_SAMPLES));
      }
      // Reappearance corroborator (flagged): arm when the track goes
      // predicted-only mid-shot; feed real samples while armed.
      if (this.useReappearance) {
        if (ball.predicted) {
          this.reapp.armOnBallLost(this.trajectory, this.rim, t);
        } else if (this.reapp.armed) {
          const res = this.reapp.onSample(
            { cx: ball.cx, cy: ball.cy, vy: ball.vy, diaPx: ball.r * 2 },
            t,
            this.netScoreEma,
            this.ballSize,
          );
          if (res.fired && res.corroborates) this.reappCorroborated = true;
        }
      }
      this.lastBallT = t;
      if (ball.cy < this.rim.planeY) this.wasAbovePlane = true;
      if (!this.touchedRim && this.touchesRimRegion(ball)) {
        this.touchedRim = true;
      }
      // Re-ascend above the plane after a rim touch ⇒ rim bounce.
      if (this.touchedRim && ball.cy < this.rim.planeY && ball.vy < 0) {
        this.rimBounce = true;
      }
      // Below-rim resolve: the flight is over once the ball drops past
      // belowY — but only on a REAL sample, and only when the ball has
      // already been above the plane (normal completed arc) or has actually
      // been SEEN falling. A release-armed ball RISING through this band is
      // just leaving the shooter's hands and must be allowed to climb (see
      // wasAbovePlane).
      //
      // (B) `!ball.predicted` — A GHOST MAY NEVER END A SHOT. The tracker
      // coasts on Kalman predictions for up to TRACKER.maxPredictedSec (0.5 s)
      // after the detector loses the ball, and belowY - planeY is only ~1.5
      // rim-box heights — LESS than one inter-frame descent at 15 fps. So a
      // coast routinely "fell past the rim" while the real ball was still at
      // the hoop, sealing the attempt before the net burst (netRoi hangs below
      // the rim BOTTOM) or the ball_in_basket blip could ever be sampled. That
      // same ghost then supplied the crossing pair the geo channel scored (see
      // resolve()).
      // BREAD-BALL: this can only keep an attempt OPEN. It adds no make term,
      // moves no threshold and touches no fusion rule; the attempt still ends
      // on a real below-rim sample, on lostBallResolveSec, or on maxLiveSec,
      // and every make still has to clear the same table. Prior art: NEX Team /
      // HomeCourt US11380100B2 keeps an attempt "unfinished" while the ball may
      // still be bouncing above the hoop, and the canonical open-source FSM
      // (avishah3/AI-Basketball-Shot-Detection-Tracker) brackets last-above /
      // first-below rather than terminating on the triggering detection.
      //
      // (E) `ball.vy > 0` alone used to bypass wasAbovePlane, and vy is the
      // Kalman estimate — gravity-biased downward the moment a track is
      // seeded. A release-armed attempt starts at the shooter's HANDS, far
      // below belowY, so the very first frame whose filtered vy read positive
      // killed the attempt before the ball had left head height. Requiring a
      // real OBSERVED descent (two consecutive real samples with cy
      // increasing) keeps the honest airball case — a ball genuinely seen
      // falling below the rim ends promptly — while a single filter artifact
      // no longer can. BREAD-BALL: identical argument, it only defers an end.
      if (
        !ball.predicted &&
        ball.cy > this.rim.belowY &&
        (this.wasAbovePlane || (ball.vy > 0 && this.realDescentObserved()))
      ) {
        if (this.useSettleWindow) {
          // Settle window (flagged): arm the DEFERRED belowRim resolve on the
          // first below-rim sample instead of resolving here. Staying live
          // keeps net / cls / trajectory collection running (see the top of
          // this SHOT_LIVE block), which is the entire point: the net burst
          // and the ball_in_basket blip both happen at or BELOW the rim
          // bottom, i.e. strictly AFTER the moment that used to seal the call.
          // It also lets a LATE bounce-out be observed by the explicit
          // re-ascent detector below. The window-elapsed check further down
          // performs the actual resolve, capping latency at settleWindowSec.
          //
          // (D) THE `touchedRim` PRECONDITION IS GONE. It was fps-coupled: at
          // 15 fps the first below-rim sample overshoots the entire rim band,
          // so touchedRim never latched and the only mechanism that extends
          // observation never armed on exactly the slow phones that need it.
          // BREAD-BALL: arming on every belowRim trigger cannot invent
          // evidence. Every added net sample must STILL exceed
          // netMotionThreshold AND land inside netWindowSec of the crossing;
          // every added cls frame must still clear ballInBasketScoreMin; the
          // fusion table is untouched. The window only buys TIME for evidence
          // that already had to pass every gate — and it can also demote
          // (settleReascend), never promote.
          if (this.belowRimFirstT === null) {
            this.belowRimFirstT = t;
            // Freeze the exit evidence at THIS sample (see belowRimTrajLen).
            this.belowRimTrajLen = this.trajectory.length;
          }
        } else {
          reason = 'belowRim';
        }
      }
      // Settle-window bounce-out detector (flagged): a REAL sample back above
      // the rim PLANE, moving UP, AT THE HOOP, AFTER the ball already dropped
      // below the rim bottom — an unambiguous carom / bounce-out (a clean make's
      // cy only keeps increasing once it clears belowY). Testing against the
      // PLANE (not merely the rim bottom) makes this a rim-diameter-scale
      // excursion, so a few px of net-occlusion jitter at the rim bottom can
      // never trip it. Consumed by resolve() to demote the would-be make.
      //
      // The hoopRoi gate is what makes "re-ascent" mean the BALL bouncing out
      // rather than "some box moved up somewhere in the frame": a physical
      // bounce-out is AT the rim on the frame it re-ascends. Without it a
      // tracker switch to any blob in the upper frame (a head, a second ball,
      // a re-acquired track across the court) demoted a genuine make — proven
      // by probe: a blob at cx=100,cy=150 killed a swish. Strictly a narrowing.
      if (
        this.useSettleWindow &&
        this.belowRimFirstT !== null &&
        !ball.predicted &&
        ball.cy < this.rim.planeY &&
        ball.vy < 0 &&
        pointInBox(this.rim.hoopRoi, ball.cx, ball.cy)
      ) {
        this.settleReascended = true;
      }
    } else if (t - this.lastBallT >= SHOT_FSM.lostBallResolveSec) {
      reason = 'ballLost';
    } else if (this.useReappearance) {
      // Tracker dropped the ball entirely: arm the reappearance trap off the
      // buffered trajectory (internally refuses without a trustworthy arc).
      this.reapp.armOnBallLost(this.trajectory, this.rim, t);
    }

    // Settle window elapsed (flagged): the deferred belowRim resolve fires
    // wherever the ball now is, hard-capping the added make latency at
    // settleWindowSec even when the ball bounced back above the rim mid-window
    // or the tracker lost it. Time gate (inputs only); GATE_EPS_SEC pins the
    // 30fps boundary. Inert unless useSettleWindow armed belowRimFirstT, so
    // offline recheck and the pinned tests (flag OFF) stay byte-identical.
    if (
      reason === null &&
      this.useSettleWindow &&
      this.belowRimFirstT !== null &&
      t - this.belowRimFirstT + GATE_EPS_SEC >= SHOT_FSM.settleWindowSec
    ) {
      reason = 'belowRim';
    }

    if (reason === null && t - this.tStart > SHOT_FSM.maxLiveSec) {
      // A below-rim resolve already PENDING when the clock runs out is a
      // decision made with full evidence in hand — the crossing, the net window
      // and the deep drop have all been observed; only the settle window's few
      // extra frames are outstanding. `reason === 'timeout'` is blanket-forced
      // to 'unsure' below, so letting the clock relabel that decision erased
      // genuine makes for every shot whose below-rim moment happened to land
      // within settleWindowSec of maxLiveSec (a stuck/occluded track that
      // finally dropped through). Keep the reason the ball earned.
      //
      // belowRimFirstT is only ever non-null while useSettleWindow is ON, so
      // the flag-OFF baseline (recheck replay + pinned tables) is untouched.
      reason = this.belowRimFirstT !== null ? 'belowRim' : 'timeout';
    }

    if (reason !== null) {
      const shot = this.resolve(t, reason);
      // 'live': the shot WAS live entering this frame — it resolved here.
      return {
        phase: this.phase,
        liveTrajectory: this.trajectory,
        resolved: shot,
        armRefusal: 'live',
      };
    }

    return {
      phase: 'SHOT_LIVE',
      liveTrajectory: this.trajectory,
      resolved: null,
      armRefusal: 'live',
    };
  }

  // -------------------------------------------------------------------------
  // Arming
  // -------------------------------------------------------------------------

  /**
   * fps-scaled floor on the real-sample count an arc fit needs. A NOMINAL_FPS-
   * authored count of `nominal` samples is a wall-clock budget; on a slow phone
   * whose arcs carry far fewer samples the same budget is fewer frames, floored
   * at ABS_MIN_FIT_SAMPLES (3 — the minimum that determines a quadratic). At
   * NOMINAL_FPS this returns `nominal` unchanged, so 30 fps is untouched.
   */
  private minFitSamples(nominal: number): number {
    return scaleFrameGate(nominal, this.meanStepDt, ABS_MIN_FIT_SAMPLES);
  }

  /**
   * NOTE on `lastRefusal` writes below: pure telemetry (see ArmRefusal).
   * Every write sits immediately before an EXISTING return — no condition,
   * ordering, or state write of the arming logic itself has changed.
   */
  private canArm(input: FsmFrameInput, ball: TrackedBall): ArmVia | null {
    // Multi-ball / rim-drift hold: SUPPRESSION-ONLY. May refuse a NEW arm;
    // never touches a live attempt (step() only reaches here from IDLE) and
    // absent behaves exactly like false. See multiBallGuard.ts.
    if (input.armLockout) {
      this.lastRefusal = 'lockout';
      return null;
    }
    // Shot cooldown (redundant with COOLDOWN phase gating, kept as a guard).
    if (input.t < this.lastResolveT + SHOT_FSM.shotCooldownSec) {
      this.lastRefusal = 'cooldown';
      return null;
    }
    // Putback guard: after a rim-bounce resolve, hold arming a little longer
    // so a tip-in doesn't double-count off the first attempt's residue.
    if (input.t < this.lastBounceResolveT + SHOT_FSM.putbackWindowSec) {
      this.lastRefusal = 'putback';
      return null;
    }
    // Wedged/resting ball: a ball that has sat still inside the layup zone
    // re-satisfies the arming conditions every IDLE frame — without this it
    // loops arm → maxLiveSec timeout → cooldown → re-arm, emitting a junk
    // review shot every ~5.5 s. ALL branches are refused until the ball
    // actually leaves the zone: the dislodging poke nudges it upward (a
    // "rising ball" the jump branch would happily arm) before dropping it
    // through the net, and that must not read as a fresh attempt either.
    if (this.restingBallSuppressed) {
      this.lastRefusal = 'resting';
      return null;
    }
    const rim = this.rim;
    // Jump shot: ball rising through the up-zone.
    if (ball.vy < 0 && pointInBox(rim.upZone, ball.cx, ball.cy)) return 'jump';
    // Layup — BALL-FIRST. The ball itself must be AT the hoop (inside the
    // inflated hoopRoi), above the rim plane, and not falling fast. The old
    // requirement that a YOLO person box intersect the hoopRoi is gone:
    // person detection was unreliable in both directions (a missed shooter
    // silently dropped real layups; a hallucinated box near the hoop opened
    // false arms). The ball being at the hoop is the direct evidence.
    //
    // Because this branch can arm WITHOUT the rising-ball signature, it
    // additionally demands REAL evidence: never a Kalman coast, and either a
    // confident single frame (≥ layupArmMinBallScore) or a persistent run of
    // lower-score real samples (layupLowStreak — occluded at-rim balls
    // routinely score 0.12–0.19). One-frame noise can't start an attempt.
    //
    // The vy gate rejects a ball clearly falling FAST (rebound, pass, loose
    // ball dropping past the hoop); a soft layup can still drift down gently
    // in the hand right at the hoop, so the allowance
    // (SHOT_FSM.layupMaxFallVyRimWidthsPerSec — rim WIDTHS, the scale-stable
    // reference) is a generous sanity backstop, not a tight vy < 0
    // requirement like the jump-shot branch.
    const maxFallVy = SHOT_FSM.layupMaxFallVyRimWidthsPerSec * rim.box.width;
    if (
      ball.cy < rim.planeY &&
      ball.vy <= maxFallVy &&
      !ball.predicted &&
      (ball.score >= SHOT_FSM.layupArmMinBallScore ||
        this.layupLowStreak >= SHOT_FSM.layupArmLowScorePersistFrames) &&
      pointInBox(this.layupZone, ball.cx, ball.cy)
    ) {
      return 'layup';
    }
    // Descending entry (floater/runner): falls into the hoop too fast for
    // the layup branch, never rose through the up-zone.
    if (this.canArmDescending(ball)) return 'descend';
    // Pose-gated release (last resort, checked after every ball-kinematic
    // branch): the ReleaseDetector saw the shooter's release motion but the
    // ball was too faint for the paths above to fire.
    if (this.canArmRelease(input, ball)) return 'release';
    // Every arm branch (jump/layup/descend/release) declined this ball.
    this.lastRefusal = 'no-branch';
    return null;
  }

  /**
   * Release-path arm test. The pose event alone is NEVER enough — a pump
   * fake, an overhead pass, or a celebration can mimic the wrist snap — so
   * it must be corroborated by a REAL (never Kalman-predicted) ball sample
   * in the upper RELEASE.armUpperFrameFrac of the frame within
   * RELEASE.armWindowSec AFTER the event. A just-released ball climbs
   * toward the rim immediately, so "real ball, high in the frame, right
   * after the release motion" is the physically tight signature; a dribble
   * or a ball still in the hands lives in the lower frame. Evidence may be
   * the live ball this frame or any pre-arm buffer sample since the event
   * (the buffer holds only REAL samples, so a ball glimpsed two frames ago
   * and lost again still corroborates).
   */
  private canArmRelease(input: FsmFrameInput, ball: TrackedBall): boolean {
    const tEvent = this.lastReleaseEventT;
    if (input.t < tEvent || input.t > tEvent + RELEASE.armWindowSec) {
      return false;
    }
    const upperY = this.frameH * RELEASE.armUpperFrameFrac;
    if (!ball.predicted && ball.cy <= upperY) return true;
    // Newest-first scan of the pre-arm buffer, stopping at pre-event samples
    // (the buffer is time-ordered; anything before the event is not flight).
    for (let i = this.preArm.length - 1; i >= 0; i--) {
      const s = this.preArm[i];
      if (s.t < tEvent) break;
      if (s.cy <= upperY) return true;
    }
    return false;
  }

  /**
   * Descending-entry arm test (floater/runner — see SHOT_FSM.descendingArm).
   * A real, confident ball inside the hoop ROI, descending within the sanity
   * cap, whose pre-arm samples fit a clean gravity parabola that ORIGINATED
   * outside the layup zone. The origin requirement is the discriminator
   * against at-rim junk: a floater arrives from out past the zone, while a
   * ball popping up off the rim (rebound residue) starts inside it.
   */
  private canArmDescending(ball: TrackedBall): boolean {
    const cfg = SHOT_FSM.descendingArm;
    const rim = this.rim;
    if (ball.predicted || ball.score < cfg.minBallScore) return false;
    if (ball.vy <= 0) return false;
    if (ball.vy > cfg.maxFallVyRimWidthsPerSec * rim.box.width) return false;
    if (!pointInBox(rim.hoopRoi, ball.cx, ball.cy)) return false;
    const buf = this.preArm;
    // fps-scaled sample floor: at 8 fps a floater's approach carries far fewer
    // than the 30 fps count of 5, so the nominal minRealSamples is scaled down
    // (never below 3) — otherwise a made floater on a slow phone never arms.
    const minReal = this.minFitSamples(cfg.minRealSamples);
    if (buf.length < minReal) return false;
    const first = buf[0];
    if (pointInBox(this.layupZone, first.cx, first.cy)) return false;
    // Size-sanity: the approach must be one consistently-sized object, not a
    // track snapping between a limb and rebound junk of very different sizes.
    let rMin = Infinity;
    let rMax = 0;
    for (const s of buf) {
      if (s.r < rMin) rMin = s.r;
      if (s.r > rMax) rMax = s.r;
    }
    if (rMin > 0 && rMax / rMin > cfg.preArmMaxRadiusRatio) return false;
    const fit = fitArc(buf, minReal);
    if (fit === null || fit.r2y < cfg.minR2y) return false;
    // Gravity floor on ya (≈ g/2): rejects linear drift, whose fit is
    // near-degenerate in the quadratic term.
    if (fit.ya < cfg.minYaRimWidthsPerSec2 * rim.box.width) return false;
    // Curvature CEILING: a rim rattle fits a near-vertical degenerate parabola
    // with a hugely inflated ya. Reject it here too (the FlightArc caps its own
    // fit; this guards the LOCAL arm fit). Scale-free, never rejects a real arc.
    if (!plausibleArcCurvature(fit.ya, rim.box.width, FLIGHT.maxArcYaRimWidths)) {
      return false;
    }
    return true;
  }

  private arm(input: FsmFrameInput, ball: TrackedBall, via: ArmVia): void {
    this.phase = 'SHOT_LIVE';
    this.armedVia = via;
    this.layupLowStreak = 0;
    this.tStart = input.t;
    if (via === 'descend') {
      // Retroactive seed: the approach observed while IDLE/COOLDOWN becomes
      // the head of the live trajectory, so the imminent plane crossing is
      // scored with real approach geometry and the release metrics come from
      // the true flight, not from the at-rim arm frame.
      for (const s of this.preArm) {
        if (s.t < ball.t) this.trajectory.push(s);
      }
    } else if (via === 'release') {
      // Retroactive seed, POST-EVENT samples only. Unlike the descend path
      // (whose parabola fit guarantees the buffer is flight), this buffer
      // may also hold pre-release sightings — the ball in the hands, a
      // dribble — from the last second of IDLE. Those are not flight and
      // would corrupt the release-point/angle metrics; the event time is
      // exactly the flight boundary, so seed only what came after it.
      for (const s of this.preArm) {
        if (s.t >= this.lastReleaseEventT && s.t < ball.t) {
          this.trajectory.push(s);
        }
      }
    }
    // (C) Capture the APPROACH — every buffered pre-arm sample that did NOT
    // become part of the live trajectory. `seededFrom` is the first sample the
    // trajectory already holds (the descend/release retro-seed above), so the
    // two sets never overlap and the apex fit can't double-weight a sample.
    // This buffer is diagnostics + the apex sanity guard only; `trajectory`,
    // which every judgment reads, is untouched by its existence.
    const seededFrom = this.trajectory.length > 0 ? this.trajectory[0]!.t : ball.t;
    this.approach = [];
    for (const s of this.preArm) {
      if (s.t < seededFrom) this.approach.push(s);
    }
    this.preArm = [];
    const p = input.personBox;
    if (p !== null) {
      // Shooter origin = person-box foot midpoint, normalized 0..1.
      this.originX = (p.x + p.width / 2) / this.frameW;
      this.originY = (p.y + p.height) / this.frameH;
    } else {
      this.originX = null;
      this.originY = null;
    }
    this.trajectory.push({
      cx: ball.cx,
      cy: ball.cy,
      r: ball.r,
      t: ball.t,
      score: ball.score,
      predicted: ball.predicted,
    });
    this.lastBallT = input.t;
    this.maxClsScore = input.ballInBasketScore;
    this.netSamples.push({ t: input.t, score: input.netMotionScore });
    this.anyNetPositive = input.netMotionScore > 0;
    this.touchedRim = false;
    this.rimBounce = false;
    // Seeded samples count: a descend arm's approach was above the plane
    // even though its arm frame may sit slightly below it.
    this.wasAbovePlane = false;
    for (const s of this.trajectory) {
      if (s.cy < this.rim.planeY) {
        this.wasAbovePlane = true;
        break;
      }
    }
  }

  /** Append a REAL sample to the rolling pre-arm buffer and prune it. */
  private pushPreArm(ball: TrackedBall, t: number): void {
    this.preArm.push({
      cx: ball.cx,
      cy: ball.cy,
      r: ball.r,
      t: ball.t,
      score: ball.score,
      predicted: false,
    });
    const horizon = t - SHOT_FSM.descendingArm.seedWindowSec;
    while (this.preArm.length > 0 && this.preArm[0].t < horizon) {
      this.preArm.shift();
    }
    if (this.preArm.length > PRE_ARM_MAX) this.preArm.shift();
  }

  /**
   * Wedged/resting-ball tracker (every frame, ALL phases — see
   * SHOT_FSM.stationaryBall). Accumulates how long a REAL ball has sat
   * essentially still inside the layup zone; past minStillSec, arming is
   * suppressed (canArm) until a real sample OUTSIDE the zone shows the ball
   * actually left. Movement inside the zone breaks the stillness run but
   * deliberately KEEPS the suppression: the dislodging poke that finally
   * drops the ball through the net must not become a fresh attempt. A long
   * gap with no real ball at all lets everything lapse, so a stale flag
   * cannot outlive the wedged ball and block a later real attempt.
   */
  private trackStationaryBall(input: FsmFrameInput): void {
    const cfg = SHOT_FSM.stationaryBall;
    const ball = input.ball;
    if (ball === null || ball.predicted) {
      if (input.t - this.stationaryLastSeenT > cfg.clearAfterGapSec) {
        this.stationaryStartT = null;
        this.restingBallSuppressed = false;
      }
      return;
    }
    if (!pointInBox(this.layupZone, ball.cx, ball.cy)) {
      // Real ball seen outside the zone: the resting ball left (or a new
      // ball is in play) — arming may resume.
      this.stationaryStartT = null;
      this.restingBallSuppressed = false;
      return;
    }
    this.stationaryLastSeenT = input.t;
    const eps = cfg.maxSpeedRimWidthsPerSec * this.rim.box.width;
    if (Math.hypot(ball.vx, ball.vy) > eps) {
      this.stationaryStartT = null; // moving within the zone: run broken, suppression kept
      return;
    }
    if (this.stationaryStartT === null) this.stationaryStartT = input.t;
    if (input.t - this.stationaryStartT >= cfg.minStillSec) {
      this.restingBallSuppressed = true;
    }
  }

  // -------------------------------------------------------------------------
  // Rim-touch test
  // -------------------------------------------------------------------------

  /**
   * Has the ball been SEEN falling? True iff the two most recent REAL
   * (non-Kalman) samples in the live buffer have strictly increasing cy
   * (screen +y is DOWN, so increasing cy = descending).
   *
   * WHY THIS EXISTS SEPARATELY FROM `ball.vy > 0`. vy is the Kalman filter's
   * estimate, and a freshly seeded track carries a gravity-biased downward
   * velocity before it has observed anything at all — which is precisely how a
   * release-armed attempt, seeded at the shooter's hands far below belowY,
   * died on its first live frame. Two consecutive real detections moving down
   * is an OBSERVATION; one filtered vy is a guess. Used only to gate an
   * attempt-ENDING branch, so a false answer here delays a resolve (safe) and
   * can never create or upgrade an outcome.
   */
  private realDescentObserved(): boolean {
    const traj = this.trajectory;
    let newest = -1;
    for (let i = traj.length - 1; i >= 0; i--) {
      if (traj[i]!.predicted) continue;
      if (newest < 0) {
        newest = i;
        continue;
      }
      return traj[i]!.cy < traj[newest]!.cy;
    }
    return false;
  }

  /** Ball center in the lower half of the hoop ROI, or ball box overlapping the rim box inflated 20%. */
  private touchesRimRegion(ball: TrackedBall): boolean {
    if (pointInBox(this.hoopRoiLowerHalf, ball.cx, ball.cy)) return true;
    const rb = this.rimInflated;
    return (
      ball.cx - ball.r < rb.x + rb.width &&
      rb.x < ball.cx + ball.r &&
      ball.cy - ball.r < rb.y + rb.height &&
      rb.y < ball.cy + ball.r
    );
  }

  /**
   * Project the trailing descending arc to the rim plane (see resolve()).
   * Returns null unless the tail is trustworthy: ≥ minRealSamples REAL
   * (never Kalman-coast) samples, all above the plane, net downward motion,
   * ending inside the layup zone (the occlusion region), fitting a gravity
   * parabola at r2y ≥ minR2y whose descending crossing lies within
   * maxProjectSec of the last real sample.
   */
  private projectVirtualCross(
    traj: readonly BallSample[],
  ): { xCross: number; tCross: number; r2y: number } | null {
    const cfg = SHOT_FSM.virtualCross;
    // Trailing run of REAL samples above the plane, oldest-first.
    const tail: BallSample[] = [];
    for (let i = traj.length - 1; i >= 0; i--) {
      const s = traj[i];
      if (s.predicted) continue; // skip coasts, keep scanning real support
      if (s.cy >= this.rim.planeY) break; // reached below-plane history
      tail.unshift(s);
      if (tail.length >= 12) break; // enough support; older samples add bias
    }
    // fps-scaled floor: the occluded-arc tail (real, above-plane, descending
    // samples) is only 2–4 samples at 8 fps, so the nominal 5 is scaled to the
    // device cadence (never below 3) — otherwise a slow-phone occluded swish
    // can never project its virtual crossing and always falls to 'unsure'.
    const minReal = this.minFitSamples(cfg.minRealSamples);
    if (tail.length < minReal) return null;
    const last = tail[tail.length - 1];
    // Net downward motion across the tail, ending where occlusion is
    // physically plausible: horizontally at the hoop (layup-zone x-range)
    // and no more than a rim-width or two above the plane.
    if (last.cy <= tail[0].cy) return null;
    const zone = this.layupZone;
    if (last.cx < zone.x || last.cx > zone.x + zone.width) return null;
    if (
      this.rim.planeY - last.cy >
      cfg.maxAbovePlaneRimWidths * this.rim.box.width
    ) {
      return null;
    }
    const fit = fitArc(tail, minReal);
    if (fit === null || fit.ya <= 0 || fit.r2y < cfg.minR2y) return null;
    // Curvature CEILING: reject a rim-rattle's degenerate near-vertical fit
    // before it projects a bogus crossing that could corroborate a make.
    if (!plausibleArcCurvature(fit.ya, this.rim.box.width, FLIGHT.maxArcYaRimWidths)) {
      return null;
    }
    const p = predictLanding(fit, this.rim.planeY);
    if (p === null) return null;
    if (p.t < last.t || p.t > last.t + cfg.maxProjectSec) return null;
    return { xCross: p.x, tCross: p.t, r2y: fit.r2y };
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  private resolve(t: number, reason: ResolveReason): ResolvedShot {
    const rim = this.rim;
    const traj = this.trajectory;
    /**
     * Demotion telemetry (see {@link ShotHold}). RECORD-ONLY: appended next to
     * each demotion that already existed, never read by any condition here.
     */
    const holds: ShotHold[] = [];

    /**
     * The trajectory PREFIX the exit test is allowed to judge: everything up to
     * and including the first below-rim sample when the settle window armed
     * (see belowRimTrajLen), the full trajectory otherwise. Fusion below reads
     * `traj` (the full buffer) exactly as before — only the carom test is
     * frozen, because the settle frames it would otherwise judge are net-noise
     * by construction. Indices align: the prefix shares the head of `traj`, so
     * crossIdx below indexes both.
     */
    const exitTraj =
      this.belowRimTrajLen !== null && this.belowRimTrajLen < traj.length
        ? traj.slice(0, this.belowRimTrajLen)
        : traj;

    // --- geo: FINAL descending crossing of the rim plane -----------------
    // Only a crossing whose BOTH samples are real detections counts. A brief
    // occlusion right at the rim plane is the NORMAL presentation of a shot —
    // the ball is hidden by rim and net at exactly this moment — and the
    // Kalman coast through it is an extrapolation, not an observation.
    //
    // (B) THIS USED TO FALL BACK to the predicted pair when no real crossing
    // existed, which FABRICATED the geo x out of filter state: a ghost drifting
    // sideways scored an out-of-span "seen miss" (fuse returns 'miss' on geo
    // === false) on a ball that was actually dropping through the net, and a
    // ghost drifting inward scored an in-span "make". Forcing geo NULL when no
    // real pair exists is the honest reading of "we did not see the crossing".
    // BREAD-BALL: null is strictly WEAKER than true — it removes a geo make
    // term. What remains are the existing corroborators (geoExit /
    // reappearance / virtualCross / flightCross), every one of which is built
    // from REAL samples and already refuses to act without net === true or
    // (net === null && cls). Nothing new can mint a make here.
    let realCrossIdx = -1;
    for (let i = 0; i + 1 < traj.length; i++) {
      if (
        traj[i].cy <= rim.planeY &&
        traj[i + 1].cy > rim.planeY &&
        !traj[i].predicted &&
        !traj[i + 1].predicted
      ) {
        realCrossIdx = i;
      }
    }
    const crossIdx = realCrossIdx;
    let xCross: number | null = null;
    let tCross: number | null = null;
    let entryAngleDeg: number | null = null;
    let geo: boolean | null = null;
    if (crossIdx >= 0) {
      const a = traj[crossIdx];
      const b = traj[crossIdx + 1];
      xCross = interpolateXAtY(
        { x: a.cx, y: a.cy },
        { x: b.cx, y: b.cy },
        rim.planeY,
      );
      if (xCross !== null) {
        const s = (rim.planeY - a.cy) / (b.cy - a.cy);
        tCross = a.t + (b.t - a.t) * s;
        geo = xCross >= rim.spanLeft && xCross <= rim.spanRight;
      }
      // Entry angle: local secant across the crossing pair (descending),
      // reported as |degrees above horizontal| after the y-flip.
      entryAngleDeg = Math.abs(elevationAngleDeg(b.cx - a.cx, b.cy - a.cy));
    }

    // --- depth-ratio parallax VETO (kill-switched; one-directional) --------
    // A 2D crossing inside the span can still be an airball flying in FRONT
    // of the hoop (or a pass behind it). The size-based depth ratio catches
    // the separations it can prove (see depthRatioGate); on a confident veto
    // geo flips true -> false. It NEVER confirms a make. Diagnostics ride on
    // the resolved shot either way so telemetry can tune thresholds.
    let geoDepth: ResolvedShot['geoDepth'];
    if (this.useDepthVeto && geo === true) {
      const sel = selectDepthSamples(traj, rim.box);
      const gate = depthRatioGate({
        ballDiaPxAvg: sel.avgDiaPx,
        nRealSamples: sel.nReal,
        rimWidthPx: rim.box.width,
        rimLockContaminated: false,
        ballSize: this.ballSize,
        viewBand: this.viewBand,
        crossingReal: realCrossIdx >= 0,
        rimBounce: this.rimBounce,
        clsStrongContext: this.maxClsScore >= DETECTION.ballInBasketScoreMin,
      });
      geoDepth = {
        ratio: gate.ratio,
        sigmaLn: gate.sigmaLn,
        snr: gate.snr,
        decision: gate.decision,
        ...(gate.disableReason ? { disableReason: gate.disableReason } : {}),
      };
      if (gate.decision !== 'silent') {
        geo = false;
        holds.push('depthVeto');
      }
    }

    // --- virtual crossing (occlusion inference) ---------------------------
    // No observed crossing: the ball died above the plane, occluded by the
    // rim/net. If its trailing REAL samples form a confident descending
    // parabola ending at the hoop, project where/when it would cross. Used
    // ONLY (a) as the net window's time reference below — the net whips at
    // the real crossing, not at the resolve timeout 1.5s later — and (b) as
    // a corroborated geo upgrade after the net/cls channels are known.
    const virtual = crossIdx < 0 ? this.projectVirtualCross(traj) : null;

    // --- global flight-arc crossing (second occlusion inference) -----------
    // (C) The latched full-flight landing prediction, validated for THIS
    // attempt. Where projectVirtualCross fits the last ~12 real samples of the
    // live buffer, this comes from the pipeline's 64-sample weighted
    // least-squares parabola over the WHOLE flight — far more robust to camera
    // angle than a 2-sample local secant, and available on shots whose live
    // tail is too short for the local fit to run at all.
    //
    // Validation is deliberately mechanical: the strict R² bar the FlightArc
    // itself applies to any outcome-adjacent landing, a landing time inside
    // this attempt, and no more than virtualCross.maxProjectSec of
    // extrapolation past the resolve. Used for exactly two things — the net
    // window's time reference below, and a corroborated geo upgrade after the
    // net/cls channels are known (see the corroborator block).
    const fl = this.flightLanding;
    const flightCross =
      fl !== null &&
      fl.r2y >= FLIGHT.corridorMinR2yStrict &&
      fl.t >= this.tStart &&
      fl.t <= t + SHOT_FSM.virtualCross.maxProjectSec
        ? { xCross: fl.x, tCross: fl.t, r2y: fl.r2y }
        : null;

    // --- net: burst near the crossing (or resolve time) ------------------
    // For a RIM BOUNCE with a known crossing, extend the window FORWARD only:
    // the ball re-ascends and drops late, so its genuine swish burst can land
    // past the symmetric window around the early crossing (netBurstInWindow).
    let net: boolean | null = null;
    /** Net samples strictly AFTER the reference time (see netForwardMinSamples). */
    let netForwardCount = 0;
    if (this.anyNetPositive) {
      const threshold =
        SHOT_FSM.netMotionThreshold *
        (this.rimBounce ? SHOT_FSM.netMotionRimBounceFactor : 1);
      // Reference order: observed crossing, then the local occlusion
      // projection, then the global flight-arc projection, then the resolve
      // time. The global arc is a THIRD fallback, consulted only when neither
      // an observed nor a locally-projected crossing exists — exactly the case
      // where `t` (the resolve instant, often 1.5 s of ball-lost timeout after
      // the ball actually reached the rim) is the worst possible reference.
      // BREAD-BALL: moving the window cannot fabricate a burst. The sample
      // still has to exceed netMotionThreshold (raised further after a rim
      // bounce), and `net` only ever reaches a make ALONGSIDE geo.
      const ref =
        tCross !== null
          ? tCross
          : virtual !== null
            ? virtual.tCross
            : flightCross !== null
              ? flightCross.tCross
              : t;
      net = netBurstInWindow(
        this.netSamples,
        ref,
        threshold,
        SHOT_FSM.netWindowSec,
        this.rimBounce && tCross !== null ? SHOT_FSM.rimBounceNetGraceSec : 0,
      );
      // (F) "No burst" is only meaningful if the window where a burst could
      // occur was actually SAMPLED. The acceptance window is symmetric around
      // the crossing, but a swish's net motion can only happen at or after it —
      // the net ROI hangs below the rim BOTTOM. When the attempt ends within a
      // frame of its own crossing (ball lost at the rim, maxLiveSec, a fast
      // low-fps drop) the forward half was never observed, yet `false` was
      // reported — and fuse() turns geo === true && net === false into a hard
      // MISS. Report the channel UNAVAILABLE instead.
      // BREAD-BALL: this does not add a make term. null routes to fuse()'s
      // netless branch, which still requires an OBSERVED in-span geo crossing
      // or (cls && occludedAtRim); cls alone still decides nothing. It refuses
      // to fabricate a "no swish" verdict out of an unobserved window — the
      // failure mode Roboflow's 2025 local shot evaluator documents verbatim
      // ("two shots that actually went in were recorded as misses because the
      // camera lost sight of the ball right at the hoop").
      if (net === false) {
        for (const ns of this.netSamples) {
          if (ns.t > ref) netForwardCount++;
        }
        if (netForwardCount < SHOT_FSM.netForwardMinSamples) net = null;
      }
    }

    // --- cls --------------------------------------------------------------
    const cls = this.maxClsScore >= DETECTION.ballInBasketScoreMin;

    // --- geoExit: observed DEEP exit through the hoop bottom -----------------
    // Recovers a rim-roll / rattle make whose clean rim-plane crossing was
    // OCCLUDED (geo === null) by reading a REAL deep in-span exit straight from
    // the trajectory (see geoExitObserved). Applied ONLY when the net channel
    // is not actively reporting "no swish" (net !== false): with net === false
    // we cannot tell a net-mistimed real drop from an airball crossing the 2D
    // plane in front of the hoop, so the shot stays 'unsure' rather than being
    // overridden into a make OR a miss. Upgrades geo (never a new cls-paired
    // make term) so fuse()'s bread-ball guarantee is untouched; it never flips
    // an explicit geo === false seen miss. On a net hoop this only reaches a
    // make via (geo && net); netless behaves like the existing netless-geo path.
    if (geo == null && net !== false && geoExitObserved(traj, rim)) {
      geo = true;
    }

    // --- reappearance corroborator (flagged) --------------------------------
    // The ball vanished at the rim and reappeared BELOW it on the pre-gap arc,
    // descending, in-span, depth-consistent. That upgrades an OCCLUDED (geo
    // null) crossing to geo=true — but only with agreement from net motion or
    // the ball_in_basket class. Never sole make evidence; never flips an
    // explicit geo=false (a seen miss stays a miss).
    if (this.useReappearance && this.reappCorroborated && geo == null) {
      if (net === true || (net === null && cls)) geo = true;
    }

    // --- virtual-crossing corroborator ---------------------------------------
    // Same contract as reappearance: an occluded (geo null) shot whose
    // projected crossing lands IN the span may upgrade to geo=true, but only
    // with net-motion or ball_in_basket agreement — never sole evidence, and
    // an out-of-span projection stays null (projection is not precise enough
    // to convict a miss). This converts the most trust-damaging output
    // ('unsure' on a clean swish that vanished into the net) into a decided
    // make while the corroboration requirement blocks the classic naive-
    // projection bug of minting makes from short misses.
    if (
      geo == null &&
      virtual !== null &&
      (net === true || (net === null && cls)) &&
      virtual.xCross >= rim.spanLeft &&
      virtual.xCross <= rim.spanRight
    ) {
      geo = true;
    }

    // --- global flight-arc corroborator (second virtual crossing) -----------
    // (C) Same pinned contract as the three corroborators above, deliberately
    // written as the same three-clause shape so the guarantee is auditable at
    // a glance:
    //   - `geo == null` — may ONLY upgrade an occluded crossing. It can never
    //     flip an explicit geo === false: a SEEN out-of-span crossing beats any
    //     projection, and a projection is not precise enough to convict either,
    //     so an out-of-span landing leaves geo null rather than minting a miss.
    //   - `net === true || (net === null && cls)` — never sole evidence. On a
    //     net hoop the net must agree; on a netless hoop the ball_in_basket
    //     class must. This is the clause that blocks the classic
    //     naive-projection bug of turning every short miss into a make.
    //   - in-span landing, from a fit already gated at the STRICT R² bar.
    // WHY IT EARNS ITS PLACE: the local projectVirtualCross needs a trailing
    // run of real, above-plane, descending samples ending at the hoop — a tail
    // the detector very often does not deliver (that IS the occlusion). The
    // global arc is fitted over up to FLIGHT.maxFlightSamples (64) samples
    // spanning the entire flight, so it survives the same dropout, and being a
    // whole-flight least-squares parabola it degrades far more gracefully with
    // camera angle than a 2-sample local secant.
    if (
      geo == null &&
      flightCross !== null &&
      (net === true || (net === null && cls)) &&
      flightCross.xCross >= rim.spanLeft &&
      flightCross.xCross <= rim.spanRight
    ) {
      geo = true;
    }

    // --- apex of the WHOLE flight (approach + trajectory) -------------------
    // (C) The shot's real high point, finally computed. The judgment buffer
    // starts at ARM and every ball-kinematic arm path fires AT the rim, so
    // `traj` alone almost never contains a jump shot's apex — which is why
    // trajectory.apexPoint had zero production callers despite being the one
    // number that says whether an arc was a shot at all. Fitting the separate
    // pre-arm `approach` samples together with the flight gives the parabola
    // enough of the rise to place a vertex.
    //
    // apexPoint() returns null unless the fitted vertex lies INSIDE the
    // observed time window, so a purely ascending or purely descending
    // observation reports nothing rather than an extrapolated guess.
    const apexSamples =
      this.approach.length > 0 ? this.approach.concat(traj) : traj;
    const apexFit = fitArc(apexSamples, this.minFitSamples(MIN_FIT_SAMPLES));
    const apexPt = apexFit !== null ? apexPoint(apexFit) : null;
    let apex: ResolvedShot['apex'];
    /**
     * The fitted vertex of the whole flight sat BELOW the rim plane, on a fit
     * trustworthy enough to say so: the ball peaked under the hoop, so nothing
     * that happened afterwards can be a made shot at this rim. Consumed once,
     * below, to demote a make. See SHOT_FSM.apexSanity for the trust gates.
     */
    let apexBelowPlane = false;
    if (apexFit !== null && apexPt !== null) {
      apex = {
        x: apexPt.x,
        y: apexPt.y,
        aboveRimPlanePx: rim.planeY - apexPt.y,
        r2y: apexFit.r2y,
        nSamples: apexSamples.length,
      };
      apexBelowPlane =
        apexPt.y > rim.planeY &&
        apexFit.r2y >= SHOT_FSM.apexSanity.minR2y &&
        apexSamples.length >= SHOT_FSM.apexSanity.minSamples &&
        plausibleArcCurvature(apexFit.ya, rim.box.width, FLIGHT.maxArcYaRimWidths);
    }

    // --- occlusion at the rim ----------------------------------------------
    const last = traj.length > 0 ? traj[traj.length - 1] : null;
    const occluded =
      last !== null &&
      (reason === 'ballLost' || last.predicted) &&
      pointInBox(rim.hoopRoi, last.cx, last.cy);

    // --- fusion -------------------------------------------------------------
    let outcome = fuse(geo, net, cls, occluded);
    if (reason === 'timeout') {
      outcome = 'unsure';
      holds.push('timeout');
    }
    // Double-count guard: ANY decided resolve too soon after the previous
    // make ⇒ unsure. Residual net/ball motion trailing a real make can still
    // produce a geo/net-agreeing 'miss' classification for a phantom second
    // attempt within the same basket-cooldown window; demoting misses too
    // (not just makes) avoids a spurious currentStreak reset right after a
    // make from that trailing motion.
    if (
      (outcome === 'make' || outcome === 'miss') &&
      t < this.lastMakeT + SHOT_FSM.basketCooldownSec
    ) {
      outcome = 'unsure';
      holds.push('basketCooldown');
    }
    // Pass-through guard: the ball-at-hoop branches (layup AND descending
    // entry) can be armed by a pass or lob whose 2D path merely CROSSES the
    // rim's projection (in front of or behind the hoop in depth) — and an
    // in-span descending crossing then reads geo=true. A real make on those
    // branches virtually always corroborates via a net burst or the
    // ball_in_basket class; a geo-ONLY "make" is exactly the pass-through
    // signature, so demote it to unsure rather than minting a phantom make.
    // (touchedRim can't discriminate here: any in-span crossing overlaps the
    // inflated rim box by construction.) Jump-shot-armed attempts are
    // untouched — a rising ball through the up-zone is already strong
    // attempt evidence. Release-armed attempts stay in the demote set on
    // purpose: the pose event proves the USER released, not that the
    // crossing ball was at the rim's depth — an overhead pass right after
    // the release motion can still sail through the 2D projection, and the
    // house rule is to never mint a make without corroboration.
    if (outcome === 'make' && this.armedVia !== 'jump' && net !== true && !cls) {
      outcome = 'unsure';
      holds.push('passThrough');
    }
    // Apex sanity guard (C): the parabola fitted over the WHOLE observed
    // flight — the pre-arm approach plus the live trajectory — peaked BELOW
    // the rim plane. A ball whose high point is under the hoop never got to
    // the rim: it is a bounce pass, a dribble, a ball rattling around beneath
    // the net, or a tracker that latched something that is not the shot. The
    // 2D channels cannot see this on their own — a ball passing just under the
    // rim can still produce one jittery above-plane sample, an in-span
    // "crossing" and a net brush, i.e. a textbook geo+net make out of a shot
    // that never happened.
    //
    // BREAD-BALL, by construction, on all four counts:
    //   - it is applied ONLY to `outcome === 'make'` and only downward
    //     (make -> 'unsure', never a fabricated miss);
    //   - it reads a fit, never writes one: no channel, threshold or fusion
    //     rule changes;
    //   - it needs a VERTEX INSIDE the observed window (apexPoint returns null
    //     otherwise), so a shot seen only on its way down — the normal
    //     occluded make — is untouched;
    //   - it needs the strict R² bar, the sample floor and plausible gravity
    //     curvature, so a rim rattle or a tracker switch (both of which fit
    //     badly) leaves the guard inert, which HANDS THE MAKE BACK.
    if (outcome === 'make' && apexBelowPlane) {
      outcome = 'unsure';
      holds.push('apexBelowRim');
    }
    // Rattle-out make guard (flagged; constructor default FALSE, ON live via
    // settingsStore). A geo+net make with an OBSERVED rim-plane crossing can
    // still be a rim-rattle / front-lip carom that bounced OUT: the ball
    // crossed the 2D plane in-span, brushed the net (a sub-swish burst read as
    // net===true), then exited the rim WITHOUT dropping through the hoop.
    //
    // WHY THIS ASKS FOR POSITIVE EVIDENCE NOW. The original trigger was
    // "the ball was seen deep (a real sample past belowY) AND
    // geoExitObserved() is false" — the ABSENCE of a proven clean exit. That
    // degenerates: the belowRim RESOLVE TRIGGER uses the SAME `cy > belowY`
    // threshold, so "seen deep" is true for essentially every shot that
    // resolves on a real below-rim sample, leaving "a make now REQUIRES
    // geoExitObserved" — precisely the clean-exit-required lever that was
    // rejected for costing real makes. And geoExitObserved is deliberately
    // strict: its descending test compares only the IMMEDIATELY PRECEDING real
    // sample, so ONE non-monotone cy (net occlusion shifting the box centroid,
    // motion blur, a re-acquired track) flips it false and kills a swish. It is
    // a make CONFIRMER — sound for upgrading geo null->true, unsound inverted
    // into a make DESTROYER, because "not proven clean" is not "proven out".
    // So the guard now demotes only on caromOutObserved: a REAL post-crossing
    // sample that PROVES the ball left the rim cylinder (deep and out of span,
    // or a re-ascent above the plane after the deepest deep sample).
    //
    // Strictly a narrowing of an existing demotion, and bread-ball-safe by
    // construction — this branch cannot mint an outcome, it can only take a
    // make away:
    //   - unsure, never a fabricated miss (the safe failure direction);
    //   - cls exempt: a corroborated ball_in_basket keeps the make;
    //   - crossIdx >= 0 required: occluded makes upgraded via the virtual /
    //     geoExit / reappearance corroborators (no observed crossing) are
    //     untouched, so the net-swallowed swish stays a make (test 13);
    //   - it judges the FROZEN prefix (exitTraj), so the settle window's
    //     net-noise frames can no longer manufacture the evidence.
    // Depth-blind by nature: a carom falling straight DOWN in front of the rim
    // stays in-span and looks identical to a swish in 2D — that residual case
    // is the depth-ratio veto's job, not this geometric guard's.
    if (
      this.useRattleGuard &&
      outcome === 'make' &&
      !cls &&
      crossIdx >= 0 &&
      caromOutObserved(exitTraj, rim, crossIdx)
    ) {
      outcome = 'unsure';
      holds.push('rattleOut');
    }
    // Settle-window bounce-out demotion (flagged; constructor default FALSE, ON
    // live via settingsStore). The ball was SEEN climbing back above the rim
    // plane AFTER dropping below the rim bottom — a carom / bounce-out, not a
    // clean drop through. Demote make -> unsure (never a fabricated miss). Gated
    // like the guard above: an OBSERVED crossing (crossIdx >= 0) is required so
    // an occluded, corroborator-upgraded make is untouched, and a corroborated
    // ball_in_basket (cls) is exempt. When useRattleGuard is also ON (the live
    // default) this is a strict subset of that guard's demotions — it exists so
    // the settle window can hold a rim-out on its own, and so the deferred live
    // window has a self-contained, testable effect.
    if (
      this.useSettleWindow &&
      outcome === 'make' &&
      this.settleReascended &&
      crossIdx >= 0 &&
      !cls
    ) {
      outcome = 'unsure';
      holds.push('settleReascend');
    }
    if (outcome === 'make') this.lastMakeT = t;

    // --- release-to-rim time --------------------------------------------------
    // Pose-gated release event → rim-plane crossing (observed, or the
    // virtual projection when the crossing was occluded — the same time the
    // net window trusts). Stamped only when the event plausibly belongs to
    // THIS attempt: the crossing must come after the event and within
    // RELEASE.maxReleaseToRimSec; a longer gap means the latched event is
    // residue from an earlier motion, and no metric beats a wrong one.
    let releaseToRimSec: number | null = null;
    const tCrossAny = tCross !== null ? tCross : virtual !== null ? virtual.tCross : null;
    if (tCrossAny !== null && Number.isFinite(this.lastReleaseEventT)) {
      const flight = tCrossAny - this.lastReleaseEventT;
      if (flight > 0 && flight <= RELEASE.maxReleaseToRimSec) {
        releaseToRimSec = flight;
      }
    }

    // --- release metrics -----------------------------------------------------
    let releaseAngleDeg: number | null = null;
    let first: BallSample | null = null;
    let lastRel: BallSample | null = null;
    let count = 0;
    for (let i = 0; i < traj.length && count < SHOT_FSM.releaseAngleSamples; i++) {
      const s = traj[i];
      if (s.predicted) continue;
      if (first === null) first = s;
      lastRel = s;
      count++;
    }
    if (first !== null && lastRel !== null && count >= 2) {
      releaseAngleDeg = elevationAngleDeg(lastRel.cx - first.cx, lastRel.cy - first.cy);
    }
    const releasePoint =
      traj.length > 0 ? { x: traj[0].cx, y: traj[0].cy } : null;

    const shot: ResolvedShot = {
      id: this.nextId++,
      tStart: this.tStart,
      tResolved: t,
      outcome,
      signals: {
        geo,
        net,
        cls,
        // Surface WHY geo was vetoed so the receipt can explain the miss: the
        // depth-illusion guard proved the ball crossed the 2D rim line while
        // in front of / behind the hoop. geoDepth is only set when the veto
        // ran; a 'silent' measurement carries no illusion tag.
        ...(geoDepth?.decision === 'veto_front'
          ? { illusion: 'front' as const }
          : geoDepth?.decision === 'veto_behind'
            ? { illusion: 'behind' as const }
            : {}),
      },
      rimBounce: this.rimBounce,
      xCross,
      entryAngleDeg,
      releaseAngleDeg,
      releasePoint,
      originX: this.originX,
      originY: this.originY,
      trajectory: traj,
      ...(geoDepth ? { geoDepth } : {}),
      ...(virtual ? { virtualCross: virtual } : {}),
      // Diagnostics: the global-arc projection that was live at resolve, and
      // the whole-flight apex. Both omitted when unavailable, so a shot with
      // no trustworthy global fit carries no extra payload.
      ...(flightCross ? { flightCross } : {}),
      ...(apex ? { apex } : {}),
      ...(releaseToRimSec !== null ? { releaseToRimSec } : {}),
      // Diagnostic only (see ShotHold): omitted entirely when nothing demoted
      // the shot, so a clean make carries no extra payload.
      ...(holds.length > 0 ? { holds } : {}),
    };

    // --- reset to COOLDOWN ---------------------------------------------------
    this.phase = 'COOLDOWN';
    this.lastResolveT = t;
    if (this.rimBounce) this.lastBounceResolveT = t;
    this.reapp.clear();
    this.reappCorroborated = false;
    this.trajectory = [];
    this.approach = [];
    this.flightLanding = null;
    this.netSamples = [];
    this.anyNetPositive = false;
    this.maxClsScore = 0;
    this.touchedRim = false;
    this.rimBounce = false;
    this.wasAbovePlane = false;
    this.belowRimFirstT = null;
    this.belowRimTrajLen = null;
    this.settleReascended = false;
    this.armedVia = null;
    this.originX = null;
    this.originY = null;

    return shot;
  }
}

/**
 * Three-signal fusion table.
 *
 * Net channel available:
 *   MAKE  if (geo && net) || (net && cls)
 *   MISS  if (crossing exists && !geo) || (geo && !net)
 * Net channel unavailable (netless hoop):
 *   MAKE  if geo || (cls && occludedAtRim)
 *   MISS  if crossing exists && !geo
 * Everything else ⇒ 'unsure'.
 *
 * Bread-ball guarantee: when the net channel IS available, `cls` may only
 * contribute to a make by AGREEING with net (`net && cls`) — it can never
 * override a `net === false` (no swish, a likely miss/airball) into a make.
 * The old `(cls && occludedAtRim)` make term did exactly that: a single
 * `ball_in_basket` blip near the rim minted a phantom make against a net that
 * said "no". Removed. The `(cls && occludedAtRim)` path survives ONLY on the
 * netless branch, where there is no net to corroborate and it is the sole
 * signal an occluded ball had that it dropped in. The safe failure mode is
 * `unsure`, never a false make.
 */
/**
 * Whether any net-motion sample above `threshold` falls inside the acceptance
 * window around `ref`.
 *
 * `graceSec === 0` → SYMMETRIC window (|t − ref| ≤ windowSec): the normal shot.
 * `graceSec > 0`   → FORWARD-ONLY window ([ref, ref + windowSec + graceSec]):
 * a RIM BOUNCE, whose genuine swish burst arrives LATE (the ball re-ascends and
 * drops after the first crossing) but never before it — so we extend forward,
 * never earlier. `net` can still only be flipped false→true here and the caller
 * keeps the raised rim-bounce threshold, so a graze on a bounce-OUT (below
 * threshold) can't read as a swish. Exported for unit testing.
 */
export function netBurstInWindow(
  netSamples: readonly { t: number; score: number }[],
  ref: number,
  threshold: number,
  windowSec: number,
  graceSec: number,
): boolean {
  const forwardOnly = graceSec > 0;
  for (const ns of netSamples) {
    const inWindow = forwardOnly
      ? ns.t >= ref && ns.t <= ref + windowSec + graceSec
      : Math.abs(ns.t - ref) <= windowSec;
    if (inWindow && ns.score > threshold) return true;
  }
  return false;
}

// Exported for the fusion truth-table test (pins the bread-ball guarantee).
export function fuse(
  geo: boolean | null,
  net: boolean | null,
  cls: boolean,
  occludedAtRim: boolean,
): ShotOutcome {
  // Geometry is the most reliable channel. A clear FINAL descending crossing
  // OUTSIDE the rim span (geo === false) means the ball missed — trust that
  // over the noisy 'ball_in_basket' class and trailing net motion. Checking it
  // first prevents a false ball_in_basket from fabricating a phantom "make" on
  // an obvious miss (the "shot becomes a make" bug, worst on netless outdoor
  // hoops where cls alone used to decide it).
  if (geo === false) return 'miss';
  if (net === null) {
    // Netless hoop: a tracked make (geo) counts; an occluded ball that
    // vanished into the basket with ball_in_basket firing counts; cls ALONE
    // (no geometry, ball not even at the rim) is too weak to call a make.
    if (geo === true) return 'make';
    if (cls && occludedAtRim) return 'make';
    return 'unsure';
  }
  // net available: cls must AGREE with net (net && cls); it may NOT override a
  // net === false into a make (the removed `(cls && occludedAtRim)` bread-ball).
  if ((geo === true && net) || (net && cls)) return 'make';
  if (geo === true && !net) return 'miss';
  return 'unsure';
}

/**
 * Whether the trajectory shows the ball physically EXITING through the BOTTOM
 * of the hoop — a net-independent make observation that recovers rim-roll /
 * rattle makes whose clean rim-plane crossing was OCCLUDED (so the crossing
 * detector left geo === null).
 *
 * True iff a REAL (non-predicted) sample reaches BELOW `rim.belowY` — the rim
 * BOTTOM + margin, NOT merely the rim TOP `planeY` — horizontally inside the
 * crossing span, reached on a DESCENDING path, with NO real sample re-ascending
 * above the rim plane afterward. Three independent guards make it bread-ball
 * safe:
 *   1. belowY (not planeY): a rim-roll-OUT grazing the front lip dips just below
 *      the rim's TOP but never reaches the BOTTOM in-span before it exits
 *      sideways/upward — so it never qualifies.
 *   2. no re-ascent: a ball that bounces below then back up above the rim plane
 *      is disqualified (the classic bounce-out).
 *   3. real samples only: a Kalman-coasted (predicted) deep sample can never
 *      fabricate an exit.
 * The caller applies it only to upgrade geo null->true (never a new cls-paired
 * make term) and only when net is not actively reporting "no swish", so it
 * inherits fuse()'s guarantees. Exported for unit testing — this geometric
 * discriminator is the crux of the rim-roll fix.
 */
/**
 * Whether the trajectory PROVES the ball left the rim cylinder after crossing
 * the plane — the carom-OUT observation the rattle-out make guard demotes on.
 *
 * WHY THIS EXISTS SEPARATELY FROM geoExitObserved. geoExitObserved answers
 * "was a clean drop-through PROVEN?"; its negation is not "was a carom-out
 * proven?", because an unproven exit is the normal state of a ball that is
 * occluded by rim and net at exactly the moment it passes through. Inverting a
 * confirmer into a destroyer is what made the guard eat genuine makes (one
 * non-monotone cy inside the net was enough). This helper only ever answers
 * with POSITIVE evidence, so a noisy or incomplete observation yields false —
 * i.e. hands the make back, never takes one away on ignorance.
 *
 * True iff a REAL (never Kalman-predicted) sample AFTER the scored crossing
 * shows either:
 *   (a) a re-ascent back above `rim.planeY` following the DEEPEST post-crossing
 *       sample, that deepest sample itself being past `rim.belowY` — the ball
 *       went down through the rim band and came back up over it. A
 *       rim-diameter-scale excursion, far beyond net-occlusion jitter; or
 *   (b) a sample past `rim.belowY` sitting OUTSIDE [spanLeft, spanRight] — at
 *       the rim's bottom the ball is somewhere it could not be had it gone
 *       through the hoop.
 *
 * `crossIdx` is the first index of the scored crossing pair, exactly as
 * resolve() computes it (traj[crossIdx].cy <= planeY < traj[crossIdx+1].cy);
 * pass -1 for "no crossing", which yields false. Scoping the scan to
 * POST-crossing samples is load-bearing, not tidiness: a release-armed attempt
 * is seeded at the shooter's HANDS, which are both far below belowY and usually
 * far outside the span, so a whole-trajectory scan would read every genuine
 * release-armed make as a carom.
 *
 * The caller applies it in one direction only — make -> 'unsure' — so it can
 * never fabricate a make or a miss. Exported for unit testing.
 */
export function caromOutObserved(
  traj: readonly BallSample[],
  rim: RimGeometry,
  crossIdx: number,
): boolean {
  if (crossIdx < 0) return false;
  // Deepest REAL post-crossing sample, and (b) checked on the way past.
  let deepIdx = -1;
  for (let i = crossIdx + 1; i < traj.length; i++) {
    const s = traj[i]!;
    if (s.predicted) continue;
    if (s.cy > rim.belowY && (s.cx < rim.spanLeft || s.cx > rim.spanRight)) {
      return true; // (b) past the rim bottom, outside the span
    }
    if (deepIdx < 0 || s.cy > traj[deepIdx]!.cy) deepIdx = i;
  }
  // (a) needs the ball to have actually reached BELOW the rim bottom first:
  // without that, a would-be "re-ascent" is just a ball still inside the rim
  // band, which no observation here can separate from a detection wobble.
  if (deepIdx < 0 || traj[deepIdx]!.cy <= rim.belowY) return false;
  for (let k = deepIdx + 1; k < traj.length; k++) {
    const s = traj[k]!;
    if (!s.predicted && s.cy < rim.planeY) return true;
  }
  return false;
}

export function geoExitObserved(
  traj: readonly BallSample[],
  rim: RimGeometry,
): boolean {
  // Deepest-in-TIME real sample that is below the rim bottom AND in-span.
  let deepIdx = -1;
  for (let i = 0; i < traj.length; i++) {
    const s = traj[i]!;
    if (
      !s.predicted &&
      s.cy > rim.belowY &&
      s.cx >= rim.spanLeft &&
      s.cx <= rim.spanRight
    ) {
      deepIdx = i;
    }
  }
  if (deepIdx < 0) return false;

  // Must have been DESCENDING into that point: the previous real sample sat
  // higher up (smaller cy). Predicted samples are skipped, never trusted.
  let descending = false;
  for (let j = deepIdx - 1; j >= 0; j--) {
    if (!traj[j]!.predicted) {
      descending = traj[j]!.cy < traj[deepIdx]!.cy;
      break;
    }
  }
  if (!descending) return false;

  // No REAL re-ascent above the rim plane after the deep exit (bounce-out).
  for (let k = deepIdx + 1; k < traj.length; k++) {
    if (!traj[k]!.predicted && traj[k]!.cy < rim.planeY) return false;
  }
  return true;
}
