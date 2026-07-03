/**
 * SQLite persistence for sessions and shots (expo-sqlite, SDK 57 API).
 *
 * Shot rows persist everything needed to rebuild stats, shot charts and clip
 * plans offline; the raw trajectory is stored as JSON for replay drawing.
 *
 * CRASH SAFETY
 * ------------
 * Every public function is wrapped so a database failure NEVER throws into UI
 * code: errors are logged via console.warn and a safe fallback is returned
 * (empty array, null, no-op, or -1 for insert row ids). If opening the
 * database itself fails (corrupt file), a one-time automatic recovery deletes
 * and re-creates it — losing history beats crashing on every launch.
 */
import * as SQLite from 'expo-sqlite';

import type { ResolvedShot, SessionStats, ShotOutcome, ShotSignals } from '../core/types';
import { recomputeStats } from '../core/stats';

export interface SessionRow {
  id: number;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number | null;
  label: string;
  /** Absolute path of the master recording, when the user recorded. */
  videoPath: string | null;
  /** 'makes' | 'all' | 'decided' | 'none' — clip retention chosen for this session. */
  keepMode: string;
  /**
   * Engine-clock second at which the recording started, or null when the
   * session wasn't recorded. videoTime = shot.tResolved − recordingStartSec.
   */
  recordingStartSec: number | null;
}

export interface SessionSummaryRow extends SessionRow {
  attempts: number;
  makes: number;
  /** makes / decided attempts, 0..1; 0 when no decided shots. */
  fgPct: number;
}

const DB_NAME = 'hoopai.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
/** Only ever attempt the automatic corrupt-db recovery once per launch. */
let recoveryAttempted = false;

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await migrate(db);
  return db;
}

/**
 * Lazily opened singleton database.
 *
 * If the first open/migrate fails (corrupt file), the database is deleted and
 * re-created once automatically. If even that fails, the cached promise is
 * cleared so a later call can retry, and the rejection surfaces to the `safe`
 * wrappers below (never to UI code).
 */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    const attempt = openAndMigrate().catch(async (err) => {
      console.warn('[db] Failed to open database', err);
      if (recoveryAttempted) throw err;
      recoveryAttempted = true;
      console.warn('[db] Attempting automatic recovery (delete + re-create)');
      try {
        await SQLite.deleteDatabaseAsync(DB_NAME);
      } catch (deleteErr) {
        console.warn('[db] Could not delete corrupt database', deleteErr);
      }
      return openAndMigrate();
    });
    // Clear the cache on terminal failure so a future call can retry.
    attempt.catch(() => {
      if (dbPromise === attempt) dbPromise = null;
    });
    dbPromise = attempt;
  }
  return dbPromise;
}

/**
 * Best-effort recovery: close, delete and re-create the database from scratch.
 * All persisted history is lost. Never throws.
 */
export async function resetDatabase(): Promise<void> {
  const stale = dbPromise;
  dbPromise = null;
  if (stale) {
    try {
      const db = await stale;
      await db.closeAsync();
    } catch {
      // Already broken or closed — nothing to release.
    }
  }
  try {
    await SQLite.deleteDatabaseAsync(DB_NAME);
  } catch (err) {
    console.warn('[db] deleteDatabaseAsync failed during reset', err);
  }
  try {
    const fresh = await openAndMigrate();
    dbPromise = Promise.resolve(fresh);
  } catch (err) {
    console.warn('[db] Re-open after reset failed', err);
    dbPromise = null;
  }
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version ?? 0;
  if (version < 1) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        startedAt INTEGER NOT NULL,
        endedAt INTEGER,
        label TEXT NOT NULL DEFAULT '',
        videoPath TEXT,
        keepMode TEXT NOT NULL DEFAULT 'makes'
      );
      CREATE TABLE IF NOT EXISTS shots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        shotIndex INTEGER NOT NULL,
        tStart REAL NOT NULL,
        tResolved REAL NOT NULL,
        outcome TEXT NOT NULL,
        corrected INTEGER NOT NULL DEFAULT 0,
        rimBounce INTEGER NOT NULL DEFAULT 0,
        entryAngleDeg REAL,
        releaseAngleDeg REAL,
        xCross REAL,
        originX REAL,
        originY REAL,
        signalsJson TEXT NOT NULL DEFAULT '{}',
        trajectoryJson TEXT NOT NULL DEFAULT '[]',
        clipPath TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_shots_session ON shots(sessionId);
      PRAGMA user_version = 1;
    `);
  }
  if (version < 2) {
    // v2: align shot timestamps with the session recording. Shot times are
    // engine-clock seconds; the recording starts later (at rim lock), so the
    // video player needs this offset: videoTime = shot.tResolved − recordingStartSec.
    await db.execAsync(`
      ALTER TABLE sessions ADD COLUMN recordingStartSec REAL;
      PRAGMA user_version = 2;
    `);
  }
}

/** Run a DB operation; on ANY failure log + return the fallback (never throw). */
async function safe<T>(op: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[db] ${op} failed`, err);
    return fallback;
  }
}

