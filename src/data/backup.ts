/**
 * backup — pure export/import of the user's full local dataset (P19).
 *
 * "Full dataset" is everything that lives only on this phone and would be
 * painful to lose: recorded {@link SessionRow sessions} and their
 * {@link ShotRow shots}, measured {@link JumpRow jumps}, the badges the user
 * has already seen, and the daily-challenge points ledger. Video FILES are
 * deliberately NOT included — they are large and device-local (a session's
 * videoPath means nothing on another install), so only the row metadata
 * travels. An imported session simply has no replay video.
 *
 * Everything here is PURE — no db, no filesystem, no share sheet. The Settings
 * screen gathers the snapshot, calls {@link buildBackup} +
 * {@link serializeBackup} and hands the string to the csvExport share
 * pipeline; on import it reads a pasted/loaded string, calls
 * {@link parseBackup} then {@link mergeBackup}, and writes the returned
 * `toInsert` rows back through the db. Keeping the format + validation + merge
 * logic pure is what makes the round-trip / corruption / duplicate cases
 * unit-testable without a device.
 *
 * MERGE SEMANTICS: import is strictly ADDITIVE and never destructive. A
 * session whose id already exists locally is skipped whole (its shots too) —
 * we never overwrite an existing row, so re-importing your own backup is a
 * no-op and importing a friend's data can only add to yours.
 */
import type { JumpRow, SessionRow, ShotRow } from './db';

/** Magic string identifying a Hoopilot backup document. */
export const BACKUP_FORMAT = 'hoopilot-backup';
/**
 * Backup schema version. Bump when the {@link BackupData} shape changes in a
 * way that isn't a pure superset; {@link parseBackup} rejects a version it
 * doesn't understand rather than silently mis-reading it.
 */
export const BACKUP_VERSION = 1;

/**
 * The device-local dataset payload. Each array is exported verbatim from the
 * db so an import can re-insert rows as-is. Achievements-seen + the challenge
 * ledger are small key/value blobs the persisted zustand stores own.
 */
export interface BackupData {
  sessions: SessionRow[];
  /** Every shot across every exported session (each carries its sessionId). */
  shots: ShotRow[];
  jumps: JumpRow[];
  /** Persisted achievements-seen store snapshot (badges seen + first-visit). */
  achievementsSeen: { hasVisited: boolean; seenBadgeIds: string[] };
  /** Persisted daily-challenge ledger snapshot. */
  challenges: { dateKey: string; completedIds: string[]; totalPoints: number };
}

/** The full, versioned, checksummed backup document. */
export interface BackupBundle {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** Epoch ms the backup was built (informational; not part of the checksum). */
  exportedAt: number;
  /** FNV-1a hash over the canonical serialization of `data` (integrity guard). */
  checksum: string;
  data: BackupData;
}

// ---------------------------------------------------------------------------
// Checksum — deterministic FNV-1a over a canonical (sorted-key) JSON string
// ---------------------------------------------------------------------------

/**
 * Stable stringify: object keys are emitted in sorted order at every depth so
 * the checksum depends only on VALUES, not on key insertion order (which JSON
 * round-trips and JS engines don't guarantee). Arrays keep their order.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/**
 * FNV-1a (32-bit) of a string, returned as fixed 8-char hex. Not cryptographic
 * — just a cheap, dependency-free integrity check that a hand-edited or
 * truncated backup is caught before it corrupts the database.
 */
export function checksumOf(data: BackupData): string {
  const str = canonical(data);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (stays in 32-bit range).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Build + serialize (export side)
// ---------------------------------------------------------------------------

/** Assemble a checksummed bundle from a gathered dataset snapshot. */
export function buildBackup(data: BackupData, nowMs: number = Date.now()): BackupBundle {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: nowMs,
    checksum: checksumOf(data),
    data,
  };
}

/** Pretty-printed JSON of a bundle, ready for the share sheet / a file. */
export function serializeBackup(bundle: BackupBundle): string {
  return JSON.stringify(bundle, null, 2);
}

// ---------------------------------------------------------------------------
// Parse + validate (import side)
// ---------------------------------------------------------------------------

export type BackupParseError =
  /** Not valid JSON at all. */
  | 'not-json'
  /** Valid JSON but not a Hoopilot backup (wrong/absent format marker). */
  | 'wrong-format'
  /** A backup from a newer/unknown schema version we can't safely read. */
  | 'unsupported-version'
  /** Structurally malformed (missing/typed-wrong data arrays). */
  | 'malformed'
  /** Checksum doesn't match the data — truncated or tampered. */
  | 'checksum-mismatch';

export type BackupParseResult =
  | { ok: true; bundle: BackupBundle }
  | { ok: false; error: BackupParseError };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Shape-check the data payload without trusting any field. */
