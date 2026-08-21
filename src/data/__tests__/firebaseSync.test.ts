/**
 * Tests for src/data/firebaseSync.ts — the IO shell, driven against a fake
 * Firestore so the assertions land on WHAT WOULD GO OVER THE WIRE.
 *
 * The two things this file exists to prove:
 *
 * 1. UNCONFIGURED AND OFFLINE ARE NORMAL. With no Firebase config, syncRecords
 *    returns 'off' without reading the database, without a network call and
 *    without throwing. With a dead connection it returns 'unreachable' the
 *    same way. This is the state the hackathon demo runs in.
 * 2. NO FRAMES, NO VIDEO, NO IMAGES. Every document actually handed to
 *    Firestore is inspected: whitelisted keys only, and the trajectory blob /
 *    clip path / video path of the local rows appear NOWHERE in the payload.
 */
const mockMem = new Map<string, string>();

jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItem: (key: string) => Promise.resolve(mockMem.get(key) ?? null),
    setItem: (key: string, value: string) => {
      mockMem.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key: string) => {
      mockMem.delete(key);
      return Promise.resolve(true);
    },
  },
}));

jest.mock('../firebaseApp', () => ({
  getFirebase: jest.fn(),
  // The real one adds a timeout; under test it must not add a timer.
  withTimeout: (promise: Promise<unknown>) => promise,
}));

jest.mock('../db', () => ({
  listSessions: jest.fn(),
  sessionShotOutcomes: jest.fn(),
  sessionShots: jest.fn(),
  allSessions: jest.fn(),
  importBackup: jest.fn(),
}));

import { getFirebase } from '../firebaseApp';
import {
  allSessions,
  importBackup,
  listSessions,
  sessionShotOutcomes,
  sessionShots,
  type SessionSummaryRow,
  type ShotRow,
} from '../db';
import { CLOUD_SESSION_FIELDS, CLOUD_SHOT_FIELDS, findForbiddenField } from '../firebaseRecords';
import { syncRecords } from '../firebaseSync';

const getFirebaseMock = getFirebase as jest.MockedFunction<typeof getFirebase>;
const listSessionsMock = listSessions as jest.MockedFunction<typeof listSessions>;
const outcomesMock = sessionShotOutcomes as jest.MockedFunction<typeof sessionShotOutcomes>;
const shotsMock = sessionShots as jest.MockedFunction<typeof sessionShots>;
const allSessionsMock = allSessions as jest.MockedFunction<typeof allSessions>;
const importBackupMock = importBackup as jest.MockedFunction<typeof importBackup>;

const UID = 'user-1';
const TRAJECTORY = '[[0,0.11,0.22],[1,0.33,0.44]]';
const CLIP = 'file:///var/mobile/clip-0.mp4';
const VIDEO = '/var/mobile/Containers/Data/Application/x/session-1.mp4';

function session(over: Partial<SessionSummaryRow> = {}): SessionSummaryRow {
  return {
    id: 1,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_600_000,
    label: 'Evening run',
    videoPath: VIDEO,
    keepMode: 'makes',
    recordingStartSec: 12.5,
    modeId: 'freeplay',
    modeResultJson: '{"score":9}',
    attempts: 2,
    makes: 1,
    fgPct: 0.5,
    ...over,
  };
}

function shot(index: number): ShotRow {
  return {
    id: index + 40,
    sessionId: 1,
    shotIndex: index,
    tStart: index,
    tResolved: index + 1,
    outcome: index === 0 ? 'make' : 'miss',
    corrected: 0,
    outcomeCorrected: 0,
    rimBounce: 0,
    entryAngleDeg: 46,
    releaseAngleDeg: 52,
    xCross: 0.5,
    originX: 0.3,
    originY: 0.8,
    signalsJson: '{"peak":0.9}',
    trajectoryJson: TRAJECTORY,
    clipPath: CLIP,
    shotValue: 2,
    formJson: '{"knee":118}',
    rechecked: 1,
    valueSource: 'court',
    valueConfidence: 0.7,
    courtX: 4,
    courtY: 6,
    arcJson: '[[0,1]]',
  };
}

/** One write Firestore was asked to perform. */
interface Write {
  path: string;
  data: Record<string, unknown>;
}

interface Ref {
  __path: string;
}

function isRef(value: unknown): value is Ref {
  return typeof value === 'object' && value !== null && '__path' in value;
}

/**
 * A fake `firebase/firestore` module: enough of the modular API for the sync
 * to run, and a log of every document it tried to write.
 */
