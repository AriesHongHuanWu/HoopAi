/**
 * firebaseRecords — the SHAPE of everything that may leave this phone, plus
 * the pure merge planner behind cloud sync. No firebase imports, no IO, no
 * clock: all of it is unit-testable on a laptop, which is the only way a
 * privacy boundary stays honest.
 *
 * ===========================================================================
 * THE BOUNDARY (product identity, and the pitch deck says so in writing)
 * ===========================================================================
 * NO FRAMES, NO VIDEO, NO IMAGES, NO PER-FRAME SEQUENCES leave the device.
 * Only numeric records and metadata. That is enforced here THREE ways, in the
 * shape of the payload rather than in a comment:
 *
 *   1. WHITELIST. {@link CLOUD_SESSION_FIELDS} / {@link CLOUD_SHOT_FIELDS} are
 *      the complete list of keys that can exist in an uploaded document. The
 *      sanitizers BUILD the payload key by key from that list, so a new
 *      SQLite column is invisible to sync until somebody deliberately adds it
 *      here. Everything else is stripped: videoPath, clipPath, trajectoryJson,
 *      signalsJson, formJson, arcJson, modeResultJson — gone.
 *   2. NAME GUARD. {@link findForbiddenField} rejects a payload carrying a key
 *      that reads like media (frame, clip, video, image, blob, base64, pose,
 *      trajectory, sequence, path, uri, …). This exists to catch the FUTURE
 *      edit — someone adding `framesJson` to the whitelist — not today's code.
 *   3. SHAPE GUARD. The same function rejects any value that is not a scalar
 *      (number | string | boolean | null), and any string longer than
 *      {@link MAX_STRING_LEN}. An array or object can hide a coordinate
 *      sequence; a long string can hide base64 pixels. Neither can be
 *      uploaded, at all, by construction.
 *
 * {@link assertUploadable} is called by firebaseSync immediately before every
 * write. A violation THROWS: the upload does not happen. Refusing to sync is
 * always the correct trade — the local SQLite store is the source of truth and
 * loses nothing by staying home.
 *
 * Frame-space and court-space POSITIONS (xCross, originX/Y, courtX/Y) are
 * deliberately not in the whitelist either. They are reconstructions of where
 * things were inside the camera image; the record worth keeping off-device is
 * the measurement (entry angle, outcome), not the geometry it came from.
 *
 * ===========================================================================
 * THE MERGE RULE (stated once, here, and implemented by planSync)
 * ===========================================================================
 * - IDENTITY: every record carries an immutable `recordKey` =
 *   `<originDeviceId>-<localId>`, and the Firestore document id IS that key.
 *   So an upload is IDEMPOTENT: re-pushing a record overwrites one document
 *   and can never create a second one. That single property is what makes
 *   "offline for a week, then sync" safe.
 * - PUSH is per-record and content-addressed. A record is pushed when
 *   hash(content) differs from the hash the ledger recorded for its key. It is
 *   NOT gated on a global "last synced at" cursor, because a run that dies
 *   half way would advance a cursor past rows that never landed. An offline
 *   device therefore pushes exactly the backlog it accumulated — no row lost,
 *   no row sent twice.
 * - PULL is additive and only ever ADDS. A remote record is imported when its
 *   key is neither already imported (ledger) nor originated by this device.
 *   Imported rows are inserted under FRESH local ids (never the remote
 *   `localId`, which belongs to another device's autoincrement), and the
 *   ledger remembers key -> new local id. That mapping is also what stops the
 *   round trip from duplicating: the next push re-uses the ORIGINAL recordKey
 *   for that row instead of minting a second key under this device's id.
 * - The local row is never overwritten by a pull. SQLite is the source of
 *   truth; the cloud is a mirror. Conflicts on one key resolve last-writer-
 *   wins IN THE CLOUD only.
 * - DELETIONS DO NOT PROPAGATE. A device that was offline while another device
 *   deleted a session keeps its copy — losing rows silently is worse than
 *   keeping one the user thought they deleted, and "delete everywhere" is a
 *   destructive operation that needs its own explicit UI.
 */
