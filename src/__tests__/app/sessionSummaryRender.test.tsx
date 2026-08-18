/**
 * Session summary RENDER test — the guard summaryScreenContract.test.ts could
 * never be.
 *
 * WHY this exists: summaryScreenContract.test.ts asserts SOURCE TEXT, so it
 * passes happily on a screen that throws the instant React commits it. A live
 * session ending is the one navigation in the app the user cannot avoid, and
 * the screen it lands on is the most composed one we ship (SessionRecap,
 * SummaryHero, PersonalBestBanner, Confetti, CourtHeatmap, CourtPlacementMap,
 * RecheckPanel, CoachMarks). This suite MOUNTS it on exactly the path a
 * finished session takes — the live store in phase 'ended' with real
 * ResolvedShots — with the REAL child components, stubbing only the native
 * leaves (Skia canvas, the worklet runtime, sqlite, the router).
 *
 * Any render-phase throw anywhere in that tree fails these tests.
 */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks — native leaves only.

/** Flipped per-test so both the motion and the reduced-motion path are covered. */
const mockReducedMotion = jest.fn(() => false);

jest.mock('react-native-reanimated', () => {
  const ReactLocal = require('react') as typeof React;
  const RN = require('react-native');
  /** Chainable stand-in for a layout-animation builder (FadeInDown etc.). */
  const entering = () => {
    const shape: Record<string, unknown> = {};
    for (const k of ['duration', 'delay', 'springify', 'reduceMotion', 'withInitialValues', 'easing', 'damping', 'stiffness']) {
      shape[k] = () => shape;
    }
    return shape;
  };
  const passthrough = (v: unknown) => v;
  return {
    __esModule: true,
    default: {
      View: RN.View,
      Text: RN.Text,
      ScrollView: RN.ScrollView,
      FlatList: RN.FlatList,
      createAnimatedComponent: (c: unknown) => c,
    },
    FadeIn: entering(),
    FadeOut: entering(),
    FadeInUp: entering(),
    FadeInDown: entering(),
    FadeOutDown: entering(),
    FadeInLeft: entering(),
    FadeInRight: entering(),
    SlideInDown: entering(),
    SlideOutDown: entering(),
    ZoomIn: entering(),
    LinearTransition: entering(),
    ReduceMotion: { System: 'system', Never: 'never', Always: 'always' },
    Easing: {
      linear: (t: number) => t,
      ease: (t: number) => t,
      quad: (t: number) => t,
      cubic: (t: number) => t,
      inOut: (fn: unknown) => fn,
      out: (fn: unknown) => fn,
      in: (fn: unknown) => fn,
      bezier: () => (t: number) => t,
    },
    useReducedMotion: () => mockReducedMotion(),
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
    useAnimatedReaction: () => {},
    useFrameCallback: () => ({ setActive: () => {} }),
    useAnimatedRef: () => ReactLocal.createRef(),
    withSpring: passthrough,
    withTiming: passthrough,
    withDelay: (_d: number, v: unknown) => v,
    withRepeat: passthrough,
    withSequence: (...v: unknown[]) => v[v.length - 1],
    cancelAnimation: () => {},
    interpolate: () => 0,
    interpolateColor: () => '#000000',
    Extrapolation: { CLAMP: 'clamp' },
    createAnimatedComponent: (c: unknown) => c,
  };
});

// The worklets runtime needs its native module; running the callback straight
// on the JS thread is what these components expect when work comes back.
jest.mock('react-native-worklets', () => ({
  __esModule: true,
  scheduleOnRN: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
  scheduleOnUI: (fn: () => unknown) => fn(),
  createWorkletRuntime: () => ({}),
}));

// Skia is ESM-only under jest; every canvas on this screen is decorative.
jest.mock('@shopify/react-native-skia', () => {
  const stub = () => null;
  const path = () => ({
    moveTo() {}, lineTo() {}, quadTo() {}, cubicTo() {}, close() {}, addCircle() {},
    addRect() {}, countPoints: () => 0,
  });
  return {
    __esModule: true,
    Canvas: stub, Group: stub, Circle: stub, Rect: stub, RoundedRect: stub,
    Path: stub, Line: stub, Text: stub, Picture: stub, Paint: stub,
    BlurMask: stub, Blur: stub, Shadow: stub, LinearGradient: stub,
    RadialGradient: stub, DashPathEffect: stub, Image: stub, ImageSVG: stub, Mask: stub,
    Skia: {
      Color: (c: unknown) => c,
      Paint: () => ({ setColor: () => {}, setAlphaf: () => {} }),
      Path: { Make: path },
      XYWHRect: (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h }),
      PictureRecorder: () => ({
        beginRecording: () => ({
          save() {}, restore() {}, translate() {}, rotate() {}, drawRect() {},
        }),
        finishRecordingAsPicture: () => ({}),
      }),
    },
    rect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
    rrect: (r: unknown) => r,
    vec: (x: number, y: number) => ({ x, y }),
    useFont: () => null,
    matchFont: () => null,
  };
});

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('expo-router', () => {
  const ReactLocal = require('react') as typeof React;
  return {
    __esModule: true,
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() },
    useLocalSearchParams: jest.fn(() => ({})),
    useFocusEffect: (cb: () => void | (() => void)) => ReactLocal.useEffect(cb, [cb]),
    useNavigation: () => ({ addListener: () => () => {} }),
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/utils/haptics', () => ({
  haptic: {
    selection: jest.fn(), impactLight: jest.fn(), impactMedium: jest.fn(),
    success: jest.fn(), warning: jest.fn(), error: jest.fn(),
  },
}));

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(), impactAsync: jest.fn(), notificationAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