function fakeFirestore(remote: Record<string, Record<string, unknown>[]>) {
  const writes: Write[] = [];
  let failGetDocs = false;

  const join = (first: unknown, segs: string[]): Ref => ({
    __path: isRef(first) ? [first.__path, ...segs].join('/') : segs.join('/'),
  });

  const storeApi = {
    collection: (first: unknown, ...segs: string[]) => join(first, segs),
    doc: (first: unknown, ...segs: string[]) => join(first, segs),
    query: (ref: Ref) => ref,
    orderBy: () => ({ __c: 'orderBy' }),
    limit: () => ({ __c: 'limit' }),
    getDocs: (ref: Ref) => {
      if (failGetDocs) return Promise.reject(new Error('network request failed'));
      const docs = (remote[ref.__path] ?? []).map((data) => ({
        id: String(data.recordKey ?? data.shotIndex ?? ''),
        data: () => data,
      }));
      return Promise.resolve({ docs });
    },
    setDoc: (ref: Ref, data: Record<string, unknown>) => {
      writes.push({ path: ref.__path, data });
      return Promise.resolve();
    },
    writeBatch: () => {
      const staged: Write[] = [];
      return {
        set: (ref: Ref, data: Record<string, unknown>) => staged.push({ path: ref.__path, data }),
        commit: () => {
          writes.push(...staged);
          return Promise.resolve();
        },
      };
    },
  };

  return {
    writes,
    breakNetwork: () => {
      failGetDocs = true;
    },
    services: {
      auth: {},
      db: { __db: true },
      authApi: {},
      storeApi,
      projectId: 'unit-test-project',
    },
  };
}

/** Point getFirebase at a fake project. */
function withFakeProject(remote: Record<string, Record<string, unknown>[]> = {}) {
  const fake = fakeFirestore(remote);
  getFirebaseMock.mockResolvedValue(
    fake.services as unknown as Awaited<ReturnType<typeof getFirebase>>,
  );
  return fake;
}

beforeEach(() => {
  mockMem.clear();
  // A stable device id, so record keys in the assertions are predictable.
  mockMem.set('hoopai.cloud.device', 'testdevice01');
  jest.clearAllMocks();
  listSessionsMock.mockResolvedValue([]);
  outcomesMock.mockResolvedValue([]);
  shotsMock.mockResolvedValue([]);
  allSessionsMock.mockResolvedValue([]);
  importBackupMock.mockResolvedValue({ sessions: 1, shots: 0, jumps: 0 });
});

describe('a build with no Firebase config', () => {
  it('answers "off" without reading the database or the network', async () => {
    getFirebaseMock.mockResolvedValue(null);
    const result = await syncRecords(UID);
    expect(result).toEqual({ outcome: 'off', pushed: 0, imported: 0, unchanged: 0 });
    // The demo path must not even pay for the local reads.
    expect(listSessionsMock).not.toHaveBeenCalled();
    expect(allSessionsMock).not.toHaveBeenCalled();
  });

  it('answers "off" when nobody is signed in', async () => {
    withFakeProject();
    const result = await syncRecords('');
    expect(result.outcome).toBe('off');
    expect(getFirebaseMock).not.toHaveBeenCalled();
  });
});

describe('a dead connection', () => {
  it('reports "unreachable" instead of throwing or hanging', async () => {
    const fake = withFakeProject();
    fake.breakNetwork();
    listSessionsMock.mockResolvedValue([session()]);
    allSessionsMock.mockResolvedValue([session()]);
    await expect(syncRecords(UID)).resolves.toEqual({
      outcome: 'unreachable',
      pushed: 0,
      imported: 0,
      unchanged: 0,
    });
    expect(fake.writes).toEqual([]);
  });
});

