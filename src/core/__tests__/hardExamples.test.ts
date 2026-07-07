/**
 * hardExamples: assembly of the correction-flywheel manifest from a seeded
 * (fully mocked) database, the clipPlanner window math shifted into video
 * time, and the never-throw write + share export pipeline.
 *
 * expo-sqlite, expo-file-system and RN Share are mocked — no native database,
 * filesystem or share sheet is involved (db.test.ts / csvExport.test.ts idioms).
 */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  deleteDatabaseAsync: jest.fn(),
}));

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (obj: Record<string, unknown>) => obj.ios },
  Share: { share: jest.fn().mockResolvedValue({ action: 'sharedAction' }) },
}));

jest.mock('expo-device', () => ({ modelName: 'iPhone 15 Pro' }));

jest.mock('expo-constants', () => ({ expoConfig: { version: '1.0.0' } }));

import type { HardExampleManifest } from '../../data/hardExamples';

type HardExamplesModule = typeof import('../../data/hardExamples');
type SqliteMock = {
  openDatabaseAsync: jest.Mock;
  deleteDatabaseAsync: jest.Mock;
};
type FileSystemMock = { cacheDirectory: string | null; writeAsStringAsync: jest.Mock };
type ReactNativeMock = { Platform: { OS: string }; Share: { share: jest.Mock } };

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
    // migrate() reads PRAGMA user_version; report 6 = already migrated.
    getFirstAsync: jest.fn().mockResolvedValue({ user_version: 6 }),
    getAllAsync: jest.fn().mockResolvedValue([]),
    runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 5, changes: 1 }),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

/** Seeded joined shot+session row, as the hard-example query returns it. */
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: 7,
    shotIndex: 3,
    tResolved: 100,
    outcome: 'miss',
    // The user hand-flipped this shot's OUTCOME (see db.ts v6) — the flag
    // the hard-example filter keys on, not the general `corrected`.
    outcomeCorrected: 1,
    rimBounce: 0,
    signalsJson: '{"geo":true,"net":false,"cls":null}',
    videoPath: '/videos/session-7.mp4',
    recordingStartSec: 90,
    ...overrides,
  };
}

let hardExamples: HardExamplesModule;
let sqlite: SqliteMock;
let fs: FileSystemMock;
let rn: ReactNativeMock;
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
  fs = require('expo-file-system/legacy');
  fs.cacheDirectory = 'file:///cache/';
  fs.writeAsStringAsync.mockReset().mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  rn = require('react-native');
  rn.Platform.OS = 'ios';
  rn.Share.share.mockReset().mockResolvedValue({ action: 'sharedAction' });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  hardExamples = require('../../data/hardExamples');
});

afterEach(() => {
  warnSpy.mockRestore();
});

/** Seed a fake db whose hard-example query resolves the given rows. */
function seed(rows: unknown[]): FakeDatabase {
  const db = fakeDatabase();
  db.getAllAsync.mockResolvedValue(rows);
  sqlite.openDatabaseAsync.mockResolvedValue(db);
  return db;
}

describe('collectHardExamples', () => {
  it('assembles one example per row with clipPlanner windows in video time', async () => {
    seed([
      row(), // outcome-corrected miss, tResolved 100, recording starts at 90
      row({
        shotIndex: 5,
        tResolved: 120,
        outcome: 'unsure',
        outcomeCorrected: 0,
        rimBounce: 1,
        signalsJson: '{"geo":null,"net":true,"cls":null}',
      }),
    ]);

    const examples = await hardExamples.collectHardExamples();

    expect(examples).toHaveLength(2);
    // videoTime = 100 − 90 = 10; window = [10 − 6, 10 + 2] (CLIPS pre/post roll).
    expect(examples[0]).toEqual({
      sessionId: 7,
      shotId: 3,
      originalOutcome: null, // Correction overwrote the detector's call.
      correctedOutcome: 'miss',
      corrected: true,
      signals: { geo: true, net: false, cls: null },
      rimBounce: false,
      videoPath: '/videos/session-7.mp4',
      windowStartSec: 4,
      windowEndSec: 12,
      deviceInfo: { os: 'ios', model: 'iPhone 15 Pro' },
      appVersion: '1.0.0',
    });
    // Uncorrected unsure: the persisted outcome IS the detector's call.
    expect(examples[1].originalOutcome).toBe('unsure');
    expect(examples[1].correctedOutcome).toBeNull();
    expect(examples[1].corrected).toBe(false);
    expect(examples[1].rimBounce).toBe(true);
    expect(examples[1].windowStartSec).toBe(24);
    expect(examples[1].windowEndSec).toBe(32);
  });

  it('clamps the window start at the beginning of the video', async () => {
    // videoTime = 92 − 90 = 2 < preRoll → start floors at 0.
    seed([row({ tResolved: 92 })]);
    const [example] = await hardExamples.collectHardExamples();
    expect(example.windowStartSec).toBe(0);
    expect(example.windowEndSec).toBe(4);
  });

  it('skips shots whose window falls entirely before the recording started', async () => {
    seed([row({ tResolved: 80 })]); // videoTime −10 → empty window.
    await expect(hardExamples.collectHardExamples()).resolves.toEqual([]);
  });

  it('never throws on corrupt signalsJson — falls back to null signals', async () => {
    seed([row({ signalsJson: 'not json at all' })]);
    const [example] = await hardExamples.collectHardExamples();
    expect(example.signals).toEqual({ geo: null, net: null, cls: null });
  });

  it('queries only OUTCOME-corrected/unsure shots of recorded sessions, newest first, with the limit', async () => {
    const db = seed([]);
    await hardExamples.collectHardExamples(25);
    const [sql, limit] = db.getAllAsync.mock.calls[0];
    // Filters on outcomeCorrected — the general `corrected` flag is also set
    // by value-only 2↔3 fixes, which are NOT detector outcome mistakes and
    // must never pollute the training export.
    expect(sql).toContain("(sh.outcomeCorrected = 1 OR sh.outcome = 'unsure')");
    expect(sql).not.toContain('sh.corrected');
    expect(sql).toContain('s.videoPath IS NOT NULL');
    expect(sql).toContain('s.recordingStartSec IS NOT NULL');
    expect(sql).toContain('ORDER BY s.startedAt DESC');
    expect(limit).toBe(25);
  });

  it('defaults the collect limit to the 500-example export cap', async () => {
    const db = seed([]);
    await hardExamples.collectHardExamples();
    const [, limit] = db.getAllAsync.mock.calls[0];
    expect(limit).toBe(hardExamples.HARD_EXAMPLE_EXPORT_LIMIT);
    expect(hardExamples.HARD_EXAMPLE_EXPORT_LIMIT).toBe(500);
  });

  it('returns an empty list when the database is unavailable, without throwing', async () => {
    sqlite.openDatabaseAsync.mockRejectedValue(new Error('no disk'));
    await expect(hardExamples.collectHardExamples()).resolves.toEqual([]);
  });
});

