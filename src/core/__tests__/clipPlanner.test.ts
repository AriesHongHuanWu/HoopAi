import { describe, expect, test } from '@jest/globals';

import { formatClipName, planClips, totalClipSeconds } from '../clipPlanner';
import { CLIPS } from '../config';
import type { ClipPlan, ResolvedShot, ShotOutcome } from '../types';

/** Minimal valid ResolvedShot with overridable fields. */
function shot(
  id: number,
  tResolved: number,
  outcome: ShotOutcome = 'make',
  extra: Partial<ResolvedShot> = {},
): ResolvedShot {
  return {
    id,
    tStart: tResolved - 1.5,
    tResolved,
    outcome,
    signals: { geo: null, net: null, cls: null },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: null,
    releaseAngleDeg: null,
    releasePoint: null,
    originX: null,
    originY: null,
    trajectory: [],
    ...extra,
  };
}

const SESSION = 600;

describe('planClips filtering', () => {
  const shots = [
    shot(1, 30, 'make'),
    shot(2, 60, 'miss'),
    shot(3, 90, 'unsure'),
  ];

  test("keep: 'makes' keeps only makes", () => {
    const plans = planClips(shots, { keep: 'makes', sessionDurationSec: SESSION });
    expect(plans.map((p) => p.shotId)).toEqual([1]);
    expect(plans[0].outcome).toBe('make');
  });

  test("keep: 'decided' keeps makes and misses, drops unsure", () => {
    const plans = planClips(shots, { keep: 'decided', sessionDurationSec: SESSION });
    expect(plans.map((p) => p.shotId)).toEqual([1, 2]);
    expect(plans.map((p) => p.outcome)).toEqual(['make', 'miss']);
  });

  test("keep: 'all' keeps everything including unsure", () => {
    const plans = planClips(shots, { keep: 'all', sessionDurationSec: SESSION });
    expect(plans.map((p) => p.shotId)).toEqual([1, 2, 3]);
  });

  test('empty input yields empty plan list', () => {
    expect(planClips([], { keep: 'all', sessionDurationSec: SESSION })).toEqual([]);
  });
});

describe('planClips windowing and clamping', () => {
  test('default window uses CLIPS pre/post roll around tResolved', () => {
    const plans = planClips([shot(1, 100)], { keep: 'all', sessionDurationSec: SESSION });
    expect(plans).toEqual([
      {
        shotId: 1,
        outcome: 'make',
        startSec: 100 - CLIPS.preRollSec,
        endSec: 100 + CLIPS.postRollSec,
      },
    ]);
  });

  test('explicit pre/post roll override the defaults', () => {
    const plans = planClips([shot(1, 100)], {
      keep: 'all',
      preRollSec: 3,
      postRollSec: 1,
      sessionDurationSec: SESSION,
    });
    expect(plans[0].startSec).toBeCloseTo(97);
    expect(plans[0].endSec).toBeCloseTo(101);
  });

  test('window clamps to 0 at the session start', () => {
    // tResolved = 2 with 6s pre-roll would start at -4.
    const plans = planClips([shot(1, 2)], { keep: 'all', sessionDurationSec: SESSION });
    expect(plans[0].startSec).toBe(0);
    expect(plans[0].endSec).toBeCloseTo(4);
  });

  test('window clamps to sessionDurationSec at the session end', () => {
    // tResolved = 599 with 2s post-roll would end at 601.
    const plans = planClips([shot(1, 599)], { keep: 'all', sessionDurationSec: SESSION });
    expect(plans[0].startSec).toBeCloseTo(593);
    expect(plans[0].endSec).toBe(SESSION);
  });

  test('plans come back sorted by startSec even when input is unsorted', () => {
    const plans = planClips(
      [shot(2, 300), shot(1, 100), shot(3, 500)],
      { keep: 'all', sessionDurationSec: SESSION },
    );
    expect(plans.map((p) => p.shotId)).toEqual([1, 2, 3]);
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].startSec).toBeGreaterThan(plans[i - 1].startSec);
    }
  });
});

