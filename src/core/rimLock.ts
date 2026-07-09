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
 * Bump-settle boost (rim bump guard). A small camera bump that stays INSIDE
 * the accept zone (displacement < maxDriftDiagFactor·diag) never trips drift,
 * so the lock converges to the true position at RIM.lockAlpha (0.05) — about
 * 45 accepted frames of subtly-wrong rim geometry. The boost watches an EMA
 * of each ACCEPTED observation's center offset from the lock: symmetric
 * detector jitter cancels out, a sustained one-sided offset (real bump) does
 * not. While that EMA exceeds SETTLE_ENTER_FRAC of the lock diagonal, the
 * damp runs at SETTLE_ALPHA and re-centers in ~4-6 accepted frames.
 *
 * One-sided by construction: the accept/reject decision is untouched and only
 * the convergence SPEED toward already-accepted observations changes
 * (location, never judgment). Kill switch: {@link RimLock.setBumpSettle}.
 */
const SETTLE_OFF_EMA_ALPHA = 0.3;
/** Boost engages when |offset EMA| exceeds this fraction of the lock diagonal. */
const SETTLE_ENTER_FRAC = 0.12;
/** ...and disengages below this fraction (hysteresis, so it cannot chatter). */
const SETTLE_EXIT_FRAC = 0.05;
/** EMA weight used while the boost is engaged (vs RIM.lockAlpha 0.05). */
const SETTLE_ALPHA = 0.35;

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
 *    (or SETTLE_ALPHA while the bump-settle boost is engaged; see the
 *    SETTLE_* constants). Observations displaced more than
 *    maxDriftDiagFactor·diag from the lock are rejected outright.
 * 3. DRIFT — DRIFT_REJECT_COUNT consecutive rejects set `driftDetected`
 *    (camera bumped). While drifted, a fresh consistent cluster of
 *    LOCK_CLUSTER_SIZE observations at the new location re-locks there and
 *    clears the drift flag. A single accepted observation at the OLD spot
 *    also clears it (camera came back).
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

  /** Set when consecutiveRejects reaches DRIFT_REJECT_COUNT. */
  private drift = false;

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
   * considered; the highest-score one wins per frame. Frames without a valid
   * rim detection leave all state untouched.
   *
   * @param frame Raw detector output for this frame.
   * @param t Frame timestamp in seconds (camera clock). Currently recorded
   *   for contract parity only — time-based periodic re-verification
   *   (RIM.reverifySec) is not wired in; re-locking is observation-driven.
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
   * observations disagreed with the locked position (camera bumped). Clears
   * when a fresh cluster re-locks or an observation agrees with the old lock.
   */
  get driftDetected(): boolean {
    return this.drift;
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
    this.drift = false;
    this.preDriftW = 0;
    this.preDriftH = 0;
    this.offEmaX = 0;
    this.offEmaY = 0;
    this.settleBoost = false;
    this.refreshGeometry();
  }

  /**
   * Returns to the initial unlocked state. `lockGen` intentionally survives
   * (monotonic across resets) and `bumpSettle` is a user setting, not
   * per-session transient state.
   */
  reset(): void {
    this.locked = false;
    this.geom = null;
    this.lockX = 0;
    this.lockY = 0;
    this.lockW = 0;
    this.lockH = 0;
    this.clearCluster();
    this.consecutiveRejects = 0;
    this.drift = false;
    this.preDriftW = 0;
    this.preDriftH = 0;
    this.offEmaX = 0;
    this.offEmaY = 0;
    this.settleBoost = false;
    this.clusterStartT = 0;
    this.lastObsT = 0;
    this.countdownSec = null;
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
      this.drift = true;
      this.preDriftW = this.lockW;
      this.preDriftH = this.lockH;
      this.consecutiveRejects++;
      this.feedCluster(box, t);
      if (this.clusterCount >= LOCK_CLUSTER_SIZE) {
        if (this.clusterSizeMatchesPreDrift()) this.lockAtClusterMean();
        else this.clearCluster();
      }
      return;
    }

    if (!displaced) {
      // Bump-settle boost: fold this accepted offset into the offset EMA and
      // run the enter/exit hysteresis BEFORE damping, so the very frame the
      // EMA crosses the threshold already damps fast. See the SETTLE_*
      // constants for the one-sidedness argument.
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
      // Accept: EMA-damp the lock toward the observation.
      const a = this.settleBoost ? SETTLE_ALPHA : RIM.lockAlpha;
      this.lockX += a * (box.x - this.lockX);
      this.lockY += a * (box.y - this.lockY);
      this.lockW += a * (box.width - this.lockW);
      this.lockH += a * (box.height - this.lockH);
      this.consecutiveRejects = 0;
      this.drift = false;
      this.preDriftW = 0;
      this.preDriftH = 0;
      this.clearCluster();
      this.refreshGeometry();
      return;
    }

    // Reject.
    this.consecutiveRejects++;
    if (this.consecutiveRejects >= DRIFT_REJECT_COUNT && !this.drift) {
      this.drift = true;
      // Capture the size of the rim we just lost, once, for the re-lock
      // sanity check below.
      this.preDriftW = this.lockW;
      this.preDriftH = this.lockH;
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
    this.drift = false;
    this.preDriftW = 0;
    this.preDriftH = 0;
    // The lock IS the cluster mean now — any accumulated offset EMA is stale.
    this.offEmaX = 0;
    this.offEmaY = 0;
    this.settleBoost = false;
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
