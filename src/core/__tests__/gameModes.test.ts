import {
  GAME_MODES,
  deriveGhostConfig,
  getModeDef,
  ghostMakesAt,
  initMode,
  shiftModeClock,
  stepMode,
  tickMode,
  type GhostConfig,
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

/** Ghost fixture: makes at +2s, +5s, +9s; the ghost session ran 10s. */
const GHOST_CFG: GhostConfig = {
  timeline: [
    { tOffsetSec: 2, makes: 1 },
    { tOffsetSec: 5, makes: 2 },
    { tOffsetSec: 9, makes: 3 },
  ],
  durationSec: 10,
};

/** initMode opts per mode — ghost needs a source timeline to race. */
const initOptsFor = (id: GameModeId) =>
  id === 'ghost' ? { ghost: GHOST_CFG } : undefined;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe('gameModes / catalog', () => {
  test('exactly the eight modes, each fully described', () => {
    const ids = GAME_MODES.map((m) => m.id);
    expect(ids).toEqual([
      'free',
      'aroundTheWorld',
      'spotShooting',
      'timed',
      'threePoint',
      'ftStreak',
      'horse',
      'ghost',
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
      const s = initMode(m.id, initOptsFor(m.id));
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
      const before = initMode(m.id, initOptsFor(m.id));
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

  // The live screen ticks at 4 Hz; the HUD displays whole seconds only
  // (message + TimerRing numeral both Math.ceil). Ticks inside one displayed
  // second must return the SAME object so the store skips the setState and
  // nothing re-renders.
  test('tickMode is identity-stable between displayed-second changes', () => {
    let s = initMode('timed', { durationSec: 30 });
    s = tickMode(s, 100); // arm at t=100 (timeLeft stays a full 30)
    // 0.25s later: ceil(29.75) = 30 = ceil(30) ⇒ nothing displayed changed.
    expect(tickMode(s, 100.25)).toBe(s);
    expect(tickMode(s, 100.9)).toBe(s);
    // Crossing into the next displayed second produces a fresh state…
    const next = tickMode(s, 101.2); // ceil(28.8) = 29
    expect(next).not.toBe(s);
    expect(next.timeLeftSec).toBeCloseTo(28.8, 6);
    expect(next.message).toContain('29s');
    // …and stays stable again until the following second boundary.
    expect(tickMode(next, 101.6)).toBe(next);
    expect(tickMode(next, 102.1)).not.toBe(next);
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

// ---------------------------------------------------------------------------
// Ghost Challenge
// ---------------------------------------------------------------------------

describe('gameModes / ghost', () => {
  const ghostInit = () => initMode('ghost', { ghost: GHOST_CFG });

  test('ghostMakesAt steps the pace: each make lands exactly at its offset', () => {
    const tl = GHOST_CFG.timeline;
    expect(ghostMakesAt(tl, 0)).toBe(0);
    expect(ghostMakesAt(tl, 1.999)).toBe(0);
    expect(ghostMakesAt(tl, 2)).toBe(1); // credited AT the offset, not before
    expect(ghostMakesAt(tl, 4.9)).toBe(1);
    expect(ghostMakesAt(tl, 5)).toBe(2);
    expect(ghostMakesAt(tl, 8.99)).toBe(2);
    expect(ghostMakesAt(tl, 9)).toBe(3);
    expect(ghostMakesAt(tl, 100)).toBe(3);
    expect(ghostMakesAt([], 100)).toBe(0);
  });

  test('deriveGhostConfig times the make timeline from the first decided shot', () => {
    const cfg = deriveGhostConfig([
      shot('miss', { tResolved: 10 }), // first decided shot ⇒ t0 = 10
      shot('make', { tResolved: 12 }),
      shot('unsure', { tResolved: 15 }), // ignored entirely
      shot('make', { tResolved: 20 }),
      shot('make', { tResolved: 30 }),
      shot('miss', { tResolved: 35 }), // last decided shot ⇒ duration 25
    ]);
    expect(cfg).not.toBeNull();
    expect(cfg?.timeline).toEqual([
      { tOffsetSec: 2, makes: 1 },
      { tOffsetSec: 10, makes: 2 },
      { tOffsetSec: 20, makes: 3 },
    ]);
    expect(cfg?.durationSec).toBe(25);
  });

  test('deriveGhostConfig guards: no shots / no makes / flat clock ⇒ null', () => {
    expect(deriveGhostConfig([])).toBeNull();
    expect(deriveGhostConfig([shot('unsure', { tResolved: 3 })])).toBeNull();
    expect(
      deriveGhostConfig([shot('miss', { tResolved: 1 }), shot('miss', { tResolved: 9 })]),
    ).toBeNull();
    // A single make is a zero-length session — nothing to race.
    expect(deriveGhostConfig([shot('make', { tResolved: 5 })])).toBeNull();
  });

  test('empty-ghost guard: no config or empty timeline starts done and stays done', () => {
    const bare = initMode('ghost');
    expect(bare.done).toBe(true);
    expect(stepMode(bare, make(), 0)).toBe(bare); // done ⇒ untouched
    expect(tickMode(bare, 5)).toBe(bare);

    const empty = initMode('ghost', { ghost: { timeline: [], durationSec: 10 } });
    expect(empty.done).toBe(true);
  });

  test('the race clock arms on YOUR first shot, never on a tick', () => {
    let s = ghostInit();
    expect(tickMode(s, 50)).toBe(s); // unarmed ⇒ tick is a strict no-op
    s = stepMode(s, make(), 100); // arms at t=100
    expect(s.started).toBe(100);
    expect(s.ghost?.yourMakes).toBe(1);
    expect(s.ghost?.ghostMakesNow).toBe(0); // ghost's first make is at +2s
    expect(s.ghost?.lead).toBe(1);
    expect(s.message).toBe('YOU 1 · GHOST 0 · +1');
    expect(s.messageTone).toBe('positive');
  });

  test('ticks advance the ghost pace between your shots; the lead can flip', () => {
    let s = ghostInit();
    s = stepMode(s, make(), 100); // you 1, ghost 0
    s = tickMode(s, 105); // elapsed 5 ⇒ ghost 2
    expect(s.ghost?.ghostMakesNow).toBe(2);
    expect(s.ghost?.lead).toBe(-1);
    expect(s.message).toBe('YOU 1 · GHOST 2 · -1');
    expect(s.messageTone).toBe('negative');
    s = stepMode(s, make(), 106); // you 2 ⇒ even
    expect(s.ghost?.lead).toBe(0);
    expect(s.message).toBe('YOU 2 · GHOST 2 · EVEN');
    expect(s.messageTone).toBe('neutral');
    expect(s.done).toBe(false);
  });

  test('a miss arms the clock but scores nothing', () => {
    let s = ghostInit();
    s = stepMode(s, miss(), 7);
    expect(s.started).toBe(7);
    expect(s.ghost?.yourMakes).toBe(0);
    expect(s.message).toBe('YOU 0 · GHOST 0 · EVEN');
  });

  test('win: ahead of the ghost total when its clock expires', () => {
    let s = ghostInit();
    s = stepMode(s, make(), 0);
    s = stepMode(s, make(), 1);
    s = stepMode(s, make(), 3);
    s = stepMode(s, make(), 4); // you 4 vs ghost final 3
    s = tickMode(s, 10); // elapsed 10 ⇒ clock expired
    expect(s.done).toBe(true);
    expect(s.progress).toBe(1);
    expect(s.timeLeftSec).toBe(0);
    expect(s.score).toBe(4);
    expect(s.ghost?.result).toBe('win');
    expect(s.ghost?.finalMargin).toBe(1);
    expect(s.ghost?.ghostMakesNow).toBe(3);
    expect(s.messageTone).toBe('positive');
  });

  test('loss: behind the ghost total at the buzzer', () => {
    let s = ghostInit();
    s = stepMode(s, make(), 0); // you 1 vs ghost final 3
    s = tickMode(s, 12);
    expect(s.done).toBe(true);
    expect(s.ghost?.result).toBe('loss');
    expect(s.ghost?.finalMargin).toBe(-2);
    expect(s.messageTone).toBe('negative');
  });

  test('tie: level with the ghost total at the buzzer', () => {
    let s = ghostInit();
    s = stepMode(s, make(), 0);
    s = stepMode(s, make(), 2);
    s = stepMode(s, make(), 4); // you 3 vs ghost final 3
    s = tickMode(s, 10);
    expect(s.done).toBe(true);
    expect(s.ghost?.result).toBe('tie');
    expect(s.ghost?.finalMargin).toBe(0);
    expect(s.messageTone).toBe('neutral');
  });

  test('a shot at/after the ghost clock does not count (buzzer rule)', () => {
    let s = ghostInit();
    s = stepMode(s, make(), 0); // you 1
    s = stepMode(s, make(), 10); // elapsed 10 ≥ 10 ⇒ finalize, shot ignored
    expect(s.done).toBe(true);
    expect(s.ghost?.yourMakes).toBe(1);
    expect(s.ghost?.result).toBe('loss');
  });

  test('config carries the timeline so replay re-inits an identical race', () => {
    const s = ghostInit();
    expect(initMode('ghost', s.config)).toEqual(ghostInit());
  });

  // Ghost races can run 30-60 minutes at a 4 Hz tick — a fresh state per tick
  // re-renders the whole live screen for the entire race. Ticks must return
  // the SAME object unless a DISPLAYED value moved: the race score
  // (ghostMakesNow / lead) or the whole-second clock (progress bar shows
  // whole percents, which whole-second quantization covers).
  test('tickGhost is identity-stable between display changes', () => {
    let s = ghostInit();
    s = stepMode(s, make(), 100); // arm; you 1, ghost 0, timeLeft 10
    s = tickMode(s, 100.3); // floor(9.7)=9 ≠ floor(10) ⇒ one fresh state
    // Sub-second ticks with the same score + same whole second: SAME object.
    expect(tickMode(s, 100.5)).toBe(s);
    expect(tickMode(s, 100.75)).toBe(s);
    // Crossing a whole second ⇒ new state.
    const nextSec = tickMode(s, 101.05); // floor(8.95) = 8
    expect(nextSec).not.toBe(s);
    // A ghost make forces an update even without waiting on the clock check —
    // the displayed race score changed (ghost's first make lands at +2s).
    const ghostScored = tickMode(nextSec, 102.0);
    expect(ghostScored).not.toBe(nextSec);
    expect(ghostScored.ghost?.ghostMakesNow).toBe(1);
    expect(ghostScored.ghost?.lead).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shiftModeClock — the real "pause" for tick-driven modes
// ---------------------------------------------------------------------------

describe('gameModes / shiftModeClock', () => {
  test('moves an armed timed clock forward by the gap (a real pause)', () => {
    let s = initMode('timed', { durationSec: 60 });
    s = tickMode(s, 100); // arm at t=100
    const shifted = shiftModeClock(s, 30); // e.g. 30s backgrounded
    expect(shifted.started).toBe(130);
    // The clock resumes where it left off instead of draining the gap:
    // 10s of real play after the shift reads 50s left, not 20s.
    expect(tickMode(shifted, 140).timeLeftSec).toBeCloseTo(50, 6);
  });

  test('pauses the ghost pace along with the clock', () => {
    let s = initMode('ghost', { ghost: GHOST_CFG });
    s = stepMode(s, make(), 100); // arm; ghost's first make lands at +2s
    const shifted = shiftModeClock(s, 60);
    expect(shifted.started).toBe(160);
    // 161 is only 1s of RACE time — the ghost has not scored yet.
    const ticked = tickMode(shifted, 161);
    expect(ticked.ghost?.ghostMakesNow).toBe(0);
    expect(ticked.done).toBe(false);
  });

  test('no-ops on unarmed, done, non-clock modes and non-positive deltas', () => {
    const unarmed = initMode('timed');
    expect(shiftModeClock(unarmed, 10)).toBe(unarmed);

    const freePlay: ModeState = { ...initMode('free'), started: 5 };
    expect(shiftModeClock(freePlay, 10)).toBe(freePlay);

    const finished: ModeState = { ...initMode('timed'), started: 5, done: true };
    expect(shiftModeClock(finished, 10)).toBe(finished);

    const ghostWaiting = initMode('ghost', { ghost: GHOST_CFG });
    expect(shiftModeClock(ghostWaiting, 10)).toBe(ghostWaiting); // pre-first-shot

    let armed = initMode('timed', { durationSec: 60 });
    armed = tickMode(armed, 100);
    expect(shiftModeClock(armed, 0)).toBe(armed);
    expect(shiftModeClock(armed, -5)).toBe(armed);
  });
});