import type { SessionRow, SessionSummaryRow, ShotOutcomeRow, ShotRow } from './db';
import type { ShotOutcome } from '../core/types';

/** Payload schema version. Bump only on a non-superset change. */
export const CLOUD_SCHEMA = 1;

/** Longest string any synced field may carry (labels are short; base64 is not). */
export const MAX_STRING_LEN = 120;

/** How many sessions one sync pass looks at, newest first. */
export const SYNC_SESSION_CAP = 200;

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/** One session, as it exists in the cloud. Scalars only. */
export interface CloudSession {
  schema: number;
  /** `<originDeviceId>-<localId>`. Also the Firestore document id. */
  recordKey: string;
  /** Opaque per-install id of the device that RECORDED this session. */
  originDeviceId: string;
  /** The originating device's SQLite row id. Meaningless on any other device. */
  localId: number;
  startedAt: number;
  endedAt: number | null;
  label: string;
  modeId: string | null;
  attempts: number;
  makes: number;
  fgPct: number;
  /** Shots stored in the `shots` subcollection under this document. */
  shotCount: number;
  /** Epoch ms of the last successful upload. Excluded from the content hash. */
  updatedAt: number;
}

/** One shot, as it exists in the cloud. Scalars only, no trajectory. */
export interface CloudShot {
  schema: number;
  /** Position within its session — the shot's identity inside the document. */
  shotIndex: number;
  tStart: number;
  tResolved: number;
  outcome: ShotOutcome;
  corrected: number;
  outcomeCorrected: number;
  rimBounce: number;
  entryAngleDeg: number | null;
  releaseAngleDeg: number | null;
  shotValue: number | null;
  valueConfidence: number | null;
}

/** THE complete set of keys a session document may contain. */
export const CLOUD_SESSION_FIELDS = [
  'schema',
  'recordKey',
  'originDeviceId',
  'localId',
  'startedAt',
  'endedAt',
  'label',
  'modeId',
  'attempts',
  'makes',
  'fgPct',
  'shotCount',
  'updatedAt',
] as const satisfies readonly (keyof CloudSession)[];

/** THE complete set of keys a shot document may contain. */
export const CLOUD_SHOT_FIELDS = [
  'schema',
  'shotIndex',
  'tStart',
  'tResolved',
  'outcome',
  'corrected',
  'outcomeCorrected',
  'rimBounce',
  'entryAngleDeg',
  'releaseAngleDeg',
  'shotValue',
  'valueConfidence',
] as const satisfies readonly (keyof CloudShot)[];

/**
 * Field names that may never appear in an uploaded document, whatever their
 * value. Defence in depth against a future whitelist edit — the list above is
 * what actually decides the payload today.
 */
export const MEDIA_FIELD_PATTERN =
  /frame|video|image|photo|thumb|clip|blob|bitmap|pixel|png|jpe?g|base64|buffer|bytes|sequence|trajector|pose|joint|landmark|keypoint|skeleton|path|uri|url|json|snapshot|asset|file|media|audio/i;

/** Prefixes that mean "this string is a file reference or inline binary". */
const EMBEDDED_BINARY = /^(data:|file:|content:|blob:|\/data\/|\/var\/mobile\/|[A-Za-z]:\\)/;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * The first field of `payload` that must not be uploaded, or null when the
 * payload is clean. Returns the offending KEY so a failure names itself.
 */
export function findForbiddenField(payload: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(payload)) {
    if (MEDIA_FIELD_PATTERN.test(key)) return key;
    if (value === null) continue;
    const t = typeof value;
    // Arrays and objects are refused wholesale: a per-frame sequence, a pose
    // and a base64 chunk all arrive as one of those two.
    if (t !== 'number' && t !== 'string' && t !== 'boolean') return key;
    if (t === 'number' && !Number.isFinite(value as number)) return key;
    if (t === 'string') {
      const s = value as string;
      if (s.length > MAX_STRING_LEN) return key;
      if (EMBEDDED_BINARY.test(s)) return key;
    }
  }
  return null;
}

