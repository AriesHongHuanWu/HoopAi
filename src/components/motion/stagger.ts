/**
 * stagger — the ONE canonical card-entrance stagger for every screen.
 *
 * Screens today hand-roll `FadeInDown.delay(i * 40..70).duration(260..420)`
 * with drifting constants and (sometimes) a missing reduced-motion gate. This
 * hook standardizes both:
 *   - one step (STAGGER_MS) and one duration (ENTER_MS) app-wide;
 *   - the single reduced-motion idiom this feature enforces: return
 *     `undefined` when the OS asks for reduced motion, which exactly matches
 *     Card's optional `entering?:` contract (Card renders a plain View).
 *
 * Never use `.reduceMotion(ReduceMotion.System)` here — undefined-under-
 * reduced is the idiom, so a gated call site can never half-animate.
 */
import { useCallback } from 'react';
import type React from 'react';
import type Animated from 'react-native-reanimated';
import { FadeInDown, useReducedMotion } from 'react-native-reanimated';

/** The type Card (and Animated.View) accepts for its `entering` prop. */
export type EnteringProp = React.ComponentProps<typeof Animated.View>['entering'];

/** Canonical per-card stagger step (ms). */
export const STAGGER_MS = 60;
/** Canonical card entrance duration (ms). */
export const ENTER_MS = 360;
/**
 * Default {@link CardStaggerOpts.capIndex}. 4 steps x 60 ms = a 240 ms ladder:
 * long enough to read as choreography, short enough that the screen is whole
 * before the user's thumb has finished travelling.
 */
export const STAGGER_CAP_INDEX = 4;

export interface CardStaggerOpts {
  /**
   * Delay added before the whole run (ms). Default 0. Home passes its
   * boot-intro delay here; it may change between renders, so it is read
   * fresh by the returned closure (the closure is re-memoized on change).
   */
  baseDelayMs?: number;
  /**
   * Index past which the delay stops growing. Default
   * {@link STAGGER_CAP_INDEX}. Keeps a long screen from trickling.
   */
  capIndex?: number;
  /** Per-index step (ms). Default {@link STAGGER_MS}. */
  stepMs?: number;
  /** Entrance duration (ms). Default {@link ENTER_MS}. */
  durationMs?: number;
}

/**
 * useCardStagger — returns `(i) => entering` for the i-th card on a screen.
 * Under reduced motion it returns `undefined` for every index (cards render
 * static); otherwise `FadeInDown.delay(base + i * step).duration(duration)`.
 */
export function useCardStagger(opts?: CardStaggerOpts): (i: number) => EnteringProp | undefined {
  const reduced = useReducedMotion();
  const baseDelayMs = opts?.baseDelayMs ?? 0;
  const stepMs = opts?.stepMs ?? STAGGER_MS;
  const durationMs = opts?.durationMs ?? ENTER_MS;
  const capIndex = opts?.capIndex ?? STAGGER_CAP_INDEX;

  return useCallback(
    (i: number) => {
      if (reduced) return undefined;
      // CAP the ladder. Un-capped, a 12-card screen (Coach, Settings) spends
      // most of a second dribbling cards in one at a time AFTER the data has
      // already arrived, which reads as the app being slow rather than
      // choreographed. Past a few steps the eye stops reading a sequence
      // anyway, so every card from capIndex on shares the last delay and the
      // screen finishes together.
      return FadeInDown.delay(baseDelayMs + Math.min(i, capIndex) * stepMs).duration(durationMs);
    },
    [reduced, baseDelayMs, stepMs, durationMs, capIndex],
  );
}

/**
 * useStaggerAt — the escape hatch for screens whose delays aren't a simple
 * index ladder (e.g. section offsets computed elsewhere). Same reduced-motion
 * gate, but the caller passes the absolute delay directly.
 */
export function useStaggerAt(opts?: {
  durationMs?: number;
}): (delayMs: number) => EnteringProp | undefined {
  const reduced = useReducedMotion();
  const durationMs = opts?.durationMs ?? ENTER_MS;

  return useCallback(
    (delayMs: number) => {
      if (reduced) return undefined;
      return FadeInDown.delay(delayMs).duration(durationMs);
    },
    [reduced, durationMs],
  );
}
