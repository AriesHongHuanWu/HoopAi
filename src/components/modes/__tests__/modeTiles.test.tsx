/**
 * ModeCatalogCard variant="tile" — the 2-column GAMES cartridge.
 *
 * The tile trades the visible tagline for section height (the grid claim: two
 * cartridges per row), so the contract pinned here is exactly what survives
 * the squeeze: (a) the a11y label still carries the tagline a sighted player
 * no longer sees, (b) only the FIRST (strongest) glance chip renders, (c) the
 * PICKED state keeps the same accent border + tag as the row, and (d) the row
 * variant's anatomy (tagline + chevron) is untouched — the tile is additive.
 */
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { color } from '../../../constants/tokens';
import { ModeCatalogCard } from '../ModeCatalogCard';

const ACCENT = color.threePt;
const TINT = 'rgba(242, 193, 78, 0.16)';

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

/** The Pressable layer — role 'button' with the style function unresolved. */
function findButton(root: ReactTestInstance): ReactTestInstance {
  const matches = root.findAll(
    (n) => n.props?.accessibilityRole === 'button' && typeof n.props.style === 'function',
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0];
}

function tileProps(over: Partial<React.ComponentProps<typeof ModeCatalogCard>> = {}) {
  return {
    variant: 'tile' as const,
    icon: 'cash' as const,
    name: 'Money Ball',
    tagline: '25 balls off five racks, money ball last',
    accent: ACCENT,
    tint: TINT,
    glance: ['25 balls', 'Money 5th'] as const,
    selected: false,
    showProBadge: true,
    onPress: jest.fn(),
    ...over,
  };
}

describe("ModeCatalogCard variant='tile'", () => {
  it('renders the name, keeps the tagline audible in the a11y label, and hides it visually', () => {
    const onPress = jest.fn();
    const r = render(
      <ModeCatalogCard
        {...tileProps({ onPress, accessibilityHint: 'Score the most in 25 balls.' })}
      />,
    );
    const card = findButton(r.root);
    expect(card.props.accessibilityLabel).toBe(
      'Money Ball. 25 balls off five racks, money ball last',
    );
    expect(card.props.accessibilityHint).toBe('Score the most in 25 balls.');
    expect(card.props.accessibilityState).toEqual({ selected: false, disabled: false });
    const all = texts(r.root);
    expect(all).toContain('Money Ball');
    // The tagline is a11y-only in the tile — the grid trades it for height.
    expect(all).not.toContain('25 balls off five racks, money ball last');
    card.props.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows ONLY the first (strongest) glance chip, uppercased', () => {
    const r = render(<ModeCatalogCard {...tileProps()} />);
    const all = texts(r.root);
    expect(all).toContain('25 BALLS');
    expect(all).not.toContain('MONEY 5TH');
  });

  it('omits the chip row entirely when glance is absent', () => {
    const r = render(<ModeCatalogCard {...tileProps({ glance: undefined })} />);
    expect(texts(r.root)).not.toContain('25 BALLS');
  });

  it('has no chevron — a grid cartridge is not a disclosure row', () => {
    const r = render(<ModeCatalogCard {...tileProps()} />);
    const names = r.root.findAllByType(Ionicons).map((i) => i.props.name);
    expect(names).not.toContain('chevron-forward');
    // The identity glyph itself still renders.
    expect(names).toContain('cash');
  });

  it('PICKED keeps the accent border, raised surface and tag — same as the row', () => {
    const r = render(<ModeCatalogCard {...tileProps({ selected: true })} />);
    expect(texts(r.root)).toContain('✓ PICKED');
    const style = pressableStyle(findButton(r.root), false);
    expect(style.borderColor).toBe(ACCENT);
    expect(style.borderWidth).toBe(1.5);
    expect(style.backgroundColor).toBe(color.surfaceRaised);
    expect(findButton(r.root).props.accessibilityState.selected).toBe(true);
  });

  it('rests on the same surface/hairline recipe as the row', () => {
    const r = render(<ModeCatalogCard {...tileProps()} />);
    const style = pressableStyle(findButton(r.root), false);
    expect(style.borderColor).toBe(color.border);
    expect(style.backgroundColor).toBe(color.surface);
    // flex: 1 shares a 2-up grid row equally.
    expect(style.flex).toBe(1);
  });

  it('shows the ProBadge only when asked', () => {
    const r = render(<ModeCatalogCard {...tileProps()} />);
    expect(texts(r.root)).toContain('PRO');
    const r2 = render(<ModeCatalogCard {...tileProps({ showProBadge: false })} />);
    expect(texts(r2.root)).not.toContain('PRO');
  });

  it("leaves the row variant's anatomy untouched: tagline visible + chevron present", () => {
    const r = render(<ModeCatalogCard {...tileProps({ variant: 'row' })} />);
    expect(texts(r.root)).toContain('25 balls off five racks, money ball last');
    expect(r.root.findAllByType(Ionicons).map((i) => i.props.name)).toContain(
      'chevron-forward',
    );
  });
});
