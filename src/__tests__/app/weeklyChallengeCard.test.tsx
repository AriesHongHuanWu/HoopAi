/**
 * WeeklyChallengeCard render contract — Home's 每週挑戰 block.
 *
 * WHY these assertions and not snapshots: the card's whole job is to show
 * numbers a user will trust, so the test pins the numbers and the honesty
 * rules rather than the markup:
 * - three rows, each metering the FIXED WeekAggregate it was handed;
 * - the done state appears exactly at target and stays at target when the
 *   week runs past it (the core clamps — the card must not un-clamp);
 * - an untouched week renders true zeros plus a stated zero state, never a
 *   fabricated or carried-over number;
 * - a goal blocked by MISSING INPUT (no baseline week, no court placement)
 *   renders the core's note, in the visible row AND in the a11y label, so a
 *   frozen bar is never silently passed off as a lazy week.
 *
 * Mock set follows src/__tests__/app/wiCDataScreens.test.tsx (reanimated's
 * worklet runtime and the icon font can't load headless).
 */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { color } from '@/constants/tokens';
import {
  WEEKLY_CHALLENGE_POOL,
  emptyWeekAggregate,
  type WeekAggregate,
  type WeeklyChallengeDef,
} from '@/core/weeklyChallenges';

// ---------------------------------------------------------------------------
// Mocks

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

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const { WeeklyChallengeCard } = require('@/components/WeeklyChallengeCard') as {
  WeeklyChallengeCard: React.ComponentType<{
    challenges: readonly WeeklyChallengeDef[];
    agg: WeekAggregate;
    entering?: unknown;
  }>;
};

// ---------------------------------------------------------------------------
// Helpers

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  await act(async () => {});
  return r;
}

