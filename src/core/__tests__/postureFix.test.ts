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
    for (const f of user) {
      if (f.left_hip) f.left_hip.y -= 0.15;
      if (f.right_hip) f.right_hip.y -= 0.15;
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

  test('sign of the diff drives which cue variant is shown (deeper dip)', () => {
    const ref = referenceSequence(CURRY);
    const user = clone(ref);
    // Sink the user's hips much lower at the dip → deeper than reference.
    for (const f of user) {
      if (f.left_hip) f.left_hip.y += 0.2;
      if (f.right_hip) f.right_hip.y += 0.2;
    }
    const cues = posturePlan(user, ref, 'right', 8);
    const depth = cues.find((c) => c.id === 'dip_depth') as PostureCue;
    expect(depth).toBeDefined();
    expect(depth.diff).toBeGreaterThan(0); // user hipY larger (+y down = lower)
    expect(depth.cue.toLowerCase()).toContain('lower');
  });

  test('empty sequences produce no cues and do not throw', () => {
    expect(posturePlan([], referenceSequence(CURRY), 'right')).toEqual([]);
    expect(posturePlan(referenceSequence(CURRY), [], 'right')).toEqual([]);
    expect(posturePlan([], [], 'right')).toEqual([]);
  });
});
