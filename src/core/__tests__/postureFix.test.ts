/**
 * posturePlan — the ranked posture-cue engine.
 *
 * RE-PINNED for the six-rule engine. Dip depth and shoulder alignment were
 * removed: the decoder hip-centres every frame, so the dip-depth rule scored
 * the ARCHETYPE's dip rather than the shooter's, and at the side profile Form
 * Check asks for the two shoulders are near-coincident, so the tilt rule was
 * atan2 noise whose sign flipped with the camera side. Fixtures that drove
 * those two rules now drive rules that survive; nothing was weakened.
 */
import { PLAYER_ARCHETYPES } from '../nbaBenchmarks';
import { referenceSequence } from '../nbaReferenceForms';
import { posturePlan, type PostureCue } from '../postureFix';
import type { DecodedFrame } from '../formSequence';
import type { PoseKeypointName } from '../types';

const CURRY = PLAYER_ARCHETYPES.find((a) => a.name === 'Stephen Curry')!;

/** Deep-clone a decoded sequence so mutations don't leak between tests. */
function clone(seq: DecodedFrame[]): DecodedFrame[] {
  return seq.map((f) => {
    const out: DecodedFrame = {};
    for (const k of Object.keys(f) as PoseKeypointName[]) out[k] = { ...f[k]! };
    return out;
  });
}

/**
 * The same motion filmed from the other side: image x negates, anatomical
 * labels stay with the shooter. Every surviving rule must be blind to this.
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

/** Index of the SET phase frame — mirrors postureFix's PHASE_FRAC.SET. */
function setIdx(seq: readonly DecodedFrame[]): number {
  return Math.round(0.6 * (seq.length - 1));
}

