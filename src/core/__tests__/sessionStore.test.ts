/**
 * Stability guards on the session store: the store must never crash the app
 * when the persistence layer misbehaves, and user actions (End, corrections)
 * must be safe to repeat or mis-target.
 */
import type { ResolvedShot } from '../types';

jest.mock('../../data/db', () => ({
  createSession: jest.fn(),
  endSession: jest.fn(),
  insertShot: jest.fn(),
  updateShotOutcome: jest.fn(),
}));

import {
  createSession,
  endSession,
  insertShot,
  updateShotOutcome,
} from '../../data/db';
import { useSession } from '../../state/sessionStore';

const mockCreateSession = createSession as jest.Mock;
const mockEndSession = endSession as jest.Mock;
const mockInsertShot = insertShot as jest.Mock;
const mockUpdateShotOutcome = updateShotOutcome as jest.Mock;

function makeShot(id: number, outcome: ResolvedShot['outcome'] = 'make'): ResolvedShot {
  return {
    id,
    tStart: id * 10,
    tResolved: id * 10 + 2,
    outcome,
    signals: { geo: outcome === 'make', net: null, cls: null },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: null,
    releaseAngleDeg: null,
    releasePoint: null,
    originX: null,
    originY: null,
    trajectory: [],
  };
}

/** Flush pending microtasks + timers so fire-and-forget db chains settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.resetAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockCreateSession.mockResolvedValue(1);
  mockEndSession.mockResolvedValue(undefined);
  mockInsertShot.mockResolvedValue(1);
  mockUpdateShotOutcome.mockResolvedValue(undefined);
  useSession.getState().resetToIdle();
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('goLive', () => {
  it('goes live without persistence when createSession rejects', async () => {
    mockCreateSession.mockRejectedValue(new Error('db down'));
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    const s = useSession.getState();
    expect(s.phase).toBe('live');
    expect(s.sessionId).toBeNull();
    expect(s.startedAtMs).toBe(1000);
  });

  it('treats the -1 failure sentinel from createSession as no persistence', async () => {
    mockCreateSession.mockResolvedValue(-1);
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    const s = useSession.getState();
    expect(s.phase).toBe('live');
    expect(s.sessionId).toBeNull();
  });

  it('keeps the db session id when persistence works', async () => {
    mockCreateSession.mockResolvedValue(7);
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    expect(useSession.getState().sessionId).toBe(7);
  });
});

describe('addShot', () => {
  it('keeps in-memory stats even when insertShot rejects', async () => {
    mockCreateSession.mockResolvedValue(7);
    mockInsertShot.mockRejectedValue(new Error('disk full'));
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    useSession.getState().addShot(makeShot(1, 'make'));
    await flush();
    const s = useSession.getState();
    expect(s.stats.attempts).toBe(1);
    expect(s.stats.makes).toBe(1);
    expect(s.shots[0]!.rowId).toBeNull();
  });

  it('leaves rowId null when insertShot reports the -1 failure sentinel', async () => {
    mockCreateSession.mockResolvedValue(7);
    mockInsertShot.mockResolvedValue(-1);
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    useSession.getState().addShot(makeShot(1));
    await flush();
    expect(useSession.getState().shots[0]!.rowId).toBeNull();
  });

  it('stores the row id and syncs a pre-row-id correction', async () => {
    mockCreateSession.mockResolvedValue(7);
    let resolveInsert: (rowId: number) => void = () => {};
    mockInsertShot.mockImplementation(
      () => new Promise<number>((resolve) => (resolveInsert = resolve)),
    );
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    useSession.getState().addShot(makeShot(1, 'make'));
    // Correct before the insert resolves — the store must sync it afterwards.
    useSession.getState().correctShot(1, 'miss');
    resolveInsert(42);
    await flush();
    expect(useSession.getState().shots[0]!.rowId).toBe(42);
    expect(mockUpdateShotOutcome).toHaveBeenCalledWith(42, 'miss');
  });
});

describe('correctShot / correctShotValue', () => {
  it('correctShot is a no-op for an unknown shot id', async () => {
    mockCreateSession.mockResolvedValue(7);
    mockInsertShot.mockResolvedValue(42);
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    useSession.getState().addShot(makeShot(1, 'make'));
    await flush();
    const before = useSession.getState().stats;
    useSession.getState().correctShot(999, 'miss');
    expect(useSession.getState().stats).toEqual(before);
    expect(mockUpdateShotOutcome).not.toHaveBeenCalledWith(expect.anything(), 'miss');
  });

  it('correctShot flips outcome, rebuilds stats and persists', async () => {
    mockCreateSession.mockResolvedValue(7);
    mockInsertShot.mockResolvedValue(42);
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    useSession.getState().addShot(makeShot(1, 'make'));
    await flush();
    useSession.getState().correctShot(1, 'miss');
    const s = useSession.getState();
    expect(s.stats.makes).toBe(0);
    expect(s.stats.misses).toBe(1);
    expect(mockUpdateShotOutcome).toHaveBeenCalledWith(42, 'miss');
  });

  it('correctShot survives a rejected updateShotOutcome', async () => {
    mockCreateSession.mockResolvedValue(7);
    mockInsertShot.mockResolvedValue(42);
    mockUpdateShotOutcome.mockRejectedValue(new Error('db gone'));
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    useSession.getState().addShot(makeShot(1, 'make'));
    await flush();
    useSession.getState().correctShot(1, 'miss');
    await flush();
    expect(useSession.getState().stats.misses).toBe(1);
  });

  it('correctShotValue is a no-op for an unknown shot id', async () => {
    mockCreateSession.mockResolvedValue(7);
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    useSession.getState().addShot(makeShot(1, 'make'));
    await flush();
    const before = useSession.getState().stats;
    useSession.getState().correctShotValue(999, 3);
    expect(useSession.getState().stats).toEqual(before);
  });

  it('correctShotValue updates points for a known shot', async () => {
    mockCreateSession.mockResolvedValue(7);
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    useSession.getState().addShot(makeShot(1, 'make'));
    await flush();
    useSession.getState().correctShotValue(1, 3);
    expect(useSession.getState().stats.points).toBe(3);
  });
});

describe('finish', () => {
  it('is idempotent: double-tap End persists exactly once', async () => {
    mockCreateSession.mockResolvedValue(7);
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    await Promise.all([
      useSession.getState().finish({ nowMs: 2000 }),
      useSession.getState().finish({ nowMs: 2001 }),
    ]);
    await useSession.getState().finish({ nowMs: 2002 });
    expect(useSession.getState().phase).toBe('ended');
    expect(mockEndSession).toHaveBeenCalledTimes(1);
    expect(mockEndSession).toHaveBeenCalledWith(7, {
      endedAt: 2000,
      videoPath: null,
      recordingStartSec: null,
    });
  });

  it('still ends the session in memory when endSession rejects', async () => {
    mockCreateSession.mockResolvedValue(7);
    mockEndSession.mockRejectedValue(new Error('db gone'));
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    await expect(useSession.getState().finish({ nowMs: 2000 })).resolves.toBeUndefined();
    expect(useSession.getState().phase).toBe('ended');
  });

  it('ends cleanly with no session id (persistence never started)', async () => {
    mockCreateSession.mockResolvedValue(-1);
    await useSession.getState().goLive({ keepMode: 'makes', nowMs: 1000 });
    await useSession.getState().finish({ nowMs: 2000 });
    expect(useSession.getState().phase).toBe('ended');
    expect(mockEndSession).not.toHaveBeenCalled();
  });
});
