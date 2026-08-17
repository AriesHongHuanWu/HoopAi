/**
 * Rim locking and derived-zone geometry.
 *
 * The rim is (nearly) static in the analysis frame, so instead of tracking it
 * per frame we LOCK it: accumulate a small cluster of mutually consistent
 * detections, average them, then hold that box with a heavy EMA damp
 * (RIM.lockAlpha). Outlier detections are rejected against the locked box;
 * a sustained run of rejects flags a camera bump (`driftDetected`) and a
 * fresh consistent cluster at the new location re-locks automatically.
 *
 * DRIFT IS BOUNDED IN BOTH DIRECTIONS (the "one knock kills the session" fix):
 * - declaring drift is time-bounded as well as count-bounded
 *   ({@link DRIFT_REJECT_SPAN_SEC}), because the reject COUNTER only advances on
 *   frames that actually carry a rim detection above the score floor — a bump
 *   that makes the rim hard/impossible to detect never advances it, so the old
 *   count-only rule could hold a knocked-off lock as "fine" indefinitely; and
 * - an unresolved drift SELF-HEALS ({@link DRIFT_MAX_UNRESOLVED_SEC}): the
 *   machine drops to UNLOCKED and re-runs the ordinary acquire path (3
 *   consistent detections + lockHoldSec, with the user-visible 3-2-1
 *   countdown) instead of publishing stale geometry forever while the pipeline
 *   refuses to arm. Downstream, drift only ever SUPPRESSES arming, so both
 *   bounds are about restoring attempts that were silently lost — neither can
 *   mint an outcome.
 *
 * While locked, the box CONTINUOUSLY re-locks onto accepted detections with a
 * per-frame CLAMPED step (see the SETTLE_* constants), so a small camera/rim
 * move is tracked live in a few frames instead of tens — without ever widening
 * the accept gate that decides which detections are the rim at all.
 *
 * All coordinates are analysis-frame pixels, +y DOWN (see types.ts).
 * Pure TypeScript, no I/O; time comes in via the `t` parameter.
 */
import { DETECTION, RIM } from './config';
import type { Box, Detection, FrameDetections, RimGeometry } from './types';

/**
 * Number of mutually consistent observations required to (re-)lock the rim.
 * Lowered 5 → 3: three spatially-agreeing detections of a STATIC object is
 * ample evidence and roughly halves acquisition time, which is what made the
 * lock feel finicky. DRIFT_REJECT_COUNT stays at 5 so an established lock is
 * still lost conservatively (fast to acquire, slow to drop).
 */
const LOCK_CLUSTER_SIZE = 3;

/**
 * Number of CONSECUTIVE rejected observations after which we declare the
 * camera bumped (`driftDetected`). Local constant for the same reason as
 * {@link LOCK_CLUSTER_SIZE}.
 */
const DRIFT_REJECT_COUNT = 5;

/**
 * Wall-clock span after which a run of CONSECUTIVE rejects declares drift even
 * though it never reached DRIFT_REJECT_COUNT.
 *
 * WHY: `consecutiveRejects` only advances on frames that contain a rim
 * detection at score >= DETECTION.rimScoreMin. The exact failure the user
 * reported ("if the rim or the camera moves it has a huge impact") often makes
 * the rim HARDER to detect — knocked partly out of frame, motion-blurred,
 * newly backlit — so detections become sparse or stop entirely. The counter
 * then crawls (or freezes at 1) and the lock keeps publishing geometry for a
 * rim that is no longer there, with no drift signal to the pipeline or the
 * user. Measuring the span of the reject run closes that hole: the run is
 * positive evidence that the geometry disagrees with what the detector sees,
 * and after 0.4 s of it we stop pretending the lock is good.
 *
 * 0.4 s is chosen so this rule can only ever fire FIRST when the reject cadence
 * is below DRIFT_REJECT_COUNT / 0.4 s = 12.5 Hz. At the 30 fps the frame-count
 * gates were authored against, 5 consecutive rejects span 4/30 = 0.133 s, so
 * the COUNT rule always wins and 30 fps behaviour is byte-identical; only the
 * slow / intermittent-detection case (the one the counter cannot see) changes.
 *
 * At least one reject is required — plain absence of detections never declares
 * drift on its own, so an occluded rim (a player standing in front of it) still
 * costs nothing.
 */
const DRIFT_REJECT_SPAN_SEC = 0.4;

/**
 * Seconds an UNRESOLVED drift may persist before the machine drops itself to
 * UNLOCKED and re-acquires from scratch.
 *
 * WHY (this is the "nothing triggers at all" bug): drift used to be latched and
 * unbounded. The pipeline refuses every arm branch while `driftDetected`
 * (shotPipeline `armLockout`), and mutually-inconsistent rejects — precisely
 * what a knocked camera produces — never re-lock, so drift could hold for the
 * WHOLE session: zero attempts recorded, while the on-screen drift banner had
 * already timed out after ~4 s. One knock silently killed everything after it.
 * Self-healing to UNLOCKED puts the user back on the normal acquire path (3
 * consistent detections + lockHoldSec) which is the path that actually SHOWS
 * the 3-2-1 countdown, so the state is both recoverable and visible.
 *
 * 1.5 s: long enough that the cheap resolutions get their chance first — a
 * camera that wobbles back (a single accepted observation clears drift and
 * KEEPS the lock) or a real move that yields a consistent cluster (re-lock in 3
 * frames, ~0.1 s at 30 fps) both land well inside it, so a transient never
 * costs the lock. Short enough that the worst case from knock to live tracking
 * is 1.5 s + lockHoldSec (2.5 s) ≈ 4 s of clearly-signalled re-aiming rather
 * than an entire dead session. Below ~1.2 s the drop starts to pre-empt those
 * cheaper paths on a slow phone (8-15 fps ⇒ a 3-frame cluster is 0.2-0.4 s and
 * detections arrive in bursts); above ~3 s the user has already lost the banner
 * and given up.
 */
