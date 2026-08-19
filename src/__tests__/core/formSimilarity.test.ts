/**
 * formSimilarity — the v2 style-match number (src/core/formSimilarity.ts, a
 * NEW pure core file; postureFix.ts stays frozen v1 core).
 *
 * What these tests pin, and why:
 *  - An identical motion scores exactly 100 with all 8 rules measured — the
 *    same 8 measurements posturePlan compares, sampled at the same
 *    PHASE_FRAC timeline.
 *  - A KNOWN single-rule angle delta produces the exact documented score:
 *    deviation = |Δ| / 25° for degree rules, capped at 1;
 *    score = round(100 · (1 − mean over measured rules)).
 *  - Deviations cap at 1 — one wildly different joint can't drive the score
 *    negative.
 *  - The confidence gate: fewer than 5 measured rules ⇒ null ("too few
 *    joints seen"), NEVER a fabricated 0-or-anything score.
 *  - The number is computed from real measured angles only — it is a style
 *    match vs a synthesized reference, and the null path is how it refuses.
 */
import { PLAYER_ARCHETYPES } from '@/core/nbaBenchmarks';
import { referenceSequence } from '@/core/nbaReferenceForms';
import { formSimilarity } from '@/core/formSimilarity';
import type { DecodedFrame } from '@/core/formSequence';
import type { PoseKeypointName } from '@/core/types';

const N_FRAMES = 21; // phase indices: DIP 5, SET 12, RELEASE 15, FOLLOW 19
const SET_IDX = 12;
const REL_IDX = 15;

/** One synthetic normalized frame with every rule's joints defined. */
function fullFrame(): DecodedFrame {
  return {
    right_shoulder: { x: 0, y: -0.3 },
    left_shoulder: { x: -0.15, y: -0.3 },
    right_elbow: { x: 0, y: -0.1 },
    right_wrist: { x: 0.2, y: -0.1 },
    left_hip: { x: -0.05, y: 0 },
    right_hip: { x: 0.05, y: 0 },
    right_knee: { x: 0, y: 0.25 },
    right_ankle: { x: 0, y: 0.5 },
  };
}

function syntheticSeq(): DecodedFrame[] {
  return Array.from({ length: N_FRAMES }, () => fullFrame());
}

/** Deep-clone a decoded sequence so mutations don't leak between frames. */
function clone(seq: DecodedFrame[]): DecodedFrame[] {
  return seq.map((f) => {
    const out: DecodedFrame = {};
    for (const k of Object.keys(f) as PoseKeypointName[]) out[k] = { ...f[k]! };
    return out;
  });
}

describe('formSimilarity', () => {
  test('an identical motion scores exactly 100 with all 8 rules measured', () => {
    const ref = syntheticSeq();
    const sim = formSimilarity(clone(ref), ref, 'right');
    expect(sim).not.toBeNull();
    expect(sim!.score).toBe(100);
    expect(sim!.measuredRules).toBe(8);
    expect(sim!.totalRules).toBe(8);
  });

  test('a known 12.5° shoulder-tilt delta scores the exact documented value', () => {
    const ref = syntheticSeq();
    const user = clone(ref);
    // Rotate ONLY the left shoulder at the SET frame: shoulderTilt@SET is
    // the single rule that reads it, so exactly one deviation changes.
    // tilt = atan2(r.y − l.y, r.x − l.x); moving l.y by 0.15·tan(12.5°)
    // makes the tilt exactly −12.5° vs the reference's 0°.
    user[SET_IDX]!.left_shoulder!.y =
      -0.3 + 0.15 * Math.tan((12.5 * Math.PI) / 180);
    const sim = formSimilarity(user, ref, 'right');
    expect(sim).not.toBeNull();
    // dev = 12.5 / 25 = 0.5; mean over 8 rules = 0.0625 → round(93.75) = 94.
    expect(sim!.score).toBe(94);
    expect(sim!.measuredRules).toBe(8);
  });

  test('a huge single-rule delta caps its deviation at 1 (score floor 88 here)', () => {
    const ref = syntheticSeq();
    const user = clone(ref);
    // 45° tilt delta → raw dev 1.8, capped at 1 → round(100·(1 − 1/8)) = 88.
    user[SET_IDX]!.left_shoulder!.y = -0.3 + 0.15;
    const sim = formSimilarity(user, ref, 'right');
    expect(sim).not.toBeNull();
    expect(sim!.score).toBe(88);
  });

  test('fewer than 5 measured rules refuses with null — never a fake score', () => {
    const ref = syntheticSeq();
    // Arm-only user: measures elbow@DIP, elbow@FOLLOW, elbowUnderBall@SET,
    // elbow@RELEASE, wristY@RELEASE = exactly 5 → still scored…
    const armOnly: DecodedFrame[] = Array.from({ length: N_FRAMES }, () => ({
      right_shoulder: { x: 0, y: -0.3 },
      right_elbow: { x: 0, y: -0.1 },
      right_wrist: { x: 0.2, y: -0.1 },
    }));
    expect(formSimilarity(armOnly, ref, 'right')).not.toBeNull();
    // …but losing the wrist at the RELEASE frame kills elbow@RELEASE and
    // wristY@RELEASE too (3 measured) → null.
    const tooFew = clone(armOnly);
    delete tooFew[REL_IDX]!.right_wrist;
    expect(formSimilarity(tooFew, ref, 'right')).toBeNull();
  });

  test('an empty user sequence refuses with null', () => {
    expect(formSimilarity([], syntheticSeq(), 'right')).toBeNull();
  });

  test('a synthesized reference matches itself at 100 (integration)', () => {
    const archetype = PLAYER_ARCHETYPES[0]!;
    const ref = referenceSequence(archetype, 'right');
    const sim = formSimilarity(ref, ref, 'right');
    expect(sim).not.toBeNull();
    expect(sim!.score).toBe(100);
    expect(sim!.measuredRules).toBe(8);
  });

  test('two different archetype references score below 100, in range', () => {
    const a = referenceSequence(PLAYER_ARCHETYPES[0]!, 'right');
    const b = referenceSequence(PLAYER_ARCHETYPES[1]!, 'right');
    const sim = formSimilarity(a, b, 'right');
    expect(sim).not.toBeNull();
    expect(sim!.score).toBeGreaterThanOrEqual(0);
    expect(sim!.score).toBeLessThan(100);
  });

  test('works for the left hand on left-handed references', () => {
    const ref = referenceSequence(PLAYER_ARCHETYPES[0]!, 'left');
    const sim = formSimilarity(ref, ref, 'left');
    expect(sim).not.toBeNull();
    expect(sim!.score).toBe(100);
  });
});
