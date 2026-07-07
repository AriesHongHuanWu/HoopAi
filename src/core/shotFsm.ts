/**
 * ShotFsm — the realtime make/miss shot state machine (three-signal fusion).
 *
 * One instance lives per session. Feed it one {@link FsmFrameInput} per
 * analysed camera frame via {@link ShotFsm.step}. The machine arms when a
 * ball climbs into the rim's up-zone (or a player carries the ball above the
 * rim plane near the hoop — the layup path), buffers the live trajectory,
 * and resolves each attempt to make / miss / unsure by fusing three
 * independent signals:
 *
 *  - geo — interpolated x at the rim plane on the FINAL descending crossing
 *    lies within the central rim span. `null` when the ball never crossed
 *    the plane downward.
 *  - net — a net-motion burst within `SHOT_FSM.netWindowSec` of the crossing
 *    (threshold raised by `netMotionRimBounceFactor` after a rim bounce).
 *    The channel is `null` (unavailable — netless hoop or no monitor) when
 *    every net-motion score during the live window was exactly 0.
 *  - cls — the detector's 'ball_in_basket' class fired at or above
 *    `DETECTION.ballInBasketScoreMin` at any point during the live shot.
 *
 * Pure TypeScript: no I/O, no wall-clock reads — time comes exclusively from
 * camera timestamps in the inputs. Per-frame allocation is bounded (one
 * trajectory sample + one net sample while a shot is live).
 *
 * Coordinates are analysis-frame pixels, +y DOWN (ball moving up ⇒ vy < 0).
 */
