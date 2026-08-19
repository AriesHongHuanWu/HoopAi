/**
 * Form similarity (v2) — a style match, never a quality score.
 *
 * Lives in its OWN core file: postureFix.ts is a frozen v1 core module, and
 * new form-check math ships as new pure core files. The measurement helpers
 * below are MIRRORED from postureFix's module-private implementations
 * (documented mirror — the formCheck.ts idiom for FormAnalyzer/formSequence
 * privates) so the similarity number reads the exact same 8 measurements
 * posturePlan compares, sampled at the same phase timeline, without exporting
 * postureFix's internals. Keep them in lockstep with postureFix.ts; the
 * exact-score pins in src/__tests__/core/formSimilarity.test.ts (including
 * the reference-matches-itself-at-100 integration) fail on drift.
 *
 * Pure + deterministic. No I/O.
 */
import { angleAtDeg } from './geometry';
import type { DecodedFrame } from './formSequence';
import type { FixPhase } from './postureFix';
import type { PoseKeypointName, ShootingHand } from './types';

// ---------------------------------------------------------------------------
// Phase sampling + per-rule measurements — MIRRORED from postureFix (private
// there). Same fractions, same nearest-frame rounding, same null-abstains.
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

/** Per-unit deviation normalizers — MIRRORED from postureFix's rule engine. */
const DEG_NORM = 25; // one "unit" of angle deviation, degrees
const LEN_NORM = 0.12; // one "unit" of length deviation, body-heights

// ---------------------------------------------------------------------------
// Form similarity
// ---------------------------------------------------------------------------

/** Rules a similarity score can draw on (posturePlan's exact 8 measurements). */
const SIMILARITY_TOTAL_RULES = 8;

/** Minimum measured rules before a similarity score exists at all. */
const SIMILARITY_MIN_RULES = 5;

export interface FormSimilarity {
  /** 0..100 — how closely the measured angles/offsets match the reference. */
  score: number;
  /** How many of the 8 rules had BOTH sides measurable. */
  measuredRules: number;
  totalRules: 8;
}

/**
 * Whole-motion similarity between a user's motion and a reference motion:
 * the SAME 8 measurements postureFix.posturePlan compares (elbow@DIP,
 * knee@DIP, elbow@RELEASE, elbow@FOLLOW, shoulderTilt@SET, hipY@DIP,
 * elbowUnderBall@SET, wristY@RELEASE), sampled at the same PHASE_FRAC
 * timeline. Each rule contributes a normalized deviation capped at 1
 * (degrees / DEG_NORM, body-heights / LEN_NORM — no deadband: similarity
 * measures everything, the deadband only gates cue-worthiness);
 * score = round(100 · (1 − mean deviation)).
 *
 * HONESTY: the number is a STYLE MATCH against a SYNTHESIZED reference —
 * the UI must label it that way, never as a skill score. It refuses (null)
 * when fewer than {@link SIMILARITY_MIN_RULES} rules had both sides
 * measurable — too few joints seen is "unmeasured", not "0/100".
 *
 * Both sequences must be in the normalized body-relative frame; `hand` is
 * the user's shooting hand and the reference must be generated for the same
 * hand (referenceSequence(archetype, hand)).
 */
export function formSimilarity(
  userSeq: readonly DecodedFrame[],
  refSeq: readonly DecodedFrame[],
  hand: ShootingHand,
): FormSimilarity | null {
  const uDip = frameAt(userSeq, 'DIP');
  const rDip = frameAt(refSeq, 'DIP');
  const uSet = frameAt(userSeq, 'SET');
  const rSet = frameAt(refSeq, 'SET');
  const uRel = frameAt(userSeq, 'RELEASE');
  const rRel = frameAt(refSeq, 'RELEASE');
  const uFol = frameAt(userSeq, 'FOLLOW');
  const rFol = frameAt(refSeq, 'FOLLOW');

  const relWristY = (f: DecodedFrame | null): number | null => {
    if (!f) return null;
    const w = f[names(hand).wrist];
    return w ? w.y : null;
  };

  const rules: { u: number | null; r: number | null; norm: number }[] = [
    { u: elbowAngle(uDip, hand), r: elbowAngle(rDip, hand), norm: DEG_NORM },
    { u: kneeAngle(uDip, hand), r: kneeAngle(rDip, hand), norm: DEG_NORM },
    { u: elbowAngle(uRel, hand), r: elbowAngle(rRel, hand), norm: DEG_NORM },
    { u: elbowAngle(uFol, hand), r: elbowAngle(rFol, hand), norm: DEG_NORM },
    {
      u: shoulderTiltDeg(uSet, hand),
      r: shoulderTiltDeg(rSet, hand),
      norm: DEG_NORM,
    },
    { u: hipY(uDip), r: hipY(rDip), norm: LEN_NORM },
    {
      u: elbowUnderBallOffset(uSet, hand),
      r: elbowUnderBallOffset(rSet, hand),
      norm: LEN_NORM,
    },
    { u: relWristY(uRel), r: relWristY(rRel), norm: LEN_NORM },
  ];

  const devs: number[] = [];
  for (const rule of rules) {
    if (rule.u == null || rule.r == null) continue;
    devs.push(Math.min(Math.abs(rule.u - rule.r) / rule.norm, 1));
  }
  if (devs.length < SIMILARITY_MIN_RULES) return null;
  let mean = 0;
  for (const d of devs) mean += d;
  mean /= devs.length;
  return {
    score: Math.round(100 * (1 - mean)),
    measuredRules: devs.length,
    totalRules: SIMILARITY_TOTAL_RULES,
  };
}
