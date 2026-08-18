/**
 * SegmentedTabs contract — the in-screen section switcher.
 *
 * Four things are pinned here because each one silently degrades to "still
 * looks fine" if it breaks:
 *
 * - CONTROLLED. onChange fires with the segment's own value and NOTHING else
 *   moves; re-tapping the live segment is a no-op (no onChange, no haptic), so
 *   a screen can't be made to re-run selection work by a fat finger.
 * - A11Y. tablist + one tab per segment, `selected` true on exactly one of
 *   them, and the badge is spoken as what it MEANS (badgeLabel) rather than a
 *   bare digit. A segmented control whose selected state is invisible to
 *   VoiceOver is a control the user cannot navigate at all.
 * - MOTION. The indicator slides over `motion.tab` when motion is allowed and
 *   LANDS INSTANTLY under reduced motion — the reduced path must not call
 *   withTiming at all, which is the only externally observable difference.
 * - BADGES. A count renders, a zero count renders nothing (never a "0" that
 *   reads as a broken counter), and 'dot' renders a presence dot.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { color, motion } from '@/constants/tokens';

// ---------------------------------------------------------------------------
// Mocks

/** Flipped per-test so both the sliding path and the reduced path are covered. */
const mockReducedMotion = jest.fn(() => false);
/** Every shared value created this render, in creation order (index 0 = the
 *  indicator's translateX; PressScale's own springs follow). */
const mockSharedValues: { value: number }[] = [];

// Reanimated's worklets runtime can't load under jest without native modules.
// withTiming stays a spy: whether it is called at all IS the reduced-motion
// contract, and its arguments are the slide.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (component: unknown) => component,
  },
  Easing: {
    out: (fn: unknown) => fn,
    cubic: 'cubic',
  },
  useReducedMotion: () => mockReducedMotion(),
  // Stable per call site, like the real hook: a fresh object per render would
  // hand each pass its own `x`, and the effect's write would land somewhere the
  // test can no longer see.
  useSharedValue: (value: number) => {
    const ref = (require('react') as typeof import('react')).useRef<{ value: number } | null>(
      null,
    );
    if (ref.current === null) {
      ref.current = { value };
      mockSharedValues.push(ref.current);
    }
    return ref.current;
  },
  useAnimatedStyle: () => ({}),
  withSpring: jest.fn((value: unknown) => value),
  withTiming: jest.fn((value: unknown) => value),
}));

// PressScale routes its tick through the settings-gated gateway, never
// expo-haptics directly.
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

import { SegmentedTabs, SEGMENT_INDICATOR_TEST_ID, type SegmentedTabItem } from '../SegmentedTabs';

const reanimated = jest.requireMock('react-native-reanimated') as { withTiming: jest.Mock };
const hapticsMod = jest.requireMock('@/utils/haptics') as { haptic: Record<string, jest.Mock> };

// ---------------------------------------------------------------------------
// Helpers

const TRACK_W = 300;
/** Mirrors TRACK_INSET (space.xs) on both sides — see SegmentedTabs. */
const SEGMENT_W = (TRACK_W - 4 * 2) / 3;

type Seg = 'week' | 'form' | 'plan';

const SEGMENTS: SegmentedTabItem<Seg>[] = [
  { value: 'week', label: 'This week' },
  { value: 'form', label: 'Your form' },
  { value: 'plan', label: 'Plan' },
];

function render(el: React.ReactElement): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r;
}

/** Unmount inside act — the measured track width is state. */
function unmount(r: ReactTestRenderer): void {
  act(() => {
    r.unmount();
  });
}

/** The tablist's onLayout never fires under react-test-renderer — drive it. */
function layout(r: ReactTestRenderer, width = TRACK_W): void {
  const track = r.root.find(
    (n) => n.props.accessibilityRole === 'tablist' && typeof n.props.onLayout === 'function',
  );
  act(() => {
    track.props.onLayout({ nativeEvent: { layout: { width, height: 48, x: 0, y: 0 } } });
  });
}

/** The `tab` a11y node per segment (the wrapper, which carries the state). */
function tabNodes(r: ReactTestRenderer) {
  return r.root.findAll(
    (n) => typeof n.type === 'string' && n.props.accessibilityRole === 'tab',
  );
}

/**
 * The Pressable INSIDE each segment — the one whose onPress runs the haptic
 * gateway. PressScale itself also carries an onPress, so it is excluded by the
 * `haptic` prop only it receives.
 */
function segmentPressables(r: ReactTestRenderer) {
  return r.root.findAll(
    (n) =>
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityRole === 'none' &&
      n.props.haptic === undefined,
  );
}

function press(r: ReactTestRenderer, i: number): void {
  act(() => {
    segmentPressables(r)[i]!.props.onPress();
  });
}

type Json = ReturnType<ReactTestRenderer['toJSON']>;

function textOf(json: Json): string {
  if (json == null) return '';
  if (Array.isArray(json)) return json.map(textOf).join(' ');
  const kids = json.children ?? [];
  return kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join(' ');
}

