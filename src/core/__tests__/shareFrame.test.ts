import { describe, expect, test } from '@jest/globals';

import { shotMomentSec, sessionMomentSec } from '../shareFrame';
import type { BallSample, ResolvedShot } from '../types';

function sample(t: number, cy: number, predicted = false): BallSample {
  return { cx: 100, cy, r: 12, t, score: 0.6, predicted };
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
