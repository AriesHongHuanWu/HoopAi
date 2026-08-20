/**
 * Presentational contract tests for the mode-picker catalog components:
 * ModeCatalogCard, RecommendedHero, ModeSectionHeader.
 *
 * These pin (a) the accessibility contract — full rules live in the hint, the
 * armed state is exposed via accessibilityState — (b) the honesty contract on
 * the hero: the reason string renders VERBATIM plus only the fixed provenance
 * suffix, and (c) the state-driven styles (selected border, disabled dimming,
 * pressed treatment) that the picker relies on to make the armed mode
 * unmistakable.
 */
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { color } from '../../../constants/tokens';
import { ModeCatalogCard } from '../ModeCatalogCard';
import { ModeSectionHeader } from '../ModeSectionHeader';
import { RecommendedHero } from '../RecommendedHero';

const ACCENT = color.info;
const TINT = 'rgba(79, 141, 232, 0.14)';

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/** All visible strings, flattening each Text's children. */
function texts(root: ReactTestInstance): string[] {
  return root
    .findAllByType(Text)
    .map((t) => React.Children.toArray(t.props.children).join(''));
}

/** Resolve a Pressable's style function for a given pressed state. */
function pressableStyle(node: ReactTestInstance, pressed: boolean): Record<string, unknown> {
  const style = node.props.style;
  return StyleSheet.flatten(typeof style === 'function' ? style({ pressed }) : style);
}

/**
 * The Pressable layer of a card/row. RN 0.86 exports Pressable wrapped in
 * memo(forwardRef(...)), so findByType can't match the export — locate it by
 * its contract instead: role 'button' with the state-driven style function
 * still unresolved (the rendered host View only carries the flattened result).
 */
function findButton(root: ReactTestInstance): ReactTestInstance {
  const matches = root.findAll(
    (n) => n.props?.accessibilityRole === 'button' && typeof n.props.style === 'function',
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0];
}

/** All nodes announcing as buttons (composite or host) — for absence checks. */
function buttonNodes(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((n) => n.props?.accessibilityRole === 'button');
}

function catalogProps(over: Partial<React.ComponentProps<typeof ModeCatalogCard>> = {}) {
  return {
    icon: 'earth' as const,
    name: 'Around the World',
    tagline: 'Five spots, make to move',
    accent: ACCENT,
    tint: TINT,
    selected: false,
    showProBadge: false,
    onPress: jest.fn(),
    ...over,
  };
}

