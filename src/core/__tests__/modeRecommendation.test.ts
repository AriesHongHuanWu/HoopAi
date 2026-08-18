import { GAME_MODES } from '../gameModes';
import {
  gameSectionModes,
  MODE_SECTIONS,
} from '../modeCatalogSections';
import {
  RECO_HALF_LIFE_DAYS,
  RECO_MIN_PLAYS,
  RECO_WINDOW_DAYS,
  recommendationReason,
  recommendFromSessions,
  type ModeRecommendation,
  type RecommendationInputRow,
} from '../modeRecommendation';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixed "now" so every test is deterministic (no Date.now anywhere). */
const NOW = 1_760_000_000_000;
const DAY_MS = 86_400_000;

/** A session row `daysAgo` days before NOW (negative = in the future). */
function row(
  daysAgo: number,
  modeId: string | null,
  modeResultJson: string | null = null,
): RecommendationInputRow {
  return { startedAt: NOW - daysAgo * DAY_MS, modeId, modeResultJson };
}

/** A finished-drill snapshot blob like the ones History persists. */
function drillJson(id: string, goals?: unknown): string {
  return JSON.stringify({
    modeId: 'spotShooting',
    config: { drill: goals === undefined ? { id } : { id, goals } },
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('recommendation constants', () => {
  it('exports the documented tuning values', () => {
    expect(RECO_WINDOW_DAYS).toBe(14);
    expect(RECO_MIN_PLAYS).toBe(2);
    expect(RECO_HALF_LIFE_DAYS).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Null cases (nothing to recommend)
// ---------------------------------------------------------------------------

describe('recommendFromSessions — null cases', () => {
  it('returns null for empty rows', () => {
    expect(recommendFromSessions([], NOW)).toBeNull();
  });

  it('returns null for a single play (below RECO_MIN_PLAYS)', () => {
    expect(recommendFromSessions([row(1, 'timed')], NOW)).toBeNull();
  });

  it('returns null when only free-play rows exist', () => {
    expect(
      recommendFromSessions([row(1, 'free'), row(2, 'free'), row(3, 'free')], NOW),
    ).toBeNull();
  });

  it('returns null when only ghost rows exist (ghost cannot be one-tap armed)', () => {
    expect(recommendFromSessions([row(1, 'ghost'), row(2, 'ghost')], NOW)).toBeNull();
  });

  it('returns null for null modeId rows (pre-v4 sessions)', () => {
    expect(recommendFromSessions([row(1, null), row(2, null)], NOW)).toBeNull();
  });

  it('returns null for unknown mode ids (forward-compat)', () => {
    expect(
      recommendFromSessions([row(1, 'futureMode'), row(2, 'futureMode')], NOW),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

describe('recommendFromSessions — recency window', () => {
  it('recommends a mode played twice within the window', () => {
    const reco = recommendFromSessions([row(1, 'timed'), row(3, 'timed')], NOW);
    expect(reco).toEqual({
      kind: 'mode',
      modeId: 'timed',
      playCount: 2,
      lastPlayedAt: NOW - 1 * DAY_MS,
    });
  });

  it('excludes rows older than 14 days', () => {
    // One in-window play + one at 15 days ago = playCount 1 → null.
    const reco = recommendFromSessions([row(1, 'timed'), row(15, 'timed')], NOW);
    expect(reco).toBeNull();
  });

  it('includes a slightly-future row (clock skew tolerance, +30min)', () => {
    const future: RecommendationInputRow = {
      startedAt: NOW + 30 * 60 * 1000,
      modeId: 'timed',
      modeResultJson: null,
    };
    const reco = recommendFromSessions([future, row(1, 'timed')], NOW);
    expect(reco).not.toBeNull();
    expect(reco).toMatchObject({ kind: 'mode', modeId: 'timed', playCount: 2 });
  });

  it('excludes a far-future row (+2 days)', () => {
    const reco = recommendFromSessions([row(-2, 'timed'), row(1, 'timed')], NOW);
    expect(reco).toBeNull(); // only 1 valid play
  });

  it('never throws on non-finite startedAt', () => {
    const bad: RecommendationInputRow = {
      startedAt: Number.NaN,
      modeId: 'timed',
      modeResultJson: null,
    };
    expect(recommendFromSessions([bad, row(1, 'timed')], NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Drill classification
// ---------------------------------------------------------------------------

describe('recommendFromSessions — drill classification', () => {
  it('classifies spotShooting rows carrying config.drill as that drill', () => {
    const reco = recommendFromSessions(
      [
        row(1, 'spotShooting', drillJson('ftLadder', [10])),
        row(2, 'spotShooting', drillJson('ftLadder', [10])),
      ],
      NOW,
    );
    expect(reco).toEqual({
      kind: 'drill',
      drillId: 'ftLadder',
      goals: [10],
      playCount: 2,
      lastPlayedAt: NOW - 1 * DAY_MS,
    });
  });

  it('treats corrupt/plain modeResultJson on spotShooting as the mode, never throwing', () => {
    for (const blob of ['not json', '42', 'null', '{}', null]) {
      const reco = recommendFromSessions(
        [row(1, 'spotShooting', blob), row(2, 'spotShooting', blob)],
        NOW,
      );
      expect(reco).toMatchObject({ kind: 'mode', modeId: 'spotShooting', playCount: 2 });
    }
  });

  it('ignores an unknown drill id inside the blob (falls back to the mode)', () => {
    const reco = recommendFromSessions(
      [
        row(1, 'spotShooting', drillJson('notADrill', [5])),
        row(2, 'spotShooting', drillJson('notADrill', [5])),
      ],
      NOW,
    );
    expect(reco).toMatchObject({ kind: 'mode', modeId: 'spotShooting' });
  });

  it('nulls goals that are not an array of finite numbers', () => {
    const reco = recommendFromSessions(
      [
        row(1, 'spotShooting', drillJson('ftLadder', [10, 'x'])),
        row(2, 'spotShooting', drillJson('ftLadder')),
      ],
      NOW,
    );
    expect(reco).toMatchObject({ kind: 'drill', drillId: 'ftLadder', goals: null });
  });

  it('takes goals from the MOST RECENT run', () => {
    const reco = recommendFromSessions(
      [
        row(5, 'spotShooting', drillJson('midClock', [10])), // older
        row(1, 'spotShooting', drillJson('midClock', [12, 12])), // newer
      ],
      NOW,
    );
    expect(reco).toEqual({
      kind: 'drill',
      drillId: 'midClock',
      goals: [12, 12],
      playCount: 2,
      lastPlayedAt: NOW - 1 * DAY_MS,
    });
  });

  it('takes the most-recent goals regardless of row order', () => {
    const reco = recommendFromSessions(
      [
        row(1, 'spotShooting', drillJson('midClock', [12, 12])), // newer first
        row(5, 'spotShooting', drillJson('midClock', [10])),
      ],
      NOW,
    );
    expect(reco).toMatchObject({ goals: [12, 12] });
  });
});

// ---------------------------------------------------------------------------
// Scoring: recency-weighted frequency
// ---------------------------------------------------------------------------

describe('recommendFromSessions — scoring', () => {
  it('half-life: 2 recent plays beat 3 stale plays', () => {
    // 3 × 0.5^(13/7) ≈ 0.83 < 2 × 0.5^(1/7) ≈ 1.81.
    const reco = recommendFromSessions(
      [
        row(13, 'horse'),
        row(13, 'horse'),
        row(13, 'horse'),
        row(1, 'ftStreak'),
        row(1, 'ftStreak'),
      ],
      NOW,
    );
    expect(reco).toMatchObject({ kind: 'mode', modeId: 'ftStreak', playCount: 2 });
  });

  it('more frequent wins when recency is equal', () => {
    const reco = recommendFromSessions(
      [row(2, 'timed'), row(2, 'timed'), row(2, 'horse')],
      NOW,
    );
    expect(reco).toMatchObject({ kind: 'mode', modeId: 'timed', playCount: 2 });
  });

  it('tie on score → later lastPlayedAt wins', () => {
    // Exact-arithmetic tie: ages 0d + 14d → 1 + 0.25 = 1.25;
    // ages 7d + 7d + 14d → 0.5 + 0.5 + 0.25 = 1.25 (all powers exact in IEEE).
    const reco = recommendFromSessions(
      [
        row(0, 'timed'),
        row(14, 'timed'),
        row(7, 'ftStreak'),
        row(7, 'ftStreak'),
        row(14, 'ftStreak'),
      ],
      NOW,
    );
    // ftStreak has MORE plays but timed played later at the same score.
    expect(reco).toEqual({
      kind: 'mode',
      modeId: 'timed',
      playCount: 2,
      lastPlayedAt: NOW,
    });
  });

  it('full tie between two modes → earlier catalog position wins', () => {
    // Identical timestamps for both → same score and lastPlayedAt.
    const reco = recommendFromSessions(
      [row(1, 'timed'), row(3, 'timed'), row(1, 'aroundTheWorld'), row(3, 'aroundTheWorld')],
      NOW,
    );
    // aroundTheWorld precedes timed in GAME_MODES.
    expect(reco).toMatchObject({ kind: 'mode', modeId: 'aroundTheWorld' });
  });

  it('full tie between a mode and a drill → the mode wins (documented)', () => {
    const reco = recommendFromSessions(
      [
        row(1, 'timed'),
        row(3, 'timed'),
        row(1, 'spotShooting', drillJson('ftLadder', [10])),
        row(3, 'spotShooting', drillJson('ftLadder', [10])),
      ],
      NOW,
    );
    expect(reco).toMatchObject({ kind: 'mode', modeId: 'timed' });
  });

  it('a drill can beat a mode outright', () => {
    const reco = recommendFromSessions(
      [
        row(1, 'spotShooting', drillJson('corners3', [5, 5])),
        row(1, 'spotShooting', drillJson('corners3', [5, 5])),
        row(1, 'spotShooting', drillJson('corners3', [5, 5])),
        row(13, 'timed'),
        row(13, 'timed'),
      ],
      NOW,
    );
    expect(reco).toMatchObject({ kind: 'drill', drillId: 'corners3', playCount: 3 });
  });

  it('is deterministic: the same input yields deep-equal output', () => {
    const rows = [
      row(1, 'timed'),
      row(2, 'spotShooting', drillJson('ftLadder', [10])),
      row(3, 'timed'),
      row(4, 'spotShooting', drillJson('ftLadder', [8])),
      row(5, 'horse'),
    ];
    const a = recommendFromSessions(rows, NOW);
    const b = recommendFromSessions(rows, NOW);
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reason copy (honesty: exact db-derived count)
// ---------------------------------------------------------------------------

describe('recommendationReason', () => {
  it('renders the exact play count', () => {
    const reco: ModeRecommendation = {
      kind: 'mode',
      modeId: 'timed',
      playCount: 3,
      lastPlayedAt: NOW,
    };
    expect(recommendationReason(reco)).toBe('Played 3× in the last 2 weeks');
  });

  it('works for drills too', () => {
    const reco: ModeRecommendation = {
      kind: 'drill',
      drillId: 'ftLadder',
      goals: [10],
      playCount: 2,
      lastPlayedAt: NOW,
    };
    expect(recommendationReason(reco)).toBe('Played 2× in the last 2 weeks');
  });
});

// ---------------------------------------------------------------------------
// Section taxonomy (modeCatalogSections)
// ---------------------------------------------------------------------------

describe('MODE_SECTIONS', () => {
  // UPDATED: 'challenges' was added between games and drills. "Challenge" used
  // to name four unrelated things across three tabs; this section is now the
  // one place the word means "a scored goal you can complete or share", and
  // its POSITION is part of the taxonomy — a challenge is a goal laid over
  // what you play, so it reads after Games and before the Drills it is not.
  it('has exactly the five sections in render order, challenges between games and drills', () => {
    expect(MODE_SECTIONS.map((s) => s.id)).toEqual([
      'quickStart',
      'games',
      'challenges',
      'drills',
      'tools',
    ]);
  });

  it('games and drills are collapsible; quickStart, challenges and tools are not', () => {
    const byId = new Map(MODE_SECTIONS.map((s) => [s.id, s]));
    expect(byId.get('games')?.collapsible).toBe(true);
    expect(byId.get('drills')?.collapsible).toBe(true);
    expect(byId.get('quickStart')?.collapsible).toBe(false);
    // Challenges is one card plus one tile — a toggle would cost more taps
    // than the height it saves, so it stays open like Quick start and Tools.
    expect(byId.get('challenges')?.collapsible).toBe(false);
    expect(byId.get('tools')?.collapsible).toBe(false);
  });

  it('keeps Drills named Drills — the section really does hold drills', () => {
    const byId = new Map(MODE_SECTIONS.map((s) => [s.id, s]));
    // Renaming Drills to Challenges would have moved the ambiguity rather than
    // removed it: spot routines with make goals are drills, not contests.
    expect(byId.get('drills')?.title).toBe('Drills');
    expect(byId.get('challenges')?.title).toBe('Challenges');
  });
});

describe('gameSectionModes', () => {
  it('returns the seven non-free modes in catalog order', () => {
    const modes = gameSectionModes();
    expect(modes).toHaveLength(7);
    expect(modes[0].id).toBe('aroundTheWorld');
    expect(modes.some((m) => m.id === 'free')).toBe(false);
    // Order preserved: the filtered list is GAME_MODES minus 'free'.
    expect(modes.map((m) => m.id)).toEqual(
      GAME_MODES.filter((m) => m.id !== 'free').map((m) => m.id),
    );
  });
});
