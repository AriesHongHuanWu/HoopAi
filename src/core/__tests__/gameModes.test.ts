import {
  GAME_MODES,
  getModeDef,
  initMode,
  stepMode,
  tickMode,
  type ModeState,
} from '../gameModes';
import type { GameModeId, ResolvedShot, ShotOutcome, ShotValue } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nextId = 1;

function shot(
  outcome: ShotOutcome,
  opts: { shotValue?: ShotValue; tResolved?: number } = {},
): ResolvedShot {
  return {
    id: nextId++,
    tStart: 0,
    tResolved: opts.tResolved ?? 0,
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
    shotValue: opts.shotValue,
  };
}

/** Fold a sequence of shots at t=0 into a fresh mode. */
function play(
  id: GameModeId,
  shots: readonly ResolvedShot[],
  opts?: Parameters<typeof initMode>[1],
): ModeState {
  let s = initMode(id, opts);
  for (const sh of shots) s = stepMode(s, sh, sh.tResolved);
  return s;
}

const make = (v?: ShotValue) => shot('make', { shotValue: v });
const miss = () => shot('miss');
const unsure = () => shot('unsure');

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe('gameModes / catalog', () => {
  test('exactly the seven modes, each fully described', () => {
    const ids = GAME_MODES.map((m) => m.id);
    expect(ids).toEqual([
      'free',
      'aroundTheWorld',
      'spotShooting',
      'timed',
      'threePoint',
      'ftStreak',
      'horse',
    ]);
    for (const m of GAME_MODES) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.emoji.length).toBeGreaterThan(0);
      expect(m.tagline.length).toBeGreaterThan(0);
      expect(m.rules.length).toBeGreaterThan(0);
    }
  });

  test('getModeDef resolves and throws on unknown', () => {
    expect(getModeDef('horse').name).toBe('H-O-R-S-E');
    // @ts-expect-error deliberately invalid id
    expect(() => getModeDef('nope')).toThrow();
  });

  test('initMode produces a not-done, unstarted state for every mode', () => {
    for (const m of GAME_MODES) {
      const s = initMode(m.id);
      expect(s.modeId).toBe(m.id);
      expect(s.done).toBe(false);
      expect(s.started).toBeNull();
      expect(s.score).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Shared invariants
// ---------------------------------------------------------------------------

describe('gameModes / shared invariants', () => {
  test('unsure shots are non-events across all modes', () => {
    for (const m of GAME_MODES) {
      const before = initMode(m.id);
      const after = stepMode(before, unsure(), 0);
      expect(after.score).toBe(before.score);
      expect(after.done).toBe(before.done);
    }
  });

  test('shots after done are ignored', () => {
    const done: ModeState = { ...initMode('free'), done: true, score: 7 };
    expect(stepMode(done, make(3), 5)).toBe(done);
  });

  test('stepMode does not mutate its input', () => {
    const s0 = initMode('free');
    const snap = JSON.parse(JSON.stringify(s0));
    stepMode(s0, make(3), 0);
    expect(s0).toEqual(snap);
  });
});

// ---------------------------------------------------------------------------
// Free Play
// ---------------------------------------------------------------------------

describe('gameModes / free', () => {
  test('accumulates points by shot value; misses do not score', () => {
    const s = play('free', [make(3), make(2), miss(), make()]);
    expect(s.score).toBe(7); // 3 + 2 + 0 + 2(default)
    expect(s.done).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Around the World
// ---------------------------------------------------------------------------

describe('gameModes / aroundTheWorld', () => {
  test('advances only on a make; completes after five', () => {
    let s = initMode('aroundTheWorld');
    expect(s.currentSpot).toBe(0);
    s = stepMode(s, miss(), 0); // stay on spot 0
    expect(s.currentSpot).toBe(0);
    for (let i = 0; i < 5; i++) s = stepMode(s, make(), 0);
    expect(s.done).toBe(true);
    expect(s.progress).toBe(1);
    expect(s.score).toBe(5);
  });

  test('tracks attempts and makes per spot', () => {
    let s = initMode('aroundTheWorld');
    s = stepMode(s, miss(), 0);
    s = stepMode(s, make(), 0);
    expect(s.spots?.[0]).toEqual({
      label: 'Left Corner',
      attempts: 2,
      makes: 1,
    });
    expect(s.currentSpot).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Spot Shooting
// ---------------------------------------------------------------------------

describe('gameModes / spotShooting', () => {
  test('requires N makes per spot before advancing', () => {
    let s = initMode('spotShooting', { makesPerSpot: 2 });
    s = stepMode(s, make(), 0);
    expect(s.currentSpot).toBe(0); // 1/2 makes
    s = stepMode(s, miss(), 0);
    expect(s.currentSpot).toBe(0); // still 1/2
    s = stepMode(s, make(), 0);
    expect(s.currentSpot).toBe(1); // 2/2 ⇒ advance
    expect(s.spots?.[0]).toEqual({
      label: 'Left Corner',
      attempts: 3,
      makes: 2,
    });
  });

  test('completes after clearing all five spots', () => {
    let s = initMode('spotShooting', { makesPerSpot: 1 });
    for (let i = 0; i < 5; i++) s = stepMode(s, make(), 0);
    expect(s.done).toBe(true);
    expect(s.progress).toBe(1);
    expect(s.score).toBe(5); // total makes
  });

  test('default makesPerSpot is 5', () => {
    let s = initMode('spotShooting');
    for (let i = 0; i < 4; i++) s = stepMode(s, make(), 0);
    expect(s.currentSpot).toBe(0);
    s = stepMode(s, make(), 0);
    expect(s.currentSpot).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Timed Challenge
// ---------------------------------------------------------------------------

describe('gameModes / timed', () => {
  test('counts makes while the clock runs; arms started on first shot', () => {
    let s = initMode('timed', { durationSec: 60 });
    expect(s.started).toBeNull();
    s = stepMode(s, make(), 10); // arms at t=10
    expect(s.started).toBe(10);
    expect(s.score).toBe(1);
    s = stepMode(s, make(), 20);
    expect(s.score).toBe(2);
    expect(s.timeLeftSec).toBeCloseTo(50, 6);
    expect(s.done).toBe(false);
  });

  test('a shot after the buzzer does not count and finalizes', () => {
    let s = initMode('timed', { durationSec: 60 });
    s = stepMode(s, make(), 5); // start at 5, score 1
    s = stepMode(s, make(), 70); // 65s elapsed > 60 ⇒ over
    expect(s.done).toBe(true);
    expect(s.score).toBe(1);
    expect(s.timeLeftSec).toBe(0);
  });

  test('tickMode arms then counts down to done at zero', () => {
    let s = initMode('timed', { durationSec: 30 });
    s = tickMode(s, 100); // arm
    expect(s.started).toBe(100);
    s = tickMode(s, 110);
    expect(s.timeLeftSec).toBeCloseTo(20, 6);
    expect(s.done).toBe(false);
    s = tickMode(s, 130);
    expect(s.timeLeftSec).toBe(0);
    expect(s.done).toBe(true);
    expect(s.progress).toBe(1);
  });

  test('tickMode is a no-op for non-timed modes', () => {
    const s = initMode('free');
    expect(tickMode(s, 999)).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// 3-Point Contest
// ---------------------------------------------------------------------------

describe('gameModes / threePoint', () => {
  test('money ball (5th of each rack) is worth 2; others 1', () => {
    let s = initMode('threePoint');
    // Rack 1: balls 1-4 makes = 4 pts, ball 5 (money) make = 2 ⇒ 6.
    for (let i = 0; i < 4; i++) s = stepMode(s, make(), 0);
    expect(s.score).toBe(4);
    s = stepMode(s, make(), 0); // money ball
    expect(s.score).toBe(6);
  });

  test('a perfect contest scores 30 and completes after 25 balls', () => {
    // Per rack: four regular makes (1 each) + one money ball (2) = 6.
    // Five racks ⇒ 30. (Max possible in this scoring model.)
    let s = initMode('threePoint');
    for (let i = 0; i < 25; i++) s = stepMode(s, make(), 0);
    expect(s.done).toBe(true);
    expect(s.score).toBe(30);
  });

  test('misses score nothing but still consume a ball', () => {
    let s = initMode('threePoint');
    for (let i = 0; i < 25; i++) s = stepMode(s, miss(), 0);
    expect(s.done).toBe(true);
    expect(s.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Free Throw Streak
// ---------------------------------------------------------------------------

describe('gameModes / ftStreak', () => {
  test('streak grows on makes, resets on a miss, best is retained', () => {
    let s = initMode('ftStreak');
    s = stepMode(s, make(), 0);
    s = stepMode(s, make(), 0);
    s = stepMode(s, make(), 0);
    expect(s.score).toBe(3);
    expect(s.bestStreak).toBe(3);
    s = stepMode(s, miss(), 0);
    expect(s.score).toBe(0);
    expect(s.bestStreak).toBe(3);
    s = stepMode(s, make(), 0);
    expect(s.score).toBe(1);
    expect(s.bestStreak).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// H-O-R-S-E
// ---------------------------------------------------------------------------

describe('gameModes / horse', () => {
  test('call then match: no letter', () => {
    let s = initMode('horse');
    s = stepMode(s, make(), 0); // call
    expect(s.currentSpot).toBe(1);
    s = stepMode(s, make(), 0); // match
    expect(s.currentSpot).toBe(0);
    expect(s.letters).toBe('');
  });

  test('miss a called shot ⇒ take a letter, back to open', () => {
    let s = initMode('horse');
    s = stepMode(s, make(), 0); // call
    s = stepMode(s, miss(), 0); // fail to match ⇒ 'H'
    expect(s.letters).toBe('H');
    expect(s.currentSpot).toBe(0);
    expect(s.done).toBe(false);
  });

  test('open miss costs nothing', () => {
    let s = initMode('horse');
    s = stepMode(s, miss(), 0); // open miss
    expect(s.letters).toBe('');
    s = stepMode(s, miss(), 0);
    expect(s.letters).toBe('');
  });

  test('five failed called shots spell HORSE and end the game', () => {
    let s = initMode('horse');
    for (let i = 0; i < 5; i++) {
      s = stepMode(s, make(), 0); // call
      s = stepMode(s, miss(), 0); // fail ⇒ letter
    }
    expect(s.letters).toBe('HORSE');
    expect(s.done).toBe(true);
    expect(s.progress).toBe(1);
  });
});
