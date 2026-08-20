/**
 * FtSeedChip stale-feedback guard — the honest-copy regression test.
 *
 * The engine clears ftSeedLast at every arm/cancel/re-aim boundary, but the
 * chip must ALSO be safe on its own: a re-mounted chip that arms while a
 * LEFTOVER feedback object from a previous seed lifecycle is still sitting in
 * engine state must NOT replay it. Replaying a stale {ok:true} instantly
 * claimed "Court anchored — 2s and 3s now measured" and rewrote the persisted
 * lastFtCalSummary receipt while the pipeline had NO seed (its fresh arm still
 * pending) — a measurement claim with zero measurement behind it. Replaying a
 * stale {ok:false, shotsLeft:0} showed the failure beat and hid the chip while
 * the pipeline silently stayed armed.
 *
 * These tests pin: (1) the payload present AT ARM TIME is ignored, (2) a
 * FRESH payload produced after arming is honored (success copy + receipt),
 * (3) a stale exhausted-failure payload does not fail the fresh arm.
 */
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (component: unknown) => component,
  },
  FadeIn: { duration: () => ({ delay: () => ({}) }) },
  FadeInDown: { duration: () => ({ delay: () => ({}) }) },
  interpolate: () => 0,
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withDelay: (_ms: number, value: unknown) => value,
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

// Icons are decorative here; skip the font machinery.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// The sanctioned haptics gateway gates on settings internally — a no-op spy
// keeps the chip's taps silent under jest.
jest.mock('@/utils/haptics', () => ({
  __esModule: true,
  haptic: {
    selection: jest.fn(),
    impactLight: jest.fn(),
    impactMedium: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));

// The chip's only store write is the lastFtCalSummary receipt — spy on it.
const mockSet = jest.fn();
jest.mock('../../../state/settingsStore', () => ({
  __esModule: true,
  useSettings: {
    getState: () => ({ set: mockSet, hapticsEnabled: false }),
  },
}));

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { FtSeedChip, type FtSeedFeedback } from '../FtSeedChip';

// ---------------------------------------------------------------------------
// Helpers

function render(el: React.ReactElement): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r;
}

/** Every rendered string, flattened. */
function textOf(root: ReactTestInstance): string {
  return root
    .findAllByType(Text)
    .map((t) => React.Children.toArray(t.props.children).join(''))
    .join(' | ');
}

/** The offer's primary "first shot measures the court" Pressable. */
function armPressable(root: ReactTestInstance): ReactTestInstance {
  const matches = root.findAll(
    (n) =>
      typeof n.props?.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.startsWith('Measure the court') &&
      typeof n.props.onPress === 'function',
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function chip(feedback: FtSeedFeedback | null, over: Partial<Props> = {}) {
  return (
    <FtSeedChip
      armSeed={over.armSeed ?? jest.fn()}
      cancelSeed={over.cancelSeed ?? jest.fn()}
      captureStandStill={over.captureStandStill ?? jest.fn(async () => ({ ok: false as const, reason: 'reset' as const }))}
      feedback={feedback}
    />
  );
}
type Props = React.ComponentProps<typeof FtSeedChip>;

beforeEach(() => {
  jest.useFakeTimers();
  mockSet.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('FtSeedChip stale-feedback guard', () => {
  it('ignores a stale {ok:true} payload present at arm time — no false "Court anchored", no receipt', () => {
    const stale: FtSeedFeedback = { ok: true };
    const armSeed = jest.fn();
    const r = render(chip(stale, { armSeed }));

    act(() => {
      armPressable(r.root).props.onPress();
    });

    // Armed and WAITING — the stale success must not have been consumed.
    expect(armSeed).toHaveBeenCalledTimes(1);
    const text = textOf(r.root);
    expect(text).toContain('FT shot armed');
    expect(text).not.toContain('Court anchored');
    expect(mockSet).not.toHaveBeenCalled();
    r.unmount();
  });

  it('still honors a FRESH success produced after arming (new object identity)', () => {
    const stale: FtSeedFeedback = { ok: true };
    const r = render(chip(stale));

    act(() => {
      armPressable(r.root).props.onPress();
    });
    // Pipeline resolves a NEW attempt — fresh object, equal-looking payload.
    act(() => {
      r.update(chip({ ok: true }));
    });

    expect(textOf(r.root)).toContain('Court anchored');
    expect(mockSet).toHaveBeenCalledWith('lastFtCalSummary', { ts: expect.any(Number) });
    r.unmount();
  });

  it('ignores a stale exhausted failure at arm time — the fresh arm is not declared failed', () => {
    const stale: FtSeedFeedback = { ok: false, shotsLeft: 0 };
    const r = render(chip(stale));

    act(() => {
      armPressable(r.root).props.onPress();
    });

    const text = textOf(r.root);
    expect(text).toContain('FT shot armed');
    expect(text).not.toContain('No luck');
    r.unmount();
  });

  it('a null-feedback arm keeps reacting to the first real payload (baseline)', () => {
    const r = render(chip(null));

    act(() => {
      armPressable(r.root).props.onPress();
    });
    act(() => {
      r.update(chip({ ok: false, shotsLeft: 2 }));
    });

    // Miss with tries left: stays armed, quiet honest sub-line.
    const text = textOf(r.root);
    expect(text).toContain('FT shot armed');
    expect(text).toContain('Distances stay estimated');
    r.unmount();
  });
});