/**
 * Throw unless `payload` is safe to upload. Called on EVERY document
 * immediately before the write, so the boundary holds even if a caller
 * hand-builds a payload without going through the sanitizers.
 */
export function assertUploadable(payload: Record<string, unknown>, what: string): void {
  const bad = findForbiddenField(payload);
  if (bad !== null) {
    throw new Error(`[firebase] refused to upload ${what}: field "${bad}" is not a numeric record`);
  }
}

// ---------------------------------------------------------------------------
// Record keys
// ---------------------------------------------------------------------------

/** Firestore document ids may not contain '/' — keep keys to [0-9a-z-]. */
export function sanitizeDeviceId(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^0-9a-z]/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 24) : 'unknown';
}

/** `<originDeviceId>-<localId>` — immutable, and the Firestore document id. */
export function recordKeyFor(deviceId: string, localId: number): string {
  return `${sanitizeDeviceId(deviceId)}-${Math.trunc(localId)}`;
}

/** Split a record key back into its parts, or null when it is malformed. */
export function parseRecordKey(key: string): { deviceId: string; localId: number } | null {
  const at = key.lastIndexOf('-');
  if (at <= 0 || at === key.length - 1) return null;
  const localId = Number(key.slice(at + 1));
  if (!Number.isInteger(localId)) return null;
  return { deviceId: key.slice(0, at), localId };
}

// ---------------------------------------------------------------------------
// Sanitizers — the only way a payload is ever built
// ---------------------------------------------------------------------------

/** Clamp a user-typed label to something a document can carry. */
function label(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_STRING_LEN);
}

/** Finite number, or null. Never NaN — Firestore rejects it and so do we. */
function num(raw: number | null | undefined): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** 0/1 flag from a nullable SQLite integer. */
function flag(raw: number | null | undefined): number {
  return raw === 1 ? 1 : 0;
}

/**
 * Build the uploadable session document from a local row. Only whitelisted
 * keys are read; `videoPath`, `keepMode`, `recordingStartSec` and
 * `modeResultJson` are dropped on the floor.
 */
export function toCloudSession(opts: {
  row: SessionSummaryRow;
  recordKey: string;
  originDeviceId: string;
  shotCount: number;
  updatedAt: number;
}): CloudSession {
  const { row, recordKey, originDeviceId, shotCount, updatedAt } = opts;
  return {
    schema: CLOUD_SCHEMA,
    recordKey,
    originDeviceId: sanitizeDeviceId(originDeviceId),
    localId: Math.trunc(row.id),
    startedAt: row.startedAt,
    endedAt: num(row.endedAt),
    label: label(row.label),
    modeId: typeof row.modeId === 'string' ? label(row.modeId) : null,
    attempts: row.attempts ?? 0,
    makes: row.makes ?? 0,
    fgPct: num(row.fgPct) ?? 0,
    shotCount,
    updatedAt,
  };
}

/**
 * Build the uploadable shot document from a local row. Every JSON blob and
 * every media path on {@link ShotRow} is dropped here — see the file header.
 */
export function toCloudShot(shot: ShotRow): CloudShot {
  return {
    schema: CLOUD_SCHEMA,
    shotIndex: Math.trunc(shot.shotIndex),
    tStart: num(shot.tStart) ?? 0,
    tResolved: num(shot.tResolved) ?? 0,
    outcome: shot.outcome,
    corrected: flag(shot.corrected),
    outcomeCorrected: flag(shot.outcomeCorrected),
    rimBounce: flag(shot.rimBounce),
    entryAngleDeg: num(shot.entryAngleDeg),
    releaseAngleDeg: num(shot.releaseAngleDeg),
    shotValue: num(shot.shotValue),
    valueConfidence: num(shot.valueConfidence),
  };
}

// ---------------------------------------------------------------------------
// Rehydration — cloud document back into a local row
// ---------------------------------------------------------------------------