describe('countHardExamples', () => {
  it('reports the COUNT(*) over the same hard-example filter', async () => {
    const db = fakeDatabase();
    db.getFirstAsync.mockImplementation(async (sql: string) =>
      sql.includes('user_version') ? { user_version: 6 } : { n: 4 },
    );
    sqlite.openDatabaseAsync.mockResolvedValue(db);

    await expect(hardExamples.countHardExamples()).resolves.toBe(4);
    const countSql = db.getFirstAsync.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .find((s: string) => s.includes('COUNT(*)'));
    expect(countSql).toContain("(sh.outcomeCorrected = 1 OR sh.outcome = 'unsure')");
    expect(countSql).toContain('s.videoPath IS NOT NULL');
  });

  it('reports 0 when the database is unavailable, without throwing', async () => {
    sqlite.openDatabaseAsync.mockRejectedValue(new Error('no disk'));
    await expect(hardExamples.countHardExamples()).resolves.toBe(0);
  });
});

describe('buildManifest', () => {
  it('wraps examples in a versioned envelope with the no-video note', async () => {
    seed([row()]);
    const examples = await hardExamples.collectHardExamples();
    const manifest = hardExamples.buildManifest(examples, Date.UTC(2026, 6, 7, 12));
    expect(manifest.format).toBe('hoopilot-hard-examples');
    expect(manifest.version).toBe(1);
    expect(manifest.exportedAt).toBe('2026-07-07T12:00:00.000Z');
    expect(manifest.exampleCount).toBe(1);
    expect(manifest.examples).toEqual(examples);
    expect(manifest.note).toContain('no video is included');
  });
});

describe('exportHardExamples', () => {
  it('writes the manifest JSON to the cache and shares the file url on iOS', async () => {
    seed([row()]);

    const result = await hardExamples.exportHardExamples();

    expect(result).toEqual({ ok: true, count: 1 });
    expect(fs.writeAsStringAsync).toHaveBeenCalledWith(
      'file:///cache/hoopilot-hard-examples.json',
      expect.any(String),
      { encoding: 'utf8' },
    );
    expect(rn.Share.share).toHaveBeenCalledWith({
      url: 'file:///cache/hoopilot-hard-examples.json',
    });
    const written = JSON.parse(fs.writeAsStringAsync.mock.calls[0][1]) as HardExampleManifest;
    expect(written.format).toBe('hoopilot-hard-examples');
    expect(written.exampleCount).toBe(1);
    expect(written.examples[0].videoPath).toBe('/videos/session-7.mp4');
  });

  it('shares the JSON as text on Android', async () => {
    rn.Platform.OS = 'android';
    seed([row()]);

    const result = await hardExamples.exportHardExamples();

    expect(result.ok).toBe(true);
    const arg = rn.Share.share.mock.calls[0][0] as { message: string };
    expect(JSON.parse(arg.message).format).toBe('hoopilot-hard-examples');
  });

  it('does nothing (no write, no share) when there are no hard examples', async () => {
    seed([]);
    await expect(hardExamples.exportHardExamples()).resolves.toEqual({ ok: false, count: 0 });
    expect(fs.writeAsStringAsync).not.toHaveBeenCalled();
    expect(rn.Share.share).not.toHaveBeenCalled();
  });

  it('falls back to a text share when the write fails, never throwing', async () => {
    seed([row()]);
    fs.writeAsStringAsync.mockRejectedValue(new Error('disk full'));

    const result = await hardExamples.exportHardExamples();

    expect(result.ok).toBe(true);
    const arg = rn.Share.share.mock.calls[0][0] as { message: string };
    expect(JSON.parse(arg.message).exampleCount).toBe(1);
  });

  it('resolves ok: false when even the text fallback fails', async () => {
    seed([row()]);
    fs.writeAsStringAsync.mockRejectedValue(new Error('disk full'));
    rn.Share.share.mockRejectedValue(new Error('share sheet unavailable'));
    await expect(hardExamples.exportHardExamples()).resolves.toEqual({ ok: false, count: 1 });
  });
});
