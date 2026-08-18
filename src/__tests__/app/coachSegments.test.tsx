/**
 * Coach's Corner segmentation contract.
 *
 * The Coach tab used to stack eight-plus cards of identical weight in one
 * scroll; it now groups them behind {@link SegmentedTabs} as [This week] /
 * [Your form] / [Plan]. Four claims are pinned, because every one of them is a
 * regression that still LOOKS fine on a screenshot:
 *
 * 1. NOTHING WAS CUT. This was a re-layout, not a feature trim, so each card
 *    that existed before must still mount — in exactly one segment. The tests
 *    assert both halves: the cards a segment owns render, and the cards it does
 *    NOT own are absent (otherwise "segmented" quietly becomes "duplicated").
 * 2. THE HERO IS NOT A SECTION. The weekly report answers "how am I doing", so
 *    it stays above the switcher and is visible in every segment. A hero that
 *    drifts into a tab takes the screen's whole answer with it.
 * 3. SWITCHING IS FREE. The SQLite scan lives above the segment state. If a tab
 *    press ever re-runs it, every switch pays a full session load — invisible
 *    on a dev machine, brutal on a real history.
 * 4. THE LADDER RESTARTS PER SEGMENT. The stagger index starts at 0 inside the
 *    selected segment, so no section ever trickles; the point of segmenting is
 *    that a section arrives as one gesture.
 *
 * Renders with react-test-renderer (this project has no RNTL) following
 * src/__tests__/app/wiCDataScreens.test.tsx. Child cards and the coach cores
 * are stubbed: what is under test is WHICH cards a segment mounts, not what
 * the engine computes (that has its own core suites).
 */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks

// Reanimated's worklets runtime can't load under jest without native modules.
// Left REAL enough for SegmentedTabs, which is the component under test here:
// it reaches past the '@/components/motion' barrel for its press spring
// precisely so a screen suite that stubs the barrel (below) can't hollow it out.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (component: unknown) => component,
  },
  Easing: { out: (fn: unknown) => fn, cubic: 'cubic' },
  FadeInDown: { duration: () => ({ delay: () => ({}) }) },
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

