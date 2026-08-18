/**
 * BootIntro timing contract — the cold-start beat, retimed.
 *
 * The intro was holding a finished brand frame for ~350 ms after the wordmark
 * had already settled, which is time the user spends looking at a screen they
 * did not ask for. This pins the shortened ladder AND the reason it is still
 * allowed to exist: the wordmark must be fully settled BEFORE the cover starts
 * lifting, otherwise the brand beat stops reading and the intro is pure cost.
 *
 * Also pins the two invariants that keep the intro honest:
 * - it anchors Home's card stagger (bootIntroDelayMs === REVEAL_AT_MS), and
 * - it plays ONCE per process, so later Home mounts stagger immediately.
 *
 * NOTE: assertions run in declaration order on purpose — the "plays once"
 * latch is module state, so everything that needs the un-played value has to
 * come before the render.
 */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks

/** Every withDelay(ms, ...) the intro schedules, in call order. */
const mockDelays: number[] = [];
/** Every withTiming(to, { duration }) the intro schedules, in call order. */
const mockTimings: { to: unknown; duration?: number }[] = [];

// Reanimated's worklets runtime can't load under jest without native modules.
// withDelay/withTiming stay recorders — the schedule IS the contract here.
jest.mock('react-native-reanimated', () => {
  const passthroughEasing = (fn: unknown) => fn;
  return {
    __esModule: true,
    default: {
      View: require('react-native').View,
      createAnimatedComponent: (component: unknown) => component,
    },
    Easing: {
      in: passthroughEasing,
      out: passthroughEasing,
      inOut: passthroughEasing,
      cubic: 'cubic',
      quad: 'quad',
      linear: 'linear',
    },
    runOnJS: (fn: unknown) => fn,
    useAnimatedStyle: () => ({}),
    useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
    useReducedMotion: () => false,
    useSharedValue: (value: unknown) => ({ value }),
    withDelay: (ms: number, value: unknown) => {
      mockDelays.push(ms);
      return value;
    },
    withSequence: (first: unknown) => first,
    withTiming: (to: unknown, config?: { duration?: number }) => {
      mockTimings.push({ to, duration: config?.duration });
      return to;
    },
  };
});

// The arc/ball/halo are a Skia canvas; the beat schedule is what's asserted.
jest.mock('@shopify/react-native-skia', () => ({
  Canvas: () => null,
  Circle: () => null,
  Path: () => null,
}));

import { BootIntro, bootIntroDelayMs } from '../BootIntro';

/** The retimed reveal (was 1150). Home's stagger anchors to this exact value. */
const REVEAL_AT_MS = 820;

type Json = ReturnType<ReactTestRenderer['toJSON']>;

/** Flatten every rendered string for "does this copy appear" assertions. */
function textOf(json: Json): string {
  if (json == null) return '';
  if (Array.isArray(json)) return json.map(textOf).join(' ');
  const kids = json.children ?? [];
  return kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join(' ');
}

// ---------------------------------------------------------------------------

describe('BootIntro', () => {
  it('anchors Home to the shortened reveal, and to nothing under reduced motion', () => {
    expect(bootIntroDelayMs(false)).toBe(REVEAL_AT_MS);
    expect(bootIntroDelayMs(true)).toBe(0);
  });

  it('renders the wordmark and schedules the retimed beats: flight 480, reveal 820', () => {
    let r!: ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(<BootIntro />);
    });

    // The brand still shows up — this is a shortened beat, not a deleted one.
    expect(textOf(r.toJSON())).toContain('HOOP');

    // Flight starts at 120 and lands 480 ms later; the halo pops 60 ms early
    // so the rim reads as reacting to the shot, not reporting it.
    expect(mockDelays).toEqual(expect.arrayContaining([120, 540, 260, REVEAL_AT_MS]));
    expect(mockTimings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: 1, duration: 480 }), // flight
        expect.objectContaining({ to: 1, duration: 360 }), // wordmark opacity
        expect.objectContaining({ to: 0, duration: 380 }), // cover lift
      ]),
    );

    act(() => {
      r.unmount();
    });
  });

  it('still lets the brand beat land before the cover lifts', () => {
    // Derived from the schedule the component actually recorded above, so
    // this fails the moment someone shortens the reveal past the story.
    // Order: flight, halo up, halo settle, wordmark opacity, wordmark rise,
    // cover lift.
    const [flightAt, , wordAt] = mockDelays;
    const ballLandsAt = flightAt! + mockTimings[0]!.duration!;
    const wordSettledAt = wordAt! + mockTimings[3]!.duration!;

    // The ball must reach the rim, and the wordmark must finish rising,
    // BEFORE the cover starts lifting — otherwise the intro is pure cost on
    // a cold start with no brand beat to show for it.
    expect(ballLandsAt).toBeLessThan(REVEAL_AT_MS);
    expect(wordSettledAt).toBeLessThan(REVEAL_AT_MS);
    // And the finished frame is HELD, not glimpsed.
    expect(REVEAL_AT_MS - wordSettledAt).toBeGreaterThanOrEqual(150);
  });

  it('plays exactly once per process', () => {
    // The mount above flipped the once-per-process latch, so Home's stagger
    // must now start immediately instead of waiting for a reveal that will
    // never come.
    expect(bootIntroDelayMs(false)).toBe(0);

    let r!: ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(<BootIntro />);
    });
    // Second mount renders nothing at all: no cover, no wordmark.
    expect(textOf(r.toJSON())).not.toContain('HOOP');
    act(() => {
      r.unmount();
    });
  });
});
