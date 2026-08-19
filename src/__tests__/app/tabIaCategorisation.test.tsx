/**
 * Tab-root information architecture — the categorisation contract.
 *
 * Four claims are pinned here because each one is a silent regression waiting
 * to happen, and none of them is visible from a unit test of any single file:
 *
 * 1. TAB WORD == H1. The bottom bar says "Train" and "Data"; the screens those
 *    labels open have to say the same word back, or the tab bar never becomes
 *    muscle memory. The friendly line survives as the lede, so the test asserts
 *    BOTH — the word is the title AND the old copy is still on screen.
 * 2. CHALLENGES IS A REAL SECTION. "Challenge" named four unrelated things in
 *    three tabs; the Train tab now has one section where the word means "a
 *    scored goal you can complete or share", holding this week's set and the
 *    friend board.
 * 3. THE LEADERBOARD ENTRY POINT IS EXPLICIT. NavTileRow used to append the
 *    leaderboard tile to any row whose eyebrow string equalled 'EXPLORE', so
 *    renaming one all-caps label silently deleted the app's only social screen.
 *    The row now renders exactly what it is handed — proven for that exact
 *    string — and the tile is placed by name on the Train tab.
 * 4. ONE ROUTE PER DESTINATION. The Data tab offered /trends twice (tile and
 *    bottom pill). Exactly one control on that screen may lead there.
 */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { emptyWeekAggregate, type WeekAggregate } from '@/core/weeklyChallenges';

// ---------------------------------------------------------------------------
// Mocks

// Reanimated's worklets runtime can't load under jest without native modules.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (component: unknown) => component,
  },
  FadeIn: { duration: () => ({ reduceMotion: () => ({}) }) },
  FadeInDown: { duration: () => ({ delay: () => ({}), reduceMotion: () => ({}) }) },
  // Chainable: History's session-list reflow attaches .reduceMotion(System).
  LinearTransition: { duration: () => ({ reduceMotion: () => ({}) }) },
  ReduceMotion: { System: 'system' },
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