const DRIFT_MAX_UNRESOLVED_SEC = 1.5;

/**
 * `driftAtT` sentinel meaning "no drift episode is currently stamped". Negative
 * so it can never collide with a real camera-clock timestamp (t >= 0).
 */
const DRIFT_UNSTAMPED = -1;

/**
 * Continuous clamped re-lock (rim bump guard). A camera/rim move that stays
 * INSIDE the accept zone (displacement < maxDriftDiagFactor·diag) never trips
 * drift, so at RIM.lockAlpha (0.05) the lock needed ~45 accepted frames to
 * converge — seconds of subtly-wrong geometry, which is the second half of
 * "if the rim or the camera moves it has a huge impact". The answer to the
 * user's "tracked live?" is yes, with two hard limits:
 *
 * 1. WHAT counts as the rim is unchanged. The accept/reject gate below is
 *    byte-identical (still maxDriftDiagFactor·diag); only the convergence SPEED
 *    toward observations the gate ALREADY accepted changes — location, never
 *    judgment.
 * 2. HOW FAR one frame can move it is clamped to FOLLOW_MAX_STEP_FRAC·diag.
 *
 * The sustained-vs-jitter discriminator is an EMA of each accepted
 * observation's center offset from the lock: for symmetric jitter of amplitude
 * A the EMA's steady-state peak is only A·β/(2-β) = 0.176·A (β =
 * SETTLE_OFF_EMA_ALPHA), while a sustained offset D converges to D itself. So a
 * SETTLE_ENTER_FRAC of 0.05·diag engages the fast damp on a sustained offset of
 * 2.2 px (on a 45 px-diagonal rim) but needs ±12.7 px of symmetric jitter — a
 * 5.7x separation. That is why the fast damp cannot simply be the base alpha:
 * chasing jitter would smear every derived zone (pinned by the damping suite).
 *
 * Lowered 0.12 → 0.05 so SMALL sustained offsets converge too: 0.12·diag left
 * everything under ~5.4 px on the 45-frame path, which is exactly the "rim is
 * a bit off and stays a bit off" case.
 */
const SETTLE_OFF_EMA_ALPHA = 0.3;
/** Fast damp engages when |offset EMA| exceeds this fraction of the lock diagonal. */
const SETTLE_ENTER_FRAC = 0.05;
/** ...and disengages below this fraction (hysteresis, so it cannot chatter). */
const SETTLE_EXIT_FRAC = 0.025;
/** EMA weight used while the fast damp is engaged (vs RIM.lockAlpha 0.05). */
const SETTLE_ALPHA = 0.35;
/**
 * Hard per-frame cap on how far ANY single accepted observation may move each
 * locked box coordinate, as a fraction of the lock diagonal (≈3.6 px on a 45 px
 * diagonal rim).
 *
 * WHY it cannot be dragged onto a background hoop: the widest accepted
 * displacement is maxDriftDiagFactor·diag (0.5·diag ≈ 22 px), which at
 * SETTLE_ALPHA would be a 7.8 px lurch on the strength of ONE frame. Clamped,
 * that same frame moves the box 3.6 px — a sub-rim-radius nudge the next
 * genuine observation pulls straight back — and walking the lock a full 0.5·diag
 * takes ≥6 CONSECUTIVE frames whose detections each sit inside the (unwidened)
 * gate around the box's CURRENT position. A decoy hoop 200 px away is never
 * inside that gate, so it can never contribute even one such frame; dragging
 * the lock across the frame would require an unbroken physical trail of rim
 * detections, i.e. a real pan of a real rim. Deliberately larger than a
 * sustained 0.3·diag bump's first step (0.35·13.4 = 4.7 px) only by a little,
 * so genuine bumps still re-center in ~6 frames.
 */
const FOLLOW_MAX_STEP_FRAC = 0.08;

/**
 * Minimum movement (px, any single box coordinate) that counts as the geometry
 * having MOVED for {@link RimLock.consumeGeometryMoved}. Matches the 1 px
 * hysteresis the worklet-ROI consumer already applies: the lock EMA-damps on
 * every accepted detection, so an exact compare reports "moved" on nearly every
 * analysed frame, and a sub-pixel-stale rect addresses the same pixels anyway.
 */
const GEOM_MOVE_EPS_PX = 1;