// enter() returns undefined (the reduced-motion idiom) so cards render static,
// while the indexes it was called with stay inspectable — that IS the ladder.
const mockEnter = jest.fn((_i: number): undefined => undefined);
jest.mock('@/components/motion', () => ({
  __esModule: true,
  useCardStagger: jest.fn(() => mockEnter),
  useStaggerAt: jest.fn(() => () => undefined),
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

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Child cards become one-word markers: this suite asks WHERE a card lands, not
// what it draws (each has its own suite for that).
function mockMarker(name: string) {
  const ReactLocal = require('react') as typeof React;
  const { Text } = require('react-native');
  return () => ReactLocal.createElement(Text, null, name);
}
jest.mock('@/components/BodyDirectionCard', () => ({
  BodyDirectionCard: mockMarker('BODY_DIRECTION_CARD'),
}));
jest.mock('@/components/coach/ArcProfileCard', () => ({
  ArcProfileCard: mockMarker('ARC_PROFILE_CARD'),
}));
jest.mock('@/components/coach/CoachTimelineCard', () => ({
  CoachTimelineCard: mockMarker('COACH_TIMELINE_CARD'),
}));
jest.mock('@/components/coach/FormReadinessCard', () => ({
  FormReadinessCard: mockMarker('FORM_READINESS_CARD'),
}));
jest.mock('@/components/coach/SeasonStrip', () => ({ SeasonStrip: mockMarker('SEASON_STRIP') }));

jest.mock('@/components/ShareCard', () => ({
  shareCoachCard: jest.fn(async () => true),
  shareWeekCard: jest.fn(async () => true),
}));

// Coach cores: pure, but their OUTPUT decides which optional cards mount, so
// they are pinned to fixtures rather than left to whatever the fake shots imply.
jest.mock('@/core/coachEngine', () => ({
  runCoach: jest.fn(() => mockFindings),
  weeklyPlan: jest.fn(() => mockPlan),
}));
jest.mock('@/core/coachInsights', () => ({
  arcProfile: jest.fn(() => ({
    n: 12,
    avgEntryDeg: 46,
    idealPct: 0.6,
    flatPct: 0.2,
    steepPct: 0.2,
  })),
  coachTimeline: jest.fn(() => [
    { weekStartMs: 1, label: 'w1', sessions: 2, attempts: 20, makes: 10, fgPct: 0.5, wss: 60 },
  ]),
  formReadiness: jest.fn(() => ({
    total: 20,
    withBallFlight: 20,
    withPose: 10,
    posePct: 0.5,
    level: 'sparse',
  })),
  seasonComparison: jest.fn(() => ({
    recent: { sessions: 3, attempts: 30, makes: 15, fgPct: 0.5 },
    prior: { sessions: 2, attempts: 20, makes: 8, fgPct: 0.4 },
    fgDeltaPts: 10,
    attemptsDelta: 10,
    sessionsDelta: 1,
  })),
}));
jest.mock('@/core/shotLab', () => ({
  matchArchetype: jest.fn(() => [
    {
      player: {
        name: 'TWIN_PLAYER',
        style: 'Quick-release spot-up',
        mechanics: 'High, compact release.',
        whatToCopy: ['Set your feet early', 'Finish tall'],
      },
      similarity: 82,
      rows: [],
    },
  ]),
}));
jest.mock('@/core/weeklyReport', () => ({
  buildWeeklyReport: jest.fn(() => mockReport),
  // Kept trivial and deterministic: the screen only uses it to bucket sessions,
  // and this fixture puts every session in one bucket (so the week picker,
  // which is a SECOND tablist, stays out of the way of these assertions).
  weekStart: jest.fn(() => 1_700_000_000_000),
}));
jest.mock('@/core/drills', () => ({
  getDrill: jest.fn(() => ({ id: 'formShooting', title: 'PLANNED_DRILL' })),
}));
jest.mock('@/core/drillProgression', () => ({
  LEVEL_LABEL: { 1: 'Starter', 2: 'Regular', 3: 'Advanced' },
  drillPrescription: jest.fn(() => 'Five sets of five.'),
  drillResultFromModeState: jest.fn(() => null),
  levelForDrill: jest.fn(() => 1),
}));
jest.mock('@/core/stats', () => ({
  recomputeStats: jest.fn(() => ({ attempts: 10, makes: 5, misses: 5, unsure: 0, fgPct: 0.5 })),
}));

jest.mock('@/data/db', () => ({
  listSessions: jest.fn(async () => []),
  sessionShots: jest.fn(async () => []),
  shotFromRow: jest.fn((r: unknown) => r),
}));

jest.mock('@/state/profileStore', () => ({
  useProfile: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ experience: 'rookie', trainingGoal: 'fun', position: 'guard' }),
}));

// ---------------------------------------------------------------------------
// Fixtures (referenced from the jest.mock factories above — hence `mock*`)

const mockFindings = [
  {
    id: 'flatArc',
    severity: 3,
    title: 'FINDING_ONE_TITLE',
    evidence: 'Your arc averaged 38 degrees.',
    prescription: 'Shoot over a chair.',
    trend: 'worsening',
    strength: 1.2,
  },
  {
    id: 'coldStart',
    severity: 2,
    title: 'FINDING_TWO_TITLE',
    evidence: 'You opened 2 for 11.',
    prescription: 'Warm up from close.',
    trend: 'flat',
    strength: 0.6,
  },
];

const mockPlan = [{ finding: mockFindings[0], drillId: 'formShooting' }];

const mockReport = {
  weekStartMs: 1_700_000_000_000,
  label: 'Nov 13 – 19',
  sessions: 3,
  attempts: 30,
  makes: 15,
  fgPct: 0.5,
  points: 32,
  bestStreak: 5,
  wss: 64,
  fgDeltaPtsVsPrior: 4,
  bestSession: null,
  hottestZone: null,
  findings: mockFindings,
  nextWeekFocus: 'FOCUS_LINE',
  headline: 'HERO_HEADLINE',
};

// ---------------------------------------------------------------------------
// Helpers

const db = jest.requireMock('@/data/db') as Record<string, jest.Mock>;

function sessionRow(id: number) {
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
  };
}

