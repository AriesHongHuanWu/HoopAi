/**
 * WI-C contract tests — data screens on the canonical motion module.
 *
 * Pins the seams this work item (and the data package's story-first pass)
 * changed:
 * - History list: stagger comes from useCardStagger and the index is CAPPED
 *   at 8 so long histories don't tail-lag; sessions load through
 *   listVisibleSessions (the free-tier retention enforcement point) with
 *   incremental paging; unsure counts surface as chips derived from the pips
 *   the screen already fetched.
 * - Session detail: top-level blocks cascade in the story-first visual order
 *   (header → recap → actions → re-check → mode → compare → angles), the
 *   unsure integrity line renders above the recap regardless of videoPath,
 *   and the tag pill's haptic tick routes through the gated '@/utils/haptics'
 *   gateway — never expo-haptics directly.
 * - Trends: useCardStagger keeps the screen's 70 ms step, ONE merged hero
 *   card owns the chart slot, and the stat grids roll in via MotionStat with
 *   the SAME numbers StatNumber showed (presentation only —
 *   Math.round(x * 100) + '%' suffix, no reformatting).
 * - Records: hero career-makes stays a MotionStat keyed on its value (the
 *   arc canvas behind it is additive); '—' placeholder tiles still render;
 *   badge rows cap their stagger at 8.
 */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { color, motion } from '@/constants/tokens';
import { emptyTotals } from '@/core/achievements';

// ---------------------------------------------------------------------------
// Mocks

// Reanimated's worklets runtime can't load under jest without native modules.
// useDerivedValue / withRepeat / cancelAnimation / Easing exist for the Skia
// shimmer inside SkeletonCard (loading states now render it on first paint).
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (component: unknown) => component,
  },
  // Chainable builder stubs — the data screens attach
  // .reduceMotion(ReduceMotion.System) to these per the sweep's shared
  // disclosure grammar (trends lens swap, history list reflow, detail chip).
  FadeIn: { duration: () => ({ reduceMotion: () => ({}) }) },
  FadeInDown: { duration: () => ({ delay: () => ({}), reduceMotion: () => ({}) }) },
  // Exit stub: the skeleton dissolve (useSkeletonExit) and trends' lens-swap
  // exit build FadeOut.duration(..).reduceMotion(..) — some at module scope,
  // so the stub must exist before the screens import.
  FadeOut: { duration: () => ({ reduceMotion: () => ({}) }) },
  LinearTransition: { duration: () => ({ reduceMotion: () => ({}) }) },
  ReduceMotion: { System: 'system' },
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
  withRepeat: (value: unknown) => value,
  cancelAnimation: () => {},
  Easing: {
    linear: (t: number) => t,
    cubic: (t: number) => t,
    out: (fn: unknown) => fn,
  },
}));

// The motion module under integration: capture how screens drive it. The
// enter fn returns undefined (the reduced-motion idiom) so Animated.View and
// Card render their static paths.
jest.mock('@/components/motion', () => {
  const ReactLocal = require('react') as typeof React;
  const { Text } = require('react-native');
  return {
    __esModule: true,
    useCardStagger: jest.fn(() => mockEnter),
    useStaggerAt: jest.fn(() => () => undefined),
    MotionStat: jest.fn(
      ({ value, suffix = '', label }: { value: number; suffix?: string; label?: string }) =>
        ReactLocal.createElement(Text, null, `${value}${suffix}${label != null ? ` ${label}` : ''}`),
    ),
    // Trends' hero numeral rolls via CountUp — deliberately NOT MotionStat,
    // so the MotionStat call-list pins below stay exact.
    CountUp: jest.fn(({ to, suffix = '' }: { to: number; suffix?: string }) =>
      ReactLocal.createElement(Text, null, `${to}${suffix}`),
    ),
    // Records draws these behind/under real numerals; decorative here.
    ArcReveal: jest.fn(() => null),
    AnimatedProgressBar: jest.fn(() => null),
  };
});
const mockEnter = jest.fn((_i: number): undefined => undefined);

// The single settings-gated haptics gateway (gating itself is WI-A's test
// surface — here we assert screens call the gateway, not expo-haptics).
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
    router: { push: jest.fn(), replace: jest.fn() },
    useFocusEffect: (cb: () => void | (() => void)) => ReactLocal.useEffect(cb, [cb]),
    useLocalSearchParams: jest.fn(() => ({ id: '5' })),
  };
});