/**
 * A pulled session as a local {@link SessionRow}, under a FRESH local id.
 *
 * Everything the cloud does not carry comes back EMPTY, never invented:
 * no video path (the recording never left the other phone), no recording
 * clock, no mode snapshot. An imported session simply has no replay.
 */
export function toSessionRow(cloud: CloudSession, localId: number): SessionRow {
  return {
    id: localId,
    startedAt: cloud.startedAt,
    endedAt: cloud.endedAt,
    label: label(cloud.label),
    videoPath: null,
    keepMode: 'none',
    recordingStartSec: null,
    modeId: cloud.modeId,
    modeResultJson: null,
  };
}

/**
 * A pulled shot as a local {@link ShotRow}.
 *
 * `signalsJson`/`trajectoryJson` come back as the EMPTY document ('{}' / '[]')
 * because the trajectory was never uploaded. That is the honest value: the
 * shot's outcome and angles are real measurements from the other device, and
 * the arc is absent rather than reconstructed. `id` is ignored by
 * db.importBackup (shots get a fresh AUTOINCREMENT key), so 0 is fine.
 */
export function toShotRow(cloud: CloudShot, sessionId: number): ShotRow {
  return {
    id: 0,
    sessionId,
    shotIndex: cloud.shotIndex,
    tStart: cloud.tStart,
    tResolved: cloud.tResolved,
    outcome: cloud.outcome,
    corrected: cloud.corrected,
    outcomeCorrected: cloud.outcomeCorrected,
    rimBounce: cloud.rimBounce,
    entryAngleDeg: cloud.entryAngleDeg,
    releaseAngleDeg: cloud.releaseAngleDeg,
    xCross: null,
    originX: null,
    originY: null,
    signalsJson: '{}',
    trajectoryJson: '[]',
    clipPath: null,
    shotValue: cloud.shotValue,
    formJson: null,
    rechecked: 0,
    valueSource: null,
    valueConfidence: cloud.valueConfidence,
    courtX: null,
    courtY: null,
    arcJson: null,
  };
}

// ---------------------------------------------------------------------------
// Inbound parsing — the boundary works in both directions
// ---------------------------------------------------------------------------