/** Clamps a signed EMA step to ±`maxStep` (see {@link FOLLOW_MAX_STEP_FRAC}). */
function clampStep(step: number, maxStep: number): number {
  if (step > maxStep) return maxStep;
  if (step < -maxStep) return -maxStep;
  return step;
}

/** Allocates a zeroed RimGeometry skeleton (filled by `writeGeometry`). */
function newRimGeometry(): RimGeometry {
  return {
    box: { x: 0, y: 0, width: 0, height: 0 },
    cx: 0,
    cy: 0,
    planeY: 0,
    spanLeft: 0,
    spanRight: 0,
    belowY: 0,
    upZone: { x: 0, y: 0, width: 0, height: 0 },
    hoopRoi: { x: 0, y: 0, width: 0, height: 0 },
    netRoi: { x: 0, y: 0, width: 0, height: 0 },
    aspect: 1,
  };
}

/**
 * Writes the full derived geometry for a rim box (given as x/y/w/h scalars to
 * avoid a temporary Box allocation on the per-frame path) into `out`.
 */
function writeGeometry(
  x: number,
  y: number,
  w: number,
  h: number,
  out: RimGeometry,
): void {
  const cx = x + w / 2;
  const cy = y + h / 2;

  out.box.x = x;
  out.box.y = y;
  out.box.width = w;
  out.box.height = h;
  out.aspect = h > 0 ? w / h : 1;
  out.cx = cx;
  out.cy = cy;

  // Rim plane = top edge of the rim box.
  out.planeY = y;

  // Crossing span: central spanFraction of the rim width, widened by the
  // rebound buffer on each side.
  const halfSpan = (RIM.spanFraction / 2) * w;
  out.spanLeft = cx - halfSpan - RIM.crossingBufferPx;
  out.spanRight = cx + halfSpan + RIM.crossingBufferPx;

  // Resolve line: below the rim bottom by a margin proportional to rim height.
  out.belowY = y + h + RIM.belowMarginFactor * h;

  // Up-zone: centered on the rim cx, sitting ON TOP of the rim plane
  // (bottom edge == planeY).
  const upW = RIM.upZoneWidthFactor * w;
  const upH = RIM.upZoneHeightFactor * h;
  out.upZone.x = cx - upW / 2;
  out.upZone.y = y - upH;
  out.upZone.width = upW;
  out.upZone.height = upH;

  // Hoop ROI: rim box scaled by hoopRoiFactor about the rim center.
  const roiW = RIM.hoopRoiFactor * w;
  const roiH = RIM.hoopRoiFactor * h;
  out.hoopRoi.x = cx - roiW / 2;
  out.hoopRoi.y = cy - roiH / 2;
  out.hoopRoi.width = roiW;
  out.hoopRoi.height = roiH;

  // Net ROI: rim-width wide, hanging directly below the rim box.
  out.netRoi.x = x;
  out.netRoi.y = y + h;
  out.netRoi.width = w;
  out.netRoi.height = RIM.netRoiHeightFactor * h;
}

/**
 * Computes all derived zones for a rim bounding box per the RIM config.
 *
 * - `planeY` = box top edge.
 * - `spanLeft/Right` = center ± (spanFraction/2)·width, widened by
 *   `crossingBufferPx` on each side.
 * - `belowY` = box bottom + belowMarginFactor·height.
 * - `upZone` = upZoneWidthFactor·w × upZoneHeightFactor·h, centered on the
 *   rim cx with its bottom edge on `planeY`.
 * - `hoopRoi` = rim box scaled by hoopRoiFactor about the rim center.
 * - `netRoi` = rim-width wide, top at the rim bottom,
 *   netRoiHeightFactor·height tall.
 *
 * Pure function; returns a fresh object every call.
 */
export function computeRimGeometry(box: Box): RimGeometry {
  const g = newRimGeometry();
  writeGeometry(box.x, box.y, box.width, box.height, g);
  return g;
}

/**
 * Locks the rim position from noisy per-frame detections and maintains the
 * derived {@link RimGeometry}.
 *
 * Lifecycle:
 * 1. UNLOCKED — accumulates rim detections; once LOCK_CLUSTER_SIZE
 *    observations mutually agree (each within maxDriftDiagFactor·diag of the
 *    cluster's running mean), locks at the cluster mean. `step` returns null
 *    until then.
 * 2. LOCKED — each accepted observation EMA-damps the box with RIM.lockAlpha
 *    (or SETTLE_ALPHA while the fast damp is engaged), with the per-frame step
 *    clamped to FOLLOW_MAX_STEP_FRAC·diag; see the SETTLE_* constants.
 *    Observations displaced more than maxDriftDiagFactor·diag from the lock are
 *    rejected outright.
 * 3. DRIFT — DRIFT_REJECT_COUNT consecutive rejects, OR a consecutive-reject
 *    run spanning DRIFT_REJECT_SPAN_SEC, set `driftDetected` (camera bumped).
 *    While drifted, a fresh consistent cluster of LOCK_CLUSTER_SIZE
 *    observations at the new location re-locks there and clears the drift flag.
 *    A single accepted observation at the OLD spot also clears it (camera came
 *    back).
 * 4. SELF-HEAL — a drift still unresolved DRIFT_MAX_UNRESOLVED_SEC after it was
 *    declared drops the machine back to state 1 (UNLOCKED): `geometry` goes
 *    null, drift clears, and the ordinary acquire path (with its 3-2-1
 *    countdown) runs again. The machine must never sit in a state where it
 *    publishes stale geometry forever while the pipeline refuses to arm.
 *
 * Allocation note: the geometry object is created once and mutated in place
 * on every update — callers needing a snapshot must copy it.
 */
