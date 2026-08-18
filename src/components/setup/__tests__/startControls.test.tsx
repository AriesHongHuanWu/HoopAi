/**
 * Render tests for the setup start controls (StartHero + StickyStartBar).
 * Both components are pure-prop presentation (no stores, no navigation), so
 * they render under react-test-renderer with the official reanimated and
 * safe-area-context jest mocks.
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';

// The shipped react-native-reanimated/mock still boots react-native-worklets
// natives (needs the worklets jest resolver, and jest config is untouchable
// here), so this test carries its own minimal mock: Animated components pass
// straight through to their RN hosts with layout-animation props stripped.
jest.mock('react-native-reanimated', () => {
  const ReactLocal = require('react');
  const RN = require('react-native');
  const passthrough = (Comp: React.ComponentType<Record<string, unknown>>) =>
    ReactLocal.forwardRef((props: Record<string, unknown>, ref: unknown) => {
      const { entering, exiting, layout, ...rest } = props;
      void entering;
      void exiting;
      void layout;
      return ReactLocal.createElement(Comp, { ...rest, ref });
    });
  const animation = () => {
    const chain: Record<string, unknown> = {};
    chain.duration = () => chain;
    chain.delay = () => chain;
    return chain;
  };
  return {
    __esModule: true,
    default: {
      View: passthrough(RN.View),
      Text: passthrough(RN.Text),
      ScrollView: passthrough(RN.ScrollView),
      createAnimatedComponent: passthrough,
    },
    createAnimatedComponent: passthrough,
    useSharedValue: (v: unknown) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    withSpring: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    useReducedMotion: jest.fn(() => false),
    FadeInUp: animation(),
    FadeInDown: animation(),
    FadeOutDown: animation(),
  };
});
jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default,
);
// StartHero's CTA carries a static arcMotif stroke on a Skia canvas; Skia's
// native bindings can't load under jest, and the canvas never mounts here
// anyway (it is gated behind onLayout, which react-test-renderer never fires).
jest.mock('@shopify/react-native-skia', () => ({
  Canvas: () => null,
  Circle: () => null,
  Path: () => null,
}));
jest.mock('@expo/vector-icons', () => {
  const ReactLocal = require('react');
  const { Text } = require('react-native');
  return {
    Ionicons: ({ name }: { name: string }) =>
      ReactLocal.createElement(Text, null, `icon:${name}`),
  };
});

import { color, space } from '@/constants/tokens';
import { PLACEMENT_TIPS, StartHero, layoutBottom, type StartHeroProps } from '../StartHero';
import { StickyStartBar, barAccessibilityLabel } from '../StickyStartBar';

function create(el: React.ReactElement): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  return tree;
}

/** Find the pressable node carrying a given accessibility label. */
function pressableByLabel(tree: renderer.ReactTestRenderer, label: string) {
  const matches = tree.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

const CHIPS: StartHeroProps['chips'] = [
  { id: 'mode', label: 'Free Play', icon: 'game-controller-outline' },
  { id: 'camera', label: 'Portrait', icon: 'phone-portrait-outline' },
  { id: 'recording', label: 'Recording off', icon: 'videocam-off-outline' },
];

function heroProps(over: Partial<StartHeroProps> = {}): StartHeroProps {
  return {
    summary: 'Free Play · Portrait · Recording off',
    chips: CHIPS,
    onStart: jest.fn(),
    disabled: false,
    onChipPress: jest.fn(),
    onLayoutBottom: jest.fn(),
    ...over,
  };
}

describe('layoutBottom', () => {
  it('is the layout bottom edge (y + height)', () => {
    expect(layoutBottom({ y: 120, height: 240 })).toBe(360);
    expect(layoutBottom({ y: 0, height: 0 })).toBe(0);
  });
});

describe('StartHero', () => {
  it('fires onStart from the GO CTA', () => {
    const props = heroProps();
    const tree = create(<StartHero {...props} />);
    const cta = pressableByLabel(tree, 'Start session — open the camera');
    act(() => {
      cta.props.onPress();
    });
    expect(props.onStart).toHaveBeenCalledTimes(1);
  });

  it('exposes disabled state on the CTA when disabled', () => {
    const tree = create(<StartHero {...heroProps({ disabled: true })} />);
    const cta = pressableByLabel(tree, 'Start session — open the camera');
    expect(cta.props.accessibilityState).toEqual({ disabled: true });
  });

  it('promises the camera on the common path — the sub-line is the honest default', () => {
    const tree = create(<StartHero {...heroProps()} />);
    expect(JSON.stringify(tree.toJSON())).toContain(
      'Opens the camera — tracking starts with your first shot',
    );
  });

  it('disabledReason replaces the camera promise — a dead CTA never keeps selling the camera', () => {
    const reason = 'Camera access needed — open the Camera section below to fix it';
    const tree = create(
      <StartHero {...heroProps({ disabled: true, disabledReason: reason })} />,
    );
    const flat = JSON.stringify(tree.toJSON());
    expect(flat).toContain(reason);
    expect(flat).not.toContain('Opens the camera — tracking starts with your first shot');
    // The a11y label of the CTA itself is unchanged — the reason is the sub-line.
    const cta = pressableByLabel(tree, 'Start session — open the camera');
    expect(cta.props.accessibilityState).toEqual({ disabled: true });
  });

  it("paints a tone='warning' chip in the unsure tint (the blocked-camera treatment)", () => {
    const warnChips: StartHeroProps['chips'] = [
      { id: 'mode', label: 'Free Play', icon: 'game-controller-outline' },
      {
        id: 'camera',
        label: 'Camera access needed',
        icon: 'phone-portrait-outline',
        tone: 'warning',
      },
    ];
    const tree = create(<StartHero {...heroProps({ chips: warnChips })} />);
    const warn = pressableByLabel(tree, 'Camera access needed — opens options');
    const style = StyleSheet.flatten(
      typeof warn.props.style === 'function' ? warn.props.style({ pressed: false }) : warn.props.style,
    );
    expect(style.backgroundColor).toBe(color.unsureTint);
    expect(style.borderColor).toBe(color.unsure);
    // The neutral chip keeps the resting hairline.
    const neutral = pressableByLabel(tree, 'Free Play — opens options');
    const neutralStyle = StyleSheet.flatten(
      typeof neutral.props.style === 'function'
        ? neutral.props.style({ pressed: false })
        : neutral.props.style,
    );
    expect(neutralStyle.backgroundColor).toBeUndefined();
    expect(neutralStyle.borderColor).toBe(color.border);
  });

  it('renders one chip per entry and reports the section id on press', () => {
    const props = heroProps();
    const tree = create(<StartHero {...props} />);
    for (const chip of CHIPS) {
      const node = pressableByLabel(tree, `${chip.label} — opens options`);
      act(() => {
        node.props.onPress();
      });
    }
    expect(props.onChipPress).toHaveBeenCalledTimes(CHIPS.length);
    expect((props.onChipPress as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
      'mode',
      'camera',
      'recording',
    ]);
  });

  it('reports its bottom edge (y + height) through onLayoutBottom', () => {
    const props = heroProps();
    const tree = create(<StartHero {...props} />);
    const withLayout = tree.root.findAll((n) => typeof n.props.onLayout === 'function');
    expect(withLayout.length).toBeGreaterThan(0);
    act(() => {
      withLayout[0]!.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 100, width: 320, height: 220 } },
      });
    });
    expect(props.onLayoutBottom).toHaveBeenCalledWith(320);
  });

  it('renders the placement tips micro strip', () => {
    const tree = create(<StartHero {...heroProps()} />);
    const flat = JSON.stringify(tree.toJSON());
    for (const tip of PLACEMENT_TIPS) {
      expect(flat).toContain(tip.label);
    }
    // The three tips read as one strip with dot dividers between them.
    expect(PLACEMENT_TIPS).toHaveLength(3);
  });
});

