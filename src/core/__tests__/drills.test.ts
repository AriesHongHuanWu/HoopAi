import {
  DRILLS,
  drillOf,
  getDrill,
  initDrillMode,
  stepDrill,
  type DrillId,
} from '../drills';
import { stepMode, type ModeState } from '../gameModes';
import type { ResolvedShot, ShotOutcome } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
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
const CENTER = 0.5;
const RIGHT = 0.9;

const make = (x?: number) => shot('make', x);
const miss = (x?: number) => shot('miss', x);
const unsure = () => shot('unsure');

/** Fold shots through a fresh drill via the public stepDrill engine. */
function playDrill(id: DrillId, shots: readonly ResolvedShot[]): ModeState {
  let s = initDrillMode(id);
  for (const sh of shots) s = stepDrill(s, sh);
  return s;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe('drills / catalog', () => {
  test('the five preset drills, each fully described', () => {
    const ids = DRILLS.map((d) => d.id);
    expect(ids).toEqual(['corners3', 'ftLadder', 'midClock', 'aroundKey', 'catchShoot10']);
    for (const d of DRILLS) {
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.icon.length).toBeGreaterThan(0);
      expect(d.tagline.length).toBeGreaterThan(0);
      expect(d.rules.length).toBeGreaterThan(0);
      expect(d.spots.length).toBeGreaterThan(0);
      for (const spot of d.spots) {
        expect(spot.goal).toBeGreaterThan(0);
        expect(['left', 'center', 'right']).toContain(spot.zone);
        // Diagram positions stay in the unit square.
        expect(spot.pos.x).toBeGreaterThanOrEqual(0);
        expect(spot.pos.x).toBeLessThanOrEqual(1);
        expect(spot.pos.y).toBeGreaterThanOrEqual(0);
        expect(spot.pos.y).toBeLessThanOrEqual(1);
      }
    }
  });

  test('spot count and goals match the spec', () => {
    expect(getDrill('corners3').spots).toHaveLength(2);
    expect(getDrill('corners3').spots.every((s) => s.goal === 5)).toBe(true);
    expect(getDrill('ftLadder').spots).toHaveLength(1);
    expect(getDrill('ftLadder').spots[0].goal).toBe(10);
    expect(getDrill('midClock').spots).toHaveLength(5);
    expect(getDrill('midClock').spots.every((s) => s.goal === 3)).toBe(true);
    expect(getDrill('aroundKey').spots).toHaveLength(6);
    expect(getDrill('aroundKey').spots.every((s) => s.goal === 1)).toBe(true);
    expect(getDrill('catchShoot10').spots[0].goal).toBe(10);
    expect(getDrill('catchShoot10').attemptCap).toBe(15);
  });

  test('getDrill throws on an unknown id', () => {
    // @ts-expect-error deliberately invalid id
    expect(() => getDrill('nope')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// initDrillMode — a drill AS a spotShooting mode
// ---------------------------------------------------------------------------

describe('drills / initDrillMode', () => {
  test('produces an unstarted spotShooting state carrying the drill config', () => {
    for (const d of DRILLS) {
      const s = initDrillMode(d.id);
      expect(s.modeId).toBe('spotShooting');
      expect(s.done).toBe(false);
      expect(s.started).toBeNull();
      expect(s.score).toBe(0);
      expect(s.currentSpot).toBe(0);
      expect(s.spots).toHaveLength(d.spots.length);
      expect(s.config?.drill?.id).toBe(d.id);
      expect(s.config?.drill?.goals).toEqual(d.spots.map((x) => x.goal));
      // drillOf resolves the running drill back off the state.
      expect(drillOf(s)?.id).toBe(d.id);
    }
  });

  test('drillOf is null for a non-drill state', () => {
    const notDrill: ModeState = {
      modeId: 'spotShooting',
      started: null,
      done: false,
      score: 0,
      progress: 0,
      message: '',
    };
    expect(drillOf(notDrill)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Shared invariants (mirror gameModes)
// ---------------------------------------------------------------------------

describe('drills / shared invariants', () => {
  test('unsure shots are non-events', () => {
    const before = initDrillMode('ftLadder');
    const after = stepDrill(before, unsure());
    expect(after.score).toBe(before.score);
    expect(after.done).toBe(before.done);
    expect(after.config?.drill?.attempts).toBe(0);
  });

  test('shots after done are ignored', () => {
    const done = playDrill('aroundKey', [make(), make(), make(), make(), make(), make()]);
    expect(done.done).toBe(true);
    const scoreAtDone = done.score;
    const after = stepDrill(done, make());
    expect(after).toBe(done);
    expect(after.score).toBe(scoreAtDone);
  });

  test('stepDrill does not mutate its input', () => {
    const s0 = initDrillMode('midClock');
    const snap = JSON.parse(JSON.stringify(s0));
    stepDrill(s0, make(LEFT));
    expect(s0).toEqual(snap);
  });
});

// ---------------------------------------------------------------------------
// Progression — anySpot drills
// ---------------------------------------------------------------------------

describe('drills / anySpot progression', () => {
  test('FT ladder: 10 makes completes; misses only burn attempts', () => {
    // 3 misses interleaved — position is irrelevant for anySpot.
    const shots = [
      make(), miss(), make(), make(), miss(), make(), make(),
      make(), make(), make(RIGHT), make(LEFT), miss(), make(),
    ];
    const s = playDrill('ftLadder', shots);
    expect(s.done).toBe(true);
    expect(s.score).toBe(10); // exactly the 10th make ends it
    expect(s.spots?.[0].makes).toBe(10);
  });

  test('around-key: one make clears each of six spots, advancing in order', () => {
    let s = initDrillMode('aroundKey');
    for (let i = 0; i < 5; i++) {
      s = stepDrill(s, make());
      expect(s.currentSpot).toBe(i + 1);
      expect(s.done).toBe(false);
    }
    s = stepDrill(s, make());
    expect(s.done).toBe(true);
    expect(s.score).toBe(6);
    expect(s.progress).toBe(1);
  });

  test('anySpot ignores zone: a wrong-third make still counts', () => {
    // aroundKey spot 0 is a left zone, but anySpot accepts a right-zone make.
    const s = stepDrill(initDrillMode('aroundKey'), make(RIGHT));
    expect(s.currentSpot).toBe(1);
    expect(s.config?.drill?.offSpotMakes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Progression — matchZone drills (the zone-mapping core)
// ---------------------------------------------------------------------------

describe('drills / matchZone progression', () => {
  test('corners: a make from the matching corner zone counts', () => {
    // Spot 0 = Left Corner (left zone). Five left makes clears it → spot 1.
    let s = initDrillMode('corners3');
    for (let i = 0; i < 5; i++) s = stepDrill(s, make(LEFT));
    expect(s.currentSpot).toBe(1);
    expect(s.spots?.[0].makes).toBe(5);
  });

  test('corners: a make from the WRONG zone is an off-spot make, no advance', () => {
    // Spot 0 = Left Corner; a right-zone make must not count toward it.
    let s = initDrillMode('corners3');
    s = stepDrill(s, make(RIGHT));
    expect(s.currentSpot).toBe(0);
    expect(s.spots?.[0].makes).toBe(0);
    expect(s.spots?.[0].attempts).toBe(1); // attempt still recorded
    expect(s.config?.drill?.offSpotMakes).toBe(1);
    expect(s.message).toMatch(/off-spot/i);
  });

  test('corners: full run — 5 left then 5 right completes the drill', () => {
    const s = playDrill('corners3', [
      make(LEFT), make(LEFT), make(LEFT), make(LEFT), make(LEFT),
      make(RIGHT), make(RIGHT), make(RIGHT), make(RIGHT), make(RIGHT),
    ]);
    expect(s.done).toBe(true);
    expect(s.score).toBe(10);
    expect(s.spots?.[0].makes).toBe(5);
    expect(s.spots?.[1].makes).toBe(5);
  });

  test('matchZone with no tracked person (null origin) accepts the make', () => {
    // A make we can't disprove positionally counts, rather than dropping it.
    const s = stepDrill(initDrillMode('corners3'), make(undefined));
    expect(s.spots?.[0].makes).toBe(1);
    expect(s.config?.drill?.offSpotMakes).toBe(0);
  });

  test('mid-range clock: 3 zone-correct makes advance each of five spots', () => {
    // Zones per spot: left, left, center, right, right.
    const zoneFor = ['left', 'left', 'center', 'right', 'right'] as const;
    const xFor = { left: LEFT, center: CENTER, right: RIGHT };
    let s = initDrillMode('midClock');
    for (let spot = 0; spot < 5; spot++) {
      for (let m = 0; m < 3; m++) s = stepDrill(s, make(xFor[zoneFor[spot]]));
    }
    expect(s.done).toBe(true);
    expect(s.score).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Attempt cap — catch-and-shoot
// ---------------------------------------------------------------------------

describe('drills / attempt cap', () => {
  test('catch-and-shoot: 10 makes inside 15 attempts wins (cleared)', () => {
    // 4 misses + 10 makes = 14 attempts, 10th make lands the goal.
    const shots = [
      miss(), make(), make(), miss(), make(), make(), make(),
      miss(), make(), make(), make(), miss(), make(), make(),
    ];
    const s = playDrill('catchShoot10', shots);
    expect(s.done).toBe(true);
    expect(s.score).toBe(10);
    expect(s.spots?.[0].makes).toBe(10);
    expect(s.message).toMatch(/complete/i);
  });

  test('catch-and-shoot: running out of attempts ends it short (not cleared)', () => {
    // 15 attempts, only 6 makes — cap ends the drill before the goal.
    const shots = [
      make(), make(), miss(), miss(), make(), miss(), miss(),
      make(), miss(), make(), miss(), miss(), make(), miss(), miss(),
    ];
    const s = playDrill('catchShoot10', shots);
    expect(s.done).toBe(true);
    expect(s.config?.drill?.attempts).toBe(15);
    expect(s.spots?.[0].makes).toBe(6);
    expect(s.message).toMatch(/up/i);
  });
});

// ---------------------------------------------------------------------------
// Integration with the mode engine (stepMode delegates to the drill)
// ---------------------------------------------------------------------------

describe('drills / stepMode delegation', () => {
  test('stepMode routes a drill state (config.drill set) through the drill engine', () => {
    // aroundKey: one make clears spot 0. stepMode must delegate, not run the
    // fixed spotShooting logic (which would need makesPerSpot makes).
    const s0 = initDrillMode('aroundKey');
    const s1 = stepMode(s0, make(), 0);
    expect(s1.currentSpot).toBe(1);
    expect(drillOf(s1)?.id).toBe('aroundKey');
  });
});