export class RimLock {
  /** True once a rim position is locked. */
  private locked = false;

  /** EMA-damped locked rim box (scalars to avoid a Box allocation). */
  private lockX = 0;
  private lockY = 0;
  private lockW = 0;
  private lockH = 0;

  /** Cached geometry, mutated in place; null while unlocked. */
  private geom: RimGeometry | null = null;

  /**
   * Running-sum cluster of candidate observations. Used both for the initial
   * lock (while unlocked) and for post-drift re-verification (while drifted);
   * the two phases never overlap.
   */
  private clusterSumX = 0;
  private clusterSumY = 0;
  private clusterSumW = 0;
  private clusterSumH = 0;
  private clusterCount = 0;

  /** Consecutive post-lock rejects (resets on any accepted observation). */
  private consecutiveRejects = 0;

  /**
   * Camera-clock time (s) the CURRENT consecutive-reject run began, i.e. of the
   * reject that took `consecutiveRejects` from 0 to 1. Meaningless while
   * `consecutiveRejects === 0`. Feeds the time-based drift rule
   * ({@link DRIFT_REJECT_SPAN_SEC}), which is the only rule that can fire while
   * the rim has stopped being detected altogether.
   */
  private rejectRunStartT = 0;

  /** Set when consecutiveRejects reaches DRIFT_REJECT_COUNT (or the run spans
   *  DRIFT_REJECT_SPAN_SEC). */
  private drift = false;

  /**
   * Camera-clock time (s) drift was declared, stamped once per drift episode;
   * DRIFT_UNSTAMPED while no episode is open. Drives {@link driftSinceSec} and
   * the {@link DRIFT_MAX_UNRESOLVED_SEC} self-heal.
   *
   * WHY a sentinel rather than 0: the self-heal bound is only meaningful
   * measured from a moment we actually OBSERVED the drift. A `drift` flag that
   * appears without going through {@link declareDrift} (white-box test setup,
   * a future caller) would otherwise be timed from the epoch and self-heal on
   * its very first frame — silently deleting the drift instead of bounding it.
   * An unstamped episode is stamped lazily on the next frame instead.
   */
  private driftAtT = DRIFT_UNSTAMPED;

  /**
   * Locked box size at the moment drift was first flagged, captured once so
   * a post-drift re-lock candidate can be sanity-checked against the size of
   * the rim we actually lost, not a shifting running value. 0 while no drift
   * has occurred since the last lock.
   */
  private preDriftW = 0;
  private preDriftH = 0;

  /**
   * EMA of accepted-observation center offsets from the lock (bump-settle
   * boost input; see the SETTLE_* constants). Symmetric jitter cancels here;
   * a sustained bump does not.
   */
  private offEmaX = 0;
  private offEmaY = 0;

  /** True while the fast SETTLE_ALPHA damp is engaged (hysteresis-latched). */
  private settleBoost = false;

  /**
   * Snapshot of the locked box as of the last {@link consumeGeometryMoved} call,
   * plus whether such a snapshot exists at all. WHY: the geometry object is
   * mutated in place and the lock now FOLLOWS the rim continuously, so
   * consumers that must re-derive state when the rim MOVES (not only when it
   * hard re-locks — that is what `lockGeneration` is for) have nothing to
   * compare against. An unpushed fresh lock always counts as moved.
   */
  private pushedValid = false;
  private pushedX = 0;
  private pushedY = 0;
  private pushedW = 0;
  private pushedH = 0;

  /** Bump-settle kill switch; default ON. See {@link setBumpSettle}. */
  private bumpSettle = true;

  /**
   * Monotonic (re-)lock counter, incremented only by lockAtClusterMean() and
   * setManual() — never by ordinary EMA accepts. WHY it exists: the
   * RimGeometry object is mutated IN PLACE and its reference never changes,
   * so downstream consumers (pipeline fsm.setRim, worklet net-ROI sync)
   * cannot see a re-lock through ref-equality — this counter is the explicit
   * signal. Deliberately NOT cleared in reset() so a consumer comparing
   * against a cached value can never miss a re-lock across a session reset.
   */
  private lockGen = 0;

  /** Seconds the rim must stay stable before the lock commits (0 = immediate). */
  private readonly holdSec: number;
  /** Camera-clock time (s) the current forming cluster began. */
  private clusterStartT = 0;
  /** Camera-clock time (s) of the last rim observation. */
  private lastObsT = 0;
  /** Seconds left on the pre-lock hold, or null when not counting (UI reads this). */
  private countdownSec: number | null = null;

  /** After this many seconds with no rim observation, a forming (unlocked)
   *  cluster is discarded — the rim left the frame, so the countdown restarts. */
  private static readonly CLUSTER_STALE_SEC = 1.0;

