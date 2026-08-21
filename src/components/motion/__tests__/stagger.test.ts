/**
 * useCardStagger / useStaggerAt / useSkeletonExit — the canonical stagger
 * contract:
 *   - reduced motion → undefined for EVERY index (Card renders a plain View);
 *   - otherwise FadeInDown.delay(base + i*step).duration(duration) with the
 *     canonical STAGGER_MS/ENTER_MS defaults and per-call opts respected;
 *   - the skeleton dissolve is a FadeOut of motion.quick that is REFERENTIALLY
 *     STABLE across re-renders (see its describe for why that is load-bearing).
 *
 * Reanimated's worklets runtime can't load under jest without native modules,
 * so this test carries a minimal mock: the builders make plain inspectable
 * records (a FRESH record per .duration() call, as Reanimated does) and
 * useReducedMotion is a controllable jest.fn.
 */
jest.mock('react-native-reanimated', () => {
  const FadeInDown = {
    delay: (delayMs: number) => ({
      kind: 'FadeInDown',
      delayMs,
      durationMs: undefined as number | undefined,
      duration(ms: number) {
        this.durationMs = ms;
        return this;
      },
    }),
  };
  const FadeOut = {
    duration: (durationMs: number) => ({
      kind: 'FadeOut',
      durationMs,
      reduceMotionMode: undefined as string | undefined,
      reduceMotion(mode: string) {
        this.reduceMotionMode = mode;
        return this;
      },
    }),
  };
  return {
    __esModule: true,
    FadeInDown,
    FadeOut,
    ReduceMotion: { System: 'system' },
    useReducedMotion: jest.fn(() => false),
  };
});

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { useReducedMotion } from 'react-native-reanimated';

import { motion } from '@/constants/tokens';

import {
  ENTER_MS,
  STAGGER_CAP_INDEX,
  STAGGER_MS,
  useCardStagger,
  useSkeletonExit,
  useStaggerAt,
} from '../stagger';

const reducedMock = useReducedMotion as jest.Mock;

/** Minimal renderHook: run a hook inside a probe component. */
function renderHook<T>(useHook: () => T): { current: T } {
  const result = { current: undefined as unknown as T };
  function Probe(): null {
    result.current = useHook();
    return null;
  }
  act(() => {
    renderer.create(React.createElement(Probe));
  });
  return result;
}

/** Re-renderable probe: returns the latest hook value plus a rerender(). */
function renderHookWithRerender<T>(useHook: () => T): {
  result: { current: T };
  rerender: () => void;
} {
  const result = { current: undefined as unknown as T };
  let bump: () => void = () => undefined;
  function Probe(): null {
    const [, setTick] = React.useState(0);
    bump = () => setTick((t) => t + 1);
    result.current = useHook();
    return null;
  }
  act(() => {
    renderer.create(React.createElement(Probe));
  });
  return {
    result,
    rerender: () => {
      act(() => {
        bump();
      });
    },
  };
}

/** The mock builder's inspectable shape. */
interface FakeEntering {
  kind: string;
  delayMs: number;
  durationMs: number | undefined;
}

/** The mock exit builder's inspectable shape. */
interface FakeExiting {
  kind: string;
  durationMs: number;
  reduceMotionMode: string | undefined;
}

beforeEach(() => {
  reducedMock.mockReturnValue(false);
});

