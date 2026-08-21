/**
 * firebaseSync — the IO shell around firebaseRecords' pure planner.
 *
 * The local SQLite database is the SOURCE OF TRUTH. This module only mirrors
 * it: it uploads numeric session records, and it imports records this device
 * has never seen (a session recorded on the user's other phone). It never
 * overwrites a local row and never deletes one.
 *
 * The merge rule lives in firebaseRecords.ts's header — read it there once,
 * rather than in two half-copies. What this file adds is the ORDER, which is
 * what makes an interrupted run safe:
 *
 *   - Shots are written BEFORE their session document. A run killed half way
 *     leaves shot documents with no session document, and the pull query only
 *     ever looks at session documents — so a partial record is invisible to
 *     other devices rather than importable as a truncated session.
 *   - The ledger only advances AFTER a write lands. A crash therefore
 *     re-pushes; because the document id is the record key, re-pushing
 *     overwrites and can never duplicate.
 *   - Imports are applied one record at a time through db.importBackup (which
 *     is additive, transactional and never throws), and the ledger is written
 *     after each one.
 *
 * NOTHING HERE THROWS AND NOTHING BLOCKS THE APP. Unconfigured build, no
 * account, airplane mode, dead wifi — each returns an ordinary result the UI
 * can phrase for the user, and every network call has a hard timeout so no
 * screen can spin forever. Cloud sync is only ever started by an explicit user
 * action or right after a sign-in; the demo path never waits on it.
 */
import Storage from 'expo-sqlite/kv-store';

import { getFirebase, withTimeout, type FirebaseServices } from './firebaseApp';
import {
  allSessions,
  importBackup,
  listSessions,
  sessionShotOutcomes,
  sessionShots,
} from './db';
import {
  SYNC_SESSION_CAP,
  assertUploadable,
  emptyLedger,
  markImported,
  markPushed,
  parseCloudSession,
  parseCloudShot,
  parseLedger,
  planSync,
  toCloudShot,
  toSessionRow,
  toShotRow,
  type CloudShot,
  type LocalSessionInput,
  type SyncLedger,
} from './firebaseRecords';

/** Where the opaque per-install device id lives. */
const DEVICE_KEY = 'hoopai.cloud.device';
/** Per-account sync ledger. Scoped by uid so two accounts never share one. */
function ledgerKey(uid: string): string {
  return `hoopai.cloud.ledger.${uid}`;
}

/** Firestore batches cap at 500 writes; stay well under with room for the session doc. */
const BATCH_LIMIT = 400;

/** Ceiling for the whole pass, so "Back up now" always answers. */
const SYNC_TIMEOUT_MS = 15_000;

export type SyncOutcome =
  /** No Firebase in this build, or nobody signed in. Not an error. */
  | 'off'
  /** Could not reach the cloud (offline, timeout, permission). Not an error. */
  | 'unreachable'
  | 'done';

export interface SyncSummary {
  outcome: SyncOutcome;
  /** Records uploaded this pass. */
  pushed: number;
  /** Records pulled from another device and added to SQLite. */
  imported: number;
  /** Records already mirrored with identical content. */
  unchanged: number;
}

const NOTHING: SyncSummary = { outcome: 'off', pushed: 0, imported: 0, unchanged: 0 };

/** 12 hex chars of randomness. NOT a hardware identifier — see the doc below. */
function freshDeviceId(): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

/**
 * This install's device id, minted on first use.
 *
 * Deliberately RANDOM and app-local: it namespaces record keys so two phones
 * cannot collide, and that is all it does. It is not the IDFA, not the Android
 * id, not derived from any hardware property, and it never leaves the user's
 * own Firestore documents.
 */
export async function deviceId(): Promise<string> {
  try {
    const existing = await Storage.getItem(DEVICE_KEY);
    if (typeof existing === 'string' && existing.length > 0) return existing;
    const fresh = freshDeviceId();
    await Storage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    // Storage unavailable: a per-launch id still keys this pass correctly, it
    // just cannot recognise its own uploads after a restart.
    return freshDeviceId();
  }
}

async function readLedger(uid: string): Promise<SyncLedger> {
  try {
    return parseLedger(await Storage.getItem(ledgerKey(uid)));
  } catch {
    return emptyLedger();
  }
}

async function writeLedger(uid: string, ledger: SyncLedger): Promise<void> {
  try {
    await Storage.setItem(ledgerKey(uid), JSON.stringify(ledger));
  } catch {
    // A ledger we could not persist costs one redundant (idempotent) push
    // next time. Never worth failing a sync over.
  }
}

/** Drop this account's ledger — used on sign-out so a new account starts clean. */
export async function clearLedger(uid: string): Promise<void> {
  try {
    await Storage.removeItem(ledgerKey(uid));
  } catch {
    // Nothing to do; a stale ledger only causes idempotent re-pushes.
  }
}

/** `users/{uid}/sessions` — the only collection this app reads or writes. */
function sessionsPath(uid: string): [string, string, string] {
  return ['users', uid, 'sessions'];
}

