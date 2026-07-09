import {
  DRILLS,
  getDrill,
  initDrillMode,
  stepDrill,
  type DrillId,
} from '../drills';
import {
  LEVEL_LABEL,
  drillPrescription,
  drillResultFromModeState,
  initDrillModeAtLevel,
  levelForDrill,
  levelGoals,
  levelOfGoals,
  type DrillLevel,
  type DrillResult,
} from '../drillProgression';
import type { ModeState } from '../gameModes';
import type { ResolvedShot, ShotOutcome } from '../types';

// ---------------------------------------------------------------------------
// Fixtures (mirrors drills.test.ts)
// ---------------------------------------------------------------------------

let nextId = 1;

/** A resolved shot with an optional normalized shooter x (drives zoneOf). */
function shot(outcome: ShotOutcome, originX: number | null = null): ResolvedShot {
  return {
    id: nextId++,
    tStart: 0,
    tResolved: 0,
    outcome,
    signals: { geo: null, net: null, cls: null },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: null,
    releaseAngleDeg: null,
    releasePoint: null,
    originX,
    originY: null,
    trajectory: [],
  };
}

// zoneOf thirds: x<1/3 left, x<2/3 center, else right.
const LEFT = 0.1;
const RIGHT = 0.9;

const make = (x?: number) => shot('make', x);

/** A history DrillResult with just the fields the ladder cares about varied. */
function result(level: DrillLevel, cleared = true, drillId: DrillId = 'corners3'): DrillResult {
  return { drillId, startedAt: 0, cleared, makes: 0, attempts: 0, level };
}

const LEVELS = [1, 2, 3] as const;

// ---------------------------------------------------------------------------
// levelGoals
// ---------------------------------------------------------------------------

describe('drillProgression / levelGoals', () => {
  test('every drill × level: lengths match the catalog, L1 is the catalog verbatim', () => {
    for (const d of DRILLS) {
      const l1 = levelGoals(d.id, 1);
      expect(l1.goals).toEqual(d.spots.map((s) => s.goal));
      expect(l1.attemptCap).toBe(d.attemptCap);
      for (const level of LEVELS) {
        expect(levelGoals(d.id, level).goals).toHaveLength(d.spots.length);
      }
    }
  });

  test('goals are monotonic across levels (L1 <= L2 <= L3, per spot)', () => {
    for (const d of DRILLS) {
      const [g1, g2, g3] = LEVELS.map((l) => levelGoals(d.id, l).goals);
      g1.forEach((g, i) => {
        expect(g2[i]).toBeGreaterThanOrEqual(g);
        expect(g3[i]).toBeGreaterThanOrEqual(g2[i]);
      });
    }
  });

  test('L2/L3 scale by ceil(1.5x) and 2x', () => {
    expect(levelGoals('corners3', 2).goals).toEqual([8, 8]);
    expect(levelGoals('corners3', 3).goals).toEqual([10, 10]);
    expect(levelGoals('ftLadder', 2).goals).toEqual([15]);
    expect(levelGoals('ftLadder', 3).goals).toEqual([20]);
    expect(levelGoals('midClock', 2).goals).toEqual([5, 5, 5, 5, 5]);
    expect(levelGoals('midClock', 3).goals).toEqual([6, 6, 6, 6, 6]);
  });

  test('catchShoot10 attempt cap scales by the total-goals ratio: 15 / 23 / 30', () => {
    expect(levelGoals('catchShoot10', 1)).toEqual({ goals: [10], attemptCap: 15 });
    expect(levelGoals('catchShoot10', 2)).toEqual({ goals: [15], attemptCap: 23 });
    expect(levelGoals('catchShoot10', 3)).toEqual({ goals: [20], attemptCap: 30 });
  });

  test('drills without a catalog cap never gain one', () => {
    for (const d of DRILLS.filter((x) => x.attemptCap == null)) {
      for (const level of LEVELS) {
        expect(levelGoals(d.id, level).attemptCap).toBeUndefined();
      }
    }
  });

  test('level labels', () => {
    expect(LEVEL_LABEL).toEqual({ 1: 'Starter', 2: 'Regular', 3: 'Advanced' });
  });
});

// ---------------------------------------------------------------------------
// levelOfGoals
// ---------------------------------------------------------------------------

