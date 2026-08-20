import { emptyStats } from '../stats';
import { bestRun, makeArcs, storyHeadline, zoneBreakdown } from '../sessionStory';
import type {
  BallSample,
  ResolvedShot,
  SessionStats,
  ShotOutcome,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nextId = 1;

/** Build a minimal valid ResolvedShot; ids auto-increment per call. */
function shot(outcome: ShotOutcome, over?: Partial<ResolvedShot>): ResolvedShot {
  return {
    id: nextId++,
    tStart: 0,
    tResolved: 0,
    outcome,
    signals: { geo: null, net: null, cls: false },
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

/** n trajectory samples along a trivial line — enough to be "drawable". */
function traj(n: number): BallSample[] {
  return Array.from({ length: n }, (_, i) => ({
    cx: 100 + i * 10,
    cy: 200 - i * 5,
    r: 10,
    t: i * 0.033,
    score: 0.9,
    predicted: false,
  }));
}

/** Hand-tweaked stats fixture for the headline copy table. */
function statsWith(over: Partial<SessionStats>): SessionStats {
  return { ...emptyStats(), ...over };
}

beforeEach(() => {
  nextId = 1;
});

// ---------------------------------------------------------------------------
// bestRun
// ---------------------------------------------------------------------------

describe('bestRun', () => {
  it('returns null for an empty session', () => {
    expect(bestRun([])).toBeNull();
  });

  it('returns null when the best run is shorter than 3 makes', () => {
    expect(bestRun([shot('make'), shot('make')])).toBeNull();
  });

  it('finds a plain 3-make run', () => {
    expect(bestRun([shot('make'), shot('make'), shot('make')])).toEqual({
      startIndex: 0,
      endIndex: 2,
      makes: 3,
    });
  });

  it('lets unsure shots pass through without counting or breaking', () => {
    const shots = [shot('make'), shot('unsure'), shot('make'), shot('make')];
    expect(bestRun(shots)).toEqual({ startIndex: 0, endIndex: 3, makes: 3 });
  });

  it('breaks the run on a miss', () => {
    const shots = [
      shot('make'),
      shot('make'),
      shot('miss'),
      shot('make'),
      shot('make'),
      shot('make'),
    ];
    expect(bestRun(shots)).toEqual({ startIndex: 3, endIndex: 5, makes: 3 });
  });

  it('keeps the earliest run on a tie', () => {
    const shots = [
      shot('make'),
      shot('make'),
      shot('make'),
      shot('miss'),
      shot('make'),
      shot('make'),
      shot('make'),
    ];
    expect(bestRun(shots)).toEqual({ startIndex: 0, endIndex: 2, makes: 3 });
  });

  it('returns null for a session made entirely of unsure shots', () => {
    expect(bestRun([shot('unsure'), shot('unsure'), shot('unsure')])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// zoneBreakdown
// ---------------------------------------------------------------------------

describe('zoneBreakdown', () => {
  it('buckets originX thirds into left/center/right', () => {
    const lines = zoneBreakdown([
      shot('make', { originX: 0.1 }),
      shot('miss', { originX: 0.5 }),
      shot('make', { originX: 0.9 }),
    ]);
    expect(lines.map((l) => l.zone)).toEqual(['left', 'center', 'right']);
    expect(lines[0]).toEqual({
      zone: 'left',
      label: 'Left',
      attempts: 1,
      makes: 1,
      decided: 1,
      fgPct: 1,
    });
    expect(lines[1]).toEqual({
      zone: 'center',
      label: 'Center',
      attempts: 1,
      makes: 0,
      decided: 1,
      fgPct: 0,
    });
    expect(lines[2]).toEqual({
      zone: 'right',
      label: 'Right',
      attempts: 1,
      makes: 1,
      decided: 1,
      fgPct: 1,
    });
  });

  it('skips shots with a null origin entirely', () => {
    const lines = zoneBreakdown([shot('make', { originX: null })]);
    for (const line of lines) {
      expect(line.attempts).toBe(0);
      expect(line.decided).toBe(0);
      expect(line.fgPct).toBeNull();
    }
  });

  it('counts unsure shots in attempts but not decided', () => {
    const lines = zoneBreakdown([
      shot('unsure', { originX: 0.5 }),
      shot('make', { originX: 0.5 }),
    ]);
    expect(lines[1]).toEqual({
      zone: 'center',
      label: 'Center',
      attempts: 2,
      makes: 1,
      decided: 1,
      fgPct: 1,
    });
  });

  it('distinguishes no-decided (null) from an honest 0% (0/2)', () => {
    const lines = zoneBreakdown([
      shot('unsure', { originX: 0.1 }), // left: attempts but nothing decided
      shot('miss', { originX: 0.5 }),
      shot('miss', { originX: 0.5 }),
    ]);
    expect(lines[0]!.fgPct).toBeNull();
    expect(lines[1]!.fgPct).toBe(0);
    expect(lines[1]!.decided).toBe(2);
  });

  it('always returns exactly 3 lines in left/center/right order', () => {
    const lines = zoneBreakdown([]);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.zone)).toEqual(['left', 'center', 'right']);
    expect(lines.map((l) => l.label)).toEqual(['Left', 'Center', 'Right']);
  });
});

// ---------------------------------------------------------------------------
// makeArcs
// ---------------------------------------------------------------------------

describe('makeArcs', () => {
  it('keeps only makes', () => {
    const arcs = makeArcs([
      shot('miss', { trajectory: traj(6) }),
      shot('unsure', { trajectory: traj(6) }),
      shot('make', { trajectory: traj(6) }),
    ]);
    expect(arcs).toHaveLength(1);
    expect(arcs[0]!.id).toBe(3);
  });

  it('drops a 3-sample trajectory and keeps a 4-sample one', () => {
    const arcs = makeArcs([
      shot('make', { trajectory: traj(3) }),
      shot('make', { trajectory: traj(4) }),
    ]);
    expect(arcs).toHaveLength(1);
    expect(arcs[0]!.id).toBe(2);
    expect(arcs[0]!.trajectory).toHaveLength(4);
  });

  it('caps at max, preserving session order', () => {
    const shots = Array.from({ length: 5 }, () =>
      shot('make', { trajectory: traj(5) }),
    );
    const arcs = makeArcs(shots, 3);
    expect(arcs.map((a) => a.id)).toEqual([1, 2, 3]);
  });

  it('defaults the cap to 12', () => {
    const shots = Array.from({ length: 20 }, () =>
      shot('make', { trajectory: traj(5) }),
    );
    expect(makeArcs(shots)).toHaveLength(12);
  });

  it('carries the entry angle through (null when unmeasured)', () => {
    const arcs = makeArcs([
      shot('make', { trajectory: traj(5), entryAngleDeg: 47.2 }),
      shot('make', { trajectory: traj(5) }),
    ]);
    expect(arcs[0]!.entryAngleDeg).toBe(47.2);
    expect(arcs[1]!.entryAngleDeg).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// storyHeadline — one test per branch of the copy table
// ---------------------------------------------------------------------------

describe('storyHeadline', () => {
  it('no attempts', () => {
    expect(storyHeadline(statsWith({ attempts: 0 }), null)).toBe(
      'No shots tracked this session.',
    );
  });

  it('caught fire (run of 5+)', () => {
    const run = { startIndex: 2, endIndex: 6, makes: 5 };
    expect(storyHeadline(statsWith({ attempts: 10 }), run)).toBe(
      'You caught fire — 5 straight at the peak.',
    );
  });

  it('best stretch (run of 3-4)', () => {
    const run = { startIndex: 0, endIndex: 2, makes: 3 };
    expect(storyHeadline(statsWith({ attempts: 10 }), run)).toBe(
      'Best stretch: 3 makes in a row.',
    );
  });

  it('steady night (fg >= 50% over 8+ attempts, no run)', () => {
    expect(storyHeadline(statsWith({ attempts: 8, fgPct: 0.5 }), null)).toBe(
      'A steady night — over half your looks dropped.',
    );
  });

  it('quick one (under 4 attempts, no run)', () => {
    expect(storyHeadline(statsWith({ attempts: 3, fgPct: 0.5 }), null)).toBe(
      'A quick one — every rep counts.',
    );
  });

  it('grind session (everything else)', () => {
    expect(storyHeadline(statsWith({ attempts: 10, fgPct: 0.3 }), null)).toBe(
      'Grind session — volume is how you build it.',
    );
  });
});