/** JSON.parse that can never throw (corrupt persisted rows). */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Creates a session row. Returns -1 when persistence failed — callers should
 * treat a negative id as "no persistence this session" and carry on.
 */
export async function createSession(opts: {
  startedAt: number;
  label?: string;
  keepMode: string;
}): Promise<number> {
  return safe('createSession', -1, async () => {
    const db = await getDb();
    const res = await db.runAsync(
      'INSERT INTO sessions (startedAt, label, keepMode) VALUES (?, ?, ?)',
      opts.startedAt,
      opts.label ?? '',
      opts.keepMode,
    );
    return res.lastInsertRowId;
  });
}

export async function endSession(
  sessionId: number,
  opts: {
    endedAt: number;
    videoPath?: string | null;
    /** Engine-clock second when the recording started (see SessionRow). */
    recordingStartSec?: number | null;
  },
): Promise<void> {
  return safe('endSession', undefined, async () => {
    const db = await getDb();
    await db.runAsync(
      'UPDATE sessions SET endedAt = ?, videoPath = ?, recordingStartSec = ? WHERE id = ?',
      opts.endedAt,
      opts.videoPath ?? null,
      opts.recordingStartSec ?? null,
      sessionId,
    );
  });
}

export async function listSessions(limit = 50): Promise<SessionSummaryRow[]> {
  return safe('listSessions', [], async () => {
    const db = await getDb();
    return db.getAllAsync<SessionSummaryRow>(
      `SELECT s.*,
              COUNT(sh.id) AS attempts,
              SUM(CASE WHEN sh.outcome = 'make' THEN 1 ELSE 0 END) AS makes,
              CASE
                WHEN SUM(CASE WHEN sh.outcome IN ('make','miss') THEN 1 ELSE 0 END) = 0 THEN 0
                ELSE CAST(SUM(CASE WHEN sh.outcome = 'make' THEN 1 ELSE 0 END) AS REAL)
                     / SUM(CASE WHEN sh.outcome IN ('make','miss') THEN 1 ELSE 0 END)
              END AS fgPct
       FROM sessions s
       LEFT JOIN shots sh ON sh.sessionId = s.id
       GROUP BY s.id
       ORDER BY s.startedAt DESC
       LIMIT ?`,
      limit,
    );
  });
}

export async function getSession(sessionId: number): Promise<SessionRow | null> {
  return safe('getSession', null, async () => {
    const db = await getDb();
    return db.getFirstAsync<SessionRow>('SELECT * FROM sessions WHERE id = ?', sessionId);
  });
}

export async function deleteSession(sessionId: number): Promise<void> {
  return safe('deleteSession', undefined, async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM shots WHERE sessionId = ?', sessionId);
      await db.runAsync('DELETE FROM sessions WHERE id = ?', sessionId);
    });
  });
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

