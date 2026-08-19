/**
 * form_sessions persistence (db v10) — contract tests on a fully mocked
 * expo-sqlite (no native database).
 *
 * What these tests pin, and why:
 *  - The v10 migration runs from BOTH a fresh (v0) and a v9 database, and a
 *    v10 database gets NO DDL — the migration is additive and idempotent.
 *  - insertFormSession resolves -1 (+ console.warn) on failure, never
 *    throws — the report screen's "not saved" honesty line depends on it.
 *  - listFormSessions is a NARROW read: explicit column list, newest first,
 *    and it must never carry bestRepJson (the ~4 KB sequence blob) nor
 *    SELECT * — the sessionShotOutcomes precedent.
 *  - getFormSession returns null on failure; deleteFormSession never throws.
 *  - A corrupt summaryJson round-trips through the exported parseJson
 *    fallback without throwing — consumers decode with the same guard the
 *    shot readers use.
 */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  deleteDatabaseAsync: jest.fn(),
}));

type DbModule = typeof import('../db');
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

function fakeDatabase(userVersion = 10): FakeDatabase {
  return {
    execAsync: jest.fn().mockResolvedValue(undefined),
    getFirstAsync: jest.fn().mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('user_version')) {
        return { user_version: userVersion };
      }
      return null;
    }),
    getAllAsync: jest.fn().mockResolvedValue([]),
    runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 7, changes: 1 }),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

const FULL_ROW = {
  ts: 1723900000000,
  hand: 'right',
  handSource: 'auto',
  repCount: 8,
  medianPoseFps: 28.5,
  elbowSpreadDeg: 4.2,
  tempoSpreadMs: 96,
  kneeSpreadDeg: null,
  releaseHeightSpread: 0.021,
  releaseHeightM: 2.41,
  tiltDeg: -4,
  summaryJson: '{"reps":[]}',
  bestRepJson: '{"index":3}',
};

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
  db = require('../db');
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('v10 migration', () => {
  const formSessionDdl = (fake: FakeDatabase): string | undefined =>
    fake.execAsync.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .find((s: string) => s.includes('form_sessions'));

  it('creates form_sessions from a fresh (v0) database', async () => {
    const fake = fakeDatabase(0);
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await db.getDb();

    const ddl = formSessionDdl(fake);
    expect(ddl).toBeDefined();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS form_sessions');
    expect(ddl).toContain('PRAGMA user_version = 10');
    expect(ddl).toContain('idx_form_sessions_ts');
  });

  it('creates form_sessions when upgrading from v9', async () => {
    const fake = fakeDatabase(9);
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await db.getDb();

    const ddl = formSessionDdl(fake);
    expect(ddl).toBeDefined();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS form_sessions');
    expect(ddl).toContain('PRAGMA user_version = 10');
  });

  it('runs NO DDL on an already-current (v10) database', async () => {
    const fake = fakeDatabase(10);
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await db.getDb();

    expect(formSessionDdl(fake)).toBeUndefined();
    // The only exec on a current database is the WAL pragma.
    const nonWal = fake.execAsync.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .filter((s: string) => !s.includes('journal_mode'));
    expect(nonWal).toEqual([]);
  });
});

describe('insertFormSession', () => {
  it('binds every column and resolves the new row id', async () => {
    const fake = fakeDatabase();
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await expect(db.insertFormSession(FULL_ROW)).resolves.toBe(7);

    const call = fake.runAsync.mock.calls.at(-1) as unknown[];
    const [sql] = call as [string];
    expect(sql).toContain('INSERT INTO form_sessions');
    // 13 columns (id is AUTOINCREMENT) → sql + 13 bound params.
    expect(call).toHaveLength(14);
    expect(call).toContain('auto');
    expect(call).toContain('{"index":3}');
    // Unmeasured spread persists as null, never 0.
    expect(call[8]).toBeNull();
  });

  it('resolves -1 and warns on failure — never throws', async () => {
    const fake = fakeDatabase();
    fake.runAsync.mockRejectedValue(new Error('SQLITE_FULL'));
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await expect(db.insertFormSession(FULL_ROW)).resolves.toBe(-1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('insertFormSession failed'),
      expect.any(Error),
    );
  });

  it('resolves -1 when the database cannot be opened at all', async () => {
    sqlite.openDatabaseAsync.mockRejectedValue(new Error('no disk'));
    await expect(db.insertFormSession(FULL_ROW)).resolves.toBe(-1);
  });
});

