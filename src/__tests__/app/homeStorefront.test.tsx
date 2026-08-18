/**
 * Home storefront contracts — the TODAY-shelf wave's compact-weekly and
 * first-run branches, plus source pins on (tabs)/index.tsx.
 *
 * WHY this shape: Home itself imports SQLite, VisionCamera and the boot
 * intro, so rendering the whole screen under jest is not honest coverage
 * (the layoutRhythmContract rationale). Instead this suite
 *   1. RENDERS the two new presentational satellites — WeeklyChallengeSummary
 *      (the compact weekly deck; a SEPARATE render path from
 *      WeeklyChallengeCard, whose own test stays untouched) and FirstRunScene
 *      (the decorative first-run frame) — against fixed inputs; and
 *   2. PINS the honesty/loading/navigation seams of the screen at source
 *      level (same idiom as summaryScreenContract.test.ts): no plain-text
 *      'Loading…' survives, the recommendation reason renders verbatim, the
 *      weekly award pass stays Home-owned, and /modes stays a typed literal.
 *
 * Mock set follows src/__tests__/app/sessionSummaryRender.test.tsx (the
 * worklets runtime, Skia and the icon font can't load headless).
 */
import * as fs from 'fs';
import * as path from 'path';

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { color } from '@/constants/tokens';
import {
  WEEKLY_CHALLENGE_POOL,
  emptyWeekAggregate,
  type WeekAggregate,
  type WeeklyChallengeDef,
} from '@/core/weeklyChallenges';

// ---------------------------------------------------------------------------
// Mocks

// Reanimated's worklets runtime can't load under jest without native modules.
jest.mock('react-native-reanimated', () => {
  const RN = require('react-native');
  const entering = () => {
    const chain: Record<string, unknown> = {};
    chain.duration = () => chain;
    chain.delay = () => chain;
    chain.reduceMotion = () => chain;
    return chain;
  };
  const passthrough = (v: unknown) => v;
  return {
    __esModule: true,
    default: {
      View: RN.View,
      Text: RN.Text,
      ScrollView: RN.ScrollView,
      createAnimatedComponent: (c: unknown) => c,
    },
    FadeIn: entering(),
    FadeInDown: entering(),
    FadeOut: entering(),
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
      back: () => (t: number) => t,
      bezier: () => (t: number) => t,
    },
    useReducedMotion: () => true,
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
    withSpring: passthrough,
    withTiming: passthrough,
    withRepeat: passthrough,
    withSequence: (...v: unknown[]) => v[v.length - 1],
    withDelay: (_d: number, v: unknown) => v,
    cancelAnimation: () => {},
    interpolate: () => 0,
    createAnimatedComponent: (c: unknown) => c,
  };
});

jest.mock('react-native-worklets', () => ({
  __esModule: true,
  scheduleOnRN: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
  scheduleOnUI: (fn: () => unknown) => fn(),
}));

// Skia is ESM-only under jest. Canvas passes children through so the
// Path/Circle/Oval props (the wiring) stay inspectable.
jest.mock('@shopify/react-native-skia', () => {
  // DISTINCT stubs per primitive — findAllByType must not cross-match.
  const stub = () => () => null;
  return {
    __esModule: true,
    Canvas: ({ children }: { children?: unknown }) => children ?? null,
    Group: stub(),
    Circle: stub(),
    Oval: stub(),
    Rect: stub(),
    RoundedRect: stub(),
    Path: stub(),
    Picture: stub(),
    BlurMask: stub(),
    LinearGradient: stub(),
    RadialGradient: stub(),
    vec: (x: number, y: number) => ({ x, y }),
    rect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
    rrect: (r: unknown) => r,
    Skia: {
      Color: (c: unknown) => c,
      Paint: () => ({ setColor: () => {}, setAlphaf: () => {} }),
      Path: {
        Make: () => ({
          moveTo() {},
          lineTo() {},
          close() {},
          addCircle() {},
          addArc() {},
        }),
      },
      XYWHRect: (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h }),
      PictureRecorder: () => ({
        beginRecording: () => ({
          save() {},
          restore() {},
          translate() {},
          rotate() {},
          drawRect() {},
        }),
        finishRecordingAsPicture: () => ({}),
      }),
    },
  };
});

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

// The gateway reads the settings store — stub it so PressScale presses work
// without hydrating zustand persistence.
jest.mock('@/utils/haptics', () => ({
  haptic: { selection: jest.fn(), impactLight: jest.fn(), impactMedium: jest.fn() },
}));

const { WeeklyChallengeSummary } =
  require('@/components/home/WeeklyChallengeSummary') as typeof import('@/components/home/WeeklyChallengeSummary');
const { FirstRunScene } =
  require('@/components/home/FirstRunScene') as typeof import('@/components/home/FirstRunScene');

