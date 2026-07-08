import { describe, expect, test } from '@jest/globals';

import { shotMomentSec, sessionMomentSec, bestMakeTrajectory } from '../shareFrame';
import type { BallSample, ResolvedShot } from '../types';

function sample(t: number, cy: number, predicted = false): BallSample {
  return { cx: 100, cy, r: 12, t, score: 0.6, predicted };
}

/**
 * A rising-then-falling arc whose EXACT minimum cy is `apexCy` (an odd sample
 * count guarantees a real apex sample at the middle). Used to assert which
 * shot's trajectory bestMakeTrajectory returns.
 */
function arc(apexCy: number, n = 5): BallSample[] {
  const mid = (n - 1) / 2;
  const out: BallSample[] = [];
  for (let i = 0; i < n; i++) {
    const cy = apexCy + Math.abs(i - mid) * 120; // apex at i === mid
    out.push({ cx: i * 50, cy, r: 12, t: i, score: 0.6, predicted: false });
  }
  return out;
}

function shot(over: Partial<ResolvedShot>): ResolvedShot {
  return {
    id: 1,
    tStart: 0,
    tResolved: 10,
    outcome: 'make',
    signals: { geo: true, net: null, cls: null },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: null,
    releaseAngleDeg: null,
    releasePoint: null,
    originX: null,
    originY: null,
    trajectory: [],
    ...over,
  };
}

describe('shotMomentSec', () => {
  test('uses the trajectory apex (min cy), rebased by recordingStartSec', () => {
    const s = shot({
      tResolved: 12,
      // apex (smallest cy) at camera t=10.5
      trajectory: [sample(10, 300), sample(10.5, 120), sample(11, 260)],
    });
    // recording started at camera t=4 → apex is 6.5s into the clip.
    expect(shotMomentSec(s, 4, 30)).toBeCloseTo(6.5);
  });

  test('ignores predicted samples for the apex', () => {
    const s = shot({
      tResolved: 12,
      trajectory: [sample(10, 300), sample(10.5, 80, true), sample(11, 150)],
    });
    // predicted 80 is skipped → real apex is 150 at t=11 → 11-4 = 7.
    expect(shotMomentSec(s, 4, 30)).toBeCloseTo(7);
  });

  test('falls back to tResolved when no real trajectory', () => {
    const s = shot({ tResolved: 9, trajectory: [] });
    expect(shotMomentSec(s, 2, 30)).toBeCloseTo(7);
  });

  test('clamps into [0, duration]', () => {
    const s = shot({ tResolved: 100, trajectory: [] });
    expect(shotMomentSec(s, 0, 30)).toBe(30); // past the end → clamped
    const s2 = shot({ tResolved: 1, trajectory: [] });
    expect(shotMomentSec(s2, 5, 30)).toBe(0); // before start → clamped
  });
});

describe('sessionMomentSec', () => {
  test('features the highest-arc make', () => {
    const lowMake = shot({ id: 1, outcome: 'make', tResolved: 5, trajectory: [sample(5, 200)] });
    const highMake = shot({ id: 2, outcome: 'make', tResolved: 8, trajectory: [sample(8, 60)] });
    const miss = shot({ id: 3, outcome: 'miss', tResolved: 9, trajectory: [sample(9, 20)] });
    // Highest make (cy 60) wins over the miss (cy 20) and low make.
    expect(sessionMomentSec([lowMake, highMake, miss], 0, 30)).toBeCloseTo(8);
  });

  test('falls back to any shot when there are no makes', () => {
    const miss = shot({ id: 1, outcome: 'miss', tResolved: 6, trajectory: [sample(6, 90)] });
    expect(sessionMomentSec([miss], 1, 30)).toBeCloseTo(5);
  });

  test('null when no shots', () => {
    expect(sessionMomentSec([], 0, 30)).toBeNull();
  });
});

describe('bestMakeTrajectory', () => {
  test('null when there are no shots', () => {
    expect(bestMakeTrajectory([])).toBeNull();
  });

  test('picks the highest-arcing make (smallest apex cy)', () => {
    const lowMake = shot({ id: 1, outcome: 'make', trajectory: arc(200) });
    const highMake = shot({ id: 2, outcome: 'make', trajectory: arc(40) });
    const got = bestMakeTrajectory([lowMake, highMake]);
    // The returned samples are the high make's — its apex (min cy) is ~40.
    const minCy = Math.min(...got!.map((p) => p.cy));
    expect(minCy).toBeCloseTo(40);
  });

  test('ignores misses when a make exists', () => {
    const make = shot({ id: 1, outcome: 'make', trajectory: arc(120) });
    const higherMiss = shot({ id: 2, outcome: 'miss', trajectory: arc(10) });
    const got = bestMakeTrajectory([make, higherMiss]);
    const minCy = Math.min(...got!.map((p) => p.cy));
    // Falls to the make (120), not the higher-arcing miss (10).
    expect(minCy).toBeCloseTo(120);
  });

  test('falls back to any shot with a usable arc when there are no makes', () => {
    const miss = shot({ id: 1, outcome: 'miss', trajectory: arc(90) });
    const got = bestMakeTrajectory([miss]);
    expect(got).not.toBeNull();
    expect(got!.length).toBeGreaterThanOrEqual(3);
  });

  test('skips shots with too few real samples', () => {
    const twoPts = shot({
      id: 1,
      outcome: 'make',
      trajectory: [sample(0, 100), sample(1, 50)],
    });
    expect(bestMakeTrajectory([twoPts])).toBeNull();
  });

  test('skips predicted-only / flat trajectories', () => {
    const predicted = shot({
      id: 1,
      outcome: 'make',
      trajectory: [sample(0, 100, true), sample(1, 50, true), sample(2, 80, true)],
    });
    expect(bestMakeTrajectory([predicted])).toBeNull();

    const flat = shot({
      id: 2,
      outcome: 'make',
      trajectory: [sample(0, 100), sample(1, 100), sample(2, 100)],
    });
    expect(bestMakeTrajectory([flat])).toBeNull();
  });

  test('returns only the real (non-predicted) samples', () => {
    const mixed = shot({
      id: 1,
      outcome: 'make',
      trajectory: [sample(0, 300), sample(1, 100, true), sample(2, 120), sample(3, 260)],
    });
    const got = bestMakeTrajectory([mixed]);
    expect(got).not.toBeNull();
    expect(got!.every((p) => !p.predicted)).toBe(true);
    expect(got!).toHaveLength(3);
  });
});
