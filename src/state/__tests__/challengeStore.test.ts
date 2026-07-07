/**
 * Ledger tests for the daily-challenge store (src/state/challengeStore.ts):
 * idempotent awards, day rollover, and the points total accumulating across
 * days. expo-sqlite/kv-store is mocked to an in-memory map (persistence
 * itself is zustand middleware, not under test) and the db module is mocked
 * so loadTodayAggregate can be exercised against fixture rows.
 */
jest.mock('expo-sqlite/kv-store', () => {
  const mem = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => {
        mem.set(key, value);
      },
      removeItem: (key: string) => {
        mem.delete(key);
      },
    },
  };
});

jest.mock('../../data/db', () => ({
  listSessions: jest.fn(),
  sessionShotOutcomes: jest.fn(),
}));

import {
  listSessions,
  sessionShotOutcomes,
  type SessionSummaryRow,
  type ShotOutcomeRow,
} from '../../data/db';
import { loadTodayAggregate, useChallenges } from '../challengeStore';

const listSessionsMock = listSessions as jest.MockedFunction<typeof listSessions>;
// The loader deliberately uses the NARROW outcome reader (no trajectory/form
// blobs) — mocking it here also pins that choice: reverting to sessionShots
// would fail these tests.
const sessionShotOutcomesMock = sessionShotOutcomes as jest.MockedFunction<
  typeof sessionShotOutcomes
>;

const initial = useChallenges.getState();

beforeEach(() => {
  useChallenges.setState({ dateKey: '', completedIds: [], totalPoints: 0 }, false);
  listSessionsMock.mockReset();
  sessionShotOutcomesMock.mockReset();
});

afterAll(() => {
  useChallenges.setState(initial, true);
});

describe('challengeStore ledger', () => {
  it('starts with no day, no completions and zero points', () => {
    const s = useChallenges.getState();
    expect(s.dateKey).toBe('');
    expect(s.completedIds).toEqual([]);
    expect(s.totalPoints).toBe(0);
  });

  it('award banks points and records the id once (idempotent per day)', () => {
    useChallenges.getState().award('2026-07-07', 'makes-15', 30);
    useChallenges.getState().award('2026-07-07', 'makes-15', 30);
    useChallenges.getState().award('2026-07-07', 'makes-15', 30);
    const s = useChallenges.getState();
    expect(s.dateKey).toBe('2026-07-07');
    expect(s.completedIds).toEqual(['makes-15']);
    expect(s.totalPoints).toBe(30);
  });

  it('award accumulates distinct challenges within a day', () => {
    useChallenges.getState().award('2026-07-07', 'makes-15', 30);
    useChallenges.getState().award('2026-07-07', 'streak-5', 50);
    useChallenges.getState().award('2026-07-07', 'perfect-day', 50);
    const s = useChallenges.getState();
    expect(s.completedIds).toEqual(['makes-15', 'streak-5', 'perfect-day']);
    expect(s.totalPoints).toBe(130);
  });

  it('rolls the completed set over on a new day but keeps the points ledger', () => {
    useChallenges.getState().award('2026-07-07', 'makes-15', 30);
    useChallenges.getState().award('2026-07-08', 'makes-15', 30);
    const s = useChallenges.getState();
    expect(s.dateKey).toBe('2026-07-08');
    // Yesterday's completion is gone; the same id completes fresh today.
    expect(s.completedIds).toEqual(['makes-15']);
    expect(s.totalPoints).toBe(60);
  });

  it('ensureDay resets completions on a date mismatch and keeps points', () => {
    useChallenges.getState().award('2026-07-07', 'threes-3', 40);
    useChallenges.getState().ensureDay('2026-07-08');
    const s = useChallenges.getState();
    expect(s.dateKey).toBe('2026-07-08');
    expect(s.completedIds).toEqual([]);
    expect(s.totalPoints).toBe(40);
  });

  it('ensureDay is a no-op on the same day', () => {
    useChallenges.getState().award('2026-07-07', 'threes-3', 40);
    useChallenges.getState().ensureDay('2026-07-07');
    expect(useChallenges.getState().completedIds).toEqual(['threes-3']);
  });

  it('award ignores a defensively-negative points value', () => {
    useChallenges.getState().award('2026-07-07', 'weird', -10);
    expect(useChallenges.getState().totalPoints).toBe(0);
    expect(useChallenges.getState().completedIds).toEqual(['weird']);
  });
});

describe('loadTodayAggregate', () => {
  /** Epoch ms for a local Y/M/D H:M (TZ-stable, same as goals.test.ts). */
  function localMs(y: number, m: number, d: number, h = 12, min = 0): number {
    return new Date(y, m, d, h, min).getTime();
  }

  /** Minimal SessionSummaryRow — only the fields the loader touches. */
  function sessionRow(id: number, startedAt: number, modeId: string | null): SessionSummaryRow {
    return { id, startedAt, modeId } as SessionSummaryRow;
  }

  /** Minimal narrow outcome row — exactly what the loader now reads. */
  function shotRow(outcome: ShotOutcomeRow['outcome'], shotValue: number | null = null): ShotOutcomeRow {
    return { outcome, shotValue };
  }

  it('aggregates only sessions started on the local day of nowMs', async () => {
    const now = localMs(2026, 6, 7, 15, 0); // 2026-07-07 15:00 local
    listSessionsMock.mockResolvedValue([
      sessionRow(1, localMs(2026, 6, 7, 9, 0), 'timed'),
      sessionRow(2, localMs(2026, 6, 7, 11, 0), null),
      sessionRow(3, localMs(2026, 6, 6, 20, 0), 'horse'), // yesterday
    ]);
    sessionShotOutcomesMock.mockImplementation(async (sessionId: number) => {
      if (sessionId === 1) {
        return [shotRow('make', 3), shotRow('make', 2), shotRow('miss')];
      }
      if (sessionId === 2) {
        return [shotRow('make', 3), shotRow('unsure'), shotRow('make', 2)];
      }
      throw new Error(`unexpected session ${sessionId}`);
    });

    const day = await loadTodayAggregate(now);
    expect(day.makes).toBe(4);
    expect(day.attempts).toBe(6);
    expect(day.threes).toBe(2);
    expect(day.bestStreak).toBe(2);
    expect(day.fgPct).toBeCloseTo(4 / 5); // 4 makes over 5 decided
    expect(day.modesPlayed).toBe(1); // 'timed' only — yesterday's horse is out
    // Yesterday's session is never fetched.
    expect(sessionShotOutcomesMock).toHaveBeenCalledTimes(2);
  });

  it('returns an empty aggregate when nothing was played today', async () => {
    const now = localMs(2026, 6, 7, 15, 0);
    listSessionsMock.mockResolvedValue([sessionRow(3, localMs(2026, 6, 1, 9, 0), 'timed')]);

    const day = await loadTodayAggregate(now);
    expect(day).toEqual({
      makes: 0,
      attempts: 0,
      threes: 0,
      bestStreak: 0,
      fgPct: 0,
      modesPlayed: 0,
    });
    expect(sessionShotOutcomesMock).not.toHaveBeenCalled();
  });
});
