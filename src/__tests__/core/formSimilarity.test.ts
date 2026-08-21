/**
 * formSimilarity — the v2 style-match number (src/core/formSimilarity.ts, a
 * NEW pure core file; postureFix.ts stays frozen v1 core).
 *
 * RE-PINNED for the six-rule engine. The old pins were written against eight
 * rules, two of which could not measure the shooter from the viewpoint this
 * pipeline captures: dip depth read a hip line formSequence pins to the origin
 * (so it scored the ARCHETYPE's dip, not the user's), and shoulder tilt was
 * atan2 across two near-coincident shoulders, sign set by the camera side.
 * Both are gone, so every mean-over-rules divisor moved 8 → 6 and every exact
 * score with it. The shoulder-tilt fixtures those pins were built on could no
 * longer move the score at all, so the single-rule deltas are now driven
 * through the shooting elbow at the DIP frame — a rule that survives.
 *
 * What these tests pin, and why:
 *  - An identical motion scores exactly 100 with all 6 rules measured — the
 *    same 6 measurements posturePlan compares, sampled at the same
 *    PHASE_FRAC timeline.
 *  - A KNOWN single-rule angle delta produces the exact documented score:
 *    deviation = |Δ| / 25° for degree rules, capped at 1;
 *    score = round(100 · (1 − mean over measured rules)).
 *  - Deviations cap at 1 — one wildly different joint can't drive the score
 *    negative.
 *  - The confidence gate: fewer than 4 measured rules ⇒ null ("too few
 *    joints seen"), NEVER a fabricated 0-or-anything score.
 *  - Viewpoint invariance: the same motion filmed from mirrored facings scores
 *    identically, and the arm-line rule ABSTAINS rather than reporting a
 *    polarity the camera chose.
 *  - The removed rules stay removed: a hip line or a shoulder tilt that used
 *    to cost the user 20+ points now moves the score by nothing.
 */
import { PLAYER_ARCHETYPES } from '@/core/nbaBenchmarks';
import { referenceSequence } from '@/core/nbaReferenceForms';
import { formSimilarity } from '@/core/formSimilarity';
import type { DecodedFrame } from '@/core/formSequence';
import type { PoseKeypointName } from '@/core/types';

const N_FRAMES = 21; // phase indices: DIP 5, SET 12, RELEASE 15, FOLLOW 19
const DIP_IDX = 5;
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

/**
 * The same motion filmed from the other side: image x negates, anatomical
 * labels stay with the shooter (the pose model names anatomy, not screen
 * side). Every rule that survives must be blind to this.
 */
function mirrorX(seq: DecodedFrame[]): DecodedFrame[] {
  return seq.map((f) => {
    const out: DecodedFrame = {};
    for (const k of Object.keys(f) as PoseKeypointName[]) {
      out[k] = { x: -f[k]!.x, y: f[k]!.y };
    }
    return out;
  });
}

/**
 * Rotate the shooting wrist about the shooting elbow at `idx` by `deg`. The
 * elbow angle in {@link fullFrame} is exactly 90°, so this moves elbow@DIP by
 * exactly `deg` with no wrap, and nothing else: the DIP-frame wrist feeds no
 * other rule (arm line is read at SET, release height at RELEASE).
 */
function bendElbowAt(seq: DecodedFrame[], idx: number, deg: number): void {
  const f = seq[idx]!;
  const e = f.right_elbow!;
  const w = f.right_wrist!;
  const th = (deg * Math.PI) / 180;
  const dx = w.x - e.x;
  const dy = w.y - e.y;
  w.x = e.x + dx * Math.cos(th) - dy * Math.sin(th);
  w.y = e.y + dx * Math.sin(th) + dy * Math.cos(th);
}

