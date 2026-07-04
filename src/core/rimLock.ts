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
 * 2. LOCKED — each accepted observation EMA-damps the box with RIM.lockAlpha.
 *    Observations displaced more than maxDriftDiagFactor·diag from the lock
 *    are rejected outright.
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
    void t;
    let best: Detection | null = null;
    const dets = frame.detections;
    for (let i = 0; i < dets.length; i++) {
      const d = dets[i];
      if (d.cls !== 'rim' || d.score < DETECTION.rimScoreMin) continue;
      if (best === null || d.score > best.score) best = d;
    }
    if (best !== null) this.observe(best.box, best.score);
    return this.locked ? this.geom : null;
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
   * User tap-adjust: overrides the rim box immediately and locks on it,
   * clearing any pending cluster and drift state.
   */
  setManual(box: Box): void {
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
    this.refreshGeometry();
  }

  /** Returns to the initial unlocked state. */
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
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Routes one accepted-class rim observation through the lock state. */
  private observe(box: Box, score: number): void {
    if (!this.locked) {
      this.feedCluster(box);
      if (this.clusterCount >= LOCK_CLUSTER_SIZE) this.lockAtClusterMean();
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
      this.feedCluster(box);
      if (this.clusterCount >= LOCK_CLUSTER_SIZE) {
        if (this.clusterSizeMatchesPreDrift()) this.lockAtClusterMean();
        else this.clearCluster();
      }
      return;
    }

    if (!displaced) {
      // Accept: EMA-damp the lock toward the observation.
      const a = RIM.lockAlpha;
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
      this.feedCluster(box);
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
  private feedCluster(box: Box): void {
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
    this.clusterSumX += box.x;
    this.clusterSumY += box.y;
    this.clusterSumW += box.width;
    this.clusterSumH += box.height;
    this.clusterCount++;
  }

  /** Locks (or re-locks) at the cluster mean and clears transient state. */
  private lockAtClusterMean(): void {
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
