/**
 * Narrow read seams for replay/baseline surfaces.
 *
 * STATUS (v9 data landed ahead of its UI): NO production consumer yet — only
 * the tests import this module. sessionArcThumbs is reserved for the session
 * arc-thumbnail strip / 3D replay theater (gated on the persisted `replay3d`
 * setting, src/state/settingsStore.ts), and recentFormShotRows for the
 * cross-session form-baseline card. If you are building either surface, START
 * HERE — do not add a new SELECT * read path. If neither has shipped by the
 * time you touch the shots schema, update these queries' column lists in the
 * same change (no runtime path will catch a drift for you).
 *
 * sessionShots() SELECT *s every row including the multi-KB
 * trajectoryJson/formJson blobs (see the sessionShotOutcomes precedent in
 * db.ts). Thumbnail strips and cross-session form-baseline scans must never
 * pay that cost, so they read through these column-scoped queries instead.
 *
 * Same crash-safety contract as db.ts: failures are logged and a safe
 * fallback is returned — a database error NEVER throws into UI code.
 */
import { getDb } from './db';
import type { ShotOutcome } from '../core/types';

/** Local mirror of db.ts safe(): log + fallback, NEVER throw into UI. */
async function quiet<T>(op: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[replayQueries] ${op} failed`, err);
    return fallback;
  }
}

export interface ArcThumbRow {
  shotIndex: number;
  outcome: ShotOutcome;
  shotValue: number | null;
  /** Serialized PersistedFlightArc; NULL when no confident arc (or pre-v9). */
  arcJson: string | null;
}

/**
 * Per-session thumbnail feed: tiny rows (arcJson ≤ ~0.7 KB, NULL when no
 * confident arc). Ordered by shotIndex. Fallback []. Callers decode via
 * decodeArcSnapshot (src/core/arcSnapshot.ts) and fall back to the trajectory
 * polyline for NULL/corrupt arcs.
 */
export async function sessionArcThumbs(sessionId: number): Promise<ArcThumbRow[]> {
  return quiet('sessionArcThumbs', [], async () => {
    const db = await getDb();
    return db.getAllAsync<ArcThumbRow>(
      'SELECT shotIndex, outcome, shotValue, arcJson FROM shots WHERE sessionId = ? ORDER BY shotIndex ASC',
      sessionId,
    );
  });
}

// Size bound: at ~4 KB formJson worst case this caps a baseline rebuild at
// ~0.8 MB of JSON parsing.
export const FORM_BASELINE_SCAN_LIMIT = 200;

export interface FormSequenceShotRow {
  sessionId: number;
  shotIndex: number;
  tResolved: number;
  outcome: ShotOutcome;
  formJson: string;
}

/**
 * Newest-first shots that HAVE a form report (formJson NOT NULL). formJson may
 * still lack .sequence — the caller (form-baseline feature) parses the
 * FormReport and filters for a decodable sequence
 * (decodeSequence(...).length >= 2), mirroring formstudio.tsx. Fallback [].
 */
export async function recentFormShotRows(
  limit: number = FORM_BASELINE_SCAN_LIMIT,
): Promise<FormSequenceShotRow[]> {
  return quiet('recentFormShotRows', [], async () => {
    const db = await getDb();
    return db.getAllAsync<FormSequenceShotRow>(
      'SELECT sessionId, shotIndex, tResolved, outcome, formJson FROM shots WHERE formJson IS NOT NULL ORDER BY id DESC LIMIT ?',
      limit,
    );
  });
}