describe('barAccessibilityLabel', () => {
  it('prefixes the summary with the start action', () => {
    expect(barAccessibilityLabel('Free Play · Portrait')).toBe(
      'Start session. Free Play · Portrait',
    );
  });
});

describe('StickyStartBar', () => {
  const summary = 'Free Play · Portrait · Makes only';

  it('renders nothing when not visible', () => {
    const tree = create(
      <StickyStartBar visible={false} disabled={false} summary={summary} onStart={jest.fn()} />,
    );
    expect(tree.toJSON()).toBeNull();
  });

  it('renders the summary and fires onStart from the START pill when visible', () => {
    const onStart = jest.fn();
    const tree = create(
      <StickyStartBar visible disabled={false} summary={summary} onStart={onStart} />,
    );
    expect(JSON.stringify(tree.toJSON())).toContain(summary);
    const bar = tree.root.findAll(
      (n) => n.props.accessibilityLabel === barAccessibilityLabel(summary),
    );
    expect(bar.length).toBeGreaterThan(0);
    const pills = tree.root.findAll(
      (n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function',
    );
    expect(pills.length).toBeGreaterThan(0);
    act(() => {
      pills[0]!.props.onPress();
    });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("tone='warning' paints the summary in the unsure tint; the default stays dim", () => {
    const warmTree = create(
      <StickyStartBar visible disabled tone="warning" summary={summary} onStart={jest.fn()} />,
    );
    const warmText = warmTree.root
      .findAllByType(Text)
      .find((t) => t.props.children === summary)!;
    expect(StyleSheet.flatten(warmText.props.style).color).toBe(color.unsure);

    const plainTree = create(
      <StickyStartBar visible disabled={false} summary={summary} onStart={jest.fn()} />,
    );
    const plainText = plainTree.root
      .findAllByType(Text)
      .find((t) => t.props.children === summary)!;
    expect(StyleSheet.flatten(plainText.props.style).color).toBe(color.textDim);
  });

  it('pads the bottom by safe-area inset + space.md', () => {
    const tree = create(
      <StickyStartBar visible disabled={false} summary={summary} onStart={jest.fn()} />,
    );
    const bar = tree.root.findAll(
      (n) => n.props.accessibilityLabel === barAccessibilityLabel(summary),
    )[0]!;
    const style = StyleSheet.flatten(bar.props.style);
    // The safe-area jest mock reports zero insets, so bottom padding = space.md.
    expect(style.paddingBottom).toBe(space.md);
    expect(style.position).toBe('absolute');
    expect(style.left).toBe(0);
    expect(style.right).toBe(0);
    expect(style.bottom).toBe(0);
  });
});
