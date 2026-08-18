/**
 * Shared UI kit contract — press physics and skeletons.
 *
 * Pins the two seams this work item added to components/ui.tsx:
 *
 * - PRESS. `<Card onPress>` no longer flat-cuts with a background tint; it
 *   delegates to PressableCard, which runs the SHARED PressScale spring. The
 *   headline assertion is that Card and PillButton drive withSpring with
 *   byte-identical numbers — that equality IS the feature (one press weight
 *   for the whole app), so it is pinned rather than left to code review.
 *   Reduced motion keeps the no-spring opacity path, and a Card with no
 *   onPress must stay a plain, non-interactive View.
 *
 * - SKELETONS. SkeletonCard draws the SHAPE of the arriving card on Shimmer:
 *   an optional hero-numeral block plus N ragged-width text bars, sized from
 *   the type tokens, announced to a screen reader as one "Loading" node.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { color, radius, type } from '@/constants/tokens';

// ---------------------------------------------------------------------------
// Mocks

/** Flipped per-test so both the spring path and the reduced path are covered. */
const mockReducedMotion = jest.fn(() => false);

// Reanimated's worklets runtime can't load under jest without native modules.
// withSpring stays a spy: its arguments are the contract under test.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (component: unknown) => component,
  },
  useReducedMotion: () => mockReducedMotion(),
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: jest.fn((value: unknown) => value),
  withTiming: jest.fn((value: unknown) => value),
}));

// Skia is ESM-only and can't be required under jest, which is exactly why
// ui.tsx loads Shimmer lazily. Mocking the concrete module (the same path
// ui.tsx requires) lets the skeleton's geometry be asserted directly.
jest.mock('../motion/Shimmer', () => ({
  __esModule: true,
  Shimmer: jest.fn(() => null),
}));