async function render(): Promise<ReactTestRenderer> {
  const CoachScreen = require('../../app/(tabs)/coach').default;
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(<CoachScreen />);
  });
  // One extra flush for the loader's chained awaits (listSessions → Promise.all).
  await act(async () => {});
  return r;
}

type Json = ReturnType<ReactTestRenderer['toJSON']>;

function textOf(json: Json): string {
  if (json == null) return '';
  if (Array.isArray(json)) return json.map(textOf).join(' ');
  const kids = json.children ?? [];
  return kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join(' ');
}

const screenText = (r: ReactTestRenderer): string => textOf(r.toJSON());

/** Unmount inside act — the screen holds loader + segment state. */
async function unmount(r: ReactTestRenderer): Promise<void> {
  await act(async () => {
    r.unmount();
  });
}

/** The section switcher's tabs (the week picker is a separate, named tablist). */
function sectionTabs(r: ReactTestRenderer) {
  const list = r.root.find(
    (n) =>
      typeof n.type === 'string' &&
      n.props.accessibilityRole === 'tablist' &&
      n.props.accessibilityLabel === 'Coach sections',
  );
  return list.findAll(
    (n) => typeof n.type === 'string' && n.props.accessibilityRole === 'tab',
  );
}

/** Press a section tab by its visible label. */
async function switchTo(r: ReactTestRenderer, label: string): Promise<void> {
  const tab = sectionTabs(r).find((t) =>
    String(t.props.accessibilityLabel).startsWith(label),
  );
  if (tab == null) throw new Error(`No section tab labelled ${label}`);
  const pressable = tab.findAll(
    (n) =>
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityRole === 'none' &&
      n.props.haptic === undefined,
  )[0]!;
  await act(async () => {
    pressable.props.onPress();
  });
}

/** Every card this screen owns, so "absent from the other segments" is checkable. */
// SectionEyebrow uppercases its child, so the eyebrow copy is matched as it
// actually renders.
const WEEK_CARDS = ['COACH_TIMELINE_CARD', 'SEASON_STRIP', 'THE READ ON YOUR WEEK'];
const FORM_CARDS = [
  'BODY_DIRECTION_CARD',
  'ARC_PROFILE_CARD',
  'TWIN_PLAYER',
  'See your shooting form in 3D',
  'FORM_READINESS_CARD',
];
const PLAN_CARDS = ['PLANNED_DRILL', 'GO DEEPER'];

beforeEach(() => {
  jest.clearAllMocks();
  mockEnter.mockClear();
  db.listSessions.mockResolvedValue([sessionRow(1), sessionRow(2), sessionRow(3)]);
  db.sessionShots.mockResolvedValue([]);
  db.shotFromRow.mockImplementation((row: unknown) => row);
});

// ---------------------------------------------------------------------------

describe('segment content', () => {
  it('opens on [This week] with that segment’s cards and none of the others', async () => {
    const r = await render();
    const text = screenText(r);

    for (const card of WEEK_CARDS) expect([card, text.includes(card)]).toEqual([card, true]);
    expect(text).toContain('FINDING_ONE_TITLE');
    expect(text).toContain('Share coach report');

    for (const card of [...FORM_CARDS, ...PLAN_CARDS]) {
      expect([card, text.includes(card)]).toEqual([card, false]);
    }
    await unmount(r);
  });

  it('shows the form cards, and only those, under [Your form]', async () => {
    const r = await render();
    await switchTo(r, 'Your form');
    const text = screenText(r);

    for (const card of FORM_CARDS) expect([card, text.includes(card)]).toEqual([card, true]);
    for (const card of [...WEEK_CARDS, ...PLAN_CARDS]) {
      expect([card, text.includes(card)]).toEqual([card, false]);
    }
    expect(text).not.toContain('FINDING_ONE_TITLE');
    await unmount(r);
  });

  it('shows the drill plan and the deep dive, and only those, under [Plan]', async () => {
    const r = await render();
    await switchTo(r, 'Plan');
    const text = screenText(r);

    for (const card of PLAN_CARDS) expect([card, text.includes(card)]).toEqual([card, true]);
    expect(text).toContain("THIS WEEK'S PLAN");
    for (const card of [...WEEK_CARDS, ...FORM_CARDS]) {
      expect([card, text.includes(card)]).toEqual([card, false]);
    }
    await unmount(r);
  });

  it('keeps every card the flat scroll had — the union of the segments', async () => {
    // The anti-regression for "we tidied the screen by dropping a card".
    const r = await render();
    const seen = new Set<string>();
    const collect = () => {
      const text = screenText(r);
      for (const card of [...WEEK_CARDS, ...FORM_CARDS, ...PLAN_CARDS]) {
        if (text.includes(card)) seen.add(card);
      }
    };
    collect();
    await switchTo(r, 'Your form');
    collect();
    await switchTo(r, 'Plan');
    collect();

    expect([...seen].sort()).toEqual([...WEEK_CARDS, ...FORM_CARDS, ...PLAN_CARDS].sort());
    await unmount(r);
  });
});