function validData(d: unknown): d is BackupData {
  if (d === null || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  if (!Array.isArray(o.sessions) || !Array.isArray(o.shots) || !Array.isArray(o.jumps)) {
    return false;
  }
  const a = o.achievementsSeen as Record<string, unknown> | undefined;
  if (a == null || typeof a.hasVisited !== 'boolean' || !isStringArray(a.seenBadgeIds)) {
    return false;
  }
  const c = o.challenges as Record<string, unknown> | undefined;
  if (
    c == null ||
    typeof c.dateKey !== 'string' ||
    !isStringArray(c.completedIds) ||
    typeof c.totalPoints !== 'number'
  ) {
    return false;
  }
  return true;
}

/**
 * Parse a backup string into a validated bundle, or a typed error. Order of
 * checks matters: format/version before structure before checksum, so the
 * error the user sees is the most specific true cause. NEVER throws.
 */
export function parseBackup(raw: string): BackupParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not-json' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, error: 'wrong-format' };
  }
  const b = parsed as Record<string, unknown>;
  if (b.format !== BACKUP_FORMAT) return { ok: false, error: 'wrong-format' };
  if (b.version !== BACKUP_VERSION) return { ok: false, error: 'unsupported-version' };
  if (!validData(b.data)) return { ok: false, error: 'malformed' };
  if (typeof b.checksum !== 'string' || b.checksum !== checksumOf(b.data)) {
    return { ok: false, error: 'checksum-mismatch' };
  }
  return {
    ok: true,
    bundle: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: typeof b.exportedAt === 'number' ? b.exportedAt : 0,
      checksum: b.checksum,
      data: b.data,
    },
  };
}

// ---------------------------------------------------------------------------
// Merge (import side)
// ---------------------------------------------------------------------------

/** Rows an import should insert, plus a human-facing summary of what happened. */
export interface BackupMergePlan {
  /** Sessions to insert (those whose id is NOT already present locally). */
  sessions: SessionRow[];
  /** Shots belonging only to the inserted sessions. */
  shots: ShotRow[];
  /** Jumps to insert (deduped by id against existing jumps). */
  jumps: JumpRow[];
  /**
   * Merged achievements-seen + challenge ledger — additive union of badge ids,
   * OR of hasVisited, and the LARGER points total (a ledger only grows, so the
   * higher number is the truthful career total; imported completedIds are
   * unioned only when they share the local dateKey, else the local day wins).
   */
  achievementsSeen: BackupData['achievementsSeen'];
  challenges: BackupData['challenges'];
  /** How many sessions were newly imported. */
  imported: number;
  /** How many sessions were skipped as duplicates (id already present). */
  skipped: number;
}

/** Existing local ids the merge dedupes against. */
export interface ExistingIds {
  sessionIds: readonly number[];
  jumpIds: readonly number[];
}

/**
 * Plan an additive merge of `incoming` onto the existing local dataset,
 * described only by its id sets + the two mergeable key/value snapshots.
 *
 * - Sessions: an incoming session whose id already exists locally is SKIPPED
 *   whole; its shots are dropped with it (never overwrite). Distinct ids are
 *   imported. Duplicate ids WITHIN the incoming set collapse to the first.
 * - Shots: only those whose sessionId is in the inserted-sessions set survive
 *   (an orphan shot pointing at a skipped/absent session would violate the FK).
 * - Jumps: deduped by id against the existing jump ids (jumps have no parent).
 * - achievementsSeen / challenges: merged as described on {@link BackupMergePlan}.
 *
 * Pure and deterministic; the caller does the actual inserts.
 */
export function mergeBackup(
  incoming: BackupData,
  existing: ExistingIds,
  localAchievements: BackupData['achievementsSeen'],
  localChallenges: BackupData['challenges'],
): BackupMergePlan {
  const existingSessions = new Set(existing.sessionIds);
  const seenIncoming = new Set<number>();
  const sessions: SessionRow[] = [];
  let skipped = 0;
  for (const s of incoming.sessions) {
    if (existingSessions.has(s.id) || seenIncoming.has(s.id)) {
      skipped += 1;
      continue;
    }
    seenIncoming.add(s.id);
    sessions.push(s);
  }
  const insertedSessionIds = new Set(sessions.map((s) => s.id));
  const shots = incoming.shots.filter((sh) => insertedSessionIds.has(sh.sessionId));

  const existingJumps = new Set(existing.jumpIds);
  const seenJumpIds = new Set<number>();
  const jumps: JumpRow[] = [];
  for (const j of incoming.jumps) {
    if (existingJumps.has(j.id) || seenJumpIds.has(j.id)) continue;
    seenJumpIds.add(j.id);
    jumps.push(j);
  }

  const achievementsSeen: BackupData['achievementsSeen'] = {
    hasVisited: localAchievements.hasVisited || incoming.achievementsSeen.hasVisited,
    seenBadgeIds: Array.from(
      new Set([...localAchievements.seenBadgeIds, ...incoming.achievementsSeen.seenBadgeIds]),
    ),
  };

  const sameDay = localChallenges.dateKey === incoming.challenges.dateKey;
  const challenges: BackupData['challenges'] = {
    // Keep the local day; only union today's completions when the days match,
    // so importing a backup from another day can't resurrect stale completions.
    dateKey: localChallenges.dateKey,
    completedIds: sameDay
      ? Array.from(
          new Set([...localChallenges.completedIds, ...incoming.challenges.completedIds]),
        )
      : localChallenges.completedIds,
    // The ledger only ever grows — the larger total is the honest career sum.
    totalPoints: Math.max(localChallenges.totalPoints, incoming.challenges.totalPoints),
  };

  return {
    sessions,
    shots,
    jumps,
    achievementsSeen,
    challenges,
    imported: sessions.length,
    skipped,
  };
}