describe('drillProgression / levelOfGoals', () => {
  test('round-trips every drill × level (highest match wins on ties)', () => {
    for (const d of DRILLS) {
      for (const level of LEVELS) {
        const goals = levelGoals(d.id, level).goals;
        // aroundKey's all-1 goals collide at L2/L3 (ceil(1.5) = 2 = 1×2); the
        // 3-first scan deliberately credits the higher level.
        const expected = d.id === 'aroundKey' && level === 2 ? 3 : level;
        expect(levelOfGoals(d.id, goals)).toBe(expected);
      }
    }
  });

  test('unrecognized goals degrade safely to level 1', () => {
    expect(levelOfGoals('corners3', [999])).toBe(1);
    expect(levelOfGoals('corners3', [])).toBe(1);
    expect(levelOfGoals('corners3', [5, 5, 5])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// initDrillModeAtLevel
// ---------------------------------------------------------------------------

describe('drillProgression / initDrillModeAtLevel', () => {
  test('L1 is initDrillMode-identical', () => {
    for (const d of DRILLS) {
      expect(initDrillModeAtLevel(d.id, 1)).toEqual(initDrillMode(d.id));
    }
  });

  test('corners3 @ L2: scaled goals + rewritten opening message, still plain spotShooting', () => {
    const s = initDrillModeAtLevel('corners3', 2);
    expect(s.modeId).toBe('spotShooting');
    expect(s.done).toBe(false);
    expect(s.config?.drill?.goals).toEqual([8, 8]);
    expect(s.message).toBe('8 at Left Corner 3.');
    // Non-goal drill fields ride through untouched.
    expect(s.config?.drill?.id).toBe('corners3');
    expect(s.config?.drill?.advance).toBe('matchZone');
    expect(s.spots).toHaveLength(2);
  });

  test('catchShoot10 @ L3 carries the scaled attempt cap into the running state', () => {
    const s = initDrillModeAtLevel('catchShoot10', 3);
    expect(s.config?.drill?.goals).toEqual([20]);
    expect(s.config?.drill?.attemptCap).toBe(30);
    expect(s.message).toBe('20 at Top of Key.');
  });

  test('stepDrill drives a leveled state to completion at the scaled goals', () => {
    // corners3 @ L2 = 8 at Left Corner, then 8 at Right Corner (matchZone).
    let s = initDrillModeAtLevel('corners3', 2);
    for (let i = 0; i < 8; i++) {
      s = stepDrill(s, make(LEFT));
    }
    expect(s.currentSpot).toBe(1); // 8th left make clears spot 0, not 5th
    expect(s.done).toBe(false);
    for (let i = 0; i < 8; i++) {
      s = stepDrill(s, make(RIGHT));
    }
    expect(s.done).toBe(true);
    expect(s.score).toBe(16);
    expect(s.spots?.[0].makes).toBe(8);
    expect(s.spots?.[1].makes).toBe(8);
    expect(s.message).toMatch(/complete/i);
  });
});

// ---------------------------------------------------------------------------
// drillResultFromModeState
// ---------------------------------------------------------------------------

/** A real finished corners3 @ L2 run (16 straight zone-correct makes). */
function finishedCorners3L2(): ModeState {
  let s = initDrillModeAtLevel('corners3', 2);
  for (let i = 0; i < 8; i++) s = stepDrill(s, make(LEFT));
  for (let i = 0; i < 8; i++) s = stepDrill(s, make(RIGHT));
  return s;
}

describe('drillProgression / drillResultFromModeState', () => {
  test('parses a real finished leveled run with the inferred level', () => {
    const done = finishedCorners3L2();
    // Round-trip through JSON exactly like History's modeResultJson does.
    const parsed = drillResultFromModeState(JSON.parse(JSON.stringify(done)), 1234);
    expect(parsed).toEqual({
      drillId: 'corners3',
      startedAt: 1234,
      cleared: true,
      makes: 16,
      attempts: 16,
      level: 2,
    });
  });

  test('a capped-out (not cleared) run parses with cleared: false', () => {
    // catchShoot10 @ L1: burn all 15 attempts as misses.
    let s = initDrillModeAtLevel('catchShoot10', 1);
    for (let i = 0; i < 15; i++) s = stepDrill(s, shot('miss'));
    expect(s.done).toBe(true);
    const parsed = drillResultFromModeState(s, 0);
    expect(parsed).toEqual({
      drillId: 'catchShoot10',
      startedAt: 0,
      cleared: false,
      makes: 0,
      attempts: 15,
      level: 1,
    });
  });

  test('rejects every malformed shape with null (never throws)', () => {
    const done = finishedCorners3L2();
    const blob = JSON.parse(JSON.stringify(done));
    expect(drillResultFromModeState(null, 0)).toBeNull();
    expect(drillResultFromModeState('x', 0)).toBeNull();
    expect(drillResultFromModeState({}, 0)).toBeNull();
    expect(drillResultFromModeState({ ...blob, modeId: 'shootout' }, 0)).toBeNull();
    expect(drillResultFromModeState({ ...blob, done: false }, 0)).toBeNull();
    expect(
      drillResultFromModeState(
        { ...blob, config: { drill: { ...blob.config.drill, id: 'nope' } } },
        0,
      ),
    ).toBeNull();
    expect(
      drillResultFromModeState(
        { ...blob, config: { drill: { ...blob.config.drill, goals: 'abc' } } },
        0,
      ),
    ).toBeNull();
    expect(drillResultFromModeState({ ...blob, config: null }, 0)).toBeNull();
    expect(drillResultFromModeState({ ...blob, config: {} }, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// levelForDrill — the promotion ladder
// ---------------------------------------------------------------------------

describe('drillProgression / levelForDrill', () => {
  test('no history → Starter', () => {
    expect(levelForDrill([])).toBe(1);
  });

  test('one L1 clear stays at 1; two L1 clears unlock 2', () => {
    expect(levelForDrill([result(1)])).toBe(1);
    expect(levelForDrill([result(1), result(1)])).toBe(2);
  });

  test('two L1 clears + two L2 clears unlock 3', () => {
    expect(levelForDrill([result(1), result(1), result(2), result(2)])).toBe(3);
  });

  test('clears at level 3 also count toward the L2 gate (r.level >= 2)', () => {
    expect(levelForDrill([result(3), result(3)])).toBe(3);
  });

  test('non-cleared results are ignored', () => {
    expect(levelForDrill([result(1, false), result(1, false), result(2, false)])).toBe(1);
    expect(levelForDrill([result(1), result(1, false), result(1)])).toBe(2);
  });

  test('order-independent', () => {
    const clears = [result(2), result(1), result(2), result(1)];
    expect(levelForDrill(clears)).toBe(3);
    expect(levelForDrill([...clears].reverse())).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// drillPrescription — exact plan-card copy
// ---------------------------------------------------------------------------

describe('drillProgression / drillPrescription', () => {
  test('level 1, no clears yet', () => {
    expect(drillPrescription('corners3', 1, [])).toBe(
      'Start at Starter: Both corners from deep — 5 makes each. Clear it twice to unlock Level 2.',
    );
  });

  test('level 1, one clear down', () => {
    expect(drillPrescription('corners3', 1, [result(1)])).toBe(
      'One clear down — clear Corners 3PT once more to unlock Level 2.',
    );
  });

  test('level 2 uses the scaled first goal', () => {
    expect(drillPrescription('corners3', 2, [result(1), result(1)])).toBe(
      'Level 2 unlocked: 8 at Left Corner 3 now. Two Level-2 clears open Advanced.',
    );
    expect(drillPrescription('catchShoot10', 2, [result(1), result(1)])).toBe(
      'Level 2 unlocked: 15 at Top of Key now. Two Level-2 clears open Advanced.',
    );
  });

  test('level 3', () => {
    expect(drillPrescription('corners3', 3, [result(1), result(1), result(2), result(2)])).toBe(
      'Advanced: 10 at Left Corner 3. This is game-weight volume — hold your form on the last rep like the first.',
    );
  });
});

// ---------------------------------------------------------------------------
// Sanity: the leveled state stays JSON-serializable with the existing shape
// ---------------------------------------------------------------------------

describe('drillProgression / serialization invariant', () => {
  test('a leveled init survives a JSON round-trip byte-identically', () => {
    for (const d of DRILLS) {
      for (const level of LEVELS) {
        const s = initDrillModeAtLevel(d.id, level);
        expect(JSON.parse(JSON.stringify(s))).toEqual(s);
        // Same key surface as a plain drill state — no new persisted field.
        expect(Object.keys(s.config?.drill ?? {}).sort()).toEqual(
          Object.keys(initDrillMode(d.id).config?.drill ?? {}).sort(),
        );
      }
    }
  });

  test('getDrill still resolves for every leveled state (no id drift)', () => {
    for (const d of DRILLS) {
      const s = initDrillModeAtLevel(d.id, 3);
      expect(getDrill(s.config!.drill!.id).id).toBe(d.id);
    }
  });
});