// enter() returns undefined (the reduced-motion idiom) so cards render static.
// Shimmer is the QUICK START / ghost-picker loading skeleton (Skia-backed —
// stubbed to nothing; these are IA tests, not loading-state tests).
jest.mock('@/components/motion', () => ({
  __esModule: true,
  useCardStagger: jest.fn(() => () => undefined),
  useStaggerAt: jest.fn(() => () => undefined),
  Shimmer: () => null,
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

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('expo-router', () => {
  const ReactLocal = require('react') as typeof React;
  return {
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
    useFocusEffect: (cb: () => void | (() => void)) => ReactLocal.useEffect(cb, [cb]),
    useLocalSearchParams: jest.fn(() => ({})),
  };
});

// Skia canvases are decorative on these screens (History's empty-state arc).
jest.mock('@shopify/react-native-skia', () => ({
  Canvas: () => null,
  Circle: () => null,
  DashPathEffect: () => null,
  Line: () => null,
  Path: () => null,
  vec: (x: number, y: number) => ({ x, y }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/components/ShotList', () => ({
  __esModule: true,
  PipRow: () => null,
  formatSessionDate: (ms: number) => `date-${ms}`,
  formatSessionTime: (ms: number) => `time-${ms}`,
}));

jest.mock('@/data/db', () => ({
  listSessions: jest.fn(async () => []),
  sessionShots: jest.fn(async () => []),
  deleteSession: jest.fn(async () => {}),
}));

jest.mock('@/data/videoLibrary', () => ({ deleteLocalVideo: jest.fn(async () => {}) }));

jest.mock('@/core/csvExport', () => ({
  sessionsToCsv: jest.fn(() => ''),
  exportCsv: jest.fn(async () => true),
}));

// The week aggregate is a DB fold behind a persisted store; stubbing the loader
// keeps this an IA test and lets it feed the card exact, checkable numbers.
jest.mock('@/state/challengeStore', () => ({
  loadWeekAggregate: jest.fn(async () => mockWeekAgg),
}));
let mockWeekAgg: WeekAggregate = emptyWeekAggregate();

// ---------------------------------------------------------------------------
// Helpers

const db = jest.requireMock('@/data/db') as Record<string, jest.Mock>;
const routerMod = jest.requireMock('expo-router') as { router: { push: jest.Mock } };

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  // One extra flush for effects that chain multiple awaits.
  await act(async () => {});
  return r;
}

/** Unmount inside act so React's teardown never trips the act() warning. */
async function unmount(r: ReactTestRenderer): Promise<void> {
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

/**
 * Every pressable control labelled `label`. Matching on onPress + the a11y
 * label finds exactly one instance per Pressable (the host View it renders
 * inherits the label but not the handler), so the count is a real count of
 * controls rather than of tree nodes.
 */
function controlsLabelled(r: ReactTestRenderer, label: string) {
  return r.root.findAll(
    (n) => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === label,
  );
}

function sessionRow(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    startedAt: 1_700_000_000_000 + id * 1000,
    endedAt: 1_700_000_100_000 + id * 1000,
    label: '',
    videoPath: null,
    keepMode: 'makes',
    recordingStartSec: null,
    modeId: null,
    modeResultJson: null,
    attempts: 10,
    makes: 5,
    fgPct: 0.5,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWeekAgg = emptyWeekAggregate();
  db.listSessions.mockResolvedValue([]);
  db.sessionShots.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// 1. Tab word == H1

describe('Tab roots title themselves with the tab word', () => {
  it('Train: H1 is the tab label, with the friendly line kept as the lede', async () => {
    const ModePickerScreen = require('../../app/(tabs)/modes').default;
    const r = await render(<ModePickerScreen />);
    const copy = textOf(r.toJSON());

    expect(copy).toContain('Train');
    // Demoted, not deleted — the voice survives one level down.
    expect(copy).toContain('How do you want to play?');
    await unmount(r);
  });

  it('Train: a new player gets the START HERE hero, never a fabricated recommendation', async () => {
    // ADDED with the hero-slot upgrade: with no session history (listSessions
    // → []), Free Play is promoted into the QUICK START hero as the 'starter'
    // variant. The eyebrow must say START HERE — and the provenance line
    // ("from your session history") must NOT render, because there is no
    // history to cite and inventing one breaks the honesty contract.
    const ModePickerScreen = require('../../app/(tabs)/modes').default;
    const r = await render(<ModePickerScreen />);
    const copy = textOf(r.toJSON());

    expect(copy).toContain('START HERE');
    expect(copy).not.toContain('from your session history');
    await unmount(r);
  });

  it('Data: H1 is the tab label, and names what the tab holds', async () => {
    const HistoryScreen = require('../../app/(tabs)/history').default;
    const r = await render(<HistoryScreen />);
    const copy = textOf(r.toJSON());

    expect(copy).toContain('Data');
    expect(copy).toMatch(/trends and records/i);
    await unmount(r);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. The Challenges section and the leaderboard entry point

describe('Train tab Challenges section', () => {
  it('renders a Challenges header with this week’s goals and the friend board', async () => {
    // Real numbers so a card rendered from stale/absent data would be visible.
    mockWeekAgg = { ...emptyWeekAggregate(), makes: 7, attempts: 20, sessions: 2 };

    const ModePickerScreen = require('../../app/(tabs)/modes').default;
    const r = await render(<ModePickerScreen />);
    const copy = textOf(r.toJSON());

    // ModeSectionHeader upper-cases its title.
    expect(copy).toContain('CHALLENGES');
    // The weekly card is present (its own header), not just the section name.
    expect(copy).toContain('WEEKLY CHALLENGES');
    // Drills keeps its own name — the section was added, not renamed.
    expect(copy).toContain('DRILLS');
    await unmount(r);
  });

  it('places the leaderboard tile explicitly, and it opens /leaderboard', async () => {
    const ModePickerScreen = require('../../app/(tabs)/modes').default;
    const r = await render(<ModePickerScreen />);

    const tiles = controlsLabelled(r, 'Leaderboard');
    // Exactly one: the app's only social entry point, and only one of it.
    expect(tiles).toHaveLength(1);

    await act(async () => {
      tiles[0].props.onPress();
    });
    expect(routerMod.router.push).toHaveBeenCalledWith('/leaderboard');
    await unmount(r);
  });
});

describe('NavTileRow', () => {
  it('renders exactly the tiles it is given — including for the old EXPLORE eyebrow', async () => {
    const { NavTileRow } = require('@/components/NavTiles');
    const r = await render(
      <NavTileRow
        eyebrow="EXPLORE"
        tiles={[{ icon: 'trending-up', label: 'Trends', hint: 'h', onPress: () => {} }]}
      />,
    );

    // UPDATED from the old contract: this row used to grow a Leaderboard tile
    // because its eyebrow read 'EXPLORE'. Content must never be selected by a
    // copy string — the tile is placed by name at the call site now.
    const labels = r.root
      .findAll(
        (n) => typeof n.props.onPress === 'function' && n.props.accessibilityLabel != null,
      )
      .map((n) => String(n.props.accessibilityLabel));
    expect(labels).toEqual(['Trends']);
    await unmount(r);
  });
});

// ---------------------------------------------------------------------------
// 4. One route per destination

describe('Data tab', () => {
  it('offers exactly one control that opens Trends', async () => {
    db.listSessions.mockResolvedValue([sessionRow(1), sessionRow(2)]);

    const HistoryScreen = require('../../app/(tabs)/history').default;
    const r = await render(<HistoryScreen />);

    // The bottom "View trends" pill duplicated the tile at the top; the tile
    // is the survivor because it sits with Records, where a reader looks for
    // "where else can I go from here".
    const trends = controlsLabelled(r, 'Trends');
    expect(trends).toHaveLength(1);
    expect(textOf(r.toJSON())).not.toContain('View trends');
    // Export CSV is still reachable — the dedupe removed a route, not a row.
    expect(textOf(r.toJSON())).toContain('Export CSV');

    await act(async () => {
      trends[0].props.onPress();
    });
    expect(routerMod.router.push).toHaveBeenCalledWith('/trends');
    await unmount(r);
  });
});