describe('listFormSessions', () => {
  it('reads newest first with the default limit and returns the rows', async () => {
    const fake = fakeDatabase();
    const rows = [{ id: 2, ...FULL_ROW }];
    fake.getAllAsync.mockResolvedValue(rows);
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await expect(db.listFormSessions()).resolves.toEqual(rows);

    const [sql, limit] = fake.getAllAsync.mock.calls.at(-1) as [string, number];
    expect(sql).toContain('FROM form_sessions');
    expect(sql).toContain('ORDER BY ts DESC');
    expect(sql).toContain('LIMIT ?');
    expect(limit).toBe(30);
  });

  it('BLOB-EXCLUSION PIN: never selects bestRepJson and never SELECT *', async () => {
    const fake = fakeDatabase();
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await db.listFormSessions(8);

    const [sql, limit] = fake.getAllAsync.mock.calls.at(-1) as [string, number];
    // The Coach card scan must not page ~4 KB sequence blobs it never
    // renders (sessionShotOutcomes narrow-read precedent).
    expect(sql).not.toContain('bestRepJson');
    expect(sql).not.toContain('*');
    // The narrow row still carries the scalar trend columns.
    expect(sql).toContain('tempoSpreadMs');
    expect(sql).toContain('summaryJson');
    expect(limit).toBe(8);
  });

  it('returns [] on failure, without throwing', async () => {
    const fake = fakeDatabase();
    fake.getAllAsync.mockRejectedValue(new Error('SQLITE_CORRUPT'));
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await expect(db.listFormSessions()).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('listFormSessions failed'),
      expect.any(Error),
    );
  });
});

describe('getFormSession / deleteFormSession', () => {
  it('getFormSession returns the full row (including bestRepJson)', async () => {
    const fake = fakeDatabase();
    const row = { id: 5, ...FULL_ROW };
    fake.getFirstAsync.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('user_version')) {
        return { user_version: 10 };
      }
      return row;
    });
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await expect(db.getFormSession(5)).resolves.toEqual(row);
    const [sql, id] = fake.getFirstAsync.mock.calls.at(-1) as [string, number];
    expect(sql).toContain('FROM form_sessions WHERE id = ?');
    expect(id).toBe(5);
  });

  it('getFormSession returns null on failure, without throwing', async () => {
    const fake = fakeDatabase();
    fake.getFirstAsync.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('user_version')) {
        return { user_version: 10 };
      }
      throw new Error('SQLITE_BUSY');
    });
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await expect(db.getFormSession(5)).resolves.toBeNull();
  });

  it('deleteFormSession binds the id and never throws on failure', async () => {
    const fake = fakeDatabase();
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    await expect(db.deleteFormSession(4)).resolves.toBeUndefined();
    const [sql, id] = fake.runAsync.mock.calls.at(-1) as [string, number];
    expect(sql).toContain('DELETE FROM form_sessions WHERE id = ?');
    expect(id).toBe(4);

    fake.runAsync.mockRejectedValue(new Error('SQLITE_LOCKED'));
    await expect(db.deleteFormSession(4)).resolves.toBeUndefined();
  });
});

describe('corrupt summaryJson', () => {
  it('rows with corrupt JSON round-trip through parseJson to the fallback', async () => {
    const fake = fakeDatabase();
    const corrupt = { id: 3, ...FULL_ROW, summaryJson: '{"reps": [truncated' };
    fake.getAllAsync.mockResolvedValue([corrupt]);
    sqlite.openDatabaseAsync.mockResolvedValue(fake);

    const rows = await db.listFormSessions();
    expect(rows).toHaveLength(1);
    // The exported guarded decoder never throws; corrupt rows read as the
    // caller's fallback (the Coach card renders "no detail", not a crash).
    const summary = db.parseJson<{ reps: unknown[] }>(rows[0]!.summaryJson, {
      reps: [],
    });
    expect(summary).toEqual({ reps: [] });
    // Sanity: a healthy row decodes normally through the same path.
    expect(db.parseJson<{ reps: unknown[] }>(FULL_ROW.summaryJson, { reps: [] }))
      .toEqual({ reps: [] });
  });
});
