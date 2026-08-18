/**
 * BodyDirectionCard render contract — the headline feature's honesty seams.
 *
 * WHY these three cases and not more: the card's whole job is to render what
 * src/core/bodyArchetype.ts actually returned, and to say so when it returned
 * nothing. So every assertion here is written against the REAL core output
 * (bodyPlan is imported, never stubbed) rather than against copy this test
 * baked in — a change in the core that silently drifts from the UI fails here.
 *
 *  1. A tall, long-levered profile renders the direction: label, closest
 *     measured frame, the play[]/avoid[] directives, the earned practice
 *     distance band, and the core's own summary.
 *  2. Height missing ⇒ NO direction is invented: the card becomes an invite
 *     that routes to the profile tab.
 *  3. Confidence is printed verbatim. StyleDirection['confidence'] has no
 *     'high' member, so every line of rendered copy that mentions confidence
 *     must carry exactly the word the core returned — checked for both the
 *     'medium' (wingspan known) and 'low' (wingspan missing) paths.
 *
 * Mock set follows src/__tests__/app/wiCDataScreens.test.tsx (reanimated /
 * icons / router / safe-area), plus the in-memory kv-store the state-store
 * tests use so the REAL profile store drives the card.
 */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks

// Reanimated's worklets runtime can't load under jest without native modules.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (component: unknown) => component,
  },
  FadeIn: { duration: () => ({}) },
  FadeInDown: { duration: () => ({ delay: () => ({}) }) },
  LinearTransition: { duration: () => ({}) },
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// The single settings-gated haptics gateway (never expo-haptics directly).
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

// Persistence is zustand middleware, not under test — same in-memory map the
// profileStore tests use, so the real store (and its selectors) run here.
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

import { BodyDirectionCard } from '@/components/BodyDirectionCard';
import { bodyPlan, RANGE_MIN_ATTEMPTS } from '@/core/bodyArchetype';
import type { ResolvedShot, ShotOutcome } from '@/core/types';
import { useProfile } from '@/state/profileStore';

const routerMod = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
const hapticsMod = jest.requireMock('@/utils/haptics') as {
  haptic: Record<string, jest.Mock>;
};

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

type Json = ReturnType<ReactTestRenderer['toJSON']>;

/** Every rendered string, individually (so one line can be checked alone). */
function stringsOf(json: Json): string[] {
  if (json == null) return [];
  if (Array.isArray(json)) return json.flatMap(stringsOf);
  const kids = json.children ?? [];
  return kids.flatMap((k) => (typeof k === 'string' ? [k] : stringsOf(k)));
}

/** Flattened copy for "does this appear anywhere" assertions. */
function textOf(json: Json): string {
  return stringsOf(json).join(' ');
}

/**
 * A decided shot at a known metric distance. originX 0.5 + shotValue 2 put it
 * in the heat map's center/mid cell, which is what feeds makePctByBand.
 */
function shot(id: number, outcome: ShotOutcome, distanceM: number): ResolvedShot {
  return {
    id,
    tStart: id,
    tResolved: id + 0.8,
    outcome,
    signals: { geo: null, net: null, cls: null },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: null,
    releaseAngleDeg: null,
    releasePoint: null,
    originX: 0.5,
    originY: 0.8,
    trajectory: [],
    shotValue: 2,
    distanceM,
  };
}

/** Enough decided attempts (half made) at a 5 m median to earn a band. */
function loggedShots(): ResolvedShot[] {
  const n = RANGE_MIN_ATTEMPTS + 4;
  return Array.from({ length: n }, (_, i) => shot(i + 1, i % 2 === 0 ? 'make' : 'miss', 5));
}

/** A tall, long-levered frame: 203 cm with a 218 cm wingspan (ratio ≈ 1.074). */
const TALL_LONG = { heightCm: 203, wingspanCm: 218, weightKg: 95, birthYear: 2000 };
const TALL_LONG_AGE = new Date().getFullYear() - 2000;

const initialProfile = useProfile.getState();

beforeEach(() => {
  act(() => {
    useProfile.getState().reset();
  });
  routerMod.router.push.mockClear();
  Object.values(hapticsMod.haptic).forEach((fn) => fn.mockClear());
});

afterAll(() => {
  act(() => {
    useProfile.setState(initialProfile, true);
  });
});

// ---------------------------------------------------------------------------

