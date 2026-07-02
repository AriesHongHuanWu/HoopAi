/**
 * SQLite persistence for sessions and shots (expo-sqlite, SDK 57 API).
 *
 * Shot rows persist everything needed to rebuild stats, shot charts and clip
 * plans offline; the raw trajectory is stored as JSON for replay drawing.
 */
import * as SQLite from 'expo-sqlite';

import type { ResolvedShot, SessionStats, ShotOutcome } from '../core/types';
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
}

export interface SessionSummaryRow extends SessionRow {
  attempts: number;
  makes: number;
  /** makes / decided attempts, 0..1; 0 when no decided shots. */
  fgPct: number;
}

const DB_NAME = 'hoopai.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** Lazily opened singleton database. */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME).then(async (db) => {
      await migrate(db);
      return db;
    });
  }
  return dbPromise;
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
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(opts: {
  startedAt: number;
  label?: string;
  keepMode: string;
}): Promise<number> {
  const db = await getDb();
  const res = await db.runAsync(
    'INSERT INTO sessions (startedAt, label, keepMode) VALUES (?, ?, ?)',
    opts.startedAt,
    opts.label ?? '',
    opts.keepMode,
  );
  return res.lastInsertRowId;
}

export async function endSession(
  sessionId: number,
  opts: { endedAt: number; videoPath?: string | null },
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE sessions SET endedAt = ?, videoPath = ? WHERE id = ?',
    opts.endedAt,
    opts.videoPath ?? null,
    sessionId,
  );
}

export async function listSessions(limit = 50): Promise<SessionSummaryRow[]> {
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
}

export async function getSession(sessionId: number): Promise<SessionRow | null> {
  const db = await getDb();
  return db.getFirstAsync<SessionRow>('SELECT * FROM sessions WHERE id = ?', sessionId);
}

export async function deleteSession(sessionId: number): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM shots WHERE sessionId = ?', sessionId);
    await db.runAsync('DELETE FROM sessions WHERE id = ?', sessionId);
  });
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

export async function insertShot(sessionId: number, shot: ResolvedShot): Promise<number> {
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
}

/** One-tap correction: flip a persisted shot's outcome. */
export async function updateShotOutcome(
  shotRowId: number,
  outcome: ShotOutcome,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE shots SET outcome = ?, corrected = 1 WHERE id = ?',
    outcome,
    shotRowId,
  );
}

export async function setShotClipPath(shotRowId: number, clipPath: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE shots SET clipPath = ? WHERE id = ?', clipPath, shotRowId);
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
  const db = await getDb();
  return db.getAllAsync<ShotRow>(
    'SELECT * FROM shots WHERE sessionId = ? ORDER BY shotIndex ASC',
    sessionId,
  );
}

/** Rebuild a ResolvedShot from its persisted row (for replay/recompute). */
export function shotFromRow(row: ShotRow): ResolvedShot {
  return {
    id: row.shotIndex,
    tStart: row.tStart,
    tResolved: row.tResolved,
    outcome: row.outcome,
    signals: JSON.parse(row.signalsJson),
    rimBounce: row.rimBounce === 1,
    xCross: row.xCross,
    entryAngleDeg: row.entryAngleDeg,
    releaseAngleDeg: row.releaseAngleDeg,
    releasePoint: null,
    originX: row.originX,
    originY: row.originY,
    trajectory: JSON.parse(row.trajectoryJson),
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