describe('ModeCatalogCard', () => {
  it('renders name + tagline and exposes the full rules via accessibilityHint', () => {
    const onPress = jest.fn();
    const r = render(
      <ModeCatalogCard
        {...catalogProps({ onPress, accessibilityHint: 'Make from all 5 spots to win.' })}
      />,
    );
    const card = findButton(r.root);
    expect(card.props.accessibilityRole).toBe('button');
    expect(card.props.accessibilityLabel).toBe('Around the World. Five spots, make to move');
    expect(card.props.accessibilityHint).toBe('Make from all 5 spots to win.');
    expect(card.props.accessibilityState).toEqual({ selected: false, disabled: false });
    expect(texts(r.root)).toEqual(
      expect.arrayContaining(['Around the World', 'Five spots, make to move']),
    );
    card.props.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('defaults the right icon to chevron-forward and honors an override', () => {
    const r = render(<ModeCatalogCard {...catalogProps()} />);
    expect(r.root.findAllByType(Ionicons).map((i) => i.props.name)).toContain('chevron-forward');

    const r2 = render(<ModeCatalogCard {...catalogProps({ rightIcon: 'chevron-up' })} />);
    const names = r2.root.findAllByType(Ionicons).map((i) => i.props.name);
    expect(names).toContain('chevron-up');
    expect(names).not.toContain('chevron-forward');
  });

  it('selected → PICKED tag, accent border and raised surface', () => {
    const r = render(<ModeCatalogCard {...catalogProps({ selected: true })} />);
    expect(texts(r.root)).toContain('✓ PICKED');
    const style = pressableStyle(findButton(r.root), false);
    expect(style.borderColor).toBe(ACCENT);
    expect(style.borderWidth).toBe(1.5);
    expect(style.backgroundColor).toBe(color.surfaceRaised);
    expect(findButton(r.root).props.accessibilityState.selected).toBe(true);
  });

  it('unselected → no PICKED tag and the resting hairline border', () => {
    const r = render(<ModeCatalogCard {...catalogProps()} />);
    expect(texts(r.root)).not.toContain('✓ PICKED');
    const style = pressableStyle(findButton(r.root), false);
    expect(style.borderColor).toBe(color.border);
    expect(style.backgroundColor).toBe(color.surface);
  });

  it('pressed → raised surface + 0.985 scale; disabled press stays inert and dims', () => {
    const r = render(<ModeCatalogCard {...catalogProps()} />);
    const pressed = pressableStyle(findButton(r.root), true);
    expect(pressed.backgroundColor).toBe(color.surfaceRaised);
    expect(pressed.transform).toEqual([{ scale: 0.985 }]);

    const r2 = render(<ModeCatalogCard {...catalogProps({ disabled: true })} />);
    const card = findButton(r2.root);
    expect(card.props.disabled).toBe(true);
    expect(card.props.accessibilityState.disabled).toBe(true);
    const disabledPressed = pressableStyle(card, true);
    expect(disabledPressed.opacity).toBe(0.55);
    expect(disabledPressed.transform).toBeUndefined();
    expect(disabledPressed.backgroundColor).toBe(color.surface);
  });

  it('uppercases glance chips and omits the chip row when glance is absent', () => {
    const r = render(
      <ModeCatalogCard {...catalogProps({ glance: ['5 spots', 'Make to move'] })} />,
    );
    const all = texts(r.root);
    expect(all).toContain('5 SPOTS');
    expect(all).toContain('MAKE TO MOVE');

    const r2 = render(<ModeCatalogCard {...catalogProps()} />);
    expect(texts(r2.root).some((t) => t === '5 SPOTS')).toBe(false);
  });

  it('shows the ProBadge only when asked', () => {
    const r = render(<ModeCatalogCard {...catalogProps({ showProBadge: true })} />);
    expect(texts(r.root)).toContain('PRO');
    const r2 = render(<ModeCatalogCard {...catalogProps()} />);
    expect(texts(r2.root)).not.toContain('PRO');
  });

  it('renders children (ghost source list) inside the card, under the row', () => {
    const r = render(
      <ModeCatalogCard {...catalogProps()}>
        <View testID="ghost-sources">
          <Text>Race Jul 4 · 6:01 PM</Text>
        </View>
      </ModeCatalogCard>,
    );
    const block = r.root.findByProps({ testID: 'ghost-sources' });
    expect(block).toBeTruthy();
    expect(texts(r.root)).toContain('Race Jul 4 · 6:01 PM');
  });
});

describe('RecommendedHero', () => {
  const heroProps = {
    icon: 'earth' as const,
    name: 'Around the World',
    tagline: 'Five spots, make to move',
    accent: ACCENT,
    tint: TINT,
    reason: 'Played 3× in the last 2 weeks',
    selected: false,
    onPress: jest.fn(),
  };

  it('renders the reason VERBATIM with only the fixed provenance suffix', () => {
    const r = render(<RecommendedHero {...heroProps} />);
    expect(texts(r.root)).toContain(
      'Played 3× in the last 2 weeks · from your session history',
    );
  });

  it('exposes the recommendation a11y contract', () => {
    const onPress = jest.fn();
    const r = render(<RecommendedHero {...heroProps} onPress={onPress} />);
    const card = findButton(r.root);
    expect(card.props.accessibilityRole).toBe('button');
    expect(card.props.accessibilityLabel).toBe(
      'Recommended: Around the World. Five spots, make to move',
    );
    expect(card.props.accessibilityHint).toBe(
      'Played 3× in the last 2 weeks. Starts setup with this mode armed.',
    );
    expect(card.props.accessibilityState).toEqual({ selected: false });
    card.props.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders eyebrow + START pill, and the PICKED tag only when selected', () => {
    const r = render(<RecommendedHero {...heroProps} />);
    const all = texts(r.root);
    expect(all).toContain('RECOMMENDED FOR YOU');
    expect(all).toContain('START');
    expect(all).not.toContain('✓ PICKED');

    const r2 = render(<RecommendedHero {...heroProps} selected />);
    expect(texts(r2.root)).toContain('✓ PICKED');
    const style = pressableStyle(findButton(r2.root), false);
    expect(style.borderColor).toBe(ACCENT);
    expect(style.borderWidth).toBe(1.5);
  });
});

describe('ModeSectionHeader', () => {
  it('static form: uppercased eyebrow + count, lede shown, no toggle affordance', () => {
    const r = render(
      <ModeSectionHeader title="Drills" count={5} lede="Guided spot-by-spot routines." />,
    );
    const all = texts(r.root);
    expect(all).toContain('DRILLS');
    expect(all).toContain('(5)');
    expect(all).toContain('Guided spot-by-spot routines.');
    expect(buttonNodes(r.root)).toHaveLength(0);
    expect(r.root.findAllByType(Ionicons)).toHaveLength(0);
  });

  it('toggle form expanded: chevron-down, collapse hint, expanded state, lede visible', () => {
    const onToggle = jest.fn();
    const r = render(
      <ModeSectionHeader
        title="Games"
        count={7}
        lede="Pick a game and prop your phone up."
        collapsed={false}
        onToggle={onToggle}
      />,
    );
    const row = findButton(r.root);
    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityLabel).toBe('Games, 7 options');
    expect(row.props.accessibilityHint).toBe('Collapses this section');
    expect(row.props.accessibilityState).toEqual({ expanded: true });
    expect(r.root.findByType(Ionicons).props.name).toBe('chevron-down');
    expect(texts(r.root)).toContain('Pick a game and prop your phone up.');
    row.props.onPress();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('toggle form collapsed: chevron-forward, expand hint, lede hidden', () => {
    const r = render(
      <ModeSectionHeader
        title="Games"
        count={7}
        lede="Pick a game and prop your phone up."
        collapsed
        onToggle={jest.fn()}
      />,
    );
    const row = findButton(r.root);
    expect(row.props.accessibilityHint).toBe('Expands this section');
    expect(row.props.accessibilityState).toEqual({ expanded: false });
    expect(r.root.findByType(Ionicons).props.name).toBe('chevron-forward');
    expect(texts(r.root)).not.toContain('Pick a game and prop your phone up.');
  });

  it('omits the count suffix from the label when count is not given', () => {
    const r = render(<ModeSectionHeader title="Quick start" collapsed={false} onToggle={jest.fn()} />);
    expect(findButton(r.root).props.accessibilityLabel).toBe('Quick start');
    expect(texts(r.root)).not.toContain('(undefined)');
  });
});