/** Unmount inside act — teardown schedules React work like any other update. */
async function cleanup(r: ReactTestRenderer): Promise<void> {
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

/** Distinct accessibility labels on the card's `accessible` row containers. */
function rowLabels(r: ReactTestRenderer): string[] {
  const found = r.root.findAll(
    (n) => n.props?.accessible === true && typeof n.props?.accessibilityLabel === 'string',
  );
  return [...new Set(found.map((n) => String(n.props.accessibilityLabel)))];
}

/** Flattened style array of every progress-fill view, in render order. */
function fillColors(r: ReactTestRenderer): string[] {
  // Identified by the inline percentage width only this view carries — no
  // testID needed, and it breaks loudly if the fill stops being driven by it.
  const bars = r.root.findAll(
    (n) =>
      Array.isArray(n.props?.style) &&
      (n.props.style as unknown[]).some(
        (s) =>
          s != null && typeof s === 'object' && typeof (s as { width?: unknown }).width === 'string',
      ),
    { deep: false },
  );
  return bars.map((n) => {
    const flat: { backgroundColor?: string } = Object.assign(
      {},
      ...(n.props.style as unknown[]).filter(Boolean),
    );
    return String(flat.backgroundColor);
  });
}

/** A real pool challenge by id — keeps ids, targets and points honest. */
function def(id: string): WeeklyChallengeDef {
  const found = WEEKLY_CHALLENGE_POOL.find((c) => c.id === id);
  if (!found) throw new Error(`weekly pool has no challenge '${id}'`);
  return found;
}

/** w-makes-150 (120 pts), w-sessions-3 (100 pts), w-spots-5 (150 pts). */
const TRIO = [def('w-makes-150'), def('w-sessions-3'), def('w-spots-5')];
/** Points on offer across TRIO — the denominator of the '★ e/o' readout. */
const TRIO_OFFERED = 120 + 100 + 150;

/** WeekAggregate with overrides; everything else zero/null. */
function agg(overrides: Partial<WeekAggregate> = {}): WeekAggregate {
  return { ...emptyWeekAggregate(), ...overrides };
}

// ---------------------------------------------------------------------------

describe('WeeklyChallengeCard', () => {
  it('renders all three challenges metered against the fixed week aggregate', async () => {
    const r = await render(
      <WeeklyChallengeCard
        challenges={TRIO}
        agg={agg({ makes: 88, attempts: 200, sessions: 2, practiceDays: 2, distinctSpots: 4 })}
      />,
    );

    const text = textOf(r.toJSON());
    expect(text).toContain('WEEKLY CHALLENGES');
    // Every title, and every progress readout, straight off the aggregate.
    expect(text).toContain('Make 150 shots');
    expect(text).toContain('Track 3 sessions');
    expect(text).toContain('Shoot from 5 spots');
    expect(text).toContain('88/150');
    expect(text).toContain('2/3');
    expect(text).toContain('4/5');
    // Points chips are the pool's real values.
    expect(text).toContain('+120');
    expect(text).toContain('+100');
    expect(text).toContain('+150');
    // Nothing complete yet: nothing banked, everything still on offer.
    expect(text).toContain(`★ 0/${TRIO_OFFERED}`);

    expect(rowLabels(r)).toEqual([
      'Make 150 shots, 88 of 150, worth 120 points',
      'Track 3 sessions, 2 of 3, worth 100 points',
      'Shoot from 5 spots, 4 of 5, worth 150 points',
    ]);
    expect(fillColors(r)).toEqual([color.accent, color.accent, color.accent]);
    await cleanup(r);
  });

  it('shows the done state exactly at target and banks those points', async () => {
    const r = await render(
      <WeeklyChallengeCard
        challenges={TRIO}
        agg={agg({ makes: 150, attempts: 300, sessions: 3, practiceDays: 3, distinctSpots: 1 })}
      />,
    );

    const labels = rowLabels(r);
    expect(labels[0]).toBe('Make 150 shots, 150 of 150, completed, worth 120 points');
    expect(labels[1]).toBe('Track 3 sessions, 3 of 3, completed, worth 100 points');
    // Not at target — no completion claimed.
    expect(labels[2]).toBe('Shoot from 5 spots, 1 of 5, worth 150 points');

    // Done rows switch to the make green; the unfinished one stays accent.
    expect(fillColors(r)).toEqual([color.make, color.make, color.accent]);
    // 120 + 100 banked out of the trio's 370 on offer.
    expect(textOf(r.toJSON())).toContain(`★ 220/${TRIO_OFFERED}`);
    await cleanup(r);
  });

  it('holds a week that runs past target at target — never over 100%', async () => {
    const r = await render(
      <WeeklyChallengeCard
        challenges={TRIO}
        agg={agg({ makes: 900, attempts: 1800, sessions: 11, practiceDays: 7, distinctSpots: 9 })}
      />,
    );

    const text = textOf(r.toJSON());
    expect(text).toContain('150/150');
    expect(text).toContain('3/3');
    expect(text).toContain('5/5');
    expect(text).not.toContain('900/150');
    expect(rowLabels(r).every((l) => l.includes('completed'))).toBe(true);
    expect(textOf(r.toJSON())).toContain(`★ ${TRIO_OFFERED}/${TRIO_OFFERED}`);
    await cleanup(r);
  });

  it('renders an honest zero state for an untouched week', async () => {
    const r = await render(<WeeklyChallengeCard challenges={TRIO} agg={emptyWeekAggregate()} />);

    const text = textOf(r.toJSON());
    expect(text).toContain('No shots tracked this week yet');
    // True zeros — the challenges are still listed, none is claimed complete.
    expect(text).toContain('0/150');
    expect(text).toContain('0/3');
    expect(text).toContain('0/5');
    expect(text).toContain(`★ 0/${TRIO_OFFERED}`);
    expect(rowLabels(r).some((l) => l.includes('completed'))).toBe(false);
    expect(fillColors(r)).toEqual([color.accent, color.accent, color.accent]);
    await cleanup(r);
  });

  it('drops the zero state as soon as the week has any tracked shot', async () => {
    const r = await render(
      <WeeklyChallengeCard challenges={TRIO} agg={agg({ attempts: 1, sessions: 1 })} />,
    );
    expect(textOf(r.toJSON())).not.toContain('No shots tracked this week yet');
    await cleanup(r);
  });

  it('surfaces the core note when a goal is blocked by missing input', async () => {
    // distinctSpots undefined = "not measured" (the narrow shot read carries no
    // court placement); prevWeekFgPct null = no baseline week to beat.
    const r = await render(
      <WeeklyChallengeCard
        challenges={[def('w-spots-5'), def('w-beat-last-week')]}
        agg={agg({
          makes: 40,
          attempts: 90,
          sessions: 3,
          practiceDays: 3,
          distinctSpots: undefined,
          fgPct: 0.5,
          prevWeekFgPct: null,
        })}
      />,
    );

    const text = textOf(r.toJSON());
    expect(text).toContain('Court position was not recorded');
    expect(text).toContain('No previous week on record yet');
    // Blocked goals read a true 0 and are never marked complete.
    expect(text).toContain('0/5');
    expect(text).toContain('0/60');
    const labels = rowLabels(r);
    expect(labels.some((l) => l.includes('completed'))).toBe(false);
    // The note reaches screen readers too, not just sighted users.
    expect(labels[0]).toContain('Court position was not recorded');
    expect(labels[1]).toContain('No previous week on record yet');
    await cleanup(r);
  });

  it('renders nothing when no challenges were drawn', async () => {
    const r = await render(<WeeklyChallengeCard challenges={[]} agg={emptyWeekAggregate()} />);
    expect(r.toJSON()).toBeNull();
    await cleanup(r);
  });

  it('forwards the parent stagger entrance to its Card', async () => {
    const entering = { __entering: true };
    const r = await render(
      <WeeklyChallengeCard challenges={TRIO} agg={emptyWeekAggregate()} entering={entering} />,
    );
    const carriers = r.root.findAll((n) => n.props?.entering === entering);
    expect(carriers.length).toBeGreaterThan(0);
    await cleanup(r);
  });
});