  constructor(opts: { lockHoldSec?: number } = {}) {
    this.holdSec = Math.max(0, opts.lockHoldSec ?? 0);
  }

  /**
   * Consumes one frame of detections and returns the current locked geometry,
   * or null while no lock is held.
   *
   * Only detections with cls === 'rim' and score >= DETECTION.rimScoreMin are
   * considered; the highest-score one wins per frame. A frame without a valid
   * rim detection touches no OBSERVATION-driven state, but the clock-driven
   * drift rules below still run on it — that is deliberate and is what makes an
   * undetectable rim recoverable rather than terminal.
   *
   * @param frame Raw detector output for this frame.
   * @param t Frame timestamp in seconds (camera clock). Drives the pre-lock hold
   *   countdown, the time-based drift declaration
   *   ({@link DRIFT_REJECT_SPAN_SEC}) and the drift self-heal
   *   ({@link DRIFT_MAX_UNRESOLVED_SEC}). Periodic re-verification
   *   (RIM.reverifySec) is still not wired in; re-locking is
   *   observation-driven.
   */
  step(frame: FrameDetections, t: number): RimGeometry | null {
    let best: Detection | null = null;
    const dets = frame.detections;
    // Frame side the boxes are authored in (square analysis frame, 640).
    const side = Math.max(frame.frameWidth, frame.frameHeight);
    const maxRimSide = RIM.rimMaxSizeFraction * side;
    for (let i = 0; i < dets.length; i++) {
      const d = dets[i];
      if (d.cls !== 'rim' || d.score < DETECTION.rimScoreMin) continue;
      // Size sanity: a rim box wider or taller than rimMaxSizeFraction of the
      // frame is not a real rim (it is a mis-scaled/degenerate detector box).
      // Drop it BEFORE it can seed or EMA the lock, so an oversized corner box
      // can never latch into a persistent phantom reticle.
      if (d.box.width > maxRimSide || d.box.height > maxRimSide) continue;
      if (best === null || d.score > best.score) best = d;
    }
    if (best !== null) this.observe(best.box, best.score, t);

    // Clock-driven drift rules, evaluated on EVERY frame — including frames
    // with no rim detection at all, which is the whole point: a bump that makes
    // the rim undetectable produces no observations, so a rule that only runs
    // inside observe() can neither declare drift nor ever end one.
    this.maybeDeclareDriftBySpan(t);
    this.maybeSelfHeal(t);

    // Pre-lock hold countdown (UI shows 3-2-1) + stale-cluster cleanup. Only
    // meaningful before the first lock; once locked or drifting, no countdown.
    if (this.locked || this.drift || this.holdSec <= 0) {
      this.countdownSec = null;
    } else if (this.clusterCount > 0) {
      if (t - this.lastObsT > RimLock.CLUSTER_STALE_SEC) {
        // Rim vanished mid-countdown → discard the cluster and restart.
        this.clearCluster();
        this.countdownSec = null;
      } else {
        this.countdownSec = Math.max(0, this.holdSec - (t - this.clusterStartT));
      }
    } else {
      this.countdownSec = null;
    }
    return this.locked ? this.geom : null;
  }

  /**
   * Seconds remaining on the pre-lock "hold steady" countdown, or null when not
   * counting (already locked, drifting, no cluster, or hold disabled). The live
   * HUD renders `ceil(this)` as a 3-2-1 reticle.
   */
  get lockCountdown(): number | null {
    return this.countdownSec;
  }

  /** Current locked geometry, or null while no lock is held. */
  get geometry(): RimGeometry | null {
    return this.locked ? this.geom : null;
  }

  /**
   * True while the lock is considered stale: DRIFT_REJECT_COUNT consecutive
   * observations disagreed with the locked position, or such a run spanned
   * DRIFT_REJECT_SPAN_SEC (camera bumped). Clears when a fresh cluster
   * re-locks, an observation agrees with the old lock, or the
   * DRIFT_MAX_UNRESOLVED_SEC self-heal drops the lock entirely.
   */
  get driftDetected(): boolean {
    return this.drift;
  }

  /**
   * Seconds since drift was declared, or null when not drifted. Lets the
   * pipeline/HUD keep a bump banner alive for as long as the condition actually
   * lasts (the old fixed ~4 s banner expired while the arm lockout stayed on,
   * leaving the user with no attempts AND no signal), and lets callers reason
   * about how close the self-heal is.
   */
  driftSinceSec(t: number): number | null {
    if (!this.drift) return null;
    if (this.driftAtT === DRIFT_UNSTAMPED) return 0; // stamped on the next step
    return Math.max(0, t - this.driftAtT);
  }

  /**
   * True only while a lock is held AND not drifted — i.e. the published
   * geometry can be trusted. The single query a consumer needs to answer "is
   * the rim currently untrusted?" without having to combine `geometry != null`
   * with `!driftDetected` itself.
   *
   * CONSUMER CONTRACT — read this before caching `geometry`. The
   * DRIFT_MAX_UNRESOLVED_SEC self-heal is the first path that takes `geometry`
   * from non-null back to null WITHOUT a `reset()`; every earlier path
   * (`reset`, the pipeline's reAim) was paired with the consumer clearing its
   * own cached rim in the same breath. A consumer that keeps a last-known rim
   * (shotPipeline's `lastRim`) and gates work on `driftDetected` alone will,
   * between the self-heal and the following re-lock, run against zones for a
   * rim that is no longer where it says it is. Gate on `trusted` (or drop the
   * cached rim when `geometry` is null) instead — a rim we do not currently
   * know the position of must suppress, never decide.
   */
  get trusted(): boolean {
    return this.locked && !this.drift;
  }