// Skia canvases are decorative on these screens. Group/LinearGradient and the
// rect/rrect factories are consumed by the SkeletonCard shimmer.
jest.mock('@shopify/react-native-skia', () => ({
  Canvas: () => null,
  Circle: () => null,
  DashPathEffect: () => null,
  Group: () => null,
  Line: () => null,
  LinearGradient: () => null,
  Path: () => null,
  Rect: () => null,
  RoundedRect: () => null,
  rect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
  rrect: (r: unknown) => ({ rect: r }),
  vec: (x: number, y: number) => ({ x, y }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/components/ShotList', () => ({
  __esModule: true,
  BackPill: () => null,
  PipRow: () => null,
  SessionRecap: () => null,
  UndoSnackbar: () => null,
  formatSessionDate: (ms: number) => `date-${ms}`,
  formatSessionTime: (ms: number) => `time-${ms}`,
  useSessionRecord: jest.fn(),
  useUndoableCorrection: jest.fn(() => ({
    correct: jest.fn(),
    pending: null,
    undo: jest.fn(),
  })),
}));

jest.mock('@/components/NavTiles', () => ({ NavTileRow: () => null }));
jest.mock('@/components/modes/modeIdentity', () => ({ ModeMark: () => null }));
jest.mock('@/components/RecheckPanel', () => ({ RecheckPanel: () => null }));
jest.mock('@/components/ReelEntryButton', () => ({ ReelEntryButton: () => null }));
jest.mock('@/components/ShareCard', () => ({ shareSessionCard: jest.fn(async () => true) }));
jest.mock('@/components/FramePickerModal', () => ({ FramePickerModal: () => null }));
jest.mock('@/components/AchievementRow', () => ({ AchievementRow: () => null }));
jest.mock('@/components/ProBadge', () => ({ ProBadge: () => null }));
jest.mock('@/components/charts/AngleHistogram', () => ({
  AngleHistogram: () => null,
  decidedEntryAngles: jest.fn(() => []),
}));
jest.mock('@/components/charts/Sparkline', () => ({ Sparkline: () => null }));
jest.mock('@/components/charts/CourtHeatmap', () => ({ CourtHeatmap: () => null }));
jest.mock('@/components/charts/CompareBars', () => ({ CompareBars: () => null }));
jest.mock('@/core/csvExport', () => ({
  sessionsToCsv: jest.fn(() => ''),
  exportCsv: jest.fn(async () => true),
}));
jest.mock('@/data/videoLibrary', () => ({ deleteLocalVideo: jest.fn(async () => {}) }));

jest.mock('@/data/db', () => ({
  listSessions: jest.fn(async () => []),
  // History's reader: the free-tier retention enforcement point (identical to
  // listSessions during beta). Mocked separately so the suite can pin that
  // History goes through it and not the raw query.
  listVisibleSessions: jest.fn(async () => []),
  sessionShots: jest.fn(async () => []),
  deleteSession: jest.fn(async () => {}),
  fgTrend: jest.fn(async () => []),
  shotFromRow: jest.fn((r: unknown) => r),
  sessionStatsFromDb: jest.fn(async () => ({})),
  updateSessionLabel: jest.fn(async () => {}),
  allSessionStartedAt: jest.fn(async () => []),
  lifetimeTotals: jest.fn(async () => null),
}));

jest.mock('@/state/achievementsSeenStore', () => {
  const state = { hasVisited: true, seenBadgeIds: [] as string[], markSeen: jest.fn() };
  return {
    useAchievementsSeen: {
      getState: () => state,
      persist: {
        hasHydrated: () => true,
        onFinishHydration: () => () => {},
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers

const db = jest.requireMock('@/data/db') as Record<string, jest.Mock>;
const shotList = jest.requireMock('@/components/ShotList') as Record<string, jest.Mock>;
const motionMod = jest.requireMock('@/components/motion') as {
  useCardStagger: jest.Mock;
  MotionStat: jest.Mock;
};
const hapticsMod = jest.requireMock('@/utils/haptics') as {
  haptic: Record<string, jest.Mock>;
};

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  // One extra flush for effects that chain multiple awaits (Promise.all etc).
  await act(async () => {});
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
  mockEnter.mockClear();
  motionMod.useCardStagger.mockClear();
  motionMod.MotionStat.mockClear();
  Object.values(hapticsMod.haptic).forEach((fn) => fn.mockClear());
  Object.values(db).forEach((fn) => fn.mockClear());
  db.listSessions.mockResolvedValue([]);
  db.listVisibleSessions.mockResolvedValue([]);
  db.sessionShots.mockResolvedValue([]);
  db.fgTrend.mockResolvedValue([]);
  db.allSessionStartedAt.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// History list

describe('History list', () => {
  it('staggers session cards via useCardStagger with the index capped at 8', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => sessionRow(i + 1));
    db.listVisibleSessions.mockResolvedValue(rows);

    const HistoryScreen = require('../../app/(tabs)/history').default;
    const r = await render(<HistoryScreen />);

    expect(motionMod.useCardStagger).toHaveBeenCalledWith({ durationMs: motion.standard });
    // Sessions load through the retention enforcement point, first page = 30.
    expect(db.listVisibleSessions).toHaveBeenCalledWith(30);
    // One enter() per card, and no index ever exceeds the cap.
    const indexes = mockEnter.mock.calls.map(([i]) => i);
    expect(indexes).toHaveLength(12);
    expect(indexes.slice(0, 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Math.max(...indexes)).toBe(8);
    r.unmount();
  });

  it('surfaces unsure counts as a chip and in the card label, from the pips already fetched', async () => {
    db.listVisibleSessions.mockResolvedValue([sessionRow(1)]);
    db.sessionShots.mockResolvedValue([
      { outcome: 'make' },
      { outcome: 'unsure' },
      { outcome: 'unsure' },
      { outcome: 'miss' },
    ]);

    const HistoryScreen = require('../../app/(tabs)/history').default;
    const r = await render(<HistoryScreen />);

    // The chip copy is on screen…
    expect(textOf(r.toJSON())).toContain('2 unsure');
    // …and the card's accessibility label carries the same honest count.
    const card = r.root.findAll(
      (n) =>
        typeof n.props.onPress === 'function' &&
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Session on '),
    )[0];
    expect(card).toBeDefined();
    expect(card.props.accessibilityLabel).toContain(', 2 unsure');
    // Derived from the outcomes the screen already loads — no extra query.
    expect(db.sessionShots).toHaveBeenCalledTimes(1);
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// Session detail

describe('Session detail', () => {
  function mockRecord(over: Record<string, unknown> = {}) {
    shotList.useSessionRecord.mockReturnValue({
      session: sessionRow(5),
      shots: [],
      stats: { attempts: 0, makes: 0, misses: 0, unsure: 0, fgPct: 0 },
      correct: jest.fn(),
      correctValue: jest.fn(),
      loaded: true,
      ...over,
    });
  }

  it('cascades its top-level blocks in visual order', async () => {
    mockRecord();
    const SessionDetailScreen = require('../../app/history/[id]').default;
    const r = await render(<SessionDetailScreen />);

    // RE-PINNED for the story-first reorder (score before tools): the ladder
    // is now header(0) → integrity+recap(1) → compact actions(2) →
    // re-check(3) → mode(4) → compare(5) → angles(6). With no video / mode /
    // previous session, blocks 3–5 are skipped but the ladder stays in
    // visual order (re-renders may repeat the pass).
    const indexes = mockEnter.mock.calls.map(([i]) => i);
    expect(indexes.slice(0, 4)).toEqual([0, 1, 2, 6]);
    expect([...new Set(indexes)].sort((a, b) => a - b)).toEqual([0, 1, 2, 6]);
    r.unmount();
  });

  it('animates the re-check, mode and comparison blocks when present', async () => {
    mockRecord({
      session: sessionRow(5, {
        videoPath: 'file:///v.mp4',
        recordingStartSec: 2,
        modeId: 'streak',
      }),
    });
    db.listSessions.mockResolvedValue([sessionRow(4)]);
    db.sessionStatsFromDb.mockResolvedValue({
      attempts: 10,
      makes: 5,
      misses: 5,
      unsure: 0,
      fgPct: 0.5,
    });

    const SessionDetailScreen = require('../../app/history/[id]').default;
    const r = await render(<SessionDetailScreen />);

    const indexes = mockEnter.mock.calls.map(([i]) => i);
    // Full ladder: header, recap, actions, re-check, mode, compare, angles.
    expect(indexes).toEqual(expect.arrayContaining([0, 1, 2, 3, 4, 5, 6]));
    r.unmount();
  });

  it('renders the unsure integrity line above the recap even with no video', async () => {
    // videoPath stays null: the integrity line must NOT be video-gated (the
    // re-check panel is, and it used to be the only top-line unsure surface).
    mockRecord({
      stats: { attempts: 10, makes: 5, misses: 3, unsure: 2, fgPct: 5 / 8 },
    });
    const SessionDetailScreen = require('../../app/history/[id]').default;
    const r = await render(<SessionDetailScreen />);

    // Copy byte-identical to the summary hero's (summaryHeroMotion pin).
    expect(textOf(r.toJSON())).toContain('2 shots unsure — not counted either way');
    r.unmount();
  });

  it('omits the integrity line when nothing was unsure', async () => {
    mockRecord();
    const SessionDetailScreen = require('../../app/history/[id]').default;
    const r = await render(<SessionDetailScreen />);

    expect(textOf(r.toJSON())).not.toContain('unsure — not counted either way');
    r.unmount();
  });

  it('routes the tag-pill tick through the gated haptics gateway', async () => {
    mockRecord();
    const SessionDetailScreen = require('../../app/history/[id]').default;
    const r = await render(<SessionDetailScreen />);

    const pill = r.root
      .findAll(
        (n) =>
          n.props.accessibilityLabel === 'Add a tag' &&
          typeof n.props.onPress === 'function',
      )[0];
    expect(pill).toBeDefined();
    await act(async () => {
      pill.props.onPress();
    });
    expect(hapticsMod.haptic.selection).toHaveBeenCalledTimes(1);
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// Trends

describe('Trends', () => {
  it('keeps the 70 ms step and rolls the stat grids with unchanged numbers', async () => {
    db.fgTrend.mockResolvedValue([
      { sessionId: 1, fgPct: 0.4, attempts: 10 },
      { sessionId: 2, fgPct: 0.5, attempts: 12 },
      { sessionId: 3, fgPct: 0.6, attempts: 8 },
    ]);
    db.listSessions.mockResolvedValue([
      sessionRow(3, { attempts: 8, makes: 5 }),
      sessionRow(2, { attempts: 12, makes: 6 }),
      sessionRow(1, { attempts: 10, makes: 4 }),
    ]);

    const TrendsScreen = require('../../app/trends').default;
    const r = await render(<TrendsScreen />);

    expect(motionMod.useCardStagger).toHaveBeenCalledWith({
      stepMs: 70,
      durationMs: motion.standard,
    });

    // RE-PINNED for the one-hero merge: the sparkline and bars cards drew the
    // same points[] twice and are now ONE hero card, so the ladder is
    // hero(0) → stat grid(1) → angles(2) → lifetime(4); court zones hold 3
    // when present (not in this fixture — no shots land in the heatmap).
    const indexes = mockEnter.mock.calls.map(([i]) => i);
    expect([...new Set(indexes)].sort((a, b) => a - b)).toEqual([0, 1, 2, 4]);

    const statCalls = motionMod.MotionStat.mock.calls.map(([p]) => p);
    // avg = mean(0.4, 0.5, 0.6) = 0.5 → 50%; best = 60%; attempts = 30.
    expect(statCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 50, suffix: '%', label: 'avg FG', size: 'medium' }),
        expect.objectContaining({ value: 60, suffix: '%', label: 'best', size: 'medium' }),
        expect.objectContaining({ value: 30, label: 'attempts', size: 'medium' }),
        // Lifetime strip: 3 tracked sessions, 15 total makes.
        expect.objectContaining({ value: 3, label: 'sessions', size: 'medium' }),
        expect.objectContaining({ value: 15, label: 'total makes', size: 'medium' }),
      ]),
    );
    // Triggers key on the value so a data change re-rolls exactly once.
    const avg = statCalls.find((p) => p.label === 'avg FG');
    expect(avg.trigger).toBe(50);
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// Records

describe('Records', () => {
  it('rolls career makes via MotionStat and keeps "—" placeholder tiles', async () => {
    db.lifetimeTotals.mockResolvedValue({
      ...emptyTotals(),
      sessions: 20,
      attempts: 500,
      makes: 250,
      bestStreak: 7,
      threes: 12,
      // bestWeekSessions stays 0 → the '—' branch must render, not roll.
    });

    const RecordsScreen = require('../../app/records').default;
    const r = await render(<RecordsScreen />);

    expect(motionMod.MotionStat).toHaveBeenCalled();
    const hero = motionMod.MotionStat.mock.calls[0][0];
    expect(hero).toEqual(
      expect.objectContaining({
        value: 250,
        size: 'hero',
        label: 'career makes',
        tint: color.accent,
        trigger: 250,
      }),
    );

    // '—' placeholders (longest day streak, best week) render statically.
    expect(textOf(r.toJSON())).toContain('—');
    r.unmount();
  });

  it('caps the badge-row stagger index at 8', async () => {
    db.lifetimeTotals.mockResolvedValue({
      ...emptyTotals(),
      sessions: 100,
      attempts: 5000,
      makes: 2500,
      bestStreak: 25,
      threes: 300,
      bestSessionFgPct: 0.9,
      bestWeekSessions: 7,
    });

    const RecordsScreen = require('../../app/records').default;
    const r = await render(<RecordsScreen />);

    const indexes = mockEnter.mock.calls.map(([i]) => i);
    // Unlocked + in-progress boards both render rows; every index respects
    // the cap so long boards never tail-lag.
    expect(indexes.length).toBeGreaterThan(8);
    expect(Math.max(...indexes)).toBe(8);
    r.unmount();
  });
});
