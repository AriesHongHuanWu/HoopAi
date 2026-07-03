/**
 * Pure store-logic tests for the standalone scoreboard (src/state/scoreboardStore.ts).
 * expo-sqlite/kv-store is mocked to an in-memory map — persistence itself
 * (zustand's `persist` middleware) is not under test here, just the reducers.
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

import { useScoreboard } from '../scoreboardStore';

const initial = useScoreboard.getState();

beforeEach(() => {
  useScoreboard.setState(
    {
      homeName: 'Home',
      awayName: 'Away',
      homeScore: 0,
      awayScore: 0,
      period: 1,
    },
    false,
  );
});

afterAll(() => {
  useScoreboard.setState(initial, true);
});

describe('scoreboardStore', () => {
  it('starts at zero-zero, period 1, default names', () => {
    const s = useScoreboard.getState();
    expect(s.homeName).toBe('Home');
    expect(s.awayName).toBe('Away');
    expect(s.homeScore).toBe(0);
    expect(s.awayScore).toBe(0);
    expect(s.period).toBe(1);
  });

  it('score adds points and never goes below zero', () => {
    useScoreboard.getState().score('home', 3);
    useScoreboard.getState().score('home', 2);
    expect(useScoreboard.getState().homeScore).toBe(5);
    useScoreboard.getState().score('home', -1);
    expect(useScoreboard.getState().homeScore).toBe(4);
    useScoreboard.getState().score('away', -1);
    expect(useScoreboard.getState().awayScore).toBe(0);
  });

  it('score clamps at the 999 ceiling', () => {
    useScoreboard.setState({ homeScore: 998 } as never);
    useScoreboard.getState().score('home', 5);
    expect(useScoreboard.getState().homeScore).toBe(999);
  });

  it('score keeps the other team untouched', () => {
    useScoreboard.getState().score('home', 2);
    expect(useScoreboard.getState().awayScore).toBe(0);
  });

  it('setName renames a team independently', () => {
    useScoreboard.getState().setName('home', 'Warriors');
    useScoreboard.getState().setName('away', 'Bulls');
    expect(useScoreboard.getState().homeName).toBe('Warriors');
    expect(useScoreboard.getState().awayName).toBe('Bulls');
  });

  it('nextPeriod increments and caps at 99', () => {
    useScoreboard.getState().nextPeriod();
    expect(useScoreboard.getState().period).toBe(2);
    useScoreboard.setState({ period: 99 } as never);
    useScoreboard.getState().nextPeriod();
    expect(useScoreboard.getState().period).toBe(99);
  });

  it('swapSides exchanges names and scores', () => {
    useScoreboard.getState().setName('home', 'Warriors');
    useScoreboard.getState().setName('away', 'Bulls');
    useScoreboard.getState().score('home', 10);
    useScoreboard.getState().score('away', 7);
    useScoreboard.getState().swapSides();
    const s = useScoreboard.getState();
    expect(s.homeName).toBe('Bulls');
    expect(s.awayName).toBe('Warriors');
    expect(s.homeScore).toBe(7);
    expect(s.awayScore).toBe(10);
  });

  it('reset zeroes scores and period but keeps team names', () => {
    useScoreboard.getState().setName('home', 'Warriors');
    useScoreboard.getState().score('home', 10);
    useScoreboard.getState().nextPeriod();
    useScoreboard.getState().reset();
    const s = useScoreboard.getState();
    expect(s.homeScore).toBe(0);
    expect(s.awayScore).toBe(0);
    expect(s.period).toBe(1);
    expect(s.homeName).toBe('Warriors');
  });
});