import { DETECTION, SHOT_FSM } from './config';
import { depthRatioGate, type BallSizeSetting, type ViewBandName } from './depthRatioGate';
import { elevationAngleDeg, interpolateXAtY } from './geometry';
import { ReappearanceTest } from './reappearance';
import { selectDepthSamples } from './sampleQuality';
import { backfillPredictedGap } from './trajectory';
import type {
  BallSample,
  Box,
  FsmFrameInput,
  FsmStepResult,
  ResolvedShot,
  RimGeometry,
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

/** Why a live shot left SHOT_LIVE (internal). */
type ResolveReason = 'belowRim' | 'ballLost' | 'timeout';

/**
 * Max samples kept in the live trajectory trail. A release→rim arc at 15–30 fps
 * is ~15–40 samples, so this doesn't clip a real shot; it just bounds a stuck /
 * occluded shot (which can run to maxLiveSec) so the comet never drags too long.
 */
const MAX_TRAJ_SAMPLES = 48;

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
  /** Last resolve that ended with a rim bounce (putback guard). */
  private lastBounceResolveT = -Infinity;

  // --- depth-aware judgment (all inert unless the veto flag is on) ---------
  /** Kill-switch: run the depth-ratio parallax veto in resolve(). */
  private readonly useDepthVeto: boolean;
  /** Kill-switch: gap-crossing reappearance corroborator. */
  private readonly useReappearance: boolean;
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

  // --- live-shot state (valid only while phase === 'SHOT_LIVE') ------------
  private tStart = 0;
  /** Whether the live attempt armed via the layup branch (vs up-zone rise). */
  private armedViaLayup = false;
  private originX: number | null = null;
  private originY: number | null = null;
  private trajectory: BallSample[] = [];
  private netSamples: NetSample[] = [];
  private anyNetPositive = false;
  private maxClsScore = 0;
  private touchedRim = false;
  private rimBounce = false;
  private lastBallT = 0;

  /**
   * @param rim   Locked rim geometry for the session (swap via setRim).
   * @param frame Analysis-frame dimensions, used to normalize shot origin.
   */
  constructor(
    rim: RimGeometry,
    frame: FrameSize,
    opts: { useDepthRatioVeto?: boolean; useReappearance?: boolean } = {},
  ) {
    this.frameW = frame.width;
    this.frameH = frame.height;
    this.useDepthVeto = opts.useDepthRatioVeto ?? SHOT_FSM.useDepthRatioVeto;
    this.useReappearance = opts.useReappearance ?? SHOT_FSM.useReappearance;
    this.setRim(rim);
  }

  /** Ball-size setting (7/6/5) feeding the depth-ratio gate. */
  setBallSize(size: BallSizeSetting): void {
    this.ballSize = size;
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
      if (ball !== null) {
        const via = this.canArm(input, ball);
        if (via !== null) this.arm(input, ball, via);
      }
      return { phase: this.phase, liveTrajectory: this.trajectory, resolved: null };
    }

    if (this.phase === 'COOLDOWN') {
      return { phase: 'COOLDOWN', liveTrajectory: this.trajectory, resolved: null };
    }

    // ---- SHOT_LIVE ----------------------------------------------------
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
      if (this.trajectory.length > MAX_TRAJ_SAMPLES) this.trajectory.shift();
      // "前後幀" gap smoothing: the ball just REAPPEARED after a dropout —
      // rewrite the straight-line Kalman coast between the two real sides with
      // the physics-true two-sided parabola. Improves the drawn comet AND the
      // crossing geometry the make/miss call is built on.
      if (!ball.predicted) backfillPredictedGap(this.trajectory);
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
      if (!this.touchedRim && this.touchesRimRegion(ball)) {
        this.touchedRim = true;
      }
      // Re-ascend above the plane after a rim touch ⇒ rim bounce.
      if (this.touchedRim && ball.cy < this.rim.planeY && ball.vy < 0) {
        this.rimBounce = true;
      }
      if (ball.cy > this.rim.belowY) reason = 'belowRim';
    } else if (t - this.lastBallT >= SHOT_FSM.lostBallResolveSec) {
      reason = 'ballLost';
    } else if (this.useReappearance) {
      // Tracker dropped the ball entirely: arm the reappearance trap off the
      // buffered trajectory (internally refuses without a trustworthy arc).
      this.reapp.armOnBallLost(this.trajectory, this.rim, t);
    }

    if (reason === null && t - this.tStart > SHOT_FSM.maxLiveSec) {
      reason = 'timeout';
    }

    if (reason !== null) {
      const shot = this.resolve(t, reason);
      return { phase: this.phase, liveTrajectory: this.trajectory, resolved: shot };
    }

    return { phase: 'SHOT_LIVE', liveTrajectory: this.trajectory, resolved: null };
  }

  // -------------------------------------------------------------------------
  // Arming
  // -------------------------------------------------------------------------

  private canArm(input: FsmFrameInput, ball: TrackedBall): 'jump' | 'layup' | null {
    // Shot cooldown (redundant with COOLDOWN phase gating, kept as a guard).
    if (input.t < this.lastResolveT + SHOT_FSM.shotCooldownSec) return null;
    // Putback guard: after a rim-bounce resolve, hold arming a little longer
    // so a tip-in doesn't double-count off the first attempt's residue.
    if (input.t < this.lastBounceResolveT + SHOT_FSM.putbackWindowSec) {
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
    return null;
  }

  private arm(input: FsmFrameInput, ball: TrackedBall, via: 'jump' | 'layup'): void {
    this.phase = 'SHOT_LIVE';
    this.armedViaLayup = via === 'layup';
    this.layupLowStreak = 0;
    this.tStart = input.t;
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
  }

  // -------------------------------------------------------------------------
  // Rim-touch test
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  private resolve(t: number, reason: ResolveReason): ResolvedShot {
    const rim = this.rim;
    const traj = this.trajectory;

    // --- geo: FINAL descending crossing of the rim plane -----------------
    // Prefer the final crossing whose BOTH samples are real detections (not
    // Kalman-predicted coasts through occlusion) over a later but predicted
    // crossing: a brief occlusion right at the rim plane — common, since the
    // ball is frequently hidden by the rim/net at exactly this moment — can
    // otherwise fabricate a crossing or misplace it from extrapolated
    // positions rather than observed ones, degrading geo/entry-angle
    // precision exactly when it matters most.
    let crossIdx = -1;
    let realCrossIdx = -1;
    for (let i = 0; i + 1 < traj.length; i++) {
      if (traj[i].cy <= rim.planeY && traj[i + 1].cy > rim.planeY) {
        crossIdx = i;
        if (!traj[i].predicted && !traj[i + 1].predicted) realCrossIdx = i;
      }
    }
    if (realCrossIdx >= 0) crossIdx = realCrossIdx;
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
      if (gate.decision !== 'silent') geo = false;
    }

    // --- net: burst near the crossing (or resolve time) ------------------
    let net: boolean | null = null;
    if (this.anyNetPositive) {
      const threshold =
        SHOT_FSM.netMotionThreshold *
        (this.rimBounce ? SHOT_FSM.netMotionRimBounceFactor : 1);
      const ref = tCross !== null ? tCross : t;
      net = false;
      for (let i = 0; i < this.netSamples.length; i++) {
        const ns = this.netSamples[i];
        if (Math.abs(ns.t - ref) <= SHOT_FSM.netWindowSec && ns.score > threshold) {
          net = true;
          break;
        }
      }
    }

    // --- cls --------------------------------------------------------------
    const cls = this.maxClsScore >= DETECTION.ballInBasketScoreMin;

    // --- reappearance corroborator (flagged) --------------------------------
    // The ball vanished at the rim and reappeared BELOW it on the pre-gap arc,
    // descending, in-span, depth-consistent. That upgrades an OCCLUDED (geo
    // null) crossing to geo=true — but only with agreement from net motion or
    // the ball_in_basket class. Never sole make evidence; never flips an
    // explicit geo=false (a seen miss stays a miss).
    if (this.useReappearance && this.reappCorroborated && geo == null) {
      if (net === true || (net === null && cls)) geo = true;
    }

    // --- occlusion at the rim ----------------------------------------------
    const last = traj.length > 0 ? traj[traj.length - 1] : null;
    const occluded =
      last !== null &&
      (reason === 'ballLost' || last.predicted) &&
      pointInBox(rim.hoopRoi, last.cx, last.cy);

    // --- fusion -------------------------------------------------------------
    let outcome = fuse(geo, net, cls, occluded);
    if (reason === 'timeout') outcome = 'unsure';
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
    }
    // Pass-through guard: the ball-first layup branch can be armed by a pass
    // or lob whose 2D path merely CROSSES the rim's projection (in front of
    // or behind the hoop in depth) — and an in-span descending crossing then
    // reads geo=true. A real layup make virtually always corroborates via a
    // net burst or the ball_in_basket class; a geo-ONLY "make" on a
    // layup-armed attempt is exactly the pass-through signature, so demote
    // it to unsure rather than minting a phantom make. (touchedRim can't
    // discriminate here: any in-span crossing overlaps the inflated rim box
    // by construction.) Jump-shot-armed attempts are untouched — a rising
    // ball through the up-zone is already strong attempt evidence.
    if (outcome === 'make' && this.armedViaLayup && net !== true && !cls) {
      outcome = 'unsure';
    }
    if (outcome === 'make') this.lastMakeT = t;

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
      signals: { geo, net, cls },
      rimBounce: this.rimBounce,
      xCross,
      entryAngleDeg,
      releaseAngleDeg,
      releasePoint,
      originX: this.originX,
      originY: this.originY,
      trajectory: traj,
      ...(geoDepth ? { geoDepth } : {}),
    };

    // --- reset to COOLDOWN ---------------------------------------------------
    this.phase = 'COOLDOWN';
    this.lastResolveT = t;
    if (this.rimBounce) this.lastBounceResolveT = t;
    this.reapp.clear();
    this.reappCorroborated = false;
    this.trajectory = [];
    this.netSamples = [];
    this.anyNetPositive = false;
    this.maxClsScore = 0;
    this.touchedRim = false;
    this.rimBounce = false;
    this.armedViaLayup = false;
    this.originX = null;
    this.originY = null;

    return shot;
  }
}

/**
 * Three-signal fusion table.
 *
 * Net channel available:
 *   MAKE  if (geo && net) || (net && cls) || (cls && occludedAtRim)
 *   MISS  if (crossing exists && !geo) || (geo && !net)
 * Net channel unavailable (netless hoop):
 *   MAKE  if geo || cls
 *   MISS  if crossing exists && !geo
 * Everything else ⇒ 'unsure'.
 */
function fuse(
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
  if ((geo === true && net) || (net && cls) || (cls && occludedAtRim)) return 'make';
  if (geo === true && !net) return 'miss';
  return 'unsure';
}