function indicatorStyle(r: ReactTestRenderer): Record<string, unknown> {
  const node = r.root.find(
    (n) => typeof n.type === 'string' && n.props.testID === SEGMENT_INDICATOR_TEST_ID,
  );
  return StyleSheet.flatten(node.props.style) as Record<string, unknown>;
}

beforeEach(() => {
  mockReducedMotion.mockReturnValue(false);
  mockSharedValues.length = 0;
  reanimated.withTiming.mockClear();
  Object.values(hapticsMod.haptic).forEach((fn) => fn.mockClear());
});

// ---------------------------------------------------------------------------

describe('rendering', () => {
  it('renders every segment as a tab inside one named tablist', () => {
    const r = render(
      <SegmentedTabs
        segments={SEGMENTS}
        value="week"
        onChange={jest.fn()}
        accessibilityLabel="Coach sections"
      />,
    );

    const lists = r.root.findAll(
      (n) => typeof n.type === 'string' && n.props.accessibilityRole === 'tablist',
    );
    expect(lists).toHaveLength(1);
    expect(lists[0]!.props.accessibilityLabel).toBe('Coach sections');

    const tabs = tabNodes(r);
    expect(tabs).toHaveLength(3);
    expect(textOf(r.toJSON())).toContain('This week');
    expect(textOf(r.toJSON())).toContain('Your form');
    expect(textOf(r.toJSON())).toContain('Plan');
    unmount(r);
  });

  it('gives every segment the same width — flex:1 slots, not measured text', () => {
    const r = render(
      <SegmentedTabs
        segments={SEGMENTS}
        value="week"
        onChange={jest.fn()}
        accessibilityLabel="Coach sections"
      />,
    );
    for (const tab of tabNodes(r)) {
      expect((StyleSheet.flatten(tab.props.style) as { flex?: number }).flex).toBe(1);
    }
    unmount(r);
  });

  it('sizes the indicator to one segment of the measured track', () => {
    const r = render(
      <SegmentedTabs
        segments={SEGMENTS}
        value="week"
        onChange={jest.fn()}
        accessibilityLabel="Coach sections"
      />,
    );
    // Before layout it has no width to claim, so it draws nothing.
    expect(indicatorStyle(r).width).toBe(0);
    layout(r);
    expect(indicatorStyle(r).width).toBeCloseTo(SEGMENT_W, 5);
    // The accent tint/edge pair is the app's one "this is live" signal.
    expect(indicatorStyle(r).backgroundColor).toBe(color.accentTint);
    expect(indicatorStyle(r).borderColor).toBe(color.accentEdge);
    unmount(r);
  });
});

// ---------------------------------------------------------------------------

