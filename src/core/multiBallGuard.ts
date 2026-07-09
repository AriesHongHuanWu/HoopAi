/**
 * Multi-ball warmup guard (D15-lite).
 *
 * During warmups several balls fly at the hoop at once and the FSM can arm on
 * the wrong one, minting phantom attempts. This guard watches how many
 * CONFIDENT 'ball' detections the pipeline saw in each frame (counted by the
 * caller at the cold-gate score, DETECTION.ballScoreMin, so faint noise can
 * never trigger it) and raises a lockout while the scene is multi-ball.
 *
 * IRON RULE — SUPPRESSION-ONLY: the lockout can only PREVENT the FSM from
 * arming a NEW attempt (via FsmFrameInput.armLockout → canArm returns null).
 * It can never create, upgrade, or otherwise influence a call, and it never
 * touches a shot that is already live. The FSM's pre-arm buffer keeps filling
 * under lockout, so when the scene clears mid-flight of a real shot the
 * descend path still retro-arms and recall recovers immediately.
 *
 * Pure TypeScript, no I/O; time comes in via the `t` parameter.
 */

export const MULTI_BALL = {
  /** Confident 'ball' detections in one frame to count as a multi-ball sighting. */
  minBalls: 2,
  /** Sightings within windowSec required to enter lockout (one noisy frame never locks). */
  confirmSightings: 2,
  /** Sighting window, seconds (time-based — fps-proof, no scaleFrameGate needed). */
  windowSec: 1.0,
  /** Continuous seconds with < minBalls confident balls before lockout clears. */
  clearSec: 1.5,
} as const;

/**
 * Ring capacity for recent sighting timestamps. Only confirmSightings within
 * windowSec matter, so a small fixed ring suffices and keeps step() free of
 * per-frame allocation. Must be >= confirmSightings.
 */
const RING_LEN = 4;

export class MultiBallGuard {
  /** Recent multi-ball sighting timestamps (−Infinity = empty slot). */
  private readonly ring: number[] = new Array<number>(RING_LEN).fill(
    Number.NEGATIVE_INFINITY,
  );
  private ringIdx = 0;
  /** Time of the most recent multi-ball frame (−Infinity = never seen). */
  private lastMultiT = Number.NEGATIVE_INFINITY;
  /** Time of the last accepted step (for non-monotonic input defense). */
  private lastT = Number.NEGATIVE_INFINITY;
  private locked = false;

  /** Current lockout state (same value step() last returned). */
  get lockout(): boolean {
    return this.locked;
  }

  /**
   * Feed one frame; count = confident ball detections (score >=
   * DETECTION.ballScoreMin, counted by the caller). Returns the lockout state
   * AFTER this frame.
   */
  step(confidentBallCount: number, t: number): boolean {
    // Defensive: ignore duplicate/backwards/invalid timestamps outright — a
    // rewound or repeated clock must never corrupt the window math or throw.
    if (!Number.isFinite(t) || t <= this.lastT) return this.locked;
    this.lastT = t;
    // Clear BEFORE recording this frame's sighting: after clearSec of quiet,
    // a sighting arriving on this very frame starts a FRESH confirmation
    // window instead of silently extending a lockout that already lapsed.
    if (this.locked && t - this.lastMultiT >= MULTI_BALL.clearSec) {
      this.locked = false;
    }
    if (confidentBallCount >= MULTI_BALL.minBalls) {
      this.ring[this.ringIdx] = t;
      this.ringIdx = (this.ringIdx + 1) % RING_LEN;
      this.lastMultiT = t;
      // Sightings inside (t − windowSec, t]. Steps are monotonic, so no ring
      // entry can exceed t and only the lower bound needs checking; empty
      // slots are −Infinity and can never pass it.
      let n = 0;
      for (let i = 0; i < RING_LEN; i++) {
        if (this.ring[i] > t - MULTI_BALL.windowSec) n++;
      }
      if (n >= MULTI_BALL.confirmSightings) this.locked = true;
    }
    return this.locked;
  }

  reset(): void {
    for (let i = 0; i < RING_LEN; i++) {
      this.ring[i] = Number.NEGATIVE_INFINITY;
    }
    this.ringIdx = 0;
    this.lastMultiT = Number.NEGATIVE_INFINITY;
    this.lastT = Number.NEGATIVE_INFINITY;
    this.locked = false;
  }
}
