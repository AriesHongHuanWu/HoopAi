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