describe('useCardStagger', () => {
  it('returns undefined for every index under reduced motion', () => {
    reducedMock.mockReturnValue(true);
    const result = renderHook(() => useCardStagger());
    for (let i = 0; i <= 5; i++) {
      expect(result.current(i)).toBeUndefined();
    }
  });

  it('uses the canonical defaults up to the cap: delay = i * STAGGER_MS', () => {
    const result = renderHook(() => useCardStagger());
    for (let i = 0; i <= STAGGER_CAP_INDEX; i++) {
      const entering = result.current(i) as unknown as FakeEntering;
      expect(entering.kind).toBe('FadeInDown');
      expect(entering.delayMs).toBe(i * STAGGER_MS);
      expect(entering.durationMs).toBe(ENTER_MS);
    }
  });

  it('CAPS the ladder so a long screen does not trickle', () => {
    // WHY: un-capped, Coach (12 cards) and Settings spent most of a second
    // dribbling cards in one at a time AFTER their data had already arrived,
    // which reads as the app being slow rather than choreographed. Everything
    // past the cap shares the last delay so the screen completes together.
    const result = renderHook(() => useCardStagger());
    const capped = (result.current(STAGGER_CAP_INDEX) as unknown as FakeEntering).delayMs;
    for (const i of [STAGGER_CAP_INDEX + 1, 8, 12, 40]) {
      expect((result.current(i) as unknown as FakeEntering).delayMs).toBe(capped);
    }
    // and the whole ladder stays inside a quarter second at the defaults
    expect(capped).toBeLessThanOrEqual(250);
  });

  it('honours an explicit capIndex', () => {
    const result = renderHook(() => useCardStagger({ capIndex: 2 }));
    expect((result.current(2) as unknown as FakeEntering).delayMs).toBe(2 * STAGGER_MS);
    expect((result.current(9) as unknown as FakeEntering).delayMs).toBe(2 * STAGGER_MS);
  });

  it('applies baseDelayMs + i * stepMs and a custom duration', () => {
    const result = renderHook(() =>
      useCardStagger({ baseDelayMs: 200, stepMs: 50, durationMs: 300 }),
    );
    const e0 = result.current(0) as unknown as FakeEntering;
    const e3 = result.current(3) as unknown as FakeEntering;
    expect(e0.delayMs).toBe(200);
    expect(e3.delayMs).toBe(200 + 3 * 50);
    expect(e0.durationMs).toBe(300);
    expect(e3.durationMs).toBe(300);
  });

  it('supports index continuation across sections (modes screen pattern)', () => {
    const result = renderHook(() => useCardStagger({ baseDelayMs: 60, stepMs: 50 }));
    // e.g. GAME_MODES.length + i with GAME_MODES.length = 4, i = 2. Index 6 is
    // past the default cap, so it shares the capped step — the continuation
    // pattern still works, it just stops growing.
    const e = result.current(4 + 2) as unknown as FakeEntering;
    expect(e.delayMs).toBe(60 + STAGGER_CAP_INDEX * 50);
  });
});

describe('useSkeletonExit', () => {
  it('returns undefined under reduced motion (the barrel idiom)', () => {
    reducedMock.mockReturnValue(true);
    const { result } = renderHookWithRerender(() => useSkeletonExit());
    expect(result.current).toBeUndefined();
  });

  it('builds FadeOut at motion.quick and ALSO chains reduceMotion(System)', () => {
    // The second gate covers an OS toggle between the render that captured
    // the builder and the unmount that plays it.
    const { result } = renderHookWithRerender(() => useSkeletonExit());
    const e = result.current as unknown as FakeExiting;
    expect(e.kind).toBe('FadeOut');
    expect(e.durationMs).toBe(motion.quick);
    expect(e.reduceMotionMode).toBe('system');
  });

  it('keeps ONE identity across re-renders', () => {
    // REGRESSION. Unlike `entering`, which Reanimated configures once in
    // componentDidMount, `exiting` is re-configured from componentDidUpdate
    // on every update and bails out on reference equality alone. An
    // unmemoized builder therefore fired a native re-register on every
    // re-render for as long as the skeleton was mounted — and loading
    // screens re-render constantly (filters, paging, the delay timer).
    const { result, rerender } = renderHookWithRerender(() => useSkeletonExit());
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });

  it('rebuilds when the reduced-motion setting itself flips', () => {
    const { result, rerender } = renderHookWithRerender(() => useSkeletonExit());
    expect(result.current).toBeDefined();
    reducedMock.mockReturnValue(true);
    rerender();
    expect(result.current).toBeUndefined();
  });
});

describe('useStaggerAt', () => {
  it('returns undefined under reduced motion', () => {
    reducedMock.mockReturnValue(true);
    const result = renderHook(() => useStaggerAt());
    expect(result.current(0)).toBeUndefined();
    expect(result.current(480)).toBeUndefined();
  });

  it('passes the delay straight through with the canonical duration', () => {
    const result = renderHook(() => useStaggerAt());
    const e = result.current(480) as unknown as FakeEntering;
    expect(e.kind).toBe('FadeInDown');
    expect(e.delayMs).toBe(480);
    expect(e.durationMs).toBe(ENTER_MS);
  });

  it('respects a custom duration', () => {
    const result = renderHook(() => useStaggerAt({ durationMs: 240 }));
    const e = result.current(120) as unknown as FakeEntering;
    expect(e.delayMs).toBe(120);
    expect(e.durationMs).toBe(240);
  });
});
