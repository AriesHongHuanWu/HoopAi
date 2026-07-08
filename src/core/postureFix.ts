/**
 * Posture-correction engine for Form Studio.
 *
 * Given the user's captured motion (a decoded {@link FormSequence}) and a
 * chosen NBA reference motion (from src/core/nbaReferenceForms.ts), both in the
 * SAME normalized body-relative frame, this computes frame-aligned joint-angle
 * (and posture) differences at the shot's key phases and turns the notable ones
 * into RANKED, plain-language correction cues, each with a concrete drill.
 *
 * Frame alignment: both sequences are resampled to a shared phase timeline
 * (dip / set / release / follow), so a fast one-motion release is compared
 * against the same phase of the user's motion, not the same wall-clock instant.
 *
 * Pure + deterministic. ~8 rules; returns them ranked worst-first.
 */
import { angleAtDeg } from './geometry';
import type { DecodedFrame } from './formSequence';
import type { PoseKeypointName, ShootingHand } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which phase a cue is measured at (for the phase label on the card). */
export type FixPhase = 'DIP' | 'SET' | 'RELEASE' | 'FOLLOW';

export interface PostureCue {
  /** Stable rule id (for keys/tests). */
  id: string;
  /** Joint / posture aspect being compared. */
  joint: string;
  phase: FixPhase;
  /** Signed user − reference difference in the rule's native unit (degrees, or
   *  body-heights for depth/offset rules). */
  diff: number;
  /** Absolute magnitude used for ranking (normalized across rule units). */
  severity: number;
  /** Short imperative headline. */
  cue: string;
  /** A concrete drill to fix it. */
  drill: string;
}

// ---------------------------------------------------------------------------
// Phase sampling
// ---------------------------------------------------------------------------

/** Named phase positions as fractions through a normalized motion [0..1]. */
const PHASE_FRAC: Record<FixPhase, number> = {
  DIP: 0.25,
  SET: 0.6,
  RELEASE: 0.75,
  FOLLOW: 0.95,
};

/** Nearest frame to a phase fraction in a sequence of `n` frames. */
function phaseIndex(n: number, frac: number): number {
  if (n <= 1) return 0;
  return Math.min(n - 1, Math.max(0, Math.round(frac * (n - 1))));
}

/** Frame at a phase in a decoded sequence (nearest), or null when empty. */
function frameAt(seq: readonly DecodedFrame[], phase: FixPhase): DecodedFrame | null {
  if (seq.length === 0) return null;
  return seq[phaseIndex(seq.length, PHASE_FRAC[phase])] ?? null;
}

function names(hand: ShootingHand) {
  const s = hand === 'right' ? 'right' : 'left';
  return {
    shoulder: `${s}_shoulder` as PoseKeypointName,
    elbow: `${s}_elbow` as PoseKeypointName,
    wrist: `${s}_wrist` as PoseKeypointName,
    hip: `${s}_hip` as PoseKeypointName,
    knee: `${s}_knee` as PoseKeypointName,
    ankle: `${s}_ankle` as PoseKeypointName,
    lShoulder: 'left_shoulder' as PoseKeypointName,
    rShoulder: 'right_shoulder' as PoseKeypointName,
    lHip: 'left_hip' as PoseKeypointName,
    rHip: 'right_hip' as PoseKeypointName,
  };
}

/** Elbow angle shoulder-elbow-wrist at a phase, or null if any joint missing. */
function elbowAngle(frame: DecodedFrame | null, hand: ShootingHand): number | null {
  if (!frame) return null;
  const n = names(hand);
  const s = frame[n.shoulder];
  const e = frame[n.elbow];
  const w = frame[n.wrist];
  if (!s || !e || !w) return null;
  return angleAtDeg(s, e, w);
}

/** Knee angle hip-knee-ankle at a phase, or null if any joint missing. */
function kneeAngle(frame: DecodedFrame | null, hand: ShootingHand): number | null {
  if (!frame) return null;
  const n = names(hand);
  const h = frame[n.hip];
  const k = frame[n.knee];
  const a = frame[n.ankle];
  if (!h || !k || !a) return null;
  return angleAtDeg(h, k, a);
}

