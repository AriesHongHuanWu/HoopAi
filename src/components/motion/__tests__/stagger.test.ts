/**
 * useCardStagger / useStaggerAt — the canonical stagger contract:
 *   - reduced motion → undefined for EVERY index (Card renders a plain View);
 *   - otherwise FadeInDown.delay(base + i*step).duration(duration) with the
 *     canonical STAGGER_MS/ENTER_MS defaults and per-call opts respected.
 *
 * Reanimated's worklets runtime can't load under jest without native modules,
 * so this test carries a minimal mock: FadeInDown builds a plain inspectable
 * record and useReducedMotion is a controllable jest.fn.
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
  return {
    __esModule: true,
    FadeInDown,
    useReducedMotion: jest.fn(() => false),
  };
});

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { useReducedMotion } from 'react-native-reanimated';

import { ENTER_MS, STAGGER_CAP_INDEX, STAGGER_MS, useCardStagger, useStaggerAt } from '../stagger';

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

/** The mock builder's inspectable shape. */
interface FakeEntering {
  kind: string;
  delayMs: number;
  durationMs: number | undefined;
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