// ---------------------------------------------------------------------------
// Helpers

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  await act(async () => {});
  return r;
}

async function cleanup(r: ReactTestRenderer): Promise<void> {
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

/** A real pool challenge by id — keeps ids, targets and points honest. */
function def(id: string): WeeklyChallengeDef {
  const found = WEEKLY_CHALLENGE_POOL.find((c) => c.id === id);
  if (!found) throw new Error(`weekly pool has no challenge '${id}'`);
  return found;
}

/** Same trio as weeklyChallengeCard.test.tsx: 120 + 100 + 150 on offer. */
const TRIO = [def('w-makes-150'), def('w-sessions-3'), def('w-spots-5')];
const TRIO_OFFERED = 120 + 100 + 150;

function agg(overrides: Partial<WeekAggregate> = {}): WeekAggregate {
  return { ...emptyWeekAggregate(), ...overrides };
}

// ---------------------------------------------------------------------------
// WeeklyChallengeSummary — the compact weekly deck (separate render path from
// WeeklyChallengeCard, whose pinned suite stays untouched).

describe('WeeklyChallengeSummary', () => {
  it('compacts the deck to one honest row: ★ earned/offered and n/total done', async () => {
    const onPress = jest.fn();
    const r = await render(
      <WeeklyChallengeSummary
        challenges={TRIO}
        // makes and sessions complete, spots at 1/5 → 220 banked, 2/3 done.
        agg={agg({ makes: 150, attempts: 300, sessions: 3, practiceDays: 3, distinctSpots: 1 })}
        onPress={onPress}
      />,
    );
    expect(textOf(r.toJSON())).toContain(`Weekly · ★ 220/${TRIO_OFFERED} · 2/3 done`);
    await cleanup(r);
  });

  it('meters the single aggregate bar with the exact mean of clamped fractions', async () => {
    const r = await render(
      <WeeklyChallengeSummary
        challenges={TRIO}
        agg={agg({ makes: 150, attempts: 300, sessions: 3, practiceDays: 3, distinctSpots: 1 })}
        onPress={jest.fn()}
      />,
    );
    // Host nodes only — RN's View also surfaces a composite wrapper instance.
    const bar = r.root.findAll(
      // Cast per FormStage3D.test idiom: ElementType has no 'View' literal
      // overlap under these React types, but RN host nodes are the string.
      (n) =>
        (n.type as unknown as string) === 'View' &&
        n.props?.accessibilityRole === 'progressbar',
    );
    expect(bar).toHaveLength(1);
    // (150/150 + 3/3 + 1/5) / 3 = 0.7333… → 73. Plain arithmetic on the
    // db-derived numbers — a projection would round differently and fail here.
    expect(bar[0]!.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 73 });
    await cleanup(r);
  });

  it('shows true zeros for an untouched week — never a carried-over number', async () => {
    const r = await render(
      <WeeklyChallengeSummary challenges={TRIO} agg={emptyWeekAggregate()} onPress={jest.fn()} />,
    );
    expect(textOf(r.toJSON())).toContain(`Weekly · ★ 0/${TRIO_OFFERED} · 0/3 done`);
    const bar = r.root.findAll((n) => n.props?.accessibilityRole === 'progressbar')[0]!;
    expect(bar.props.accessibilityValue.now).toBe(0);
    await cleanup(r);
  });

  it('fires onPress from its one accessible button (the parent owns the route)', async () => {
    const onPress = jest.fn();
    const r = await render(
      <WeeklyChallengeSummary challenges={TRIO} agg={emptyWeekAggregate()} onPress={onPress} />,
    );
    const button = r.root.findAll(
      (n) =>
        typeof n.props?.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Weekly challenges') &&
        typeof n.props?.onPress === 'function',
    );
    expect(button.length).toBeGreaterThan(0);
    await act(async () => {
      button[0]!.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    await cleanup(r);
  });

  it('turns the bar make-green only when every challenge is done', async () => {
    const r = await render(
      <WeeklyChallengeSummary
        challenges={TRIO}
        agg={agg({ makes: 900, attempts: 1800, sessions: 11, practiceDays: 7, distinctSpots: 9 })}
        onPress={jest.fn()}
      />,
    );
    expect(textOf(r.toJSON())).toContain(`★ ${TRIO_OFFERED}/${TRIO_OFFERED} · 3/3 done`);
    // The fill color rides an inner view; pin it via the style prop.
    const fills = r.root.findAll(
      (n) =>
        Array.isArray(n.props?.style) &&
        (n.props.style as unknown[]).some(
          (s) =>
            s != null &&
            typeof s === 'object' &&
            (s as { backgroundColor?: string }).backgroundColor === color.make,
        ),
    );
    expect(fills.length).toBeGreaterThan(0);
    await cleanup(r);
  });

  it('renders nothing when no challenges were drawn', async () => {
    const r = await render(
      <WeeklyChallengeSummary challenges={[]} agg={emptyWeekAggregate()} onPress={jest.fn()} />,
    );
    expect(r.toJSON()).toBeNull();
    await cleanup(r);
  });
});

// ---------------------------------------------------------------------------
// FirstRunScene — decorative, static, and numberless by contract.

describe('FirstRunScene', () => {
  it('renders the one line of copy, visibly and as the accessible label', async () => {
    const r = await render(<FirstRunScene width={361} />);
    const copy =
      'Prop your phone up — your makes, misses and FG% land here after your first session.';
    expect(textOf(r.toJSON())).toContain(copy);
    const labelled = r.root.findAll(
      (n) => n.props?.accessible === true && n.props?.accessibilityLabel === copy,
    );
    expect(labelled.length).toBeGreaterThan(0);
    await cleanup(r);
  });

  it('never implies detection happened: no digits, no stats, anywhere', async () => {
    const r = await render(<FirstRunScene width={361} />);
    // 'FG%' names the future metric; an actual digit would be a fabricated stat.
    expect(textOf(r.toJSON())).not.toMatch(/\d/);
    await cleanup(r);
  });

  it('draws the finished static arc — full trim, no draw-in', async () => {
    const r = await render(<FirstRunScene width={361} />);
    const skia = jest.requireMock('@shopify/react-native-skia') as {
      Path: React.ComponentType<unknown>;
    };
    // ArcReveal's double stroke (echo + crisp), both already at trim end 1
    // because the scene passes animate={false}.
    const paths = r.root.findAllByType(skia.Path);
    expect(paths).toHaveLength(2);
    for (const p of paths) {
      expect((p.props as { end: { value: number } }).end.value).toBe(1);
    }
    await cleanup(r);
  });

  it('renders nothing without a measured width', async () => {
    const r = await render(<FirstRunScene width={0} />);
    expect(r.toJSON()).toBeNull();
    await cleanup(r);
  });
});

// ---------------------------------------------------------------------------
// Source pins on the screen itself (Home imports SQLite/VisionCamera, so
// source assertions are the honest level — layoutRhythmContract rationale).

const HOME_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'app', '(tabs)', 'index.tsx'),
  'utf8',
);
/** Line comments stripped, so prose about old behavior can't false-positive. */
const HOME_CODE = HOME_SRC.replace(/\/\/.*$/gm, '');