/** Shoulder-line tilt from horizontal (deg), signed. Null if a shoulder is missing. */
function shoulderTiltDeg(frame: DecodedFrame | null, hand: ShootingHand): number | null {
  if (!frame) return null;
  const n = names(hand);
  const l = frame[n.lShoulder];
  const r = frame[n.rShoulder];
  if (!l || !r) return null;
  return (Math.atan2(r.y - l.y, r.x - l.x) * 180) / Math.PI;
}

/** Hip-center y at a phase (depth proxy; +y down = lower). Null if no hip. */
function hipY(frame: DecodedFrame | null): number | null {
  if (!frame) return null;
  const l = frame.left_hip;
  const r = frame.right_hip;
  if (l && r) return (l.y + r.y) / 2;
  return l?.y ?? r?.y ?? null;
}

/** Signed horizontal offset of elbow from wrist at a phase (arm-line proxy). */
function elbowUnderBallOffset(frame: DecodedFrame | null, hand: ShootingHand): number | null {
  if (!frame) return null;
  const n = names(hand);
  const e = frame[n.elbow];
  const w = frame[n.wrist];
  if (!e || !w) return null;
  return e.x - w.x;
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

/** Per-unit severity normalizers so degree rules and length rules rank fairly. */
const DEG_DEADBAND = 8; // ignore angle diffs under this (pose noise floor)
const DEG_NORM = 25; // one "unit" of angle severity
const LEN_DEADBAND = 0.05; // body-heights
const LEN_NORM = 0.12;

interface RuleResult {
  diff: number;
  severity: number;
}

function degRule(user: number | null, ref: number | null): RuleResult | null {
  if (user == null || ref == null) return null;
  const diff = user - ref;
  if (Math.abs(diff) < DEG_DEADBAND) return null;
  return { diff, severity: Math.abs(diff) / DEG_NORM };
}

function lenRule(user: number | null, ref: number | null): RuleResult | null {
  if (user == null || ref == null) return null;
  const diff = user - ref;
  if (Math.abs(diff) < LEN_DEADBAND) return null;
  return { diff, severity: Math.abs(diff) / LEN_NORM };
}

/**
 * Compare the user's motion to a reference motion and return ranked posture
 * cues (worst first). `maxCues` caps the list (default 4 — one-cue-at-a-time
 * coaching, with a couple of secondaries).
 *
 * Both sequences must be in the normalized body-relative frame. `hand` is the
 * user's shooting hand; the reference is assumed generated for the same hand.
 */
export function posturePlan(
  userSeq: readonly DecodedFrame[],
  refSeq: readonly DecodedFrame[],
  hand: ShootingHand,
  maxCues = 4,
): PostureCue[] {
  const cues: PostureCue[] = [];
  const push = (
    id: string,
    joint: string,
    phase: FixPhase,
    r: RuleResult | null,
    lowCue: string,
    highCue: string,
    lowDrill: string,
    highDrill: string,
  ) => {
    if (!r) return;
    const low = r.diff < 0;
    cues.push({
      id,
      joint,
      phase,
      diff: r.diff,
      severity: r.severity,
      cue: low ? lowCue : highCue,
      drill: low ? lowDrill : highDrill,
    });
  };

  const uDip = frameAt(userSeq, 'DIP');
  const rDip = frameAt(refSeq, 'DIP');
  const uSet = frameAt(userSeq, 'SET');
  const rSet = frameAt(refSeq, 'SET');
  const uRel = frameAt(userSeq, 'RELEASE');
  const rRel = frameAt(refSeq, 'RELEASE');
  const uFol = frameAt(userSeq, 'FOLLOW');
  const rFol = frameAt(refSeq, 'FOLLOW');

  // 1. Elbow set-point angle at the dip (the L).
  push(
    'elbow_dip',
    'Set-point elbow',
    'DIP',
    degRule(elbowAngle(uDip, hand), elbowAngle(rDip, hand)),
    'Your elbow is more closed than the reference at the dip — open it toward a 90° L before you rise.',
    'Your elbow opens too early at the dip — keep a tighter L so the ball loads under it.',
    'Mirror reps: pause at the dip, check the shooting elbow makes a clean L, then finish. 20 slow reps.',
    'Wall-form shooting: shoot up a wall from 1 ft away — a too-open elbow throws the ball into the wall, forcing the tuck.',
  );

  // 2. Knee bend at the dip (leg load).
  push(
    'knee_dip',
    'Knee bend',
    'DIP',
    degRule(kneeAngle(uDip, hand), kneeAngle(rDip, hand)),
    'You sink deeper than the reference — a shallower, quicker load keeps the shot on rhythm.',
    'Your legs stay straighter than the reference — bend the knees to drive power from the ground.',
    'Metronome dips: load to a set depth on the beat, hold half a second, rise. 3×10.',
    'Chair-rise shooting: start seated on a chair edge, rise and shoot in one motion so the legs drive the ball. 3×10.',
  );

  // 3. Release elbow extension.
  push(
    'elbow_release',
    'Release extension',
    'RELEASE',
    degRule(elbowAngle(uRel, hand), elbowAngle(rRel, hand)),
    'You release with a bent arm — reach full extension so the wrist, not the elbow, finishes the shot.',
    'You over-extend past the reference — a relaxed full reach beats a locked, jammed one.',
    'Reach-and-hold: shoot, then freeze with the arm fully extended toward the rim until the ball lands. Every rep.',
    'Soft-finish reps: exaggerate a loose gooseneck finish so the arm extends without locking. 3×15.',
  );

  // 4. Follow-through hold (arm still extended at the follow phase).
  push(
    'follow_hold',
    'Follow-through',
    'FOLLOW',
    degRule(elbowAngle(uFol, hand), elbowAngle(rFol, hand)),
    'Your arm has already collapsed by the follow-through — hold the finish until the ball hits the rim.',
    'Your follow-through arm sits stiffer than the reference — let it relax into the gooseneck.',
    'Freeze the finish: hold the follow-through until the ball hits the floor, every rep, for one session.',
    'Relaxed-wrist reps: finish with a floppy "reaching into the cookie jar" wrist snap. 3×15.',
  );

  // 5. Shoulder alignment (level shoulders at the set point).
  push(
    'shoulder_set',
    'Shoulder alignment',
    'SET',
    degRule(shoulderTiltDeg(uSet, hand), shoulderTiltDeg(rSet, hand)),
    'Your shoulders tilt more than the reference at the set point — level them so the shot goes straight up.',
    'Your shoulders tilt more than the reference at the set point — level them so the shot goes straight up.',
    'Square-up drill: film from the front, freeze at the set point, and level a broomstick across the shoulders. 20 reps.',
    'Square-up drill: film from the front, freeze at the set point, and level a broomstick across the shoulders. 20 reps.',
  );

  // 6. Dip depth (hip height at the dip vs reference).
  push(
    'dip_depth',
    'Dip depth',
    'DIP',
    lenRule(hipY(uDip), hipY(rDip)),
    'Your dip is shallower than the reference — a slightly deeper gather adds rhythm and power.',
    'You dip lower than the reference — a shallower dip quickens the release against closeouts.',
    'Depth-target dips: mark a wall height for your hips, load to it, and rise. 3×12.',
    'Quick-dip catches: on the catch, load only halfway and fire — trains a compact, fast gather. 3×10.',
  );

  // 7. Arm line at set (elbow under the wrist/ball).
  push(
    'arm_line_set',
    'Arm line',
    'SET',
    lenRule(
      elbowUnderBallOffset(uSet, hand),
      elbowUnderBallOffset(rSet, hand),
    ),
    'Your shooting elbow drifts inside the wrist at the set point — stack it under the ball for a straighter line.',
    'Your shooting elbow flares outside the wrist at the set point — bring it under the ball for a straighter line.',
    'One-hand form shots from 3 ft: only makes with the elbow tracking under the ball count. 3×15.',
    'Elbow-in reps: shoot with a towel lightly pinned at the ribcage on the shooting side to stop the flare. 3×15.',
  );

  // 8. Release wrist height (release point vs reference).
  const relWristY = (f: DecodedFrame | null): number | null => {
    if (!f) return null;
    const w = f[names(hand).wrist];
    return w ? w.y : null;
  };
  push(
    'release_height',
    'Release height',
    'RELEASE',
    lenRule(relWristY(uRel), relWristY(rRel)),
    'You release higher than the reference — fine if it repeats, but a lower, quicker set can beat the clock.',
    'You release lower than the reference — raise the release point so it clears a contest.',
    'Consistency reps: lock ONE release height and groove 50 makes from a single spot before moving.',
    'Wall-reach reps: mark your one-hand reach on a wall and release above that mark 20 times in a row.',
  );

  cues.sort((a, b) => b.severity - a.severity);
  return cues.slice(0, maxCues);
}
