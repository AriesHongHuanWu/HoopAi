/**
 * ReleaseDetector — pose-gated shot-release detection.
 *
 * Watches the shooting-side wrist / elbow / shoulder keypoints (MoveNet
 * COCO-17, analysis-frame px, +y DOWN) and emits a {@link ReleaseEvent} when
 * the release SIGNATURE completes: within a trailing ~RELEASE.windowSec, the
 * wrist (a) sits above the shoulder, (b) snaps upward faster than
 * RELEASE.minUpwardWristVyFracPerSec (rising ⇒ vy < 0), and (c) the elbow
 * extends past RELEASE.minElbowExtensionDeg. Each condition may be satisfied
 * on a different frame — a real release is a fast sequence, not one pose —
 * but all three must be recent together. At most one event fires per
 * RELEASE.debounceSec.
 *
 * WHY: the shot FSM's ball-kinematic arm paths need the BALL detected at the
 * decisive moment, and a dark/small ball is routinely invisible exactly at
 * release. The shooter's body is a far larger detection target, so the
 * release MOTION is observable when the ball is not. The emitted event
 * carries the wrist position — where the ball physically was an instant ago
 * — which the tracker uses as a reacquisition prior and the FSM as a fourth,
 * guarded arm path (see RELEASE in config.ts for the full rationale).
 *
 * Landmarks are used RAW (no One-Euro filtering, unlike FormAnalyzer): the
 * velocity spike IS the signal, and a low-pass would blunt exactly the edge
 * we are looking for. Noise defense comes from the AND of three independent
 * conditions plus the co-occurrence window. Keypoints below
 * FORM.keypointScoreMin are treated as missing (same gate as FormAnalyzer;
 * the pose parser's own score floor already dropped the worst — see
 * src/ml/poseParser.ts), and any missing landmark simply leaves its
 * condition un-refreshed that frame — never a throw, never a stale emit.
 *
 * Pure TypeScript: no I/O, no wall clock — time comes exclusively from the
 * camera timestamps carried on each {@link PoseFrame}.
 */
import { FORM, RELEASE } from './config';
import { angleAtDeg } from './geometry';
import type {
  PoseFrame,
  PoseKeypoint,
  PoseKeypointName,
  ShootingHand,
} from './types';

/**
 * Max spacing between two wrist samples for a finite-difference velocity to
 * be meaningful. Past a few dropped frames the wrist may have gone down and
 * back up between samples, and a long-gap "velocity" (Δy over half a second)
 * says nothing about a snap. ~4 frames at 30 fps.
 */
const MAX_VY_GAP_SEC = 0.15;

/** A fired release event (all analysis-frame px / camera seconds). */
export interface ReleaseEvent {
  /** Camera time of the frame that completed the release signature. */
  t: number;
  /** Shooting-hand wrist position on that frame — the ball's launch locus. */
  wristX: number;
  wristY: number;
}

/**
 * Streaming detector; one instance per session. Feed every pose frame in
 * timestamp order via {@link ReleaseDetector.push}; it returns the event
 * exactly on the frame the signature completes, else null.
 */
export class ReleaseDetector {
  private readonly hand: ShootingHand;
  private readonly frameHeight: number;

  /** Last VALID wrist sample (for the finite-difference vy). */
  private lastWrist: { x: number; y: number; t: number } | null = null;

  // Most recent time each signature condition held (-Infinity = never).
  private aboveShoulderT = -Infinity;
  private vySpikeT = -Infinity;
  private elbowExtendedT = -Infinity;

  /** Time of the last emitted event (debounce). */
  private lastEmitT = -Infinity;

  /**
   * @param opts.hand        Shooting hand from Settings (mirrors FormAnalyzer:
   *                         handedness picks which COCO side is watched).
   * @param opts.frameHeight Analysis-frame height in px — converts the
   *                         scale-free vy threshold into px/s.
   */
  constructor(opts: { hand: ShootingHand; frameHeight: number }) {
    this.hand = opts.hand;
    this.frameHeight = opts.frameHeight;
  }

  /**
   * Feed one pose frame (camera-timestamp order). Returns the release event
   * exactly on the completing frame, otherwise null.
   */
  push(pose: PoseFrame): ReleaseEvent | null {
    const t = pose.t;
    const side = this.hand;
    const wrist = this.keypoint(pose, `${side}_wrist` as PoseKeypointName);
    const elbow = this.keypoint(pose, `${side}_elbow` as PoseKeypointName);
    const shoulder = this.keypoint(
      pose,
      `${side}_shoulder` as PoseKeypointName,
    );

    // (b) Upward velocity spike: finite difference between CONSECUTIVE valid
    // wrist samples only — a long detection gap makes Δy/Δt meaningless.
    if (wrist !== null) {
      const prev = this.lastWrist;
      if (prev !== null && t > prev.t && t - prev.t <= MAX_VY_GAP_SEC) {
        const vy = (wrist.y - prev.y) / (t - prev.t); // +y down: rising < 0
        if (vy <= -RELEASE.minUpwardWristVyFracPerSec * this.frameHeight) {
          this.vySpikeT = t;
        }
      }
      this.lastWrist = { x: wrist.x, y: wrist.y, t };
    }

    // (a) Wrist above the shoulder (strictly: smaller y = higher).
    if (wrist !== null && shoulder !== null && wrist.y < shoulder.y) {
      this.aboveShoulderT = t;
    }

    // (c) Elbow extended past the release threshold.
    if (wrist !== null && elbow !== null && shoulder !== null) {
      const deg = angleAtDeg(shoulder, elbow, wrist);
      if (deg !== null && deg >= RELEASE.minElbowExtensionDeg) {
        this.elbowExtendedT = t;
      }
    }

    // Fire when all three conditions co-occurred within the window. The
    // event needs a wrist THIS frame (its position is the payload the
    // tracker seeds from) — with the wrist missing, the conditions can't
    // have refreshed this frame anyway, so nothing is lost by waiting.
    const horizon = t - RELEASE.windowSec;
    if (
      wrist !== null &&
      this.aboveShoulderT >= horizon &&
      this.vySpikeT >= horizon &&
      this.elbowExtendedT >= horizon &&
      t - this.lastEmitT >= RELEASE.debounceSec
    ) {
      this.lastEmitT = t;
      return { t, wristX: wrist.x, wristY: wrist.y };
    }
    return null;
  }

  /** Clear all state (new session); the debounce forgets past events too. */
  reset(): void {
    this.lastWrist = null;
    this.aboveShoulderT = -Infinity;
    this.vySpikeT = -Infinity;
    this.elbowExtendedT = -Infinity;
    this.lastEmitT = -Infinity;
  }

  /** Score-gated keypoint lookup (below FORM.keypointScoreMin = missing). */
  private keypoint(
    pose: PoseFrame,
    name: PoseKeypointName,
  ): PoseKeypoint | null {
    const raw = pose.keypoints[name];
    if (!raw || raw.score < FORM.keypointScoreMin) return null;
    return raw;
  }
}