describe('posturePlan', () => {
  test('a form identical to the reference produces no cues', () => {
    const ref = referenceSequence(CURRY);
    const user = clone(ref);
    const cues = posturePlan(user, ref, 'right');
    expect(cues).toEqual([]);
  });

  test('returns at most maxCues, ranked worst-first', () => {
    const ref = referenceSequence(CURRY);
    const user = clone(ref);
    // Perturb several joints across the motion to trigger multiple rules.
    for (const f of user) {
      if (f.right_wrist) f.right_wrist.y += 0.15;
      if (f.right_elbow) f.right_elbow.x += 0.12;
      if (f.left_hip) f.left_hip.y += 0.12;
      if (f.right_hip) f.right_hip.y += 0.12;
      if (f.left_shoulder) f.left_shoulder.y += 0.06;
    }
    const cues = posturePlan(user, ref, 'right', 3);
    expect(cues.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i - 1]!.severity).toBeGreaterThanOrEqual(cues[i]!.severity);
    }
  });

  test('detects a bent release arm and phases it at RELEASE', () => {
    const ref = referenceSequence(CURRY);
    const user = clone(ref);
    // Collapse the release elbow inward so the arm is clearly bent at release.
    const relIdx = Math.round(0.75 * (ref.length - 1));
    const f = user[relIdx]!;
    // Pull the wrist back toward the shoulder to sharply bend the elbow angle.
    if (f.right_wrist && f.right_shoulder) {
      f.right_wrist.x = f.right_shoulder.x + 0.02;
      f.right_wrist.y = f.right_elbow!.y + 0.02;
    }
    const cues = posturePlan(user, ref, 'right', 8);
    const elbow = cues.find((c) => c.id === 'elbow_release');
    expect(elbow).toBeDefined();
    expect(elbow!.phase).toBe('RELEASE');
    expect(elbow!.cue.length).toBeGreaterThan(0);
    expect(elbow!.drill.length).toBeGreaterThan(0);
  });

  test('every cue carries joint, phase, cue text and a drill', () => {
    const ref = referenceSequence(CURRY);
    const user = clone(ref);
    // Was a hip perturbation, which drove only the dropped dip-depth rule and
    // now moves nothing. Raise the shooting wrist instead: that is read by the
    // release-height rule and by the three elbow-angle rules, all surviving.
    for (const f of user) {
      if (f.right_wrist) f.right_wrist.y -= 0.18;
    }
    const cues = posturePlan(user, ref, 'right', 8);
    expect(cues.length).toBeGreaterThan(0);
    for (const c of cues) {
      expect(c.joint).toBeTruthy();
      expect(['DIP', 'SET', 'RELEASE', 'FOLLOW']).toContain(c.phase);
      expect(c.cue).toBeTruthy();
      expect(c.drill).toBeTruthy();
      expect(Number.isFinite(c.diff)).toBe(true);
      expect(Number.isFinite(c.severity)).toBe(true);
    }
  });

  test('small differences under the deadband are ignored', () => {
    const ref = referenceSequence(CURRY);
    const user = clone(ref);
    // A sub-perceptual nudge on every joint: tiny enough that no measured
    // angle moves past the 8° deadband nor any length past 0.05 body-heights.
    for (const f of user) {
      for (const k of Object.keys(f) as (keyof typeof f)[]) {
        f[k]!.x += 0.002;
        f[k]!.y += 0.002;
      }
    }
    const cues = posturePlan(user, ref, 'right');
    expect(cues).toEqual([]);
  });

  test('sign of the diff drives which cue variant is shown (higher release)', () => {
    // Was pinned on dip depth, a dropped rule. Release height carries the same
    // signed-length semantics and survives, so the sign contract is pinned there.
    const ref = referenceSequence(CURRY);
    const user = clone(ref);
    // Raise the user's release point (+y is DOWN, so higher = smaller y).
    for (const f of user) {
      if (f.right_wrist) f.right_wrist.y -= 0.2;
    }
    const cues = posturePlan(user, ref, 'right', 8);
    const height = cues.find((c) => c.id === 'release_height') as PostureCue;
    expect(height).toBeDefined();
    expect(height.diff).toBeLessThan(0); // user wristY smaller (+y down = higher)
    expect(height.cue.toLowerCase()).toContain('higher');
  });

  test('the dropped rules produce no cue at all', () => {
    const ref = referenceSequence(CURRY);
    // A hip line 0.5 body-heights off the reference. The decoder centres every
    // frame on the hips, so this was never the shooter's error to report.
    const hips = clone(ref);
    for (const f of hips) if (f.left_hip) f.left_hip.y += 0.5;
    expect(posturePlan(hips, ref, 'right', 8)).toEqual([]);
    // A ~45° shoulder tilt at the set point: unmeasurable side-on, so silent.
    const tilt = clone(ref);
    const s = tilt[setIdx(tilt)]!;
    if (s.left_shoulder) s.left_shoulder.y += 0.15;
    expect(posturePlan(tilt, ref, 'right', 8)).toEqual([]);
  });

  test('the arm-line cue is identical from mirrored facings', () => {
    const ref = referenceSequence(CURRY);
    const user = clone(ref);
    // Flare the shooting elbow outboard at the set point.
    user[setIdx(user)]!.right_elbow!.x += 0.09;
    const cues = posturePlan(user, ref, 'right', 8);
    const arm = cues.find((c) => c.id === 'arm_line_set') as PostureCue;
    expect(arm).toBeDefined();
    expect(arm.cue.toLowerCase()).toContain('flares outside');
    // Same shooter, phone on the other wing: raw (elbow.x − wrist.x) flips
    // sign, so the whole cue list must be unchanged once it is signed by the
    // shooter's own shoulder axis.
    expect(posturePlan(mirrorX(user), ref, 'right', 8)).toEqual(cues);
  });

  test('the arm-line rule abstains when facing cannot be read', () => {
    const ref = referenceSequence(CURRY);
    const user = clone(ref);
    const i = setIdx(user);
    user[i]!.right_elbow!.x += 0.09;
    // Collapse the apparent shoulder separation below the facing floor — at
    // the side profile the sign of the offset is the camera's, not the shooter's.
    user[i]!.left_shoulder!.x = user[i]!.right_shoulder!.x - 0.02;
    const cues = posturePlan(user, ref, 'right', 8);
    expect(cues.find((c) => c.id === 'arm_line_set')).toBeUndefined();
  });

  test('empty sequences produce no cues and do not throw', () => {
    expect(posturePlan([], referenceSequence(CURRY), 'right')).toEqual([]);
    expect(posturePlan(referenceSequence(CURRY), [], 'right')).toEqual([]);
    expect(posturePlan([], [], 'right')).toEqual([]);
  });
});