  /**
   * True when the locked box has moved at least GEOM_MOVE_EPS_PX in any
   * coordinate since the last {@link consumeGeometryMoved} — non-consuming, for
   * HUD/debug reads and tests.
   */
  get geometryMoved(): boolean {
    if (!this.locked) return false;
    if (!this.pushedValid) return true;
    return (
      Math.abs(this.lockX - this.pushedX) >= GEOM_MOVE_EPS_PX ||
      Math.abs(this.lockY - this.pushedY) >= GEOM_MOVE_EPS_PX ||
      Math.abs(this.lockW - this.pushedW) >= GEOM_MOVE_EPS_PX ||
      Math.abs(this.lockH - this.pushedH) >= GEOM_MOVE_EPS_PX
    );
  }

  /**
   * {@link geometryMoved}, and if it was true, records the current box as the
   * new baseline ("push" it). WHY a consuming query: the rim now follows the
   * real rim continuously, so geometry changes without ever hard re-locking —
   * `lockGeneration` (hard re-locks only) cannot see that, and the object is
   * mutated in place so ref-equality cannot either. A consumer that must
   * re-derive rim-relative state (FSM zones, worklet ROIs) calls this once per
   * frame and rebuilds when it returns true.
   */
  consumeGeometryMoved(): boolean {
    const moved = this.geometryMoved;
    if (moved) {
      this.pushedValid = true;
      this.pushedX = this.lockX;
      this.pushedY = this.lockY;
      this.pushedW = this.lockW;
      this.pushedH = this.lockH;
    }
    return moved;
  }

  /**
   * Monotonic count of hard (re-)locks: cluster locks (initial, post-drift,
   * large-jump) and manual overrides. Because `geometry` is mutated in place,
   * ref-equality can never reveal a re-lock — consumers that cache derived
   * state (FSM zones, worklet ROI rects) must watch this counter and rebuild
   * when it changes. Ordinary EMA accepts do NOT increment it.
   */
  get lockGeneration(): number {
    return this.lockGen;
  }

  /**
   * Kill switch for the bump-settle boost (default ON). Disabling zeroes the
   * offset EMA and drops any engaged boost, so damping reverts exactly to the
   * plain RIM.lockAlpha behavior.
   */
  setBumpSettle(enabled: boolean): void {
    this.bumpSettle = enabled;
    if (!enabled) {
      this.offEmaX = 0;
      this.offEmaY = 0;
      this.settleBoost = false;
    }
  }

  /**
   * User tap-adjust: overrides the rim box immediately and locks on it,
   * clearing any pending cluster and drift state.
   */
  setManual(box: Box): void {
    this.lockGen++;
    this.lockX = box.x;
    this.lockY = box.y;
    this.lockW = box.width;
    this.lockH = box.height;
    this.locked = true;
    this.clearCluster();
    this.consecutiveRejects = 0;
    this.rejectRunStartT = 0;
    this.drift = false;
    this.driftAtT = DRIFT_UNSTAMPED;
    this.preDriftW = 0;
    this.preDriftH = 0;
    this.offEmaX = 0;
    this.offEmaY = 0;
    this.settleBoost = false;
    this.pushedValid = false;
    this.refreshGeometry();
  }

