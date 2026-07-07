/**
 * ShotFsm — the realtime make/miss shot state machine (three-signal fusion).
 *
 * One instance lives per session. Feed it one {@link FsmFrameInput} per
 * analysed camera frame via {@link ShotFsm.step}. The machine arms when a
 * ball climbs into the rim's up-zone, a player carries the ball above the
 * rim plane near the hoop (the layup path), or a confident ball falls into
 * the hoop ROI off a ballistic arc from outside the zone (the
 * descending-entry / floater path — seeded retroactively from a rolling
 * pre-arm buffer), buffers the live trajectory, and resolves each attempt
 * to make / miss / unsure by fusing three independent signals:
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
import { backfillPredictedGap, fitArc, predictLanding } from './trajectory';
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

/** Which arming branch started the live attempt (internal). */
type ArmVia = 'jump' | 'layup' | 'descend';

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
      if (ball !== null) {
        const via = this.canArm(input, ball);
        if (via !== null) this.arm(input, ball, via);
      }
      return { phase: this.phase, liveTrajectory: this.trajectory, resolved: null };
    }

    if (this.phase === 'COOLDOWN') {
      // Keep the pre-arm buffer warm: a floater's approach frequently spans
      // the COOLDOWN → IDLE boundary, and the descending-entry branch needs
      // those samples the moment IDLE resumes.
      const ball = input.ball;
      if (ball !== null && !ball.predicted) this.pushPreArm(ball, t);
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

  private canArm(input: FsmFrameInput, ball: TrackedBall): ArmVia | null {
    // Shot cooldown (redundant with COOLDOWN phase gating, kept as a guard).
    if (input.t < this.lastResolveT + SHOT_FSM.shotCooldownSec) return null;
    // Putback guard: after a rim-bounce resolve, hold arming a little longer
    // so a tip-in doesn't double-count off the first attempt's residue.
    if (input.t < this.lastBounceResolveT + SHOT_FSM.putbackWindowSec) {
      return null;
    }
    // Wedged/resting ball: a ball that has sat still inside the layup zone
    // re-satisfies the arming conditions every IDLE frame — without this it
    // loops arm → maxLiveSec timeout → cooldown → re-arm, emitting a junk
    // review shot every ~5.5 s. ALL branches are refused until the ball
    // actually leaves the zone: the dislodging poke nudges it upward (a
    // "rising ball" the jump branch would happily arm) before dropping it
    // through the net, and that must not read as a fresh attempt either.
    if (this.restingBallSuppressed) return null;
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
    return null;
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
    if (buf.length < cfg.minRealSamples) return false;
    const first = buf[0];
    if (pointInBox(this.layupZone, first.cx, first.cy)) return false;
    const fit = fitArc(buf);
    if (fit === null || fit.r2y < cfg.minR2y) return false;
    // Gravity floor on ya (≈ g/2): rejects linear drift, whose fit is
    // near-degenerate in the quadratic term.
    if (fit.ya < cfg.minYaRimWidthsPerSec2 * rim.box.width) return false;
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
    if (tail.length < cfg.minRealSamples) return null;
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
    const fit = fitArc(tail);
    if (fit === null || fit.ya <= 0 || fit.r2y < cfg.minR2y) return null;
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

    // --- virtual crossing (occlusion inference) ---------------------------
    // No observed crossing: the ball died above the plane, occluded by the
    // rim/net. If its trailing REAL samples form a confident descending
    // parabola ending at the hoop, project where/when it would cross. Used
    // ONLY (a) as the net window's time reference below — the net whips at
    // the real crossing, not at the resolve timeout 1.5s later — and (b) as
    // a corroborated geo upgrade after the net/cls channels are known.
    const virtual = crossIdx < 0 ? this.projectVirtualCross(traj) : null;

    // --- net: burst near the crossing (or resolve time) ------------------
    let net: boolean | null = null;
    if (this.anyNetPositive) {
      const threshold =
        SHOT_FSM.netMotionThreshold *
        (this.rimBounce ? SHOT_FSM.netMotionRimBounceFactor : 1);
      const ref = tCross !== null ? tCross : virtual !== null ? virtual.tCross : t;
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
    // attempt evidence.
    if (outcome === 'make' && this.armedVia !== 'jump' && net !== true && !cls) {
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
      ...(virtual ? { virtualCross: virtual } : {}),
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
