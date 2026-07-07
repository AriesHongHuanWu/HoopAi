/**
 * Crash-safety tests for the persistence layer: every public db function must
 * swallow failures (returning safe fallbacks) and a corrupt database must
 * trigger the one-time delete + re-create recovery.
 *
 * expo-sqlite is fully mocked — no native database is involved.
 */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  deleteDatabaseAsync: jest.fn(),
}));

import { emptyTotals } from '../achievements';

type DbModule = typeof import('../../data/db');
type SqliteMock = {
  openDatabaseAsync: jest.Mock;
  deleteDatabaseAsync: jest.Mock;
};

interface FakeDatabase {
  execAsync: jest.Mock;
  getFirstAsync: jest.Mock;
  getAllAsync: jest.Mock;
  runAsync: jest.Mock;
  withTransactionAsync: jest.Mock;
  closeAsync: jest.Mock;
}

function fakeDatabase(): FakeDatabase {
  return {
    execAsync: jest.fn().mockResolvedValue(undefined),
    // migrate() reads PRAGMA user_version; report 1 = already migrated.
    getFirstAsync: jest.fn().mockResolvedValue({ user_version: 1 }),
    getAllAsync: jest.fn().mockResolvedValue([]),
    runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 5, changes: 1 }),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

let db: DbModule;
let sqlite: SqliteMock;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  // db.ts keeps module-level state (cached promise, one-shot recovery flag) —
  // re-require a fresh copy for every test.
  jest.resetModules();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sqlite = require('expo-sqlite');
  sqlite.openDatabaseAsync.mockReset();
  sqlite.deleteDatabaseAsync.mockReset().mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  db = require('../../data/db');
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('corrupt database recovery', () => {
  it('deletes and re-creates the database when the first open fails', async () => {
    const fresh = fakeDatabase();
    sqlite.openDatabaseAsync
      .mockRejectedValueOnce(new Error('database disk image is malformed'))
      .mockResolvedValue(fresh);

    const id = await db.createSession({ startedAt: 1, keepMode: 'makes' });

    expect(id).toBe(5);
    expect(sqlite.deleteDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(sqlite.openDatabaseAsync).toHaveBeenCalledTimes(2);
  });

  it('returns safe fallbacks when even recovery fails, without throwing', async () => {
    sqlite.openDatabaseAsync.mockRejectedValue(new Error('no disk'));

    await expect(db.listSessions()).resolves.toEqual([]);
    await expect(db.getSession(1)).resolves.toBeNull();
    await expect(db.sessionShots(1)).resolves.toEqual([]);
    await expect(db.fgTrend()).resolves.toEqual([]);
    await expect(db.createSession({ startedAt: 1, keepMode: 'makes' })).resolves.toBe(-1);
    await expect(db.endSession(1, { endedAt: 2 })).resolves.toBeUndefined();
    // Recovery is attempted exactly once, not per call.
    expect(sqlite.deleteDatabaseAsync).toHaveBeenCalledTimes(1);
  });
});

describe('query failures return fallbacks', () => {
  it('write failures return the sentinel / resolve void', async () => {
    const broken = fakeDatabase();
    broken.runAsync.mockRejectedValue(new Error('SQLITE_FULL'));
    sqlite.openDatabaseAsync.mockResolvedValue(broken);

    await expect(db.createSession({ startedAt: 1, keepMode: 'makes' })).resolves.toBe(-1);
    await expect(db.endSession(1, { endedAt: 2 })).resolves.toBeUndefined();
    await expect(db.updateShotOutcome(1, 'miss')).resolves.toBeUndefined();
    await expect(db.setShotClipPath(1, '/x.mp4')).resolves.toBeUndefined();
    await expect(db.deleteSession(1)).resolves.toBeUndefined();
  });

  it('read failures return empty results', async () => {
    const broken = fakeDatabase();
    broken.getAllAsync.mockRejectedValue(new Error('SQLITE_CORRUPT'));
    sqlite.openDatabaseAsync.mockResolvedValue(broken);

    await expect(db.listSessions()).resolves.toEqual([]);
    await expect(db.sessionShots(3)).resolves.toEqual([]);
    const stats = await db.sessionStatsFromDb(3);
    expect(stats.attempts).toBe(0);
    // Lifetime totals fall back to all-zeros; career bests to null (NOT
    // zeros — zeros would let a broken read fire a false PB celebration).
    await expect(db.lifetimeTotals()).resolves.toEqual(emptyTotals());
    await expect(db.careerBests(1)).resolves.toBeNull();
  });
});

describe('lifetimeTotals session scan', () => {
  it('classifies tip-off hours, weekly cadence and mode results', async () => {
    const fake = fakeDatabase();
    sqlite.openDatabaseAsync.mockResolvedValue(fake);
    fake.getFirstAsync.mockImplementation(async (sql: string) => {
      if (sql.includes('user_version')) return { user_version: 1 };
      if (sql.includes('COUNT(DISTINCT sessionId)')) {
        return { sessions: 4, attempts: 30, makes: 15, threes: 4, correctedCalls: 7 };
      }
      return { best: 0.55 };
    });
    // Local-time Date constructor keeps the hour assertions timezone-proof.
    const at = (dayIdx: number, hour: number) =>
      new Date(2026, 0, 5 + dayIdx, hour, 30).getTime();
    fake.getAllAsync.mockImplementation(async (sql: string) => {
      if (sql.includes('modeResultJson')) {
        return [
          { startedAt: at(0, 23), modeId: null, modeResultJson: null },
          {
            startedAt: at(1, 6),
            modeId: 'aroundTheWorld',
            modeResultJson: JSON.stringify({ done: true, progress: 1 }),
          },
          { startedAt: at(2, 14), modeId: 'horse', modeResultJson: JSON.stringify({ done: true }) },
          { startedAt: at(2, 20), modeId: 'timed', modeResultJson: JSON.stringify({ done: false }) },
        ];
      }
      // Streak walk rows: 3 in a row in session 1, then a fresh session.
      return [
        { sessionId: 1, outcome: 'make' },
        { sessionId: 1, outcome: 'make' },
        { sessionId: 1, outcome: 'make' },
        { sessionId: 2, outcome: 'make' },
      ];
    });

    const totals = await db.lifetimeTotals();
    expect(totals.correctedCalls).toBe(7);
    expect(totals.nightSessions).toBe(1);
    expect(totals.dawnSessions).toBe(1);
    expect(totals.bestWeekSessions).toBe(4);
    expect(totals.atwWins).toBe(1);
    expect(totals.horseGames).toBe(1);
    expect(totals.modesPlayed).toBe(3);
    expect(totals.bestStreak).toBe(3);
    expect(totals.bestSessionFgPct).toBe(0.55);
  });
});

describe('careerBests', () => {
  it('excludes the given session id and walks streaks per session', async () => {
    const fake = fakeDatabase();
    sqlite.openDatabaseAsync.mockResolvedValue(fake);
    fake.getFirstAsync
      .mockResolvedValueOnce({ user_version: 1 }) // migrate
      .mockResolvedValueOnce({ mostMakes: 12, bestFg: 0.6 }); // aggregates
    fake.getAllAsync.mockResolvedValue([
      { sessionId: 2, outcome: 'make' },
      { sessionId: 2, outcome: 'make' },
      { sessionId: 2, outcome: 'miss' },
      { sessionId: 3, outcome: 'make' },
    ]);

    const bests = await db.careerBests(7);

    expect(bests).toEqual({ bestStreak: 2, bestFgPct: 0.6, mostMakes: 12 });
    // Both queries carry the exclusion parameter.
    expect(fake.getFirstAsync.mock.calls.at(-1)?.[1]).toBe(7);
    expect(fake.getAllAsync.mock.calls.at(-1)?.[1]).toBe(7);
  });
});

describe('updateShotOutcome', () => {
  it('stamps corrected=1 AND outcomeCorrected=1 by default (one-tap/swipe correction)', async () => {
    const fake = fakeDatabase();
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await db.updateShotOutcome(9, 'make');

    expect(fake.runAsync).toHaveBeenCalledWith(
      'UPDATE shots SET outcome = ?, corrected = ?, outcomeCorrected = ? WHERE id = ?',
      'make',
      1,
      1,
      9,
    );
  });

  it('clears both flags when restoring the original detection (undo / machine recheck)', async () => {
    const fake = fakeDatabase();
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await db.updateShotOutcome(9, 'miss', false);

    // corrected=false is the machine/undo path — it must NOT stamp
    // outcomeCorrected, or automated rechecks would masquerade as user
    // ground truth in the hard-example export.
    expect(fake.runAsync).toHaveBeenCalledWith(
      'UPDATE shots SET outcome = ?, corrected = ?, outcomeCorrected = ? WHERE id = ?',
      'miss',
      0,
      0,
      9,
    );
  });
});

describe('updateShotValue', () => {
  it('stamps corrected but NEVER outcomeCorrected — a 2↔3 fix is not an outcome error', async () => {
    const fake = fakeDatabase();
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await db.updateShotValue(9, 3);

    const [sql] = fake.runAsync.mock.calls.at(-1) as [string, ...unknown[]];
    expect(sql).toContain('corrected = 1');
    expect(sql).not.toContain('outcomeCorrected');
  });
});

describe('migrations', () => {
  it('v6 adds outcomeCorrected and backfills it from the legacy corrected flag', async () => {
    const fake = fakeDatabase();
    fake.getFirstAsync.mockResolvedValue({ user_version: 5 });
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await db.getDb();

    const v6 = fake.execAsync.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .find((s: string) => s.includes('outcomeCorrected'));
    expect(v6).toContain(
      'ALTER TABLE shots ADD COLUMN outcomeCorrected INTEGER NOT NULL DEFAULT 0',
    );
    // Pre-v6 rows can't tell outcome fixes from value fixes; copying keeps
    // previously-exported outcome corrections instead of dropping them.
    expect(v6).toContain('UPDATE shots SET outcomeCorrected = corrected');
    expect(v6).toContain('PRAGMA user_version = 6');
  });

  it('skips v6 when the database is already current', async () => {
    const fake = fakeDatabase();
    fake.getFirstAsync.mockResolvedValue({ user_version: 6 });
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await db.getDb();

    const v6 = fake.execAsync.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .find((s: string) => s.includes('outcomeCorrected'));
    expect(v6).toBeUndefined();
  });
});

describe('sessionShotOutcomes', () => {
  it('selects ONLY outcome + shotValue, ordered by shotIndex', async () => {
    const fake = fakeDatabase();
    fake.getAllAsync.mockResolvedValue([
      { outcome: 'make', shotValue: 3 },
      { outcome: 'miss', shotValue: null },
    ]);
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    const rows = await db.sessionShotOutcomes(7);

    expect(rows).toEqual([
      { outcome: 'make', shotValue: 3 },
      { outcome: 'miss', shotValue: null },
    ]);
    const [sql, sessionId] = fake.getAllAsync.mock.calls.at(-1) as [string, number];
    // Narrow on purpose: no SELECT * — the multi-KB trajectoryJson/formJson
    // blobs must not ride along on the every-Home-focus challenge rebuild.
    expect(sql).toContain('SELECT outcome, shotValue FROM shots');
    expect(sql).not.toContain('*');
    // Ordered so streak walks over the stream stay correct.
    expect(sql).toContain('ORDER BY shotIndex ASC');
    expect(sessionId).toBe(7);
  });

  it('returns an empty list when the database is unavailable, without throwing', async () => {
    sqlite.openDatabaseAsync.mockRejectedValue(new Error('no disk'));
    await expect(db.sessionShotOutcomes(1)).resolves.toEqual([]);
  });
});

describe('shotFromRow', () => {
  const baseRow = {
    id: 10,
    sessionId: 1,
    shotIndex: 2,
    tStart: 1,
    tResolved: 2,
    outcome: 'make' as const,
    corrected: 0,
    rimBounce: 1,
    entryAngleDeg: 45,
    releaseAngleDeg: 50,
    xCross: 320,
    originX: 0.5,
    originY: 0.9,
    signalsJson: '{"geo":true,"net":false,"cls":null}',
    trajectoryJson: '[{"cx":1,"cy":2,"r":3,"t":1,"score":0.9,"predicted":false}]',
    clipPath: null,
  };

  it('parses valid rows', () => {
    const shot = db.shotFromRow(baseRow);
    expect(shot.signals).toEqual({ geo: true, net: false, cls: null });
    expect(shot.trajectory).toHaveLength(1);
    expect(shot.rimBounce).toBe(true);
  });

  it('never throws on corrupt JSON columns', () => {
    const shot = db.shotFromRow({
      ...baseRow,
      signalsJson: 'not json at all',
      trajectoryJson: '[{truncated',
    });
    expect(shot.signals).toEqual({ geo: null, net: null, cls: null });
    expect(shot.trajectory).toEqual([]);
  });
});

describe('resetDatabase', () => {
  it('closes, deletes and re-opens; never throws even when steps fail', async () => {
    const first = fakeDatabase();
    const second = fakeDatabase();
    sqlite.openDatabaseAsync.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await db.getDb();
    await expect(db.resetDatabase()).resolves.toBeUndefined();

    expect(first.closeAsync).toHaveBeenCalledTimes(1);
    expect(sqlite.deleteDatabaseAsync).toHaveBeenCalledTimes(1);
    await expect(db.getDb()).resolves.toBe(second);
  });

  it('swallows a total reset failure', async () => {
    sqlite.openDatabaseAsync.mockRejectedValue(new Error('no disk'));
    sqlite.deleteDatabaseAsync.mockRejectedValue(new Error('locked'));
    await expect(db.resetDatabase()).resolves.toBeUndefined();
  });
});