// ---------------------------------------------------------------------------

describe('the weekly hero', () => {
  it('stays visible in every segment — it is the headline, not a section', async () => {
    const r = await render();
    for (const label of ['This week', 'Your form', 'Plan', 'This week']) {
      await switchTo(r, label);
      const text = screenText(r);
      expect([label, text.includes('HERO_HEADLINE')]).toEqual([label, true]);
      expect([label, text.includes('WEEK OF NOV 13 – 19')]).toEqual([label, true]);
      // The week's box score travels with it.
      expect([label, text.includes('15/30')]).toEqual([label, true]);
    }
    await unmount(r);
  });
});

// ---------------------------------------------------------------------------

describe('switching', () => {
  it('does not remount the data loader', async () => {
    const r = await render();
    expect(db.listSessions).toHaveBeenCalledTimes(1);

    await switchTo(r, 'Your form');
    await switchTo(r, 'Plan');
    await switchTo(r, 'This week');

    // Three switches, still the ONE scan from mount.
    expect(db.listSessions).toHaveBeenCalledTimes(1);
    expect(db.sessionShots).toHaveBeenCalledTimes(3); // one per session row, once.
    await unmount(r);
  });

  it('marks exactly one section tab selected, and badges it with real counts', async () => {
    const r = await render();
    expect(sectionTabs(r).map((t) => t.props.accessibilityState.selected)).toEqual([
      true,
      false,
      false,
    ]);
    expect(sectionTabs(r).map((t) => t.props.accessibilityLabel)).toEqual([
      // Two fixture findings, one fixture assignment — the badges are counts
      // the screen actually holds, never decoration.
      'This week, 2 findings',
      'Your form',
      'Plan, 1 drill',
    ]);

    await switchTo(r, 'Plan');
    expect(sectionTabs(r).map((t) => t.props.accessibilityState.selected)).toEqual([
      false,
      false,
      true,
    ]);
    await unmount(r);
  });

  it('restarts the entrance ladder at 0 inside the selected segment', async () => {
    const r = await render();
    mockEnter.mockClear();
    await switchTo(r, 'Your form');

    const indexes = [...new Set(mockEnter.mock.calls.map(([i]) => i))].sort((a, b) => a - b);
    // Form owns five cards: 0..4, starting at 0 — never continuing a ladder
    // from wherever the previous segment left off.
    expect(indexes[0]).toBe(0);
    expect(Math.max(...indexes)).toBeLessThanOrEqual(4);
    await unmount(r);
  });
});

// ---------------------------------------------------------------------------

describe('states that are not segmented', () => {
  it('shows no section switcher before there is anything to section', async () => {
    db.listSessions.mockResolvedValue([]);
    const r = await render();

    expect(screenText(r)).toContain('No sessions to coach yet');
    expect(
      r.root.findAll(
        (n) => typeof n.type === 'string' && n.props.accessibilityLabel === 'Coach sections',
      ),
    ).toHaveLength(0);
    // The day-one card the empty state carries is untouched by segmentation.
    expect(screenText(r)).toContain('BODY_DIRECTION_CARD');
    await unmount(r);
  });
});