describe('switching', () => {
  it('reports the pressed segment through onChange', () => {
    const onChange = jest.fn();
    const r = render(
      <SegmentedTabs
        segments={SEGMENTS}
        value="week"
        onChange={onChange}
        accessibilityLabel="Coach sections"
      />,
    );
    press(r, 2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('plan');
    unmount(r);
  });

  it('ticks the gated haptic gateway on a real switch', () => {
    const r = render(
      <SegmentedTabs
        segments={SEGMENTS}
        value="week"
        onChange={jest.fn()}
        accessibilityLabel="Coach sections"
      />,
    );
    press(r, 1);
    expect(hapticsMod.haptic.selection).toHaveBeenCalledTimes(1);
    unmount(r);
  });

  it('is inert when the live segment is pressed again', () => {
    const onChange = jest.fn();
    const r = render(
      <SegmentedTabs
        segments={SEGMENTS}
        value="form"
        onChange={onChange}
        accessibilityLabel="Coach sections"
      />,
    );
    press(r, 1);
    expect(onChange).not.toHaveBeenCalled();
    expect(hapticsMod.haptic.selection).not.toHaveBeenCalled();
    unmount(r);
  });

  it('stays controlled — pressing does not move the indicator on its own', () => {
    const r = render(
      <SegmentedTabs
        segments={SEGMENTS}
        value="week"
        onChange={jest.fn()}
        accessibilityLabel="Coach sections"
      />,
    );
    layout(r);
    press(r, 2);
    // The parent owns `value`; nothing here re-selected itself.
    expect(tabNodes(r).map((t) => t.props.accessibilityState.selected)).toEqual([
      true,
      false,
      false,
    ]);
    unmount(r);
  });

  it('routes VoiceOver activation to the same handler as a finger', () => {
    const onChange = jest.fn();
    const r = render(
      <SegmentedTabs
        segments={SEGMENTS}
        value="week"
        onChange={onChange}
        accessibilityLabel="Coach sections"
      />,
    );
    act(() => {
      tabNodes(r)[1]!.props.onAccessibilityTap();
    });
    expect(onChange).toHaveBeenCalledWith('form');
    unmount(r);
  });
});

// ---------------------------------------------------------------------------

describe('accessibility', () => {
  it('marks exactly one tab selected and keeps every tab focusable', () => {
    const r = render(
      <SegmentedTabs
        segments={SEGMENTS}
        value="form"
        onChange={jest.fn()}
        accessibilityLabel="Coach sections"
      />,
    );
    const tabs = tabNodes(r);
    expect(tabs.map((t) => t.props.accessibilityState.selected)).toEqual([false, true, false]);
    for (const tab of tabs) {
      expect(tab.props.accessible).toBe(true);
      expect(tab.props.focusable).toBe(true);
    }
    unmount(r);
  });

  it('speaks what a badge MEANS, not a bare digit', () => {
    const r = render(
      <SegmentedTabs
        segments={[
          { value: 'week', label: 'This week', badge: 3, badgeLabel: '3 findings' },
          { value: 'form', label: 'Your form' },
          { value: 'plan', label: 'Plan', badge: 'dot', badgeLabel: 'new drill waiting' },
        ]}
        value="week"
        onChange={jest.fn()}
        accessibilityLabel="Coach sections"
      />,
    );
    expect(tabNodes(r).map((t) => t.props.accessibilityLabel)).toEqual([
      'This week, 3 findings',
      'Your form',
      'Plan, new drill waiting',
    ]);
    unmount(r);
  });

  it('hides the decorative indicator from the screen reader', () => {
    const r = render(
      <SegmentedTabs
        segments={SEGMENTS}
        value="week"
        onChange={jest.fn()}
        accessibilityLabel="Coach sections"
      />,
    );
    const node = r.root.find(
      (n) => typeof n.type === 'string' && n.props.testID === SEGMENT_INDICATOR_TEST_ID,
    );
    expect(node.props.accessibilityElementsHidden).toBe(true);
    expect(node.props.importantForAccessibility).toBe('no-hide-descendants');
    unmount(r);
  });
});

// ---------------------------------------------------------------------------

describe('badges', () => {
  it('renders a count badge only when there is something to count', () => {
    const r = render(
      <SegmentedTabs
        segments={[
          { value: 'week', label: 'This week', badge: 3, badgeLabel: '3 findings' },
          // A zero count must render NOTHING — a "0" pill reads as a broken
          // counter, not as an empty section.
          { value: 'plan', label: 'Plan', badge: 0, badgeLabel: '0 drills' },
        ]}
        value="week"
        onChange={jest.fn()}
        accessibilityLabel="Coach sections"
      />,
    );
    const text = textOf(r.toJSON());
    expect(text).toContain('3');
    expect(text).not.toContain('0');
    unmount(r);
  });

  it('renders a presence dot for a countless badge', () => {
    const r = render(
      <SegmentedTabs
        segments={[
          { value: 'week', label: 'This week' },
          { value: 'plan', label: 'Plan', badge: 'dot', badgeLabel: 'has an update' },
        ]}
        value="week"
        onChange={jest.fn()}
        accessibilityLabel="Coach sections"
      />,
    );
    // 6x6 circle, textFaint while its segment is not selected.
    const dots = r.root.findAll((n) => {
      if (typeof n.type !== 'string') return false;
      const s = StyleSheet.flatten(n.props.style) as { width?: number; borderRadius?: number };
      return s?.width === 6 && s?.borderRadius === 3;
    });
    expect(dots).toHaveLength(1);
    expect(textOf(r.toJSON())).not.toContain('dot');
    unmount(r);
  });
});

// ---------------------------------------------------------------------------

describe('indicator motion', () => {
  it('slides to the new segment over the lateral-switch duration', () => {
    const r = render(
      <SegmentedTabs
        segments={SEGMENTS}
        value="week"
        onChange={jest.fn()}
        accessibilityLabel="Coach sections"
      />,
    );
    layout(r);
    // The FIRST measurement snaps — otherwise a screen restored onto segment 2
    // animates in from the left edge on mount.
    expect(reanimated.withTiming).not.toHaveBeenCalled();

    act(() => {
      r.update(
        <SegmentedTabs
          segments={SEGMENTS}
          value="plan"
          onChange={jest.fn()}
          accessibilityLabel="Coach sections"
        />,
      );
    });

    expect(reanimated.withTiming).toHaveBeenCalledTimes(1);
    const [target, config] = reanimated.withTiming.mock.calls[0] as [number, { duration: number }];
    expect(target).toBeCloseTo(SEGMENT_W * 2, 5);
    expect(config.duration).toBe(motion.tab);
    // And the shared value actually landed there (withTiming is identity here).
    expect(mockSharedValues[0]!.value).toBeCloseTo(SEGMENT_W * 2, 5);
    unmount(r);
  });

  it('swaps instantly under reduced motion — no slide at all', () => {
    mockReducedMotion.mockReturnValue(true);
    const r = render(
      <SegmentedTabs
        segments={SEGMENTS}
        value="week"
        onChange={jest.fn()}
        accessibilityLabel="Coach sections"
      />,
    );
    layout(r);
    act(() => {
      r.update(
        <SegmentedTabs
          segments={SEGMENTS}
          value="form"
          onChange={jest.fn()}
          accessibilityLabel="Coach sections"
        />,
      );
    });

    // The whole contract: the position changed, but nothing animated.
    expect(reanimated.withTiming).not.toHaveBeenCalled();
    expect(mockSharedValues[0]!.value).toBeCloseTo(SEGMENT_W, 5);
    unmount(r);
  });
});
