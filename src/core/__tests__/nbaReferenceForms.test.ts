import { angleAtDeg } from '../geometry';
import { PLAYER_ARCHETYPES } from '../nbaBenchmarks';
import {
  REF_FRAMES,
  archetypeByName,
  paramsForArchetype,
  referenceReleaseFrame,
  referenceSequence,
} from '../nbaReferenceForms';
import { SEQ_KEYPOINT_ORDER } from '../formSequence';
import type { PoseKeypointName } from '../types';

const CURRY = PLAYER_ARCHETYPES.find((a) => a.name === 'Stephen Curry')!;
const DURANT = PLAYER_ARCHETYPES.find((a) => a.name === 'Kevin Durant')!;

describe('referenceSequence', () => {
  test('produces REF_FRAMES frames for every archetype, no NaNs', () => {
    for (const a of PLAYER_ARCHETYPES) {
      const seq = referenceSequence(a);
      expect(seq.length).toBe(REF_FRAMES);
      for (const frame of seq) {
        for (const name of Object.keys(frame) as PoseKeypointName[]) {
          expect(Number.isFinite(frame[name]!.x)).toBe(true);
          expect(Number.isFinite(frame[name]!.y)).toBe(true);
        }
      }
    }
  });

  test('is deterministic — same archetype yields byte-identical frames', () => {
    const a = referenceSequence(CURRY);
    const b = referenceSequence(CURRY);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('core shooting joints are populated across the motion', () => {
    const seq = referenceSequence(CURRY);
    const need: PoseKeypointName[] = [
      'right_shoulder',
      'right_elbow',
      'right_wrist',
      'left_hip',
      'right_hip',
      'right_knee',
      'right_ankle',
    ];
    for (const frame of seq) {
      for (const n of need) expect(frame[n]).toBeDefined();
    }
  });

  test('shooting arm extends by the follow-through (elbow angle straighter than at dip)', () => {
    const seq = referenceSequence(DURANT);
    const dip = seq[Math.round(0.25 * (REF_FRAMES - 1))]!;
    const follow = seq[REF_FRAMES - 1]!;
    const dipElbow = angleAtDeg(dip.right_shoulder!, dip.right_elbow!, dip.right_wrist!)!;
    const followElbow = angleAtDeg(
      follow.right_shoulder!,
      follow.right_elbow!,
      follow.right_wrist!,
    )!;
    expect(followElbow).toBeGreaterThan(dipElbow);
    expect(followElbow).toBeGreaterThan(140); // near-extended
  });

  test('wrist rises (y decreases, +y down) from dip to release', () => {
    const seq = referenceSequence(CURRY);
    const dip = seq[Math.round(0.25 * (REF_FRAMES - 1))]!;
    const release = seq[referenceReleaseFrame(CURRY)]!;
    expect(release.right_wrist!.y).toBeLessThan(dip.right_wrist!.y);
  });

  test('a higher-release archetype (Durant) releases the wrist higher than a lower one (Curry)', () => {
    const curry = referenceSequence(CURRY);
    const durant = referenceSequence(DURANT);
    const cw = curry[referenceReleaseFrame(CURRY)]!.right_wrist!.y;
    const dw = durant[referenceReleaseFrame(DURANT)]!.right_wrist!.y;
    // Higher release ⇒ more negative y.
    expect(dw).toBeLessThan(cw);
  });

  test('left-handed reference mirrors the shooting wrist to the left of center', () => {
    const right = referenceSequence(CURRY, 'right');
    const left = referenceSequence(CURRY, 'left');
    const rRel = right[referenceReleaseFrame(CURRY)]!;
    const lRel = left[referenceReleaseFrame(CURRY)]!;
    expect(rRel.right_wrist!.x).toBeGreaterThan(0);
    expect(lRel.left_wrist!.x).toBeLessThan(0);
  });

  test('one-motion archetype releases earlier (smaller frac) than a slow two-motion one', () => {
    const curryFrac = paramsForArchetype(CURRY).releaseFrac; // fast one-motion
    const kawhi = PLAYER_ARCHETYPES.find((a) => a.name === 'Kawhi Leonard')!;
    const kawhiFrac = paramsForArchetype(kawhi).releaseFrac; // slow two-motion
    expect(curryFrac).toBeLessThan(kawhiFrac);
  });

  test('all keypoints stay within a sane normalized range', () => {
    for (const a of PLAYER_ARCHETYPES) {
      for (const frame of referenceSequence(a)) {
        for (const n of SEQ_KEYPOINT_ORDER) {
          const p = frame[n];
          if (!p) continue;
          expect(Math.abs(p.x)).toBeLessThan(2);
          expect(Math.abs(p.y)).toBeLessThan(2);
        }
      }
    }
  });

  test('archetypeByName finds a known player and returns undefined otherwise', () => {
    expect(archetypeByName('Stephen Curry')?.name).toBe('Stephen Curry');
    expect(archetypeByName('Nobody')).toBeUndefined();
  });
});
