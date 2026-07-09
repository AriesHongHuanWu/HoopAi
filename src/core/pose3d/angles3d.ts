/**
 * 3D joint-angle readouts + release-frame detection for Form Studio 3D.
 *
 * Operates on the anthropometric lift output ({@link LiftedSequence},
 * src/core/pose3d/lift.ts — +x right, +y DOWN, +z toward camera, body-height
 * units). Every reading carries the MINIMUM confidence of its contributing
 * joints so the UI can honestly dim/qualify estimates built on shaky depth.
 *
 * IMPORTANT (honesty): COCO-17 has NO hand keypoints, so true wrist flexion
 * cannot be measured from this data. This module intentionally exposes
 * FOREARM TILT (elbow→wrist vs world vertical) as the closest honest proxy,
 * and the UI must label it "FOREARM TILT", never "wrist angle". Readings are
 * never invented when joints are missing: null means null.
 *
 * Release detection is DELIBERATELY 2D and lift-independent: it reads the raw
 * decoded sequence, so the picked frame is deterministic and unaffected by
 * depth estimation.
 *
 * Pure TypeScript: no I/O, no wall clock, no randomness.
 */
import type { DecodedFrame } from '../formSequence';
import type { PoseKeypointName, ShootingHand } from '../types';
import type { Frame3D, Joint3D, LiftedSequence } from './lift';

/** Rays shorter than this (body heights) have no meaningful direction. */
const MIN_RAY_LEN = 1e-6;

/** One angle estimate; `c` = min confidence of contributing joints, 0..1. */
export interface AngleReading {
  deg: number;
  c: number;
}

/** Shooting-side joint names for the elbow/knee triples + forearm segment. */
function sideJoints(hand: ShootingHand): {
  shoulder: PoseKeypointName;
  elbow: PoseKeypointName;
  wrist: PoseKeypointName;
  hip: PoseKeypointName;
  knee: PoseKeypointName;
  ankle: PoseKeypointName;
} {
  return hand === 'right'
    ? {
        shoulder: 'right_shoulder',
        elbow: 'right_elbow',
        wrist: 'right_wrist',
        hip: 'right_hip',
        knee: 'right_knee',
        ankle: 'right_ankle',
      }
    : {
        shoulder: 'left_shoulder',
        elbow: 'left_elbow',
        wrist: 'left_wrist',
        hip: 'left_hip',
        knee: 'left_knee',
        ankle: 'left_ankle',
      };
}

/**
 * 3D angle at vertex `b` between rays b→a and b→c, in degrees 0..180.
 * Returns null if any joint is missing or either ray is degenerate
 * (length < 1e-6). `reading.c = min(a.c, b.c, c.c)`.
 */
export function jointAngleDeg(
  a: Joint3D | undefined,
  b: Joint3D | undefined,
  c: Joint3D | undefined
): AngleReading | null {
  if (!a || !b || !c) return null;
  const ux = a.x - b.x;
  const uy = a.y - b.y;
  const uz = a.z - b.z;
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  const vz = c.z - b.z;
  const lu = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const lv = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (lu < MIN_RAY_LEN || lv < MIN_RAY_LEN) return null;
  // Clamp the cosine so float drift at |cos|≈1 never produces acos(NaN).
  const cos = Math.min(1, Math.max(-1, (ux * vx + uy * vy + uz * vz) / (lu * lv)));
  return {
    deg: (Math.acos(cos) * 180) / Math.PI,
    c: Math.min(a.c, b.c, c.c),
  };
}

/**
 * Angle between the shooting-side elbow→wrist vector and world UP, degrees.
 * World up is (0, -1, 0) because +y points DOWN. 0° = forearm points straight
 * up, 90° = horizontal. `c = min(elbow.c, wrist.c)`. Null if either joint is
 * missing or the segment is degenerate.
 */
export function forearmTiltDeg(frame: Frame3D, hand: ShootingHand): AngleReading | null {
  const s = sideJoints(hand);
  const elbow = frame[s.elbow];
  const wrist = frame[s.wrist];
  if (!elbow || !wrist) return null;
  const vx = wrist.x - elbow.x;
  const vy = wrist.y - elbow.y;
  const vz = wrist.z - elbow.z;
  const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (len < MIN_RAY_LEN) return null;
  // dot(v, up) with up = (0,-1,0) reduces to -vy.
  const cos = Math.min(1, Math.max(-1, -vy / len));
  return {
    deg: (Math.acos(cos) * 180) / Math.PI,
    c: Math.min(elbow.c, wrist.c),
  };
}

/**
 * Index of the frame where the shooting-side wrist reaches its MINIMUM y
 * (+y is DOWN, so minimum y = highest point ≈ release). Ties resolve to the
 * earliest index. If the wrist is present in zero frames, falls back to
 * `round(0.75 · (n − 1))` (release sits ~3/4 through the captured motion).
 * Empty input returns 0.
 */
export function releaseFrameIndex(
  frames: readonly DecodedFrame[],
  hand: ShootingHand
): number {
  if (frames.length === 0) return 0;
  const wristName: PoseKeypointName = hand === 'right' ? 'right_wrist' : 'left_wrist';
  let bestIdx = -1;
  let bestY = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const wrist = frames[i]?.[wristName];
    if (wrist && wrist.y < bestY) {
      bestY = wrist.y;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return Math.round(0.75 * (frames.length - 1));
  return bestIdx;
}

/** Shooting-side elbow/knee angles for one lifted frame (live scrub readout). */
export function frameAngles(
  frame: Frame3D,
  hand: ShootingHand
): { elbow: AngleReading | null; knee: AngleReading | null } {
  const s = sideJoints(hand);
  return {
    elbow: jointAngleDeg(frame[s.shoulder], frame[s.elbow], frame[s.wrist]),
    knee: jointAngleDeg(frame[s.hip], frame[s.knee], frame[s.ankle]),
  };
}

/** Bundled at-release readouts for the Form Studio 3D readout card. */
export interface ReleaseReadouts {
  frame: number;
  elbow: AngleReading | null;
  knee: AngleReading | null;
  forearmTilt: AngleReading | null;
}

/**
 * Release-frame readouts: the frame is picked from the RAW 2D sequence
 * (deterministic, lift-independent), clamped into the lifted sequence, then
 * elbow/knee/forearm-tilt are measured on that lifted frame.
 */
export function releaseReadouts(
  lifted: LiftedSequence,
  raw2d: readonly DecodedFrame[],
  hand: ShootingHand
): ReleaseReadouts {
  const frame = Math.max(
    0,
    Math.min(releaseFrameIndex(raw2d, hand), lifted.frames.length - 1)
  );
  const frame3d = lifted.frames[frame];
  if (!frame3d) return { frame, elbow: null, knee: null, forearmTilt: null };
  const { elbow, knee } = frameAngles(frame3d, hand);
  return { frame, elbow, knee, forearmTilt: forearmTiltDeg(frame3d, hand) };
}