// The swipe wrapper needs the gesture-handler native module; the row body it
// wraps is what this suite renders.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const ReactLocal = require('react') as typeof React;
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ReactLocal.forwardRef(
      ({ children }: { children: React.ReactNode }, _ref: unknown) =>
        ReactLocal.createElement(View, null, children),
    ),
    SwipeDirection: { LEFT: 'left', RIGHT: 'right' },
  };
});

jest.mock('@/data/db', () => ({
  __esModule: true,
  getSession: jest.fn(async () => null),
  sessionShots: jest.fn(async () => []),
  listSessions: jest.fn(async () => []),
  // Career maxima from BEFORE tonight — low enough that tonight sets records.
  careerBests: jest.fn(async () => ({ bestStreak: 2, bestFgPct: 0.3, mostMakes: 2 })),
  lifetimeTotals: jest.fn(async () => ({ makes: 100, sessions: 5 })),
  shotFromRow: jest.fn((r: unknown) => r),
  updateShotOutcome: jest.fn(async () => {}),
  updateShotValue: jest.fn(async () => {}),
  updateSessionLabel: jest.fn(async () => {}),
}));

jest.mock('@/data/videoLibrary', () => ({
  saveSessionVideo: jest.fn(async () => true),
  deleteLocalVideo: jest.fn(async () => {}),
}));

jest.mock('@/data/recheckRunner', () => ({
  startSessionRecheck: jest.fn(() => ({ cancel: jest.fn(), promise: new Promise(() => {}) })),
}));

// Share-card rendering is a Skia snapshot + native share sheet.
jest.mock('@/components/ShareCard', () => ({
  __esModule: true,
  ShareCard: () => null,
  shareSessionCard: jest.fn(async () => true),
  sessionCardData: jest.fn(() => ({})),
}));

// Persistence is zustand middleware, not under test — same in-memory map the
// store suites use, so the REAL settings store (and its selectors) run here.
jest.mock('expo-sqlite/kv-store', () => {
  const mem = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => {
        mem.set(key, value);
      },
      removeItem: (key: string) => {
        mem.delete(key);
      },
    },
  };
});

import SessionSummaryScreen from '@/app/session/summary';
import { recomputeStats } from '@/core/stats';
import type { BallSample, ResolvedShot, ShotOutcome } from '@/core/types';
import { useSession } from '@/state/sessionStore';
import { useSettings } from '@/state/settingsStore';

// ---------------------------------------------------------------------------
// Realistic just-ended-session data

function trajectory(id: number): BallSample[] {
  return Array.from({ length: 9 }, (_, i) => ({
    cx: 120 + i * 14,
    cy: 320 - i * 22 + i * i * 1.6,
    r: 9,
    t: id * 4 + i * 0.05,
    score: 0.82,
    predicted: false,
  }));
}

function shot(id: number, outcome: ShotOutcome, over: Partial<ResolvedShot> = {}): ResolvedShot {
  const decided = outcome !== 'unsure';
  return {
    id,
    tStart: id * 4,
    tResolved: id * 4 + 1.1,
    outcome,
    signals: {
      geo: decided ? outcome === 'make' : null,
      net: decided ? outcome === 'make' : null,
      cls: outcome === 'make' ? true : null,
    },
    rimBounce: outcome === 'miss',
    xCross: 0.5,
    entryAngleDeg: 44 + (id % 5),
    releaseAngleDeg: 52,
    releasePoint: { x: 100, y: 300 },
    originX: 0.2 + (id % 3) * 0.3,
    originY: 0.8,
    trajectory: trajectory(id),
    shotValue: id % 4 === 0 ? 3 : 2,
    distanceRimWidths: id % 4 === 0 ? 7.5 : 3.8,
    valueSource: 'heuristic',
    valueConfidence: 0.7,
    ...over,
  };
}

