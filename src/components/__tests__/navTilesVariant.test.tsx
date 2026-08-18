/**
 * NavTiles — the rich description variant + the press contract.
 *
 * Pins three things:
 * 1. VARIANT IS A ROW DECISION. A tile's `description` renders only when its
 *    NavTileRow opts into variant="rich" — a compact (3-across) row ignores
 *    descriptions even when the specs carry them, so siblings always match.
 * 2. ONE CONTROL NODE PER TILE. The IA suites (tabIaCategorisation,
 *    leaderboard) count entry points by finding the single node carrying both
 *    `accessibilityLabel` and `onPress`. That is WHY NavTile keeps a direct
 *    Pressable instead of a PressScale wrapper: any wrapper receiving those
 *    props is a second matching node and every tile double-counts. This test
 *    keeps the count honest so a future "upgrade" fails here first.
 * 3. THE HAPTIC IS GATED. Pressing ticks haptic.selection() through the
 *    src/utils/haptics gateway (never raw expo-haptics), then the spec's
 *    onPress.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { color, type } from '@/constants/tokens';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

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

import { LEADERBOARD_TILE, NavTileRow, type NavTileSpec } from '../NavTiles';

const hapticsMock = jest.requireMock('@/utils/haptics') as {
  haptic: { selection: jest.Mock };
};

function render(el: React.ReactElement): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r;
}

type Json = ReturnType<ReactTestRenderer['toJSON']>;

/** Flatten every rendered string for "does this copy appear" assertions. */
function textOf(json: Json): string {
  if (json == null) return '';
  if (Array.isArray(json)) return json.map(textOf).join(' ');
  const kids = json.children ?? [];
  return kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join(' ');
}

const richTiles: NavTileSpec[] = [
  {
    icon: 'trending-up',
    label: 'Trends',
    hint: 'Open trends',
    description: 'FG% and volume over time',
    onPress: jest.fn(),
  },
  {
    icon: 'trophy-outline',
    label: 'Records',
    hint: 'Open records',
    description: 'Career bests and badges',
    onPress: jest.fn(),
  },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('NavTileRow variants', () => {
  it('compact rows ignore descriptions even when the specs carry them', () => {
    const r = render(<NavTileRow tiles={richTiles} />);
    const copy = textOf(r.toJSON());
    expect(copy).toContain('Trends');
    expect(copy).not.toContain('FG% and volume over time');
    act(() => r.unmount());
  });

  it('rich rows render each description as a single-line caption', () => {
    const r = render(<NavTileRow tiles={richTiles} variant="rich" />);
    const copy = textOf(r.toJSON());
    expect(copy).toContain('FG% and volume over time');
    expect(copy).toContain('Career bests and badges');

    const descNode = r.root
      .findAllByType(Text)
      .find((n) => n.props.children === 'FG% and volume over time');
    expect(descNode).toBeDefined();
    // One line — a wrapping description would break the row's shared height.
    expect(descNode!.props.numberOfLines).toBe(1);
    const flat = Object.assign(
      {},
      ...[descNode!.props.style].flat(Infinity).filter(Boolean),
    ) as Record<string, unknown>;
    expect(flat.fontFamily).toBe(type.caption.fontFamily);
    expect(flat.fontSize).toBe(type.caption.fontSize);
    expect(flat.color).toBe(color.textFaint);
    act(() => r.unmount());
  });

  it('a tile without a description renders no empty second line in a rich row', () => {
    const bare: NavTileSpec = {
      icon: 'settings-outline',
      label: 'Settings',
      hint: 'Open settings',
      onPress: jest.fn(),
    };
    const r = render(<NavTileRow tiles={[bare]} variant="rich" />);
    // Exactly one Text: the label.
    expect(r.root.findAllByType(Text)).toHaveLength(1);
    act(() => r.unmount());
  });
});

describe('NavTile press contract', () => {
  it('keeps exactly ONE node carrying accessibilityLabel + onPress per tile', () => {
    // The matcher the pinned IA suites use to count entry points — NavTile
    // must never gain a wrapper that would double this count.
    const r = render(<NavTileRow tiles={richTiles} variant="rich" />);
    const trends = r.root.findAll(
      (n) => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === 'Trends',
    );
    expect(trends).toHaveLength(1);
    act(() => r.unmount());
  });

  it('fires the gated selection haptic, then the spec onPress', () => {
    const r = render(<NavTileRow tiles={richTiles} />);
    const tile = r.root.findAll(
      (n) => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === 'Records',
    )[0];
    act(() => {
      tile.props.onPress();
    });
    expect(hapticsMock.haptic.selection).toHaveBeenCalledTimes(1);
    expect(richTiles[1].onPress).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it('LEADERBOARD_TILE keeps its byte-compatible spec shape', () => {
    // Placed explicitly by the Train tab; the pinned suites assert label and
    // destination. `description` stays OPTIONAL — absent here on purpose.
    expect(LEADERBOARD_TILE.label).toBe('Leaderboard');
    expect(LEADERBOARD_TILE.icon).toBe('people-outline');
    expect(typeof LEADERBOARD_TILE.hint).toBe('string');
    expect(typeof LEADERBOARD_TILE.onPress).toBe('function');
    expect('description' in LEADERBOARD_TILE).toBe(false);
  });
});