describe('planClips merging', () => {
  test('rapid consecutive makes merge into one clip keeping the first id', () => {
    // Default window is [t-6, t+2]; shots 3s apart overlap heavily.
    const plans = planClips(
      [shot(1, 100, 'make'), shot(2, 103, 'make'), shot(3, 106, 'make')],
      { keep: 'makes', sessionDurationSec: SESSION },
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual({
      shotId: 1,
      outcome: 'make',
      startSec: 94,
      endSec: 108,
    });
  });

  test('merged clip is a make when ANY merged shot was a make', () => {
    const plans = planClips(
      [shot(1, 100, 'miss'), shot(2, 103, 'make')],
      { keep: 'decided', sessionDurationSec: SESSION },
    );
    expect(plans).toHaveLength(1);
    expect(plans[0].shotId).toBe(1); // first shot's id
    expect(plans[0].outcome).toBe('make'); // upgraded by the merged make
  });

  test('merged clip keeps first outcome when no merged shot was a make', () => {
    const plans = planClips(
      [shot(1, 100, 'miss'), shot(2, 103, 'unsure')],
      { keep: 'all', sessionDurationSec: SESSION },
    );
    expect(plans).toHaveLength(1);
    expect(plans[0].outcome).toBe('miss');
  });

  test('windows separated by less than mergeGapSec merge; >= gap stays split', () => {
    // 1s rolls → shot at t gives [t-1, t+1].
    const opts = { keep: 'all' as const, preRollSec: 1, postRollSec: 1, sessionDurationSec: SESSION };

    // Gap = (12.4-1) - (10+1) = 0.4 < 0.5 → merged.
    const mergedPlans = planClips([shot(1, 10), shot(2, 12.4)], opts);
    expect(mergedPlans).toHaveLength(1);
    expect(mergedPlans[0].startSec).toBeCloseTo(9);
    expect(mergedPlans[0].endSec).toBeCloseTo(13.4);

    // Gap = (12.5-1) - (10+1) = 0.5, not < mergeGapSec → separate clips.
    const splitPlans = planClips([shot(1, 10), shot(2, 12.5)], opts);
    expect(splitPlans).toHaveLength(2);
  });

  test('a contained shorter window does not shrink the merged clip', () => {
    // Start-clamping makes shot2's window [0, 3] a subset of shot1's [0, 4].
    // Sorted order (stable on equal startSec) visits [0, 4] first; merging
    // must keep endSec = 4, not adopt the shorter window's 3.
    const plans = planClips(
      [shot(1, 2), shot(2, 1)],
      { keep: 'all', preRollSec: 6, postRollSec: 2, sessionDurationSec: SESSION },
    );
    expect(plans).toHaveLength(1);
    expect(plans[0].shotId).toBe(1);
    expect(plans[0].startSec).toBe(0);
    expect(plans[0].endSec).toBeCloseTo(4);
  });

  test('merging across three windows chains transitively', () => {
    const opts = { keep: 'all' as const, preRollSec: 1, postRollSec: 1, sessionDurationSec: SESSION };
    // [9,11], [11.2,13.2], [13.4,15.4] — each consecutive gap 0.2 < 0.5.
    const plans = planClips([shot(1, 10), shot(2, 12.2), shot(3, 14.4)], opts);
    expect(plans).toHaveLength(1);
    expect(plans[0].startSec).toBeCloseTo(9);
    expect(plans[0].endSec).toBeCloseTo(15.4);
  });
});

describe('planClips corrected outcomes', () => {
  test('a shot corrected to make is kept by keep:makes', () => {
    const corrected = shot(1, 100, 'make', { corrected: true }); // was a miss, user flipped it
    const plans = planClips([corrected], { keep: 'makes', sessionDurationSec: SESSION });
    expect(plans).toHaveLength(1);
    expect(plans[0].outcome).toBe('make');
  });

  test('a shot corrected to miss is dropped by keep:makes', () => {
    const corrected = shot(1, 100, 'miss', { corrected: true }); // was a make, user flipped it
    const plans = planClips([corrected], { keep: 'makes', sessionDurationSec: SESSION });
    expect(plans).toHaveLength(0);
  });
});

describe('totalClipSeconds', () => {
  test('sums window durations', () => {
    const plans: ClipPlan[] = [
      { shotId: 1, outcome: 'make', startSec: 0, endSec: 8 },
      { shotId: 2, outcome: 'miss', startSec: 20, endSec: 24.5 },
    ];
    expect(totalClipSeconds(plans)).toBeCloseTo(12.5);
  });

  test('empty plan list totals zero', () => {
    expect(totalClipSeconds([])).toBe(0);
  });

  test('matches planClips output including merges', () => {
    const plans = planClips(
      [shot(1, 100, 'make'), shot(2, 103, 'make')],
      { keep: 'makes', sessionDurationSec: SESSION },
    );
    // Windows [94, 102] and [97, 105] merge to [94, 105] → 11s.
    expect(totalClipSeconds(plans)).toBeCloseTo(11);
  });
});

describe('formatClipName', () => {
  const plan: ClipPlan = { shotId: 3, outcome: 'make', startSec: 94, endSec: 108 };

  test('builds <label>_shot<id>_<outcome>.mp4', () => {
    expect(formatClipName(plan, 'morning')).toBe('morning_shot3_make.mp4');
  });

  test('spaces become dashes and everything is lowercased', () => {
    expect(formatClipName(plan, 'Morning Session')).toBe('morning-session_shot3_make.mp4');
  });

  test('whitespace runs collapse to a single dash', () => {
    expect(formatClipName(plan, 'My   Great\tSession')).toBe('my-great-session_shot3_make.mp4');
  });

  test('miss outcome appears in the name', () => {
    const missPlan: ClipPlan = { shotId: 12, outcome: 'miss', startSec: 0, endSec: 8 };
    expect(formatClipName(missPlan, 'Gym Run')).toBe('gym-run_shot12_miss.mp4');
  });
});