/** Read every mirrored session document for this account. */
async function fetchRemoteSessions(services: FirebaseServices, uid: string) {
  const { storeApi, db } = services;
  const [a, b, c] = sessionsPath(uid);
  const q = storeApi.query(
    storeApi.collection(db, a, b, c),
    storeApi.orderBy('startedAt', 'desc'),
    storeApi.limit(SYNC_SESSION_CAP),
  );
  const snap = await withTimeout(storeApi.getDocs(q));
  const out = [];
  for (const docSnap of snap.docs) {
    const parsed = parseCloudSession(docSnap.data(), docSnap.id);
    if (parsed != null) out.push(parsed);
  }
  return out;
}

/** Read the shots of one mirrored session. */
async function fetchRemoteShots(
  services: FirebaseServices,
  uid: string,
  recordKey: string,
): Promise<CloudShot[]> {
  const { storeApi, db } = services;
  const [a, b, c] = sessionsPath(uid);
  const snap = await withTimeout(
    storeApi.getDocs(storeApi.collection(db, a, b, c, recordKey, 'shots')),
  );
  const out: CloudShot[] = [];
  for (const docSnap of snap.docs) {
    const parsed = parseCloudShot(docSnap.data());
    if (parsed != null) out.push(parsed);
  }
  out.sort((x, y) => x.shotIndex - y.shotIndex);
  return out;
}

/**
 * Upload one record: its shots first, then the session document.
 *
 * Every document goes through {@link assertUploadable} on the way out. If a
 * payload ever carried a frame, a clip path or any non-scalar value, this
 * throws and NOTHING is written — refusing to sync is always better than
 * breaking the promise printed on the pitch deck.
 */
async function pushRecord(
  services: FirebaseServices,
  uid: string,
  item: { recordKey: string; session: Record<string, unknown>; localRowId: number },
): Promise<void> {
  const { storeApi, db } = services;
  const [a, b, c] = sessionsPath(uid);
  const sessionRef = storeApi.doc(db, a, b, c, item.recordKey);

  const shots = (await sessionShots(item.localRowId)).map(toCloudShot);
  for (let i = 0; i < shots.length; i += BATCH_LIMIT) {
    const batch = storeApi.writeBatch(db);
    for (const shot of shots.slice(i, i + BATCH_LIMIT)) {
      const payload = { ...shot } as unknown as Record<string, unknown>;
      assertUploadable(payload, `shot ${shot.shotIndex} of ${item.recordKey}`);
      batch.set(storeApi.doc(sessionRef, 'shots', String(shot.shotIndex)), payload);
    }
    await withTimeout(batch.commit());
  }

  assertUploadable(item.session, `session ${item.recordKey}`);
  await withTimeout(storeApi.setDoc(sessionRef, item.session));
}

/**
 * Mirror this device's records into the account, and import anything the
 * account holds that this device has never seen.
 *
 * Never throws. Returns what happened so the UI can say it plainly.
 */
export async function syncRecords(uid: string): Promise<SyncSummary> {
  if (uid.length === 0) return NOTHING;
  const services = await getFirebase();
  if (services == null) return NOTHING;

  let pushed = 0;
  let imported = 0;
  let unchanged = 0;
  let ledger = await readLedger(uid);

  try {
    const device = await deviceId();

    // ---- read the local side (source of truth) --------------------------
    const rows = await listSessions(SYNC_SESSION_CAP);
    const local: LocalSessionInput[] = [];
    for (const row of rows) {
      // Narrow two-column read — no trajectory blobs just to decide what
      // changed. See hashSessionDigest.
      local.push({ row, outcomes: await sessionShotOutcomes(row.id) });
    }
    const everySession = await allSessions();
    const nextLocalId = everySession.reduce((max, s) => Math.max(max, s.id), 0) + 1;

    // ---- read the cloud side -------------------------------------------
    const remote = await withTimeout(fetchRemoteSessions(services, uid), SYNC_TIMEOUT_MS);

    const plan = planSync({
      deviceId: device,
      local,
      remote,
      ledger,
      now: Date.now(),
      nextLocalId,
    });
    unchanged = plan.unchanged;

    // ---- push ----------------------------------------------------------
    for (const item of plan.push) {
      await pushRecord(services, uid, {
        recordKey: item.recordKey,
        session: item.session as unknown as Record<string, unknown>,
        localRowId: item.localRowId,
      });
      ledger = markPushed(ledger, item.recordKey, item.hash);
      pushed += 1;
    }
    if (plan.push.length > 0) await writeLedger(uid, ledger);

    // ---- pull ----------------------------------------------------------
    for (const item of plan.pull) {
      const shots = await fetchRemoteShots(services, uid, item.recordKey);
      const result = await importBackup({
        sessions: [toSessionRow(item.session, item.localId)],
        shots: shots.map((s) => toShotRow(s, item.localId)),
        jumps: [],
      });
      // importBackup swallows its own failures and reports zero — only claim
      // the import (and only remember it) when a row actually landed.
      if (result.sessions > 0) {
        ledger = markImported(ledger, item.recordKey, item.localId);
        await writeLedger(uid, ledger);
        imported += 1;
      }
    }

    return { outcome: 'done', pushed, imported, unchanged };
  } catch (err) {
    console.warn('[firebase] sync did not finish', err);
    // Whatever landed before the failure is still recorded in the ledger.
    return { outcome: 'unreachable', pushed, imported, unchanged };
  }
}
