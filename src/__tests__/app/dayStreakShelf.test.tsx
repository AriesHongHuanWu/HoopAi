/**
 * DayStreakShelf contract tests — the consecutive-practice-DAY badge shelf.
 *
 * Pins the honesty-critical seams of surfacing src/core/dayStreakBadges.ts:
 * - Earned vs locked rungs render as two visibly different things, driven by
 *   the core's ladder rather than by thresholds re-typed in the component.
 * - A BROKEN streak (current 0, best 30) still shows every badge the best-ever
 *   run earned — a thing you did stays done — while the chase line resets to
 *   the current streak, which is the number the user can actually move today.
 * - The never-practised case renders an honest empty state with all six rungs
 *   locked, and while session dates are still loading the shelf renders
 *   NOTHING rather than a zero that might be wrong.
 *
 * Renders the real component against a mocked db, so the assertions are about
 * what a user would see on the Profile tab, not about internal state.
 */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { DAY_STREAK_BADGES } from '@/core/dayStreakBadges';

// ---------------------------------------------------------------------------
// Mocks (same shapes as src/__tests__/app/wiCDataScreens.test.tsx)

// Reanimated's worklets runtime can't load under jest without native modules.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (component: unknown) => component,
  },
  FadeIn: { duration: () => ({}) },
  FadeInDown: { duration: () => ({ delay: () => ({}) }) },
  LinearTransition: { duration: () => ({}) },
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('expo-router', () => {
  const ReactLocal = require('react') as typeof React;
  return {
    router: { push: jest.fn(), replace: jest.fn() },
    useFocusEffect: (cb: () => void | (() => void)) => ReactLocal.useEffect(cb, [cb]),
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/data/db', () => ({
  allSessionStartedAt: jest.fn(async () => [] as number[]),
}));

// ---------------------------------------------------------------------------
// Helpers

const db = jest.requireMock('@/data/db') as { allSessionStartedAt: jest.Mock };

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  // One extra flush for effects that chain multiple awaits.
  await act(async () => {});
  return r;
}

/** Unmount inside act — the focus-effect cleanup schedules React work. */
async function unmountSafely(r: ReactTestRenderer): Promise<void> {
  await act(async () => {
    r.unmount();
  });
}

type Json = ReturnType<ReactTestRenderer['toJSON']>;

/** Flatten every rendered string for "does this copy appear" assertions. */
function textOf(json: Json): string {
  if (json == null) return '';
  if (Array.isArray(json)) return json.map(textOf).join(' ');
  const kids = json.children ?? [];
  return kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join(' ');
}

/** Every badge tile's accessibility label, in ladder order. */
function tileLabels(r: ReactTestRenderer): string[] {
  return r.root
    .findAll(
      (n) =>
        typeof n.props.accessibilityLabel === 'string' &&
        DAY_STREAK_BADGES.some((b) => n.props.accessibilityLabel.startsWith(`${b.name},`)),
      { deep: false },
    )
    .map((n) => n.props.accessibilityLabel as string);
}

/**
 * Local-noon timestamp `n` days ago. Noon (not "now minus n * 86400000") so a
 * DST shift can never bump a date into the neighbouring local day.
 */
function daysAgoAtNoon(n: number): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
}

function DayStreakShelfUnderTest() {
  const { DayStreakShelf } = require('../../components/DayStreakShelf');
  return <DayStreakShelf />;
}

beforeEach(() => {
  db.allSessionStartedAt.mockReset();
  db.allSessionStartedAt.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------

describe('DayStreakShelf', () => {
  it('renders the earned rungs lit and the upcoming ones locked', async () => {
    // Today plus the 7 days before it → current 8, best 8.
    db.allSessionStartedAt.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => daysAgoAtNoon(i)),
    );

    const r = await render(<DayStreakShelfUnderTest />);
    const labels = tileLabels(r);

    // Every rung on the ladder is rendered, in order.
    expect(labels).toHaveLength(DAY_STREAK_BADGES.length);
    // 3 and 7 are earned at 8 days; 14 / 30 / 60 / 100 are not.
    expect(labels[0]).toContain('Three straight, earned');
    expect(labels[1]).toContain('Full week, earned');
    expect(labels[2]).toContain('Fortnight, locked');
    expect(labels[3]).toContain('Month strong, locked');
    expect(labels[4]).toContain('Iron habit, locked');
    expect(labels[5]).toContain('Hundred days, locked');
    // Locked rungs state their price in days rather than a fake progress bar.
    expect(labels[2]).toContain('Needs 14 days in a row');

    const text = textOf(r.toJSON());
    // Honest status line + days-to-next readout, both straight from the core.
    expect(text).toContain('8-day streak — today is banked');
    expect(text).toContain('6 more days in a row to earn Fortnight');
    // Current and best-ever both on the shelf.
    expect(text).toContain('DAY STREAK');
    expect(text).toContain('BEST EVER');
    await unmountSafely(r);
  });

  it('keeps badges earned by the best-ever run after the streak breaks', async () => {
    // A 30-day run that ended two months ago → current 0, best 30.
    db.allSessionStartedAt.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => daysAgoAtNoon(60 + i)),
    );

    const r = await render(<DayStreakShelfUnderTest />);
    const labels = tileLabels(r);

    // A broken streak never takes a badge away: 3 / 7 / 14 / 30 stay earned.
    expect(labels[0]).toContain('Three straight, earned');
    expect(labels[1]).toContain('Full week, earned');
    expect(labels[2]).toContain('Fortnight, earned');
    expect(labels[3]).toContain('Month strong, earned');
    expect(labels[4]).toContain('Iron habit, locked');
    expect(labels[5]).toContain('Hundred days, locked');

    const text = textOf(r.toJSON());
    // …but the chase resets to the CURRENT streak, and says so honestly.
    expect(text).toContain('No streak going — one session today starts one');
    expect(text).toContain('3 more days in a row to earn Three straight');
    // Best-ever 30 is still on display next to the 0-day current streak.
    expect(text).toContain('30');
    // Never invents a live streak it can't back up.
    expect(text).not.toContain('30-day streak');
    await unmountSafely(r);
  });

  it('renders an honest empty state, all rungs locked, with no sessions', async () => {
    db.allSessionStartedAt.mockResolvedValue([]);

    const r = await render(<DayStreakShelfUnderTest />);
    const labels = tileLabels(r);

    expect(labels).toHaveLength(DAY_STREAK_BADGES.length);
    expect(labels.every((l) => l.includes(', locked'))).toBe(true);

    const text = textOf(r.toJSON());
    expect(text).toContain('No practice days recorded yet');
    // No fabricated streak numerals in the zero state.
    expect(text).not.toContain('day streak —');
    expect(text).toContain('3 more days in a row to earn Three straight');
    await unmountSafely(r);
  });

  it('renders nothing while the session dates are still loading', async () => {
    // A promise that never settles — the pre-data frame must not guess a zero.
    db.allSessionStartedAt.mockReturnValue(new Promise<number[]>(() => {}));

    const r = await render(<DayStreakShelfUnderTest />);
    expect(r.toJSON()).toBeNull();
    await unmountSafely(r);
  });
});
