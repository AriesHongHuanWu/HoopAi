import {
  applyShot,
  createAccumulator,
  emptyStats,
  pushShot,
  recomputeStats,
  streakSoundFor,
  zoneOf,
} from '../stats';
import type {
  ResolvedShot,
  SessionStats,
  ShotOutcome,
  SoundEvent,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a ResolvedShot with sensible defaults. */
function shot(
  overrides: Partial<ResolvedShot> & { outcome: ShotOutcome },
): ResolvedShot {
  return {
    id: 1,
    tStart: 0,
    tResolved: 1,
    signals: { geo: null, net: null, cls: null },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: null,
    releaseAngleDeg: null,
    releasePoint: null,
    originX: null,
    originY: null,
    trajectory: [],
    ...overrides,
  };
}

function fold(shots: readonly ResolvedShot[]): SessionStats {
  let stats = emptyStats();
  for (const s of shots) stats = applyShot(stats, s);
  return stats;
}

// numpy fixtures (np.mean / np.std, default ddof=0 — population std):
// entry   [44.2, 47.8, 41.5, 50.1, 45.9] -> mean 45.9, std 2.949576240750525
// release [48.0, 52.5, 46.3, 55.0, 50.2] -> mean 50.4, std 3.1041907157905113
// entry   [44.2, 47.8]                   -> mean 46.0, std 1.8
const ENTRY_ANGLES = [44.2, 47.8, 41.5, 50.1, 45.9];
const RELEASE_ANGLES = [48.0, 52.5, 46.3, 55.0, 50.2];

describe('stats', () => {
  // -------------------------------------------------------------------------
  // emptyStats
  // -------------------------------------------------------------------------

  test('emptyStats: all zeroes, null angles, zeroed zones', () => {
    expect(emptyStats()).toEqual({
      attempts: 0,
      makes: 0,
      misses: 0,
      unsure: 0,
      fgPct: 0,
      currentStreak: 0,
      bestStreak: 0,
      avgEntryAngleDeg: null,
      entryAngleStdDeg: null,
      avgReleaseAngleDeg: null,
      releaseAngleStdDeg: null,
      byZone: {
        left: { attempts: 0, makes: 0, fgPct: 0 },
        center: { attempts: 0, makes: 0, fgPct: 0 },
        right: { attempts: 0, makes: 0, fgPct: 0 },
      },
    });
  });

  test('emptyStats: returns a fresh object each call', () => {
    expect(emptyStats()).not.toBe(emptyStats());
  });

  // -------------------------------------------------------------------------
  // zoneOf
  // -------------------------------------------------------------------------

  test('zoneOf: thirds of normalized x', () => {
    expect(zoneOf(0)).toBe('left');
    expect(zoneOf(0.32)).toBe('left');
    expect(zoneOf(0.5)).toBe('center');
    expect(zoneOf(0.65)).toBe('center');
    expect(zoneOf(0.7)).toBe('right');
    expect(zoneOf(1)).toBe('right');
  });

  test('zoneOf: boundaries — exactly 1/3 is center, exactly 2/3 is right', () => {
    expect(zoneOf(1 / 3)).toBe('center');
    expect(zoneOf(2 / 3)).toBe('right');
  });

  test('zoneOf: null passes through', () => {
    expect(zoneOf(null)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // applyShot: counts / fgPct
  // -------------------------------------------------------------------------

  test('fgPct excludes unsure shots', () => {
    const s = fold([
      shot({ outcome: 'make' }),
      shot({ outcome: 'miss' }),
      shot({ outcome: 'unsure' }),
      shot({ outcome: 'make' }),
    ]);
    expect(s.attempts).toBe(4);
    expect(s.makes).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.unsure).toBe(1);
    expect(s.fgPct).toBeCloseTo(2 / 3, 12);
  });

  test('fgPct is 0 when only unsure shots exist', () => {
    const s = fold([shot({ outcome: 'unsure' }), shot({ outcome: 'unsure' })]);
    expect(s.attempts).toBe(2);
    expect(s.fgPct).toBe(0);
  });

  test('applyShot does not mutate its input and returns a new object', () => {
    const before = fold([shot({ outcome: 'make', originX: 0.5 })]);
    const snapshot = JSON.parse(JSON.stringify(before));
    const after = applyShot(
      before,
      shot({ outcome: 'miss', originX: 0.5, entryAngleDeg: 45 }),
    );
    expect(after).not.toBe(before);
    expect(after.byZone).not.toBe(before.byZone);
    expect(after.byZone.center).not.toBe(before.byZone.center);
    expect(before).toEqual(snapshot);
  });

  // -------------------------------------------------------------------------
  // Streaks
  // -------------------------------------------------------------------------

  test('makes extend currentStreak and bestStreak; miss zeroes current only', () => {
    const s = fold([
      shot({ outcome: 'make' }),
      shot({ outcome: 'make' }),
      shot({ outcome: 'make' }),
      shot({ outcome: 'miss' }),
      shot({ outcome: 'make' }),
    ]);
    expect(s.currentStreak).toBe(1);
    expect(s.bestStreak).toBe(3);
  });

  test('unsure leaves both streaks untouched', () => {
    const s = fold([
      shot({ outcome: 'make' }),
      shot({ outcome: 'make' }),
      shot({ outcome: 'unsure' }),
      shot({ outcome: 'make' }),
    ]);
    expect(s.currentStreak).toBe(3);
    expect(s.bestStreak).toBe(3);

    const t = fold([shot({ outcome: 'miss' }), shot({ outcome: 'unsure' })]);
    expect(t.currentStreak).toBe(0);
    expect(t.bestStreak).toBe(0);
  });

  test('bestStreak is retained across a later shorter run', () => {
    const s = fold([
      shot({ outcome: 'make' }),
      shot({ outcome: 'make' }),
      shot({ outcome: 'make' }),
      shot({ outcome: 'make' }),
      shot({ outcome: 'miss' }),
      shot({ outcome: 'make' }),
      shot({ outcome: 'make' }),
    ]);
    expect(s.currentStreak).toBe(2);
    expect(s.bestStreak).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Angle running stats (vs numpy fixtures)
  // -------------------------------------------------------------------------

  test('running avg/std match numpy over decided shots', () => {
    const shots = ENTRY_ANGLES.map((e, i) =>
      shot({
        outcome: i % 2 === 0 ? 'make' : 'miss',
        entryAngleDeg: e,
        releaseAngleDeg: RELEASE_ANGLES[i],
      }),
    );
    const s = fold(shots);
    expect(s.avgEntryAngleDeg).toBeCloseTo(45.9, 10);
    expect(s.entryAngleStdDeg).toBeCloseTo(2.949576240750525, 10);
    expect(s.avgReleaseAngleDeg).toBeCloseTo(50.4, 10);
    expect(s.releaseAngleStdDeg).toBeCloseTo(3.1041907157905113, 10);
  });

  test('single decided shot: avg = value, std = 0 (population)', () => {
    const s = fold([
      shot({ outcome: 'make', entryAngleDeg: 44.2, releaseAngleDeg: 48.0 }),
    ]);
    expect(s.avgEntryAngleDeg).toBe(44.2);
    expect(s.entryAngleStdDeg).toBe(0);
    expect(s.avgReleaseAngleDeg).toBe(48.0);
    expect(s.releaseAngleStdDeg).toBe(0);
  });

  test('unsure shots and null angles are excluded from angle stats', () => {
    const s = fold([
      shot({ outcome: 'make', entryAngleDeg: 44.2 }),
      // unsure: its angle must NOT count even though present
      shot({ outcome: 'unsure', entryAngleDeg: 90 }),
      shot({ outcome: 'miss', entryAngleDeg: 47.8 }),
      // decided but angle unavailable: must not inflate the sample count
      shot({ outcome: 'make', entryAngleDeg: null }),
    ]);
    // numpy over [44.2, 47.8]: mean 46.0, population std 1.8
    expect(s.avgEntryAngleDeg).toBeCloseTo(46.0, 10);
    expect(s.entryAngleStdDeg).toBeCloseTo(1.8, 10);
    // no release angles at all
    expect(s.avgReleaseAngleDeg).toBeNull();
    expect(s.releaseAngleStdDeg).toBeNull();
  });

  test('applyShot on a foreign (hand-built) stats object still works', () => {
    // Not produced by this module — exercises the reconstruction fallback.
    const foreign: SessionStats = {
      attempts: 2,
      makes: 2,
      misses: 0,
      unsure: 0,
      fgPct: 1,
      currentStreak: 2,
      bestStreak: 2,
      avgEntryAngleDeg: 46.0,
      entryAngleStdDeg: 1.8,
      avgReleaseAngleDeg: null,
      releaseAngleStdDeg: null,
      byZone: {
        left: { attempts: 0, makes: 0, fgPct: 0 },
        center: { attempts: 2, makes: 2, fgPct: 1 },
        right: { attempts: 0, makes: 0, fgPct: 0 },
      },
    };
    const s = applyShot(
      foreign,
      shot({ outcome: 'miss', entryAngleDeg: 41.5, originX: 0.5 }),
    );
    expect(s.attempts).toBe(3);
    expect(s.fgPct).toBeCloseTo(2 / 3, 12);
    expect(s.currentStreak).toBe(0);
    expect(s.bestStreak).toBe(2);
    // numpy over [44.2, 47.8, 41.5]: mean 44.5, population std 2.5806975801127865
    expect(s.avgEntryAngleDeg).toBeCloseTo(44.5, 10);
    expect(s.entryAngleStdDeg).toBeCloseTo(2.5806975801127865, 10);
    expect(s.byZone.center).toEqual({ attempts: 3, makes: 2, fgPct: 2 / 3 });
  });

  // -------------------------------------------------------------------------
  // Zone bucketing
  // -------------------------------------------------------------------------

  test('zone bucketing incl. null origin and unsure exclusion from zone fgPct', () => {
    const s = fold([
      shot({ outcome: 'make', originX: 0.1 }), // left make
      shot({ outcome: 'miss', originX: 0.5 }), // center miss
      shot({ outcome: 'make', originX: 0.5 }), // center make
      shot({ outcome: 'unsure', originX: 0.9 }), // right unsure
      shot({ outcome: 'make', originX: 0.9 }), // right make
      shot({ outcome: 'miss', originX: null }), // no origin: not bucketed
    ]);
    expect(s.byZone.left).toEqual({ attempts: 1, makes: 1, fgPct: 1 });
    expect(s.byZone.center).toEqual({ attempts: 2, makes: 1, fgPct: 0.5 });
    // Right: 2 attempts (unsure counts as attempt) but fgPct over decided only.
    expect(s.byZone.right).toEqual({ attempts: 2, makes: 1, fgPct: 1 });
    // Null-origin shot counted globally but in no zone.
    expect(s.attempts).toBe(6);
    const zoneAttempts =
      s.byZone.left.attempts + s.byZone.center.attempts + s.byZone.right.attempts;
    expect(zoneAttempts).toBe(5);
  });

  // -------------------------------------------------------------------------
  // recomputeStats (user correction flow)
  // -------------------------------------------------------------------------

  test('recomputeStats after flipping one outcome matches folding the corrected list', () => {
    const original: ResolvedShot[] = [
      shot({ id: 1, outcome: 'make', entryAngleDeg: 44.2, originX: 0.2 }),
      shot({ id: 2, outcome: 'miss', entryAngleDeg: 47.8, originX: 0.5 }),
      shot({ id: 3, outcome: 'make', entryAngleDeg: 41.5, originX: 0.5 }),
      shot({ id: 4, outcome: 'unsure', originX: 0.8 }),
      shot({ id: 5, outcome: 'make', entryAngleDeg: 50.1, originX: 0.9 }),
    ];
    // User flips shot 2 from miss to make.
    const corrected = original.map((sh) =>
      sh.id === 2 ? { ...sh, outcome: 'make' as const, corrected: true } : sh,
    );

    const recomputed = recomputeStats(corrected);
    expect(recomputed).toEqual(fold(corrected));

    expect(recomputed.makes).toBe(4);
    expect(recomputed.misses).toBe(0);
    expect(recomputed.fgPct).toBe(1);
    // Streak now runs through the corrected miss (unsure does not break it).
    expect(recomputed.currentStreak).toBe(4);
    expect(recomputed.bestStreak).toBe(4);
    // Angle stats unchanged by the flip (same decided angle samples).
    expect(recomputed.avgEntryAngleDeg).toBeCloseTo(
      recomputeStats(original).avgEntryAngleDeg as number,
      10,
    );
  });

  test('recomputeStats of empty list equals emptyStats', () => {
    expect(recomputeStats([])).toEqual(emptyStats());
  });

  // -------------------------------------------------------------------------
  // Accumulator API
  // -------------------------------------------------------------------------

  test('pushShot collects decided non-null angles and derives identical stats', () => {
    const shots = [
      shot({ outcome: 'make', entryAngleDeg: 44.2, releaseAngleDeg: 48.0 }),
      shot({ outcome: 'unsure', entryAngleDeg: 90, releaseAngleDeg: 90 }),
      shot({ outcome: 'miss', entryAngleDeg: 47.8, releaseAngleDeg: null }),
    ];
    let acc = createAccumulator();
    for (const sh of shots) acc = pushShot(acc, sh);

    expect(acc.angles.entry).toEqual([44.2, 47.8]);
    expect(acc.angles.release).toEqual([48.0]);
    expect(acc.stats).toEqual(recomputeStats(shots));
  });

  test('pushShot is immutable: the input accumulator is unchanged', () => {
    const acc0 = createAccumulator();
    const acc1 = pushShot(
      acc0,
      shot({ outcome: 'make', entryAngleDeg: 45, releaseAngleDeg: 50 }),
    );
    expect(acc1).not.toBe(acc0);
    expect(acc0.angles.entry).toEqual([]);
    expect(acc0.angles.release).toEqual([]);
    expect(acc0.stats.attempts).toBe(0);
    expect(acc1.angles.entry).toEqual([45]);
    expect(acc1.stats.attempts).toBe(1);
  });

  // -------------------------------------------------------------------------
  // streakSoundFor
  // -------------------------------------------------------------------------

  test('streak sounds fire exactly at 3/5/10', () => {
    expect(streakSoundFor(1, 'make')).toBe('make');
    expect(streakSoundFor(2, 'make')).toBe('make');
    expect(streakSoundFor(3, 'make')).toBe('streak3');
    expect(streakSoundFor(4, 'make')).toBe('make');
    expect(streakSoundFor(5, 'make')).toBe('streak5');
    expect(streakSoundFor(6, 'make')).toBe('make');
    expect(streakSoundFor(9, 'make')).toBe('make');
    expect(streakSoundFor(10, 'make')).toBe('streak10');
    expect(streakSoundFor(11, 'make')).toBe('make');
  });

  test('miss plays miss regardless of streak; unsure is silent (null)', () => {
    expect(streakSoundFor(0, 'miss')).toBe('miss');
    expect(streakSoundFor(3, 'miss')).toBe('miss');
    expect(streakSoundFor(0, 'unsure')).toBeNull();
    expect(streakSoundFor(3, 'unsure')).toBeNull();
  });

  test('integration: sounds during an 11-make run fire at 3, 5, 10 only', () => {
    let stats = emptyStats();
    const sounds: (SoundEvent | null)[] = [];
    for (let i = 0; i < 11; i++) {
      const sh = shot({ outcome: 'make' });
      stats = applyShot(stats, sh);
      sounds.push(streakSoundFor(stats.currentStreak, sh.outcome));
    }
    expect(sounds).toEqual([
      'make',
      'make',
      'streak3',
      'make',
      'streak5',
      'make',
      'make',
      'make',
      'make',
      'streak10',
      'make',
    ]);
  });
});