describe('formSimilarity', () => {
  test('an identical motion scores exactly 100 with all 6 rules measured', () => {
    const ref = syntheticSeq();
    const sim = formSimilarity(clone(ref), ref, 'right');
    expect(sim).not.toBeNull();
    expect(sim!.score).toBe(100);
    expect(sim!.measuredRules).toBe(6);
    expect(sim!.totalRules).toBe(6);
  });

  test('a known 12.5° elbow delta scores the exact documented value', () => {
    const ref = syntheticSeq();
    const user = clone(ref);
    // elbow@DIP is the single rule that reads the DIP-frame wrist, so exactly
    // one deviation changes: 90° → 102.5°.
    bendElbowAt(user, DIP_IDX, 12.5);
    const sim = formSimilarity(user, ref, 'right');
    expect(sim).not.toBeNull();
    // dev = 12.5 / 25 = 0.5; mean over 6 rules = 0.08333 → round(91.67) = 92.
    expect(sim!.score).toBe(92);
    expect(sim!.measuredRules).toBe(6);
  });

  test('a huge single-rule delta caps its deviation at 1 (score floor 83 here)', () => {
    const ref = syntheticSeq();
    const user = clone(ref);
    // 45° elbow delta → raw dev 1.8, capped at 1 → round(100·(1 − 1/6)) = 83.
    bendElbowAt(user, DIP_IDX, 45);
    const sim = formSimilarity(user, ref, 'right');
    expect(sim).not.toBeNull();
    expect(sim!.score).toBe(83);
  });

  test('fewer than 4 measured rules refuses with null — never a fake score', () => {
    const ref = syntheticSeq();
    // Arm-only user: measures elbow@DIP, elbow@RELEASE, elbow@FOLLOW and
    // wristY@RELEASE = exactly 4 → still scored. The arm line abstains: with
    // one shoulder there is no shoulder axis, so there is no facing to sign it
    // with, and an unsigned x-difference is the camera's opinion, not the
    // shooter's.
    const armOnly: DecodedFrame[] = Array.from({ length: N_FRAMES }, () => ({
      right_shoulder: { x: 0, y: -0.3 },
      right_elbow: { x: 0, y: -0.1 },
      right_wrist: { x: 0.2, y: -0.1 },
    }));
    const arm = formSimilarity(armOnly, ref, 'right');
    expect(arm).not.toBeNull();
    expect(arm!.measuredRules).toBe(4);
    // …but losing the wrist at the RELEASE frame kills elbow@RELEASE and
    // wristY@RELEASE too (2 measured) → null.
    const tooFew = clone(armOnly);
    delete tooFew[REL_IDX]!.right_wrist;
    expect(formSimilarity(tooFew, ref, 'right')).toBeNull();
  });

  test('an empty user sequence refuses with null', () => {
    expect(formSimilarity([], syntheticSeq(), 'right')).toBeNull();
  });

  test('the same motion from mirrored facings scores identically', () => {
    const ref = syntheticSeq();
    const user = clone(ref);
    bendElbowAt(user, DIP_IDX, 12.5);
    user[SET_IDX]!.right_elbow!.x += 0.09; // a real arm-line deviation
    const a = formSimilarity(user, ref, 'right');
    const b = formSimilarity(mirrorX(user), ref, 'right');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Both must have actually read the arm line — otherwise this passes for
    // the wrong reason (two abstains agree trivially).
    expect(a!.measuredRules).toBe(6);
    expect(b!.measuredRules).toBe(6);
    expect(a!.score).toBeLessThan(100);
    expect(b!.score).toBe(a!.score);
  });

  test('near the side profile the arm-line rule abstains instead of guessing', () => {
    const ref = syntheticSeq();
    const user = clone(ref);
    // Collapse the apparent shoulder separation at SET to 0.02 body-heights —
    // below the facing floor, where the sign is keypoint noise.
    user[SET_IDX]!.left_shoulder!.x = user[SET_IDX]!.right_shoulder!.x - 0.02;
    const sim = formSimilarity(user, ref, 'right');
    expect(sim).not.toBeNull();
    expect(sim!.measuredRules).toBe(5); // 5 of 6, reported honestly
    expect(sim!.totalRules).toBe(6);
    // The abstain drops the rule; it never invents a deviation for it.
    expect(sim!.score).toBe(100);
  });

  test('the removed rules can no longer move the score', () => {
    const ref = syntheticSeq();
    // Dip depth used to read this hip line — which the decoder pins to the
    // origin, so it only ever measured the archetype.
    const hips = clone(ref);
    for (const f of hips) f.left_hip!.y += 0.5;
    const hipSim = formSimilarity(hips, ref, 'right');
    expect(hipSim!.score).toBe(100);
    expect(hipSim!.measuredRules).toBe(6);
    // Shoulder tilt used to read this: a ~45° tilt at the set point.
    const tilt = clone(ref);
    tilt[SET_IDX]!.left_shoulder!.y += 0.15;
    const tiltSim = formSimilarity(tilt, ref, 'right');
    expect(tiltSim!.score).toBe(100);
    expect(tiltSim!.measuredRules).toBe(6);
  });

  test('a synthesized reference matches itself at 100 (integration)', () => {
    const archetype = PLAYER_ARCHETYPES[0]!;
    const ref = referenceSequence(archetype, 'right');
    const sim = formSimilarity(ref, ref, 'right');
    expect(sim).not.toBeNull();
    expect(sim!.score).toBe(100);
    expect(sim!.measuredRules).toBe(6);
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
    expect(sim!.measuredRules).toBe(6);
  });
});