// PressScale routes haptics through the gated gateway; assert it is used
// rather than expo-haptics.
jest.mock('@/utils/haptics', () => ({
  haptic: {
    selection: jest.fn(),
    impactLight: jest.fn(),
    impactMedium: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { Card, PillButton, PressableCard, SkeletonCard } from '../ui';

const reanimated = jest.requireMock('react-native-reanimated') as { withSpring: jest.Mock };
const shimmerMod = jest.requireMock('../motion/Shimmer') as { Shimmer: jest.Mock };
const hapticsMod = jest.requireMock('@/utils/haptics') as { haptic: Record<string, jest.Mock> };

// ---------------------------------------------------------------------------
// Helpers

function render(el: React.ReactElement): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r;
}

/** Unmount inside act — SkeletonCard's measured width is state. */
function unmount(r: ReactTestRenderer): void {
  act(() => {
    r.unmount();
  });
}

/** Only HOST nodes: findAll also returns the composite that forwarded props. */
function hostsWithRole(r: ReactTestRenderer, role: string) {
  return r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === role);
}

/** The single Pressable a press primitive renders (spring path or not). */
function pressableOf(r: ReactTestRenderer) {
  const hits = r.root.findAll(
    (n) => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button',
  );
  return hits[0]!;
}

/** Resolve a style prop that may be an array or Pressable's callback form. */
function flatStyle(style: unknown): Record<string, unknown> {
  const resolved = typeof style === 'function' ? style({ pressed: false }) : style;
  return (StyleSheet.flatten(resolved as never) ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  mockReducedMotion.mockReturnValue(false);
  reanimated.withSpring.mockClear();
  shimmerMod.Shimmer.mockClear();
  Object.values(hapticsMod.haptic).forEach((fn) => fn.mockClear());
});

// ---------------------------------------------------------------------------
// Press feedback

describe('Card press physics', () => {
  it('drives the SAME spring as PillButton — one press weight for the app', () => {
    const card = render(<Card onPress={() => {}}>{null}</Card>);
    act(() => {
      pressableOf(card).props.onPressIn();
    });
    const cardSpring = reanimated.withSpring.mock.calls[0];
    unmount(card);

    reanimated.withSpring.mockClear();
    const pill = render(<PillButton label="Start" onPress={() => {}} />);
    act(() => {
      pressableOf(pill).props.onPressIn();
    });
    const pillSpring = reanimated.withSpring.mock.calls[0];
    unmount(pill);

    // The literal numbers, so a future edit to either one has to justify
    // making the app press in two different weights.
    expect(cardSpring).toEqual([0.97, { damping: 20, stiffness: 400 }]);
    expect(cardSpring).toEqual(pillSpring);
  });

  it('springs back to rest on press-out', () => {
    const r = render(<Card onPress={() => {}}>{null}</Card>);
    act(() => {
      pressableOf(r).props.onPressOut();
    });
    expect(reanimated.withSpring).toHaveBeenCalledWith(1, { damping: 16, stiffness: 300 });
    unmount(r);
  });

  it('keeps the card surface and still fires onPress', () => {
    const onPress = jest.fn();
    const r = render(<Card onPress={onPress}>{null}</Card>);
    const pressable = pressableOf(r);
    expect(flatStyle(pressable.props.style)).toEqual(
      expect.objectContaining({ backgroundColor: color.surface, borderRadius: radius.lg }),
    );
    act(() => {
      pressable.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    unmount(r);
  });

  it('drops the spring under reduced motion and dims on press instead', () => {
    mockReducedMotion.mockReturnValue(true);
    const r = render(<Card onPress={() => {}}>{null}</Card>);
    const pressable = pressableOf(r);

    expect(pressable.props.onPressIn).toBeUndefined();
    expect(reanimated.withSpring).not.toHaveBeenCalled();
    // The pressed state is still legible — it just doesn't move.
    expect(flatStyle(() => pressable.props.style({ pressed: true }))).toEqual(
      expect.objectContaining({ opacity: 0.85 }),
    );
    unmount(r);
  });

  it('leaves a non-tappable Card inert — no button role, no press handlers', () => {
    const r = render(<Card>{null}</Card>);
    expect(hostsWithRole(r, 'button')).toHaveLength(0);
    unmount(r);
  });
});

describe('PressableCard', () => {
  it('routes its haptic through the gated gateway, never expo-haptics', () => {
    const r = render(
      <PressableCard onPress={() => {}} haptic="impactLight" accessibilityLabel="Open session">
        {null}
      </PressableCard>,
    );
    const pressable = pressableOf(r);
    expect(pressable.props.accessibilityLabel).toBe('Open session');
    act(() => {
      pressable.props.onPress();
    });
    expect(hapticsMod.haptic.impactLight).toHaveBeenCalledTimes(1);
    unmount(r);
  });

  it('dims and disables when disabled', () => {
    const r = render(
      <PressableCard onPress={() => {}} disabled>
        {null}
      </PressableCard>,
    );
    const pressable = pressableOf(r);
    expect(pressable.props.disabled).toBe(true);
    expect(flatStyle(pressable.props.style)).toEqual(expect.objectContaining({ opacity: 0.4 }));
    unmount(r);
  });

  it('still wraps in an entering view so screen staggers keep working', () => {
    const entering = { __entering: true } as never;
    const r = render(
      <PressableCard onPress={() => {}} entering={entering}>
        {null}
      </PressableCard>,
    );
    expect(r.root.findAll((n) => n.props.entering === entering).length).toBeGreaterThan(0);
    unmount(r);
  });
});

// ---------------------------------------------------------------------------
// Skeletons

describe('SkeletonCard', () => {
  /** Every Shimmer block SkeletonCard drew, in render order. */
  function blocks() {
    return shimmerMod.Shimmer.mock.calls.map(
      ([p]) => p as { width: number; height: number; radius: number },
    );
  }

  it('draws three ragged text bars by default and no hero block', () => {
    const r = render(<SkeletonCard />);
    const bars = blocks();
    expect(bars).toHaveLength(3);
    // All text bars: body ink height, small radius.
    bars.forEach((b) => {
      expect(b.height).toBe(type.body.fontSize);
      expect(b.radius).toBe(radius.sm);
    });
    // Ragged right edge — the last line breaks shortest.
    expect(bars[2]!.width).toBe(Math.round(bars[0]!.width * 0.6));
    expect(bars[1]!.width).toBe(Math.round(bars[0]!.width * 0.88));
    unmount(r);
  });

  it('adds a hero-numeral block above the bars when hero is set', () => {
    const r = render(<SkeletonCard hero lines={2} />);
    const bars = blocks();
    expect(bars).toHaveLength(3);
    // The hero block is first, full width, sized to the big stat it replaces.
    expect(bars[0]).toEqual(
      expect.objectContaining({ height: type.statLarge.lineHeight, radius: radius.md }),
    );
    expect(bars[0]!.width).toBeGreaterThan(bars[2]!.width);
    unmount(r);
  });

  it('clamps to at least one bar so lines={0} still reserves space', () => {
    const r = render(<SkeletonCard lines={0} />);
    expect(blocks()).toHaveLength(1);
    unmount(r);
  });

  it('announces itself as a single loading node', () => {
    const r = render(<SkeletonCard />);
    const announced = hostsWithRole(r, 'progressbar');
    expect(announced).toHaveLength(1);
    expect(announced[0]!.props.accessible).toBe(true);
    expect(announced[0]!.props.accessibilityLabel).toBe('Loading');
    unmount(r);
  });

  it('re-sizes its bars to the measured card width', () => {
    const r = render(<SkeletonCard lines={1} />);
    const seeded = blocks()[0]!.width;
    shimmerMod.Shimmer.mockClear();

    // A narrow container (e.g. a two-up grid cell) must not keep drawing
    // full-bleed bars — that is the whole reason the width is measured.
    act(() => {
      r.root
        .findAll((n) => typeof n.props.onLayout === 'function')[0]!
        .props.onLayout({ nativeEvent: { layout: { width: 200, height: 80 } } });
    });
    const measured = blocks()[0]!.width;
    expect(measured).toBeLessThan(seeded);
    unmount(r);
  });
});
