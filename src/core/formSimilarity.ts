/**
 * Form similarity (v2) — a style match, never a quality score.
 *
 * Lives in its OWN core file: postureFix.ts is a frozen v1 core module, and
 * new form-check math ships as new pure core files. The measurement helpers
 * below are MIRRORED from postureFix's module-private implementations
 * (documented mirror — the formCheck.ts idiom for FormAnalyzer/formSequence
 * privates) so the similarity number reads the exact same 6 measurements
 * posturePlan compares, sampled at the same phase timeline, without exporting
 * postureFix's internals. Keep them in lockstep with postureFix.ts; the
 * exact-score pins in src/__tests__/core/formSimilarity.test.ts (including
 * the reference-matches-itself-at-100 integration) fail on drift.
 *
 * Viewpoint honesty: a rule only counts if it survives the SIDE profile Form
 * Check asks for and does not change sign with which wing the phone is on.
 * Dip depth and shoulder tilt failed both tests and were removed, not scored;
 * the arm-line rule abstains when the shooter's facing cannot be read.
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

/**
 * Apparent shoulder x-separation, in body-heights, below which the shooter's
 * facing is UNKNOWN. MIRRORED from postureFix.
 */
const FACING_MIN_SHOULDER_DX = 0.06;

/**
 * Which way the shooter faces, as the sign of their own shoulder axis
 * (right − left) in image x. Null when the shoulders are too close in x to
 * tell — at that point the sign is noise, not facing. MIRRORED from postureFix.
 */
function facingSign(frame: DecodedFrame): -1 | 1 | null {
  const l = frame.left_shoulder;
  const r = frame.right_shoulder;
  if (!l || !r) return null;
  const dx = r.x - l.x;
  if (Math.abs(dx) < FACING_MIN_SHOULDER_DX) return null;
  return dx < 0 ? -1 : 1;
}

/**
 * Horizontal offset of the elbow from the wrist at a phase (arm-line proxy),
 * signed by the shooter's OWN facing so the same flare reads the same from
 * either wing; abstains when facing cannot be established. MIRRORED from
 * postureFix.
 */
function elbowUnderBallOffset(frame: DecodedFrame | null, hand: ShootingHand): number | null {
  if (!frame) return null;
  const n = names(hand);
  const e = frame[n.elbow];
  const w = frame[n.wrist];
  if (!e || !w) return null;
  const sign = facingSign(frame);
  if (sign == null) return null;
  return sign * (e.x - w.x);
}

/** Per-unit deviation normalizers — MIRRORED from postureFix's rule engine. */
const DEG_NORM = 25; // one "unit" of angle deviation, degrees
const LEN_NORM = 0.12; // one "unit" of length deviation, body-heights

// ---------------------------------------------------------------------------
// Form similarity
// ---------------------------------------------------------------------------

/** Rules a similarity score can draw on (posturePlan's exact 6 measurements). */
const SIMILARITY_TOTAL_RULES = 6;

/**
 * Minimum measured rules before a similarity score exists at all. Four, so a
 * side-on rep still scores on the viewpoint-robust core (three elbow angles
 * plus the knee) after the arm-line rule abstains for want of a facing.
 */
const SIMILARITY_MIN_RULES = 4;

export interface FormSimilarity {
  /** 0..100 — how closely the measured angles/offsets match the reference. */
  score: number;
  /** How many of the 6 rules had BOTH sides measurable. */
  measuredRules: number;
  totalRules: 6;
}

/**
 * Whole-motion similarity between a user's motion and a reference motion:
 * the SAME 6 measurements postureFix.posturePlan compares (elbow@DIP,
 * knee@DIP, elbow@RELEASE, elbow@FOLLOW, elbowUnderBall@SET,
 * wristY@RELEASE), sampled at the same PHASE_FRAC
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
    // shoulderTilt@SET and hipY@DIP are absent on purpose — see the module
    // header and postureFix's matching block. Neither is measurable from the
    // viewpoint this pipeline captures, so neither may move the score.
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