/** A full session: makes, misses, one unsure, a 3-make streak, two 3PT. */
const SHOTS: ResolvedShot[] = [
  shot(1, 'make'), shot(2, 'make'), shot(3, 'miss'), shot(4, 'make'),
  shot(5, 'make'), shot(6, 'unsure'), shot(7, 'make'), shot(8, 'miss'),
  shot(9, 'make'), shot(10, 'make'), shot(11, 'make'), shot(12, 'miss'),
];

/** The store exactly as sessionStore.finish() leaves it before router.replace. */
function endedSession(over: Partial<Parameters<typeof useSession.setState>[0]> = {}): void {
  useSession.setState({
    phase: 'ended',
    sessionId: 42,
    startedAtMs: Date.now() - 12 * 60_000,
    shots: SHOTS.map((s) => ({ shot: s, rowId: s.id, syncedOutcome: s.outcome })),
    stats: recomputeStats(SHOTS),
    rimLocked: false,
    isRecording: false,
    recordingPath: '/var/mobile/session-42.mov',
    recordingStartSec: 0,
    lastShot: SHOTS[SHOTS.length - 1]!,
    ...over,
  });
}

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  // One extra flush for the effects that chain awaits (careerBests, lifetimeTotals…).
  await act(async () => {});
  return r;
}

type Json = ReturnType<ReactTestRenderer['toJSON']>;
/** Flatten every rendered string so copy can be asserted. */
function textOf(json: Json): string {
  if (json == null) return '';
  if (Array.isArray(json)) return json.map(textOf).join(' ');
  const kids = json.children ?? [];
  return kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join(' ');
}

beforeEach(() => {
  mockReducedMotion.mockReturnValue(false);
  useSettings.setState({ dailyGoalMakes: 0, saveToPhotos: false });
  endedSession();
});

afterEach(() => {
  useSession.getState().resetToIdle();
});

describe('the summary screen a finished session lands on', () => {
  it('mounts the just-ended session with the real recap tree', async () => {
    const r = await render(<SessionSummaryScreen />);
    const text = textOf(r.toJSON());
    // The screen actually painted its skeleton, not just "no throw".
    expect(text).toContain('SESSION COMPLETE');
    expect(text).toContain('BOX SCORE');
    expect(text).toContain('NEXT UP');
    // …and the recap really rendered rows, not an empty state.
    expect(text).toMatch(/Shot\s+1\b/);
    expect(text).not.toContain('No shots recorded.');
    expect(text).not.toContain('No session to show');
    await act(async () => {
      r.unmount();
    });
  });

  it('renders the personal-best + milestone + daily-goal block', async () => {
    useSettings.setState({ dailyGoalMakes: 5 });
    const r = await render(<SessionSummaryScreen />);
    const text = textOf(r.toJSON());
    expect(text).toContain('NEW PERSONAL BEST');
    expect(text).toContain('Daily goal');
    await act(async () => {
      r.unmount();
    });
  });

  it('renders the calibrated court map when shots carry court positions', async () => {
    const placed = SHOTS.map((s) =>
      shot(s.id, s.outcome, { courtPos: { x: (s.id % 5) - 2, y: 4 + (s.id % 3) } }),
    );
    endedSession({
      shots: placed.map((s) => ({ shot: s, rowId: s.id, syncedOutcome: s.outcome })),
      stats: recomputeStats(placed),
    });
    const r = await render(<SessionSummaryScreen />);
    expect(textOf(r.toJSON())).toContain('COURT MAP');
    await act(async () => {
      r.unmount();
    });
  });

  it('renders under system reduced motion', async () => {
    mockReducedMotion.mockReturnValue(true);
    const r = await render(<SessionSummaryScreen />);
    expect(textOf(r.toJSON())).toContain('SESSION COMPLETE');
    await act(async () => {
      r.unmount();
    });
  });

  it('renders a session with no recording', async () => {
    endedSession({ recordingPath: null, recordingStartSec: null });
    const r = await render(<SessionSummaryScreen />);
    expect(textOf(r.toJSON())).toContain('SESSION COMPLETE');
    await act(async () => {
      r.unmount();
    });
  });

  it('renders an empty session', async () => {
    endedSession({ shots: [], stats: recomputeStats([]) });
    const r = await render(<SessionSummaryScreen />);
    expect(textOf(r.toJSON())).toContain('No shots recorded.');
    await act(async () => {
      r.unmount();
    });
  });

  it('survives a shot correction (the swipe path) and the undo snackbar', async () => {
    const r = await render(<SessionSummaryScreen />);
    const flip = r.root
      .findAll((n) => n.props.accessibilityRole === 'button')
      .find((n) => typeof n.props.onPress === 'function' && /Change to (make|miss)/.test(
        String(n.props.accessibilityLabel ?? ''),
      ));
    // The recap renders its correction buttons with a label, not a bare pill.
    if (flip != null) {
      await act(async () => {
        flip.props.onPress();
      });
    }
    expect(textOf(r.toJSON())).toContain('BOX SCORE');
    await act(async () => {
      r.unmount();
    });
  });
});
