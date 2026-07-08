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

import {
  emptyTotals,
  isEarlyBirdHour,
  isNightOwlHour,
  maxSessionsInWeek,
  type CareerBests,
  type LifetimeTotals,
} from '../core/achievements';
import { historyRetentionLimit } from '../core/premium';
import type { FormReport, GameModeId, ResolvedShot, SessionStats, ShotOutcome, ShotSignals, ShotValueSource } from '../core/types';
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
  /**
   * The {@link GameModeId} this session was played under, or null for a
   * plain Free Play session created before v4 (or one that never went
   * through a game mode). Additive column — see migration v4.
   */
  modeId: string | null;
  /**
   * JSON-serialized snapshot of the final {@link ModeState} (from
   * src/core/gameModes.ts), captured at `finish()` time so History can
   * reconstruct the ModeComplete-style breakdown (score, letters, spots…)
   * for a past game. Null when no mode was active or before v4.
   */
  modeResultJson: string | null;
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
  if (version < 3) {
    // v3: persist the estimated 2/3-point value so lifetime records (career
    // threes) survive restarts. NULL on rows written before v3 ⇒ treated as 2.
    await db.execAsync(`
      ALTER TABLE shots ADD COLUMN shotValue INTEGER;
      PRAGMA user_version = 3;
    `);
  }
  if (version < 4) {
    // v4: persist which game mode (if any) a session was played under, plus a
    // JSON snapshot of the final ModeState, so History can identify past mode
    // games (vs Free Play) and show their final score/breakdown. NULL on rows
    // written before v4 ⇒ treated as a plain/unknown-mode session.
    await db.execAsync(`
      ALTER TABLE sessions ADD COLUMN modeId TEXT;
      ALTER TABLE sessions ADD COLUMN modeResultJson TEXT;
      PRAGMA user_version = 4;
    `);
  }
  if (version < 5) {
    // v5: persist the pose-based FormReport (metrics + tips + release pose)
    // so the Shot Lab's form analysis works on HISTORY sessions, not just the
    // live one. NULL on rows written before v5 or when form analysis was off.
    await db.execAsync(`
      ALTER TABLE shots ADD COLUMN formJson TEXT;
      PRAGMA user_version = 5;
    `);
  }
  if (version < 6) {
    // v6 (two features landed together):
    //
    // rechecked — offline re-check bookkeeping (src/core/recheck.ts). 1 once
    // the machine has re-analysed this shot against the recording — whether
    // or not the verdict changed — so a second "Re-check" tap never redoes
    // the same expensive pass. DEFAULT 0 covers all pre-v6 rows.
    //
    // outcomeCorrected — splits "the user corrected the OUTCOME" out of the
    // overloaded `corrected` flag. updateShotValue (the one-tap 2↔3 point
    // fix) also stamps corrected=1, so the hard-example export — which needs
    // shots whose MAKE/MISS call was wrong — was polluted by value-only
    // fixes masquerading as outcome corrections. outcomeCorrected is set
    // only by updateShotOutcome when the caller passes corrected=true (user
    // edits; machine rechecks/undo pass false and never stamp it). Backfill
    // from the legacy flag: pre-v6 rows can't distinguish the two kinds of
    // correction, and copying keeps every previously-exported outcome
    // correction in the export instead of silently dropping them.
    await db.execAsync(`
      ALTER TABLE shots ADD COLUMN rechecked INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE shots ADD COLUMN outcomeCorrected INTEGER NOT NULL DEFAULT 0;
      UPDATE shots SET outcomeCorrected = corrected;
      PRAGMA user_version = 6;
    `);
  }
  if (version < 7) {
    // v7: Jump Lab — a standalone log of measured vertical jumps, independent
    // of shooting sessions (a jump test is its own thing, not a shot). One row
    // per measured jump: epoch-ms timestamp, height in centimetres, which
    // estimator produced it ('hang-time' | 'displacement'), and a 0..1
    // confidence. Its own table (not a shots column) because jumps have no
    // session / rim / trajectory and are queried on their own timeline for the
    // personal-best + sparkline.
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS jumps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        heightCm REAL NOT NULL,
        method TEXT NOT NULL DEFAULT 'hang-time',
        confidence REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_jumps_ts ON jumps(ts);
      PRAGMA user_version = 7;
    `);
  }
  if (version < 8) {
    // v8: 2/3 provenance — so the detection receipt + court placement map show
    // the SAME "shows its work" data when a session is reopened from History,
    // not just live. valueSource = which estimator decided the point value;
    // valueConfidence = its 0..1 confidence; courtX/courtY = the homography-
    // mapped court position (present only for court-registered shots). All
    // additive + nullable — old rows read back as undefined (graceful).
    await db.execAsync(`
      ALTER TABLE shots ADD COLUMN valueSource TEXT;
      ALTER TABLE shots ADD COLUMN valueConfidence REAL;
      ALTER TABLE shots ADD COLUMN courtX REAL;
      ALTER TABLE shots ADD COLUMN courtY REAL;
      PRAGMA user_version = 8;
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
  /** The game mode this session is played under, if any (see SessionRow). */
  modeId?: GameModeId | null;
}): Promise<number> {
  return safe('createSession', -1, async () => {
    const db = await getDb();
    const res = await db.runAsync(
      'INSERT INTO sessions (startedAt, label, keepMode, modeId) VALUES (?, ?, ?, ?)',
      opts.startedAt,
      opts.label ?? '',
      opts.keepMode,
      opts.modeId ?? null,
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
    /**
     * JSON snapshot of the final ModeState, when the session was played under
     * a game mode (see SessionRow.modeResultJson). Omitted/undefined leaves
     * the column untouched from createSession-time (there is none to set) —
     * pass null explicitly only when clearing a previously-set result.
     */
    modeResultJson?: string | null;
  },
): Promise<void> {
  return safe('endSession', undefined, async () => {
    const db = await getDb();
    await db.runAsync(
      'UPDATE sessions SET endedAt = ?, videoPath = ?, recordingStartSec = ?, modeResultJson = COALESCE(?, modeResultJson) WHERE id = ?',
      opts.endedAt,
      opts.videoPath ?? null,
      opts.recordingStartSec ?? null,
      opts.modeResultJson ?? null,
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

/**
 * Sessions the History screen should actually show, with the free-tier
 * retention cap (src/core/premium.ts historyRetentionLimit) applied on top of
 * `listSessions`. During beta (or once the user is Pro) the cap is null and
 * this is identical to `listSessions(requestedLimit)`. `requestedLimit` lets
 * the caller ask for a larger page than the cap without ever seeing more than
 * the cap allows once gating is live — this is the pre-launch enforcement
 * point called out in PRO_FEATURES's 'unlimitedHistory' blurb.
 */
export async function listVisibleSessions(requestedLimit = 50): Promise<SessionSummaryRow[]> {
  const cap = historyRetentionLimit();
  const effectiveLimit = cap == null ? requestedLimit : Math.min(requestedLimit, cap);
  return listSessions(effectiveLimit);
}

/**
 * Every session row (raw columns, no summary join), newest first — the export
 * side of the backup feature (src/data/backup.ts). Never throws.
 */
export async function allSessions(): Promise<SessionRow[]> {
  return safe('allSessions', [], async () => {
    const db = await getDb();
    return db.getAllAsync<SessionRow>('SELECT * FROM sessions ORDER BY startedAt DESC');
  });
}

/**
 * Every session's start time in epoch ms (lightweight — one column, all rows).
 * Feeds the career day-streak (src/core/streak.ts) in Records. Never throws.
 */
export async function allSessionStartedAt(): Promise<number[]> {
  return safe('allSessionStartedAt', [], async () => {
    const db = await getDb();
    const rows = await db.getAllAsync<{ startedAt: number }>(
      'SELECT startedAt FROM sessions',
    );
    return rows.map((r) => r.startedAt);
  });
}

/** Every shot row across all sessions (ordered for stable exports). Never throws. */
export async function allShots(): Promise<ShotRow[]> {
  return safe('allShots', [], async () => {
    const db = await getDb();
    return db.getAllAsync<ShotRow>('SELECT * FROM shots ORDER BY sessionId ASC, shotIndex ASC');
  });
}

/** Every jump row. Never throws. */
export async function allJumps(): Promise<JumpRow[]> {
  return safe('allJumps', [], async () => {
    const db = await getDb();
    return db.getAllAsync<JumpRow>('SELECT * FROM jumps ORDER BY ts DESC');
  });
}

export async function getSession(sessionId: number): Promise<SessionRow | null> {
  return safe('getSession', null, async () => {
    const db = await getDb();
    return db.getFirstAsync<SessionRow>('SELECT * FROM sessions WHERE id = ?', sessionId);
  });
}

/**
 * Update a session's free-text label. Used both for the session title
 * (SessionTitle rename) and — additively — as a free-text TAG shown as a
 * chip on the History card and used to filter the History list. Never
 * throws; a failed write just leaves the previous label in place.
 */
export async function updateSessionLabel(sessionId: number, label: string): Promise<void> {
  return safe('updateSessionLabel', undefined, async () => {
    const db = await getDb();
    await db.runAsync('UPDATE sessions SET label = ? WHERE id = ?', label, sessionId);
  });
}

/**
 * Clear a session's videoPath WITHOUT touching its shots or stats — the
 * storage manager (src/app/storage.tsx) deletes the recording FILE and calls
 * this so History stops offering a replay that no longer exists on disk. The
 * session, its shots, angles and FG% all stay. Never throws.
 */
export async function clearSessionVideo(sessionId: number): Promise<void> {
  return safe('clearSessionVideo', undefined, async () => {
    const db = await getDb();
    await db.runAsync('UPDATE sessions SET videoPath = NULL WHERE id = ?', sessionId);
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
         signalsJson, trajectoryJson, shotValue, formJson,
         valueSource, valueConfidence, courtX, courtY
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      shot.shotValue ?? null,
      shot.form ? JSON.stringify(shot.form) : null,
      shot.valueSource ?? null,
      shot.valueConfidence ?? null,
      shot.courtPos?.x ?? null,
      shot.courtPos?.y ?? null,
    );
    return res.lastInsertRowId;
  });
}

/**
 * Correction write: set a persisted shot's outcome. `corrected` stamps or
 * clears the user-edited flag — the default (true) is the one-tap/swipe
 * correction; pass false when restoring the original detection (undo) or
 * flushing an outcome that was never hand-edited (late insert sync).
 *
 * `outcomeCorrected` mirrors `corrected` HERE and only here: it marks "the
 * user hand-flipped this shot's make/miss call", which is what the
 * hard-example export filters on. Machine rechecks/undo (corrected=false)
 * clear it, and updateShotValue (2↔3 fix) never touches it — see the v6
 * migration note.
 */
export async function updateShotOutcome(
  shotRowId: number,
  outcome: ShotOutcome,
  corrected = true,
): Promise<void> {
  return safe('updateShotOutcome', undefined, async () => {
    const db = await getDb();
    await db.runAsync(
      'UPDATE shots SET outcome = ?, corrected = ?, outcomeCorrected = ? WHERE id = ?',
      outcome,
      corrected ? 1 : 0,
      corrected ? 1 : 0,
      shotRowId,
    );
  });
}

/**
 * Stamp a shot as machine-re-checked (offline recheck ran over it, whatever
 * the verdict) so the pass is never repeated for the same shot. Distinct from
 * `corrected`, which marks USER edits.
 */
export async function markShotRechecked(shotRowId: number): Promise<void> {
  return safe('markShotRechecked', undefined, async () => {
    const db = await getDb();
    await db.runAsync('UPDATE shots SET rechecked = 1 WHERE id = ?', shotRowId);
  });
}

/**
 * One-tap 2↔3 correction: persist a shot's corrected point value. Stamps the
 * general `corrected` flag (Records' corrected-calls total counts every hand
 * edit) but deliberately NOT `outcomeCorrected` — the make/miss call was
 * right, so this shot is not a hard example for the detector.
 */
export async function updateShotValue(shotRowId: number, value: 2 | 3): Promise<void> {
  return safe('updateShotValue', undefined, async () => {
    const db = await getDb();
    await db.runAsync(
      'UPDATE shots SET shotValue = ?, corrected = 1 WHERE id = ?',
      value,
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
  /**
   * 1 when the USER hand-corrected the make/miss call (vs `corrected`, which
   * any hand edit — including a 2↔3 value fix — stamps). Optional so
   * hand-built pre-v6 rows still typecheck; SELECTed rows always carry it.
   */
  outcomeCorrected?: number;
  rimBounce: number;
  entryAngleDeg: number | null;
  releaseAngleDeg: number | null;
  xCross: number | null;
  originX: number | null;
  originY: number | null;
  signalsJson: string;
  trajectoryJson: string;
  clipPath: string | null;
  /**
   * Estimated 2/3-point value; null on pre-v3 rows or when estimation didn't
   * run. Optional so hand-built rows (tests, fixtures) predating v3 still
   * typecheck — SELECTed rows always carry the column.
   */
  shotValue?: number | null;
  /** Serialized FormReport; null pre-v5 or when form analysis was off. */
  formJson?: string | null;
  /**
   * 1 once the offline re-check pass ran over this shot (v6). Optional so
   * hand-built rows (tests, fixtures) predating v6 still typecheck.
   */
  rechecked?: number | null;
  /**
   * 2/3 provenance (v8): which estimator decided the value, its confidence,
   * and the homography-mapped court position (courtX/courtY, court-registered
   * shots only). Optional so pre-v8 / hand-built rows still typecheck.
   */
  valueSource?: string | null;
  valueConfidence?: number | null;
  courtX?: number | null;
  courtY?: number | null;
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

/** The narrow per-shot slice aggregate scans need (see sessionShotOutcomes). */
export interface ShotOutcomeRow {
  outcome: ShotOutcome;
  shotValue: number | null;
}

/**
 * Narrow per-session read for aggregate passes that only need the outcome
 * stream (e.g. the Home daily-challenge rebuild): sessionShots() SELECT *s
 * every row including the multi-KB trajectoryJson/formJson blobs, which an
 * every-Home-focus scan over the whole day's sessions should never pay for.
 * Ordered by shotIndex so streak walks stay correct. Never throws.
 */
export async function sessionShotOutcomes(sessionId: number): Promise<ShotOutcomeRow[]> {
  return safe('sessionShotOutcomes', [], async () => {
    const db = await getDb();
    return db.getAllAsync<ShotOutcomeRow>(
      'SELECT outcome, shotValue FROM shots WHERE sessionId = ? ORDER BY shotIndex ASC',
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
    shotValue: row.shotValue === 3 ? 3 : row.shotValue === 2 ? 2 : undefined,
    ...(row.formJson
      ? { form: parseJson<FormReport | undefined>(row.formJson, undefined) }
      : {}),
    // 2/3 provenance (v8) — so the receipt + placement map render the same
    // "shows its work" data on a reopened session as they did live.
    ...(row.valueSource != null ? { valueSource: row.valueSource as ShotValueSource } : {}),
    ...(row.valueConfidence != null ? { valueConfidence: row.valueConfidence } : {}),
    ...(row.courtX != null && row.courtY != null
      ? { courtPos: { x: row.courtX, y: row.courtY } }
      : {}),
  };
}

export async function sessionStatsFromDb(sessionId: number): Promise<SessionStats> {
  const rows = await sessionShots(sessionId);
  return recomputeStats(rows.map(shotFromRow));
}

/**
 * Insert an imported backup's rows (src/data/backup.ts mergeBackup output).
 * Sessions/shots/jumps are inserted with their ORIGINAL ids preserved (the
 * merge plan already excluded any id that collides locally), all inside one
 * transaction so a partial failure rolls back. Returns the counts actually
 * written; never throws (a failure logs + returns zeros, leaving the db
 * untouched). Achievements-seen / challenge-ledger merges are applied by the
 * caller against their persisted zustand stores, not here.
 */
export async function importBackup(plan: {
  sessions: SessionRow[];
  shots: ShotRow[];
  jumps: JumpRow[];
}): Promise<{ sessions: number; shots: number; jumps: number }> {
  return safe('importBackup', { sessions: 0, shots: 0, jumps: 0 }, async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const s of plan.sessions) {
        await db.runAsync(
          `INSERT INTO sessions (
             id, startedAt, endedAt, label, videoPath, keepMode,
             recordingStartSec, modeId, modeResultJson
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          s.id,
          s.startedAt,
          s.endedAt,
          s.label,
          s.videoPath,
          s.keepMode,
          s.recordingStartSec,
          s.modeId,
          s.modeResultJson,
        );
      }
      for (const sh of plan.shots) {
        await db.runAsync(
          `INSERT INTO shots (
             id, sessionId, shotIndex, tStart, tResolved, outcome, corrected,
             rimBounce, entryAngleDeg, releaseAngleDeg, xCross, originX, originY,
             signalsJson, trajectoryJson, clipPath, shotValue, formJson,
             rechecked, outcomeCorrected
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sh.id,
          sh.sessionId,
          sh.shotIndex,
          sh.tStart,
          sh.tResolved,
          sh.outcome,
          sh.corrected,
          sh.rimBounce,
          sh.entryAngleDeg,
          sh.releaseAngleDeg,
          sh.xCross,
          sh.originX,
          sh.originY,
          sh.signalsJson,
          sh.trajectoryJson,
          sh.clipPath,
          sh.shotValue ?? null,
          sh.formJson ?? null,
          sh.rechecked ?? 0,
          sh.outcomeCorrected ?? 0,
        );
      }
      for (const j of plan.jumps) {
        await db.runAsync(
          'INSERT INTO jumps (id, ts, heightCm, method, confidence) VALUES (?, ?, ?, ?, ?)',
          j.id,
          j.ts,
          j.heightCm,
          j.method,
          j.confidence,
        );
      }
    });
    return {
      sessions: plan.sessions.length,
      shots: plan.shots.length,
      jumps: plan.jumps.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Lifetime records
// ---------------------------------------------------------------------------

/** Sessions scanned for the best-streak walk (newest first). */
const LIFETIME_STREAK_SESSION_CAP = 200;

/**
 * Career totals for the Records screen (src/core/achievements.ts).
 *
 * - `sessions` counts sessions with at least one tracked shot.
 * - `threes` counts makes persisted with shotValue = 3 (pre-v3 rows count as 2).
 * - `bestSessionFgPct` runs over decided shots (make|miss) of sessions with
 *   ≥ 10 attempts, matching the Sharpshooter badge's floor.
 * - `bestStreak` walks each session's shots in order (misses reset, unsure
 *   shots are skipped — same semantics as src/core/stats.ts), scanning only
 *   the {@link LIFETIME_STREAK_SESSION_CAP} most recent sessions.
 * - `correctedCalls` counts shots the user hand-corrected (corrected = 1).
 * - `nightSessions` / `dawnSessions` / `bestWeekSessions` classify session
 *   start times (local clock) via the pure helpers in achievements.ts.
 * - `atwWins` / `horseGames` parse the persisted modeResultJson snapshot
 *   (see SessionRow) for finished games; `modesPlayed` counts distinct
 *   non-Free-Play modes with at least one tracked shot.
 *
 * Never throws: any failure returns all-zero totals.
 */
export async function lifetimeTotals(): Promise<LifetimeTotals> {
  return safe('lifetimeTotals', emptyTotals(), async () => {
    const db = await getDb();

    const agg = await db.getFirstAsync<{
      sessions: number;
      attempts: number;
      makes: number;
      threes: number;
      correctedCalls: number;
    }>(
      `SELECT COUNT(DISTINCT sessionId) AS sessions,
              COUNT(*) AS attempts,
              COALESCE(SUM(CASE WHEN outcome = 'make' THEN 1 ELSE 0 END), 0) AS makes,
              COALESCE(SUM(CASE WHEN outcome = 'make' AND shotValue = 3 THEN 1 ELSE 0 END), 0) AS threes,
              COALESCE(SUM(CASE WHEN corrected = 1 THEN 1 ELSE 0 END), 0) AS correctedCalls
       FROM shots`,
    );

    const best = await db.getFirstAsync<{ best: number | null }>(
      `SELECT MAX(CAST(makes AS REAL) / decided) AS best FROM (
         SELECT COUNT(*) AS attempts,
                SUM(CASE WHEN outcome = 'make' THEN 1 ELSE 0 END) AS makes,
                SUM(CASE WHEN outcome IN ('make','miss') THEN 1 ELSE 0 END) AS decided
         FROM shots
         GROUP BY sessionId
       )
       WHERE attempts >= 10 AND decided > 0`,
    );

    // Best streak: one query, per-session walk in JS (streaks never span
    // sessions). Ordered by session then shot index; capped at recent sessions.
    const rows = await db.getAllAsync<{ sessionId: number; outcome: ShotOutcome }>(
      `SELECT sh.sessionId, sh.outcome
       FROM shots sh
       WHERE sh.sessionId IN (
         SELECT id FROM sessions ORDER BY startedAt DESC LIMIT ?
       )
       ORDER BY sh.sessionId ASC, sh.shotIndex ASC`,
      LIFETIME_STREAK_SESSION_CAP,
    );
    let bestStreak = 0;
    let streak = 0;
    let currentSession: number | null = null;
    for (const row of rows) {
      if (row.sessionId !== currentSession) {
        currentSession = row.sessionId;
        streak = 0;
      }
      if (row.outcome === 'make') {
        streak += 1;
        if (streak > bestStreak) bestStreak = streak;
      } else if (row.outcome === 'miss') {
        streak = 0;
      }
      // 'unsure' leaves the streak untouched (see src/core/stats.ts).
    }

    // Session-level facts: tip-off time (night owl / early bird / weekly
    // cadence) and game-mode outcomes. One pass over sessions with shots.
    const sessionRows = await db.getAllAsync<{
      startedAt: number;
      modeId: string | null;
      modeResultJson: string | null;
    }>(
      `SELECT s.startedAt, s.modeId, s.modeResultJson
       FROM sessions s
       WHERE EXISTS (SELECT 1 FROM shots sh WHERE sh.sessionId = s.id)`,
    );
    let nightSessions = 0;
    let dawnSessions = 0;
    let atwWins = 0;
    let horseGames = 0;
    const startTimes: number[] = [];
    const modesSeen = new Set<string>();
    for (const s of sessionRows) {
      startTimes.push(s.startedAt);
      const hour = new Date(s.startedAt).getHours();
      if (isNightOwlHour(hour)) nightSessions += 1;
      else if (isEarlyBirdHour(hour)) dawnSessions += 1;
      if (s.modeId != null && s.modeId !== 'free') {
        modesSeen.add(s.modeId);
        const result = s.modeResultJson
          ? parseJson<{ done?: boolean; progress?: number }>(s.modeResultJson, {})
          : {};
        if (s.modeId === 'aroundTheWorld' && result.done === true && (result.progress ?? 0) >= 1) {
          atwWins += 1;
        }
        if (s.modeId === 'horse' && result.done === true) {
          horseGames += 1;
        }
      }
    }

    return {
      sessions: agg?.sessions ?? 0,
      attempts: agg?.attempts ?? 0,
      makes: agg?.makes ?? 0,
      bestStreak,
      bestSessionFgPct: best?.best ?? 0,
      threes: agg?.threes ?? 0,
      correctedCalls: agg?.correctedCalls ?? 0,
      nightSessions,
      dawnSessions,
      bestWeekSessions: maxSessionsInWeek(startTimes),
      atwWins,
      horseGames,
      modesPlayed: modesSeen.size,
    };
  });
}

/**
 * Career maxima for the "NEW PERSONAL BEST" check (src/core/achievements.ts
 * detectNewBests), computed over every session EXCEPT `excludeSessionId` —
 * pass the just-ended session's id so the baseline honestly reflects the
 * career BEFORE it (its shots are already persisted by the time the summary
 * renders). Omit the id to rank against everything.
 *
 * Returns null (not zeros) on any db failure so a broken read can never
 * masquerade as "you beat a career of zero" and fire a false celebration.
 */
export async function careerBests(excludeSessionId?: number): Promise<CareerBests | null> {
  return safe<CareerBests | null>('careerBests', null, async () => {
    const db = await getDb();
    // Session ids are positive; -1 excludes nothing.
    const exclude = excludeSessionId ?? -1;

    const agg = await db.getFirstAsync<{
      mostMakes: number | null;
      bestFg: number | null;
    }>(
      `SELECT MAX(makes) AS mostMakes,
              MAX(CASE WHEN attempts >= 10 AND decided > 0
                       THEN CAST(makes AS REAL) / decided END) AS bestFg
       FROM (
         SELECT COUNT(*) AS attempts,
                SUM(CASE WHEN outcome = 'make' THEN 1 ELSE 0 END) AS makes,
                SUM(CASE WHEN outcome IN ('make','miss') THEN 1 ELSE 0 END) AS decided
         FROM shots
         WHERE sessionId <> ?
         GROUP BY sessionId
       )`,
      exclude,
    );

    // Same per-session streak walk as lifetimeTotals, minus the excluded
    // session (streaks never span sessions).
    const rows = await db.getAllAsync<{ sessionId: number; outcome: ShotOutcome }>(
      `SELECT sh.sessionId, sh.outcome
       FROM shots sh
       WHERE sh.sessionId <> ?
         AND sh.sessionId IN (
           SELECT id FROM sessions ORDER BY startedAt DESC LIMIT ?
         )
       ORDER BY sh.sessionId ASC, sh.shotIndex ASC`,
      exclude,
      LIFETIME_STREAK_SESSION_CAP,
    );
    let bestStreak = 0;
    let streak = 0;
    let currentSession: number | null = null;
    for (const row of rows) {
      if (row.sessionId !== currentSession) {
        currentSession = row.sessionId;
        streak = 0;
      }
      if (row.outcome === 'make') {
        streak += 1;
        if (streak > bestStreak) bestStreak = streak;
      } else if (row.outcome === 'miss') {
        streak = 0;
      }
    }

    return {
      bestStreak,
      bestFgPct: agg?.bestFg ?? 0,
      mostMakes: agg?.mostMakes ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Jump Lab (v7)
// ---------------------------------------------------------------------------

/** One persisted vertical-jump measurement (jumps table, v7). */
export interface JumpRow {
  id: number;
  /** Epoch ms. */
  ts: number;
  /** Measured vertical jump, centimetres. */
  heightCm: number;
  /** Estimator that produced the height ('hang-time' | 'displacement'). */
  method: string;
  /** 0..1 confidence in the measurement. */
  confidence: number;
}

/**
 * Persist one measured jump. Returns -1 when persistence failed (the number
 * still shows in the UI this session; it just won't survive a restart).
 */
export async function insertJump(opts: {
  ts: number;
  heightCm: number;
  method: string;
  confidence: number;
}): Promise<number> {
  return safe('insertJump', -1, async () => {
    const db = await getDb();
    const res = await db.runAsync(
      'INSERT INTO jumps (ts, heightCm, method, confidence) VALUES (?, ?, ?, ?)',
      opts.ts,
      opts.heightCm,
      opts.method,
      opts.confidence,
    );
    return res.lastInsertRowId;
  });
}

/** Jump history, newest first. Never throws (empty on failure). */
export async function listJumps(limit = 60): Promise<JumpRow[]> {
  return safe('listJumps', [], async () => {
    const db = await getDb();
    return db.getAllAsync<JumpRow>(
      'SELECT * FROM jumps ORDER BY ts DESC LIMIT ?',
      limit,
    );
  });
}

/** Personal-best jump height in centimetres (0 when no history). Never throws. */
export async function bestJumpCm(): Promise<number> {
  return safe('bestJumpCm', 0, async () => {
    const db = await getDb();
    const row = await db.getFirstAsync<{ best: number | null }>(
      'SELECT MAX(heightCm) AS best FROM jumps',
    );
    return row?.best ?? 0;
  });
}

/** Delete one jump measurement (mis-detected outlier cleanup). Never throws. */
export async function deleteJump(id: number): Promise<void> {
  return safe('deleteJump', undefined, async () => {
    const db = await getDb();
    await db.runAsync('DELETE FROM jumps WHERE id = ?', id);
  });
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