  /**
   * Returns to the initial unlocked state. `lockGen` intentionally survives
   * (monotonic across resets) and `bumpSettle` is a user setting, not
   * per-session transient state.
   */
  reset(): void {
    this.dropToUnlocked();
    this.geom = null;
    this.clusterStartT = 0;
    this.lastObsT = 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Routes one accepted-class rim observation through the lock state. */
  private observe(box: Box, score: number, t: number): void {
    this.lastObsT = t;
    if (!this.locked) {
      this.feedCluster(box, t);
      // Lock once the cluster is consistent AND (when a hold is configured) it
      // has stayed stable for holdSec — the 3-2-1 countdown the user asked for.
      if (
        this.clusterCount >= LOCK_CLUSTER_SIZE &&
        (this.holdSec <= 0 || t - this.clusterStartT >= this.holdSec)
      ) {
        this.lockAtClusterMean();
      }
      return;
    }

    const diag = Math.hypot(this.lockW, this.lockH);
    const dx = box.x + box.width / 2 - (this.lockX + this.lockW / 2);
    const dy = box.y + box.height / 2 - (this.lockY + this.lockH / 2);
    const dist = Math.hypot(dx, dy);
    const displaced = dist > RIM.maxDriftDiagFactor * diag;

    // LARGE-jump fast path: a confident rim landing far outside the lock is a
    // probable camera pan, not shake. Flag drift and start the re-verify cluster
    // on THIS frame instead of waiting for DRIFT_REJECT_COUNT slow rejects. It
    // still needs a full consistent cluster + the size guard below before it
    // re-locks, so a single stray far box can't re-lock.
    if (
      displaced &&
      !this.drift &&
      score >= RIM.relockStrongScore &&
      dist >= RIM.largeJumpDiagFactor * diag
    ) {
      this.declareDrift(t);
      this.noteReject(t);
      this.feedCluster(box, t);
      if (this.clusterCount >= LOCK_CLUSTER_SIZE) {
        if (this.clusterSizeMatchesPreDrift()) this.lockAtClusterMean();
        else this.clearCluster();
      }
      return;
    }

    if (!displaced) {
      // Continuous re-lock: fold this accepted offset into the offset EMA and
      // run the enter/exit hysteresis BEFORE damping, so the very frame the
      // EMA crosses the threshold already damps fast. See the SETTLE_*
      // constants for the sustained-vs-jitter argument.
      this.offEmaX += SETTLE_OFF_EMA_ALPHA * (dx - this.offEmaX);
      this.offEmaY += SETTLE_OFF_EMA_ALPHA * (dy - this.offEmaY);
      const off = Math.hypot(this.offEmaX, this.offEmaY);
      if (this.bumpSettle) {
        if (!this.settleBoost && off > SETTLE_ENTER_FRAC * diag) {
          this.settleBoost = true;
        } else if (this.settleBoost && off < SETTLE_EXIT_FRAC * diag) {
          this.settleBoost = false;
        }
      }
      // Accept: EMA-damp the lock toward the observation, with every coordinate
      // step CLAMPED (FOLLOW_MAX_STEP_FRAC) so no single frame — however
      // confident, however close to the edge of the accept gate — can lurch the
      // geometry. The gate above already decided this box IS the rim; the clamp
      // only bounds how much of one frame's opinion we act on.
      const a = this.settleBoost ? SETTLE_ALPHA : RIM.lockAlpha;
      const maxStep = FOLLOW_MAX_STEP_FRAC * diag;
      this.lockX += clampStep(a * (box.x - this.lockX), maxStep);
      this.lockY += clampStep(a * (box.y - this.lockY), maxStep);
      this.lockW += clampStep(a * (box.width - this.lockW), maxStep);
      this.lockH += clampStep(a * (box.height - this.lockH), maxStep);
      this.consecutiveRejects = 0;
      this.drift = false;
      this.driftAtT = DRIFT_UNSTAMPED;
      this.preDriftW = 0;
      this.preDriftH = 0;
      this.clearCluster();
      this.refreshGeometry();
      return;
    }

    // Reject.
    this.noteReject(t);
    if (
      !this.drift &&
      (this.consecutiveRejects >= DRIFT_REJECT_COUNT ||
        t - this.rejectRunStartT >= DRIFT_REJECT_SPAN_SEC)
    ) {
      this.declareDrift(t);
    }
    if (this.drift) {
      // Re-verify: accumulate a consistent cluster at the new location.
      this.feedCluster(box, t);
      if (this.clusterCount >= LOCK_CLUSTER_SIZE) {
        if (this.clusterSizeMatchesPreDrift()) {
          this.lockAtClusterMean();
        } else {
          // Cluster is internally consistent but a size mismatch against the
          // pre-drift lock (e.g. a similarly-shaped decoy object) — refuse to
          // re-lock onto it and keep accumulating for a fresh candidate.
          this.clearCluster();
        }
      }
    }
  }

  /**
   * Records one post-lock reject, stamping the start of the run so the
   * time-based drift rule has a reference point. Split out because the
   * large-jump fast path counts a reject too.
   */
  private noteReject(t: number): void {
    if (this.consecutiveRejects === 0) this.rejectRunStartT = t;
    this.consecutiveRejects++;
  }

  /**
   * Flags drift and stamps the moment, capturing the size of the rim we just
   * lost (once) for the post-drift re-lock sanity check. Idempotent within an
   * episode: re-declaring would slide `driftAtT` forward and defeat the
   * self-heal bound, which is exactly how an unbounded latch is built.
   */
  private declareDrift(t: number): void {
    if (this.drift) return;
    this.drift = true;
    this.driftAtT = t;
    this.preDriftW = this.lockW;
    this.preDriftH = this.lockH;
  }

  /**
   * Time-based drift declaration ({@link DRIFT_REJECT_SPAN_SEC}). Runs from
   * `step` on every frame so a reject run that goes SILENT — the bump made the
   * rim undetectable, so `consecutiveRejects` can never advance again — still
   * ends in a drift declaration instead of an indefinitely-held stale lock.
   */
  private maybeDeclareDriftBySpan(t: number): void {
    if (!this.locked || this.drift || this.consecutiveRejects === 0) return;
    if (t - this.rejectRunStartT >= DRIFT_REJECT_SPAN_SEC) this.declareDrift(t);
  }

  /**
   * Self-heal ({@link DRIFT_MAX_UNRESOLVED_SEC}): a drift that neither re-locked
   * nor came back within the bound gives up the lock, so the ordinary acquire
   * path takes over. Runs AFTER `observe` each frame, so this frame's
   * observation always gets first chance to resolve the drift the cheap way.
   */
  private maybeSelfHeal(t: number): void {
    if (!this.drift) return;
    if (this.driftAtT === DRIFT_UNSTAMPED) {
      // Drift appeared without going through declareDrift. Adopt NOW as the
      // start of the episode: the bound must run from a moment we observed, or
      // an unstamped flag would be timed from the epoch and dropped on its
      // first frame — deleting the drift signal instead of bounding it.
      this.driftAtT = t;
      return;
    }
    if (t - this.driftAtT < DRIFT_MAX_UNRESOLVED_SEC) return;
    this.dropToUnlocked();
  }

  /**
   * Drops to the UNLOCKED state, discarding the lock and all drift state.
   *
   * `lockGen` deliberately does NOT move: it counts hard (re-)LOCKS, and a
   * consumer that treats an unlock as a lock would rebuild zones around a box
   * that no longer exists. Consumers see the invalidation through
   * `geometry === null` / `trusted === false`, and the re-lock that follows
   * bumps `lockGen` as usual. `geom` is kept allocated (unreachable while
   * unlocked) so re-locking stays allocation-free on the per-frame path.
   */
  private dropToUnlocked(): void {
    this.locked = false;
    this.lockX = 0;
    this.lockY = 0;
    this.lockW = 0;
    this.lockH = 0;
    this.clearCluster();
    this.consecutiveRejects = 0;
    this.rejectRunStartT = 0;
    this.drift = false;
    this.driftAtT = DRIFT_UNSTAMPED;
    this.preDriftW = 0;
    this.preDriftH = 0;
    this.offEmaX = 0;
    this.offEmaY = 0;
    this.settleBoost = false;
    this.pushedValid = false;
    this.countdownSec = null;
  }

  /**
   * True when the current cluster's mean box size is plausibly the same rim
   * as the pre-drift lock (both width and height ratios within
   * RIM.relockMaxSizeRatio). Always true if no pre-drift size was captured
   * (defensive; should not happen once locked).
   */
  private clusterSizeMatchesPreDrift(): boolean {
    if (this.preDriftW <= 0 || this.preDriftH <= 0) return true;
    const n = this.clusterCount;
    const meanW = this.clusterSumW / n;
    const meanH = this.clusterSumH / n;
    if (meanW <= 0 || meanH <= 0) return false;
    const wRatio = Math.max(meanW / this.preDriftW, this.preDriftW / meanW);
    const hRatio = Math.max(meanH / this.preDriftH, this.preDriftH / meanH);
    return (
      wRatio <= RIM.relockMaxSizeRatio && hRatio <= RIM.relockMaxSizeRatio
    );
  }

  /**
   * Adds an observation to the running cluster. An observation whose center
   * strays more than maxDriftDiagFactor·diag from the cluster's running mean
   * restarts the cluster at that observation.
   */
  private feedCluster(box: Box, t: number): void {
    if (this.clusterCount > 0) {
      const n = this.clusterCount;
      const meanW = this.clusterSumW / n;
      const meanH = this.clusterSumH / n;
      const meanCx = this.clusterSumX / n + meanW / 2;
      const meanCy = this.clusterSumY / n + meanH / 2;
      const d = Math.hypot(
        box.x + box.width / 2 - meanCx,
        box.y + box.height / 2 - meanCy,
      );
      if (d > RIM.maxDriftDiagFactor * Math.hypot(meanW, meanH)) {
        this.clearCluster();
      }
    }
    // A big move restarts the cluster (above) → this observation begins a fresh
    // one, so (re)stamp its start time; the hold countdown measures from here.
    if (this.clusterCount === 0) this.clusterStartT = t;
    this.clusterSumX += box.x;
    this.clusterSumY += box.y;
    this.clusterSumW += box.width;
    this.clusterSumH += box.height;
    this.clusterCount++;
  }

  /** Locks (or re-locks) at the cluster mean and clears transient state. */
  private lockAtClusterMean(): void {
    this.lockGen++;
    const n = this.clusterCount;
    this.lockX = this.clusterSumX / n;
    this.lockY = this.clusterSumY / n;
    this.lockW = this.clusterSumW / n;
    this.lockH = this.clusterSumH / n;
    this.locked = true;
    this.clearCluster();
    this.consecutiveRejects = 0;
    this.rejectRunStartT = 0;
    this.drift = false;
    this.driftAtT = DRIFT_UNSTAMPED;
    this.preDriftW = 0;
    this.preDriftH = 0;
    // The lock IS the cluster mean now — any accumulated offset EMA is stale.
    this.offEmaX = 0;
    this.offEmaY = 0;
    this.settleBoost = false;
    // A hard (re-)lock is by definition a move the consumers have not seen.
    this.pushedValid = false;
    this.refreshGeometry();
  }

  private clearCluster(): void {
    this.clusterSumX = 0;
    this.clusterSumY = 0;
    this.clusterSumW = 0;
    this.clusterSumH = 0;
    this.clusterCount = 0;
  }

  /** Rewrites the cached geometry (allocating it on first lock only). */
  private refreshGeometry(): void {
    if (this.geom === null) this.geom = newRimGeometry();
    writeGeometry(this.lockX, this.lockY, this.lockW, this.lockH, this.geom);
  }
}