function asNum(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function asOutcome(raw: unknown): ShotOutcome | null {
  return raw === 'make' || raw === 'miss' || raw === 'unsure' ? raw : null;
}

/**
 * Read a session document off the wire, keeping ONLY whitelisted keys.
 *
 * This is the inbound half of the privacy boundary: even if a document in the
 * project somehow carried a `clipPath` or a base64 field, it could not reach
 * SQLite through here — the parser never looks at anything but the whitelist.
 * Returns null when a required field is missing or the wrong type, so a
 * malformed document is skipped instead of importing half a session.
 */
export function parseCloudSession(raw: unknown, fallbackKey?: string): CloudSession | null {
  if (raw == null || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const recordKey = typeof d.recordKey === 'string' && d.recordKey.length > 0 ? d.recordKey : fallbackKey;
  const startedAt = asNum(d.startedAt);
  if (recordKey == null || startedAt == null) return null;
  const parts = parseRecordKey(recordKey);
  if (parts == null) return null;
  return {
    schema: asNum(d.schema) ?? CLOUD_SCHEMA,
    recordKey,
    originDeviceId:
      typeof d.originDeviceId === 'string' ? sanitizeDeviceId(d.originDeviceId) : parts.deviceId,
    localId: asNum(d.localId) ?? parts.localId,
    startedAt,
    endedAt: asNum(d.endedAt),
    label: label(typeof d.label === 'string' ? d.label : ''),
    modeId: typeof d.modeId === 'string' ? label(d.modeId) : null,
    attempts: asNum(d.attempts) ?? 0,
    makes: asNum(d.makes) ?? 0,
    fgPct: asNum(d.fgPct) ?? 0,
    shotCount: asNum(d.shotCount) ?? 0,
    updatedAt: asNum(d.updatedAt) ?? 0,
  };
}

/** Read a shot document off the wire. Whitelist only — see parseCloudSession. */
export function parseCloudShot(raw: unknown): CloudShot | null {
  if (raw == null || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const shotIndex = asNum(d.shotIndex);
  const outcome = asOutcome(d.outcome);
  if (shotIndex == null || outcome == null) return null;
  return {
    schema: asNum(d.schema) ?? CLOUD_SCHEMA,
    shotIndex: Math.trunc(shotIndex),
    tStart: asNum(d.tStart) ?? 0,
    tResolved: asNum(d.tResolved) ?? 0,
    outcome,
    corrected: d.corrected === 1 ? 1 : 0,
    outcomeCorrected: d.outcomeCorrected === 1 ? 1 : 0,
    rimBounce: d.rimBounce === 1 ? 1 : 0,
    entryAngleDeg: asNum(d.entryAngleDeg),
    releaseAngleDeg: asNum(d.releaseAngleDeg),
    shotValue: asNum(d.shotValue),
    valueConfidence: asNum(d.valueConfidence),
  };
}

// ---------------------------------------------------------------------------
// Content hash — what "this record changed" means
// ---------------------------------------------------------------------------

/** Sorted-key JSON so the hash depends on values, not key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** FNV-1a, 32-bit, hex. Same idiom as data/backup.ts's checksum. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Hash of a record's CONTENT — `updatedAt` is excluded on purpose. Including
 * the upload timestamp would change the hash on every run and re-push the
 * user's whole history every time they opened the app.
 *
 * The digest is the session document plus the per-shot outcome/value stream —
 * NOT the full shot rows. That is a deliberate IO trade: the stream comes from
 * db.sessionShotOutcomes, a narrow two-column read, so deciding what changed
 * across a whole history costs no trajectory blobs. It still catches every
 * edit a user can make to a session: a new shot, a make/miss correction, a
 * 2↔3 value fix, a rename, a re-end. Full shot rows are only ever read for
 * the sessions this digest says actually need uploading.
 */
export function hashSessionDigest(
  session: CloudSession,
  outcomes: readonly ShotOutcomeRow[],
): string {
  const { updatedAt: _stamp, ...content } = session;
  const stream = outcomes.map((o) => [o.outcome, o.shotValue ?? null]);
  return fnv1a(canonical({ session: content, shots: stream }));
}

// ---------------------------------------------------------------------------
// The ledger — what this device already pushed, and what it already imported
// ---------------------------------------------------------------------------

export interface SyncLedger {
  /** recordKey -> content hash of the payload last SUCCESSFULLY pushed. */
  pushed: Record<string, string>;
  /** recordKey -> the local session id a pulled record was imported into. */
  imported: Record<string, number>;
}

export function emptyLedger(): SyncLedger {
  return { pushed: {}, imported: {} };
}

/** Tolerant parse of a persisted ledger — a corrupt blob starts over empty. */
export function parseLedger(raw: string | null): SyncLedger {
  if (raw == null) return emptyLedger();
  try {
    const parsed = JSON.parse(raw) as Partial<SyncLedger>;
    const pushed: Record<string, string> = {};
    const imported: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed.pushed ?? {})) {
      if (typeof v === 'string') pushed[k] = v;
    }
    for (const [k, v] of Object.entries(parsed.imported ?? {})) {
      if (typeof v === 'number' && Number.isInteger(v)) imported[k] = v;
    }
    return { pushed, imported };
  } catch {
    return emptyLedger();
  }
}

/** Ledger + "key pushed with this content". Pure — returns a new ledger. */
export function markPushed(ledger: SyncLedger, recordKey: string, hash: string): SyncLedger {
  return { pushed: { ...ledger.pushed, [recordKey]: hash }, imported: ledger.imported };
}

/** Ledger + "key was imported into this local row". Pure. */
export function markImported(ledger: SyncLedger, recordKey: string, localId: number): SyncLedger {
  return { pushed: ledger.pushed, imported: { ...ledger.imported, [recordKey]: localId } };
}

/**
 * The record key a LOCAL row must be pushed under.
 *
 * A row this device imported keeps the ORIGINATING device's key — that is the
 * anti-duplication rule: without it, a pulled session would be re-uploaded
 * under this device's id and every phone would breed a copy on every sync.
 */
export function keyForLocalRow(deviceId: string, localId: number, ledger: SyncLedger): string {
  for (const [key, mapped] of Object.entries(ledger.imported)) {
    if (mapped === localId) return key;
  }
  return recordKeyFor(deviceId, localId);
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * One local session and the CHEAP fingerprint of its shots (see
 * {@link hashSessionDigest}). Full {@link ShotRow}s are read later, and only
 * for the sessions the plan actually pushes.
 */
export interface LocalSessionInput {
  row: SessionSummaryRow;
  outcomes: readonly ShotOutcomeRow[];
}

/** One record queued for upload. Its shots are read by the caller. */
export interface PushItem {
  recordKey: string;
  session: CloudSession;
  /**
   * THIS device's SQLite row id — what the caller reads shots from. Not the
   * same as `session.localId`, which belongs to the originating device when
   * the row was pulled from another phone.
   */
  localRowId: number;
  /** Content hash to record in the ledger once the write lands. */
  hash: string;
}

/** One remote record queued for import, with the local id it will take. */
export interface PullItem {
  recordKey: string;
  session: CloudSession;
  /** Fresh local id — never the remote `localId`. */
  localId: number;
}

export interface SyncPlan {
  push: PushItem[];
  pull: PullItem[];
  /** Local records already in the cloud with identical content. */
  unchanged: number;
  /** Remote records already present locally (imported earlier, or ours). */
  alreadyLocal: number;
}

/**
 * Decide what this sync pass must do. Pure: no clock beyond the `now` you
 * pass, no IO, no firebase. See the merge rule in the file header.
 */
export function planSync(input: {
  deviceId: string;
  local: readonly LocalSessionInput[];
  remote: readonly CloudSession[];
  ledger: SyncLedger;
  /** Epoch ms stamped as `updatedAt` on everything pushed this pass. */
  now: number;
  /** First unused local session id — pulled rows are numbered from here. */
  nextLocalId: number;
}): SyncPlan {
  const { deviceId, local, remote, ledger, now, nextLocalId } = input;
  const device = sanitizeDeviceId(deviceId);

  const push: PushItem[] = [];
  let unchanged = 0;
  /** Keys this device holds locally — its own rows AND ones it imported. */
  const heldKeys = new Set<string>(Object.keys(ledger.imported));

  for (const item of local) {
    const recordKey = keyForLocalRow(device, item.row.id, ledger);
    heldKeys.add(recordKey);
    const session = toCloudSession({
      row: item.row,
      recordKey,
      originDeviceId: parseRecordKey(recordKey)?.deviceId ?? device,
      shotCount: item.outcomes.length,
      updatedAt: now,
    });
    const hash = hashSessionDigest(session, item.outcomes);
    if (ledger.pushed[recordKey] === hash) {
      unchanged += 1;
      continue;
    }
    push.push({ recordKey, session, localRowId: item.row.id, hash });
  }

  const pull: PullItem[] = [];
  let alreadyLocal = 0;
  let nextId = Math.max(1, Math.trunc(nextLocalId));
  // Oldest first, so the local ids handed out ascend with real time.
  const incoming = [...remote].sort((a, b) => a.startedAt - b.startedAt);
  for (const session of incoming) {
    const key = session.recordKey;
    if (typeof key !== 'string' || key.length === 0) continue;
    if (heldKeys.has(key)) {
      alreadyLocal += 1;
      continue;
    }
    // A record whose key says THIS device originated it, but which is not in
    // our local rows, was deleted here. Deletions do not propagate, and they
    // do not come back either: importing it would resurrect a session the
    // user removed on this very phone.
    if (parseRecordKey(key)?.deviceId === device) {
      alreadyLocal += 1;
      continue;
    }
    pull.push({ recordKey: key, session, localId: nextId });
    nextId += 1;
  }

  return { push, pull, unchanged, alreadyLocal };
}