describe('what actually goes over the wire', () => {
  async function pushOneSession() {
    const fake = withFakeProject();
    listSessionsMock.mockResolvedValue([session()]);
    allSessionsMock.mockResolvedValue([session()]);
    outcomesMock.mockResolvedValue([
      { outcome: 'make', shotValue: 2 },
      { outcome: 'miss', shotValue: null },
    ]);
    shotsMock.mockResolvedValue([shot(0), shot(1)]);
    const result = await syncRecords(UID);
    return { fake, result };
  }

  it('uploads the session and its shots, and reports what it did', async () => {
    const { fake, result } = await pushOneSession();
    expect(result).toEqual({ outcome: 'done', pushed: 1, imported: 0, unchanged: 0 });
    expect(fake.writes.map((w) => w.path)).toEqual([
      // Shots first, session document LAST: an interrupted run leaves no
      // session document, so a partial record is invisible to other devices.
      'users/user-1/sessions/testdevice01-1/shots/0',
      'users/user-1/sessions/testdevice01-1/shots/1',
      'users/user-1/sessions/testdevice01-1',
    ]);
  });

  it('carries NO frame, video, image, clip or trajectory field', async () => {
    const { fake } = await pushOneSession();
    for (const write of fake.writes) {
      expect([write.path, findForbiddenField(write.data)]).toEqual([write.path, null]);
    }
    // The blobs the local rows DO carry must appear nowhere in the payload.
    const wire = JSON.stringify(fake.writes);
    expect(wire).not.toContain(TRAJECTORY);
    expect(wire).not.toContain(CLIP);
    expect(wire).not.toContain(VIDEO);
    expect(wire).not.toContain('signalsJson');
    expect(wire).not.toContain('formJson');
    expect(wire).not.toContain('arcJson');
  });

  it('carries exactly the whitelisted fields and nothing else', async () => {
    const { fake } = await pushOneSession();
    const sessionDoc = fake.writes[fake.writes.length - 1];
    expect(Object.keys(sessionDoc.data).sort()).toEqual([...CLOUD_SESSION_FIELDS].sort());
    for (const write of fake.writes.slice(0, -1)) {
      expect(Object.keys(write.data).sort()).toEqual([...CLOUD_SHOT_FIELDS].sort());
    }
  });

  it('writes nothing the second time when nothing changed', async () => {
    await pushOneSession();
    const { fake, result } = await pushOneSession();
    expect(result).toEqual({ outcome: 'done', pushed: 0, imported: 0, unchanged: 1 });
    expect(fake.writes).toEqual([]);
  });
});

describe('merging back on another device', () => {
  const REMOTE_KEY = 'otherphone99-4';
  const remote = {
    'users/user-1/sessions': [
      {
        schema: 1,
        recordKey: REMOTE_KEY,
        originDeviceId: 'otherphone99',
        localId: 4,
        startedAt: 1_600_000_000_000,
        endedAt: null,
        label: 'Their session',
        modeId: null,
        attempts: 1,
        makes: 1,
        fgPct: 1,
        shotCount: 1,
        updatedAt: 1,
      },
    ],
    [`users/user-1/sessions/${REMOTE_KEY}/shots`]: [
      {
        schema: 1,
        shotIndex: 0,
        tStart: 0,
        tResolved: 1,
        outcome: 'make',
        corrected: 0,
        outcomeCorrected: 0,
        rimBounce: 0,
        entryAngleDeg: 45,
        releaseAngleDeg: null,
        shotValue: 3,
        valueConfidence: null,
        // Even if a document somehow carried media, it must not reach SQLite.
        clipPath: 'file:///nope.mp4',
      },
    ],
  };

  it('imports an unseen record under a fresh local id, with no invented video', async () => {
    withFakeProject(remote);
    allSessionsMock.mockResolvedValue([session({ id: 7 })]);
    listSessionsMock.mockResolvedValue([]);

    const result = await syncRecords(UID);
    expect(result).toEqual({ outcome: 'done', pushed: 0, imported: 1, unchanged: 0 });

    const plan = importBackupMock.mock.calls[0][0];
    // Local id 8 — the next free one, never the remote row's id 4.
    expect(plan.sessions[0].id).toBe(8);
    expect(plan.sessions[0].label).toBe('Their session');
    expect(plan.sessions[0].videoPath).toBeNull();
    expect(plan.shots).toHaveLength(1);
    expect(plan.shots[0].sessionId).toBe(8);
    expect(plan.shots[0].trajectoryJson).toBe('[]');
    expect(plan.shots[0].clipPath).toBeNull();
    expect(plan.shots[0].entryAngleDeg).toBe(45);
  });

  it('does not import it again on the next sync', async () => {
    withFakeProject(remote);
    allSessionsMock.mockResolvedValue([session({ id: 7 })]);
    await syncRecords(UID);
    importBackupMock.mockClear();

    const again = await syncRecords(UID);
    expect(importBackupMock).not.toHaveBeenCalled();
    expect(again.imported).toBe(0);
  });

  it('does not claim an import the database refused', async () => {
    withFakeProject(remote);
    allSessionsMock.mockResolvedValue([]);
    // importBackup never throws; it reports zeros when it failed.
    importBackupMock.mockResolvedValue({ sessions: 0, shots: 0, jumps: 0 });
    const result = await syncRecords(UID);
    expect(result.imported).toBe(0);

    // ...and because it was never recorded as imported, the next pass retries.
    importBackupMock.mockResolvedValue({ sessions: 1, shots: 1, jumps: 0 });
    const retry = await syncRecords(UID);
    expect(retry.imported).toBe(1);
  });
});