describe('Home storefront source contracts', () => {
  it('speaks the one loading language: SkeletonCard, never dim text', () => {
    expect(HOME_CODE).not.toContain('Loading…');
    expect(HOME_SRC).toContain('<SkeletonCard lines={2} />');
    // The skeleton keeps the last-session slot's stagger index, so the
    // entrance ladder is unchanged while the card is loading.
    expect(HOME_SRC).toContain('enter(6)');
  });

  it('rolls the payoff numeral and re-rolls only on a genuinely new session', () => {
    expect(HOME_SRC).toContain('MotionStat');
    expect(HOME_SRC).toContain('trigger={lastSession.id}');
  });

  it('renders the recommendation reason verbatim from the core', () => {
    expect(HOME_SRC).toContain('recommendationReason(reco)');
    // The reason lands in JSX as-is — never concatenated into invented copy.
    expect(HOME_SRC).toContain('{recoView.reason}');
  });

  it('deep-links Train with the typed literal — arming stays Train’s contract', () => {
    expect(HOME_SRC).toContain("router.push('/modes')");
  });

  it('keeps the weekly and daily award passes Home-owned while presentation shrinks', () => {
    // Points writes are Home's contract (modes.tsx displays read-only): the
    // compact summary replaced the full card, but both award passes stay.
    expect(HOME_SRC).toContain('awardWeekly(key, r.def.id, r.def.points)');
    expect(HOME_SRC).toContain('award(key, c.id, c.points)');
    expect(HOME_SRC).toContain('WeeklyChallengeSummary');
    expect(HOME_CODE).not.toContain('WeeklyChallengeCard');
  });

  it('draws the hero arc from the canonical motif, not a hand-rolled quadratic', () => {
    expect(HOME_SRC).toContain('arcMotif(width, HERO_HEIGHT)');
    // The exact legacy template the motif replaced (parity pinned by
    // arcReveal.test.ts) must not creep back in.
    expect(HOME_CODE).not.toContain('Q ${width * 0.36}');
  });

  it('keeps the quick-start disclosure honest about reusing the last orientation', () => {
    expect(HOME_SRC).toContain('lastOrient} like last time');
  });

  it('gates the perfect-day burst behind a module-level day stamp', () => {
    expect(HOME_SRC).toContain('perfectDayCelebrated');
    expect(HOME_SRC).toContain('SuccessBurst');
  });
});
