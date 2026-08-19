/**
 * Contract tests for the narrow replay/baseline read seam: queries must stay
 * column-scoped (no SELECT * — the multi-KB trajectoryJson/formJson blobs
 * must not ride along) and every failure mode must resolve to [] instead of
 * throwing into UI code.
 *
 * expo-sqlite is fully mocked — no native database is involved.
 */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  deleteDatabaseAsync: jest.fn(),
}));

type ReplayQueriesModule = typeof import('../replayQueries');
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
    // migrate() reads PRAGMA user_version; report 10 = already migrated
    // (arcJson column + form_sessions table present).
    getFirstAsync: jest.fn().mockResolvedValue({ user_version: 10 }),
    getAllAsync: jest.fn().mockResolvedValue([]),
    runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 5, changes: 1 }),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

let replayQueries: ReplayQueriesModule;
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
  replayQueries = require('../replayQueries');
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('sessionArcThumbs', () => {
  it('returns the resolved rows and binds the session id', async () => {
    const fake = fakeDatabase();
    const rows = [
      { shotIndex: 0, outcome: 'make', shotValue: 3, arcJson: '{"v":1}' },
      { shotIndex: 1, outcome: 'miss', shotValue: null, arcJson: null },
    ];
    fake.getAllAsync.mockResolvedValue(rows);
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await expect(replayQueries.sessionArcThumbs(7)).resolves.toEqual(rows);

    const [, sessionId] = fake.getAllAsync.mock.calls.at(-1) as [string, number];
    expect(sessionId).toBe(7);
  });

  it('selects ONLY the thumbnail columns, ordered by shotIndex (narrowness pin)', async () => {
    const fake = fakeDatabase();
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await replayQueries.sessionArcThumbs(3);

    const [sql] = fake.getAllAsync.mock.calls.at(-1) as [string, number];
    expect(sql).toContain('shotIndex, outcome, shotValue, arcJson');
    // No SELECT * — the multi-KB trajectoryJson/formJson blobs must not ride
    // along on a per-session thumbnail strip.
    expect(sql).not.toContain('*');
    expect(sql).not.toContain('trajectoryJson');
    expect(sql).not.toContain('formJson');
    expect(sql).toContain('ORDER BY shotIndex ASC');
  });
});

describe('recentFormShotRows', () => {
  it('filters to rows with a form report and binds the default limit', async () => {
    const fake = fakeDatabase();
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await replayQueries.recentFormShotRows();

    const [sql, limit] = fake.getAllAsync.mock.calls.at(-1) as [string, number];
    expect(sql).toContain('formJson IS NOT NULL');
    expect(sql).toContain('LIMIT ?');
    // Newest-first so a baseline rebuild sees the most recent form.
    expect(sql).toContain('ORDER BY id DESC');
    expect(sql).not.toContain('*');
    expect(sql).not.toContain('trajectoryJson');
    expect(limit).toBe(replayQueries.FORM_BASELINE_SCAN_LIMIT);
    expect(replayQueries.FORM_BASELINE_SCAN_LIMIT).toBe(200);
  });

  it('binds an explicit limit when given one', async () => {
    const fake = fakeDatabase();
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await replayQueries.recentFormShotRows(25);

    const [, limit] = fake.getAllAsync.mock.calls.at(-1) as [string, number];
    expect(limit).toBe(25);
  });
});

describe('never-throw contract', () => {
  it('returns [] and warns when the query itself rejects', async () => {
    const broken = fakeDatabase();
    broken.getAllAsync.mockRejectedValue(new Error('SQLITE_CORRUPT'));
    sqlite.openDatabaseAsync.mockResolvedValue(broken);

    await expect(replayQueries.sessionArcThumbs(1)).resolves.toEqual([]);
    await expect(replayQueries.recentFormShotRows()).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[replayQueries] sessionArcThumbs failed'),
      expect.any(Error),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[replayQueries] recentFormShotRows failed'),
      expect.any(Error),
    );
  });

  it('returns [] when the database cannot be opened at all', async () => {
    // getDb() retries once (delete + re-create); reject both attempts.
    sqlite.openDatabaseAsync.mockRejectedValue(new Error('no disk'));

    await expect(replayQueries.sessionArcThumbs(1)).resolves.toEqual([]);
    await expect(replayQueries.recentFormShotRows()).resolves.toEqual([]);
  });
});
