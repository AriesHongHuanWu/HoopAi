/**
 * WORKLET BOUNDARY — the celebration effects must be serializable to the UI
 * runtime.
 *
 * WHY THIS SUITE EXISTS: the personal-best confetti on the post-session summary
 * took the app down on device while every existing test stayed green. The
 * reason is a failure mode no source-text contract and no ordinary render test
 * can see:
 *
 *   react-native-worklets serializes a worklet by cloning its CLOSURE. Any
 *   captured function that is not itself a worklet is cloned as a REMOTE
 *   FUNCTION, whose entire body on the UI runtime is
 *     throw new Error('[Worklets] Tried to synchronously call a Remote
 *                      Function. Called "<name>" on the UI Runtime.')
 *   (node_modules/react-native-worklets/src/memory/serializable.native.ts ->
 *    cloneNonWorkletFunction, and remoteFunctionUnpacker.native.ts).
 *
 *   Under jest the reanimated mock runs updaters on the JS thread, where the
 *   same call is an ordinary function call and succeeds. So the bug is invisible
 *   to "does it render" — the screen paints, and the throw happens later, on the
 *   UI runtime, where no React error boundary can catch it.
 *
 * These tests RENDER each effect for real, take the worklet the render actually
 * built, and apply the serializer's own rule to its closure — transitively, so a
 * worklet that captures a worklet that captures a plain helper still fails.
 */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks

/** Every worklet the render under test hands to reanimated. */
const workletsBuilt: unknown[] = [];

jest.mock('react-native-reanimated', () => {
  const RN = require('react-native');
  const record = (fn: unknown) => {
    workletsBuilt.push(fn);
    return fn;
  };
  return {
    __esModule: true,
    default: {
      View: RN.View,
      createAnimatedComponent: (c: unknown) => c,
    },
    useReducedMotion: () => false,
    useSharedValue: (value: unknown) => ({ value }),
    useDerivedValue: (fn: () => unknown) => {
      record(fn);
      return { value: fn() };
    },
    useAnimatedStyle: (fn: () => unknown) => {
      record(fn);
      return {};
    },
    useAnimatedProps: (fn: () => unknown) => {
      record(fn);
      return {};
    },
    withTiming: (v: unknown) => v,
    withDelay: (_d: number, v: unknown) => v,
    withRepeat: (v: unknown) => v,
    cancelAnimation: () => {},
    Easing: {
      linear: (t: number) => t,
      ease: (t: number) => t,
      out: (fn: unknown) => fn,
      in: (fn: unknown) => fn,
      inOut: (fn: unknown) => fn,
    },
  };
});

jest.mock('@shopify/react-native-skia', () => {
  const stub = () => null;
  return {
    __esModule: true,
    Canvas: stub,
    Picture: stub,
    Group: stub,
    Circle: stub,
    Rect: stub,
    Skia: {
      Color: (c: unknown) => c,
      Paint: () => ({ setColor: () => {}, setAlphaf: () => {} }),
      XYWHRect: (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h }),
      PictureRecorder: () => ({
        beginRecording: () => ({
          save() {}, restore() {}, translate() {}, rotate() {}, drawRect() {}, drawCircle() {},
        }),
        finishRecordingAsPicture: () => ({}),
      }),
    },
  };
});

import { Confetti } from '../Confetti';
import { FlameLicks } from '../FlameLicks';
import { SuccessBurst } from '@/components/motion/SuccessBurst';

// ---------------------------------------------------------------------------
// The serializer's rule, applied to a worklet the render actually produced.

/** Mirrors react-native-worklets `isWorkletFunction`. */
function isWorklet(value: unknown): boolean {
  return typeof value === 'function' && !!(value as { __workletHash?: number }).__workletHash;
}

/**
 * Walk a worklet's captured closure the way `makeShareableCloneRecursive` does
 * and throw the error the UI runtime would throw, naming the offending symbol
 * and the capture path that reaches it.
 */
function assertSerializableToUiRuntime(
  worklet: unknown,
  path: string,
  seen: Set<unknown> = new Set(),
): void {
  const closure = (worklet as { __closure?: Record<string, unknown> }).__closure;
  if (closure == null) return;
  for (const [name, captured] of Object.entries(closure)) {
    // Only FUNCTIONS cross the worklet boundary as remote stubs. Plain data,
    // host objects (Skia) and shared values clone by value/reference.
    if (typeof captured !== 'function') continue;
    if (!isWorklet(captured)) {
      throw new Error(
        `[Worklets] Tried to synchronously call a Remote Function. Called "${name}" on the UI Runtime.\n` +
          `  captured by: ${path}\n` +
          `  fix: give ${name}() a 'worklet' directive, or stop calling it from a worklet.`,
      );
    }
    if (seen.has(captured)) continue;
    seen.add(captured);
    assertSerializableToUiRuntime(captured, `${path} -> ${name}`, seen);
  }
}

/** Render, then push a real layout through so the particle field is spawned. */
function renderWithLayout(el: React.ReactElement): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  act(() => {
    for (const node of r.root.findAll((n) => typeof n.props.onLayout === 'function')) {
      node.props.onLayout({ nativeEvent: { layout: { width: 390, height: 844, x: 0, y: 0 } } });
    }
  });
  return r;
}

beforeEach(() => {
  workletsBuilt.length = 0;
});

describe('celebration effects survive the trip to the UI runtime', () => {
  it('Confetti — the personal-best burst the summary screen fires', () => {
    const r = renderWithLayout(<Confetti trigger={42} seed={42} />);
    // The render really built the per-frame picture worklet.
    expect(workletsBuilt.length).toBeGreaterThan(0);
    expect(workletsBuilt.some((w) => (w as { __workletHash?: number }).__workletHash != null)).toBe(
      true,
    );
    for (const [i, w] of workletsBuilt.entries()) {
      assertSerializableToUiRuntime(w, `Confetti worklet #${i}`);
    }
    act(() => {
      r.unmount();
    });
  });

  it('SuccessBurst — the shared make celebration', () => {
    const r = renderWithLayout(<SuccessBurst trigger={7} seed={3} pieces={16} />);
    for (const [i, w] of workletsBuilt.entries()) {
      assertSerializableToUiRuntime(w, `SuccessBurst worklet #${i}`);
    }
    act(() => {
      r.unmount();
    });
  });

  it('FlameLicks — the tier-3 streak layer on the live HUD', () => {
    const r = renderWithLayout(<FlameLicks trigger={9} />);
    for (const [i, w] of workletsBuilt.entries()) {
      assertSerializableToUiRuntime(w, `FlameLicks worklet #${i}`);
    }
    act(() => {
      r.unmount();
    });
  });

  it('the particle evaluator itself is a worklet, with its whole call chain', () => {
    // The rule this file exists to keep: a caller marking ITSELF a worklet does
    // not workletize an imported callee, so the evaluator and everything it
    // reaches must carry the directive on its own.
    const particles = require('../particles') as Record<string, unknown>;
    for (const name of ['particleState', 'lifeAlpha', 'smoothstep']) {
      expect(`${name}:${isWorklet(particles[name])}`).toBe(`${name}:true`);
    }
    // The spawners deliberately stay plain JS — they run once in useMemo on the
    // JS thread and never cross the boundary.
    expect(isWorklet(particles.spawnConfetti)).toBe(false);
    expect(isWorklet(particles.spawnFlames)).toBe(false);
  });
});