/** Persists a shot. Returns -1 when persistence failed (shot stays in memory). */
export async function insertShot(sessionId: number, shot: ResolvedShot): Promise<number> {
  return safe('insertShot', -1, async () => {
    const db = await getDb();
    const res = await db.runAsync(
      `INSERT INTO shots (
         sessionId, shotIndex, tStart, tResolved, outcome, corrected, rimBounce,
         entryAngleDeg, releaseAngleDeg, xCross, originX, originY,
         signalsJson, trajectoryJson
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      shot.id,
      shot.tStart,
      shot.tResolved,
      shot.outcome,
      shot.corrected ? 1 : 0,
      shot.rimBounce ? 1 : 0,
      shot.entryAngleDeg,
      shot.releaseAngleDeg,
      shot.xCross,
      shot.originX,
      shot.originY,
      JSON.stringify(shot.signals),
      JSON.stringify(shot.trajectory),
    );
    return res.lastInsertRowId;
  });
}

/** One-tap correction: flip a persisted shot's outcome. */
export async function updateShotOutcome(
  shotRowId: number,
  outcome: ShotOutcome,
): Promise<void> {
  return safe('updateShotOutcome', undefined, async () => {
    const db = await getDb();
    await db.runAsync(
      'UPDATE shots SET outcome = ?, corrected = 1 WHERE id = ?',
      outcome,
      shotRowId,
    );
  });
}

export async function setShotClipPath(shotRowId: number, clipPath: string): Promise<void> {
  return safe('setShotClipPath', undefined, async () => {
    const db = await getDb();
    await db.runAsync('UPDATE shots SET clipPath = ? WHERE id = ?', clipPath, shotRowId);
  });
}

export interface ShotRow {
  id: number;
  sessionId: number;
  shotIndex: number;
  tStart: number;
  tResolved: number;
  outcome: ShotOutcome;
  corrected: number;
  rimBounce: number;
  entryAngleDeg: number | null;
  releaseAngleDeg: number | null;
  xCross: number | null;
  originX: number | null;
  originY: number | null;
  signalsJson: string;
  trajectoryJson: string;
  clipPath: string | null;
}

export async function sessionShots(sessionId: number): Promise<ShotRow[]> {
  return safe('sessionShots', [], async () => {
    const db = await getDb();
    return db.getAllAsync<ShotRow>(
      'SELECT * FROM shots WHERE sessionId = ? ORDER BY shotIndex ASC',
      sessionId,
    );
  });
}

const FALLBACK_SIGNALS: ShotSignals = { geo: null, net: null, cls: null };

/** Rebuild a ResolvedShot from its persisted row (for replay/recompute). */
export function shotFromRow(row: ShotRow): ResolvedShot {
  return {
    id: row.shotIndex,
    tStart: row.tStart,
    tResolved: row.tResolved,
    outcome: row.outcome,
    signals: parseJson<ShotSignals>(row.signalsJson, FALLBACK_SIGNALS),
    rimBounce: row.rimBounce === 1,
    xCross: row.xCross,
    entryAngleDeg: row.entryAngleDeg,
    releaseAngleDeg: row.releaseAngleDeg,
    releasePoint: null,
    originX: row.originX,
    originY: row.originY,
    trajectory: parseJson(row.trajectoryJson, []),
    corrected: row.corrected === 1,
  };
}

export async function sessionStatsFromDb(sessionId: number): Promise<SessionStats> {
  const rows = await sessionShots(sessionId);
  return recomputeStats(rows.map(shotFromRow));
}

/** Per-session FG% series for the trends screen (oldest first). */
export async function fgTrend(
  limit = 30,
): Promise<{ sessionId: number; startedAt: number; fgPct: number; attempts: number }[]> {
  const rows = await listSessions(limit);
  return rows
    .filter((r) => r.attempts > 0)
    .map((r) => ({
      sessionId: r.id,
      startedAt: r.startedAt,
      fgPct: r.fgPct,
      attempts: r.attempts,
    }))
    .reverse();
}