describe('BodyDirectionCard — direction half', () => {
  it('renders the core direction for a tall, long-levered profile', async () => {
    useProfile.setState(TALL_LONG);
    const shots = loggedShots();
    const r = await render(<BodyDirectionCard shots={shots} />);
    const text = textOf(r.toJSON());

    // The card must show what the core produced for exactly this input.
    const plan = bodyPlan(
      { heightCm: 203, wingspanCm: 218, weightKg: 95, ageYears: TALL_LONG_AGE },
      {
        medianDistanceM: 5,
        makePctByBand: [{ band: 'mid', pct: 50, attempts: shots.length }],
      },
    );
    const direction = plan.direction!;
    expect(direction).not.toBeNull();

    expect(text).toContain(direction.label);
    expect(text).toContain(direction.archetype);
    expect(text).toContain('Closest measured frame');
    for (const line of direction.play) expect(text).toContain(line);
    for (const line of direction.avoid) expect(text).toContain(line);

    // Distance half is earned here, and prints the core's band verbatim.
    const [lo, hi] = plan.range!.recommendedBandM;
    expect(text).toContain(`${lo}–${hi} m`);
    expect(text).toContain(plan.range!.rationale);

    // And the card never dresses the reference set up as a personal model.
    expect(text).toMatch(/published pro measurements/i);
    await act(async () => {
      r.unmount();
    });
  });

  it('renders the direction alone and names the missing half with no shots', async () => {
    useProfile.setState(TALL_LONG);
    const r = await render(<BodyDirectionCard shots={[]} />);
    const text = textOf(r.toJSON());

    const plan = bodyPlan(
      { heightCm: 203, wingspanCm: 218, weightKg: 95, ageYears: TALL_LONG_AGE },
      { medianDistanceM: null, makePctByBand: [] },
    );
    expect(plan.direction).not.toBeNull();
    expect(plan.range).toBeNull();

    expect(text).toContain(plan.direction!.label);
    // Honest partial state: says which half is missing, invents no band.
    expect(text).toMatch(/Distance half/i);
    expect(text).toContain('no honest distance recommendation yet');
    expect(text).not.toMatch(/practice band \(your shots\)/i);
    await act(async () => {
      r.unmount();
    });
  });
});

describe('BodyDirectionCard — height missing', () => {
  it('invites the user to the profile instead of guessing a direction', async () => {
    useProfile.setState({ heightCm: null, wingspanCm: null });
    const r = await render(<BodyDirectionCard shots={[]} />);
    const text = textOf(r.toJSON());

    expect(bodyPlan({ heightCm: null, wingspanCm: null }, { medianDistanceM: null }).direction)
      .toBeNull();

    expect(text).toMatch(/Add your height/i);
    expect(text).not.toContain('Closest measured frame');
    // No direction ⇒ no confidence claim of any kind.
    expect(text).not.toMatch(/confidence/i);

    const button = r.root.findAll(
      (n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function',
    )[0];
    expect(button).toBeDefined();
    await act(async () => {
      button.props.onPress();
    });
    expect(routerMod.router.push).toHaveBeenCalledWith('/profile');
    expect(hapticsMod.haptic.selection).toHaveBeenCalledTimes(1);
    await act(async () => {
      r.unmount();
    });
  });
});

describe('BodyDirectionCard — confidence copy', () => {
  /** Every rendered line that talks about confidence, for verbatim checking. */
  function confidenceLines(r: ReactTestRenderer): string[] {
    return stringsOf(r.toJSON()).filter((s) => /confiden/i.test(s));
  }

  it("prints the core's 'medium' verbatim when the wingspan ratio is usable", async () => {
    useProfile.setState(TALL_LONG);
    const expected = bodyPlan(
      { heightCm: 203, wingspanCm: 218, ageYears: TALL_LONG_AGE },
      { medianDistanceM: null },
    ).direction!.confidence;
    expect(expected).toBe('medium');

    const r = await render(<BodyDirectionCard shots={loggedShots()} />);
    const lines = confidenceLines(r);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain(expected);
      // The type has no 'high' member — the UI must never coin one.
      expect(line).not.toMatch(/\bhigh\b|\bcertain|guarantee/i);
    }
    expect(textOf(r.toJSON())).not.toMatch(/high[- ]confidence/i);
    await act(async () => {
      r.unmount();
    });
  });

  it("drops to the core's 'low' when the wingspan is unset", async () => {
    useProfile.setState({ heightCm: 203, wingspanCm: null, birthYear: 2000 });
    const expected = bodyPlan({ heightCm: 203, wingspanCm: null }, { medianDistanceM: null })
      .direction!.confidence;
    expect(expected).toBe('low');

    const r = await render(<BodyDirectionCard shots={[]} />);
    const lines = confidenceLines(r);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain('low');
      expect(line).not.toMatch(/\bmedium\b|\bhigh\b|\bcertain|guarantee/i);
    }
    await act(async () => {
      r.unmount();
    });
  });
});
