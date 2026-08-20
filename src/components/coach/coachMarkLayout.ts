/**
 * coachMarkLayout — pure card-position math for the CoachMarks walkthrough.
 *
 * Extracted from CoachMarks.tsx so the placement formulas can be unit-tested
 * without mounting React Native. Everything here is arithmetic on numbers; the
 * only imports are design tokens (pure constants) and a type-only React Native
 * import that is erased at compile time.
 *
 * Coordinate space: screen/window coordinates, origin top-left, +y DOWN — the
 * same space `measureInWindow` reports target rects in.
 */
import type { LayoutRectangle } from 'react-native';

import { space } from '../../constants/tokens';

/**
 * Padding between a target rect and its highlight ring. Single source of
 * truth — CoachMarks re-imports this for the ring geometry so the card gap
 * and the ring can never drift apart.
 */
export const HIGHLIGHT_PAD = 10;

/**
 * Keeps a below-placed card's top edge at least this far above the window
 * bottom so the card body and its buttons stay reachable. Matches the
 * long-standing clamp in CoachMarks (card height budget, pre-extraction).
 */
export const CARD_BOTTOM_CLAMP = 260;

/**
 * Absolute-position style fragment for the coach card. Exactly one of
 * top/bottom is set; spread into `{ position: 'absolute', left, right }`.
 */
export interface CardPos {
  top?: number;
  bottom?: number;
}

/**
 * Card position for one step.
 *
 * - `null` — no target rect: caller should center the card instead.
 * - 'below' (default behavior pre-extraction): card top sits just under the
 *   highlight ring, clamped inside [insetTop + gap, windowHeight - 260].
 * - 'above': card bottom sits just over the highlight ring — for targets
 *   anchored to the bottom of the screen (e.g. the live action bar) — clamped
 *   so it never sinks below the bottom safe-area inset.
 */
export function cardPosFor(
  rect: LayoutRectangle | undefined,
  placement: 'below' | 'above',
  windowHeight: number,
  insetTop: number,
  insetBottom: number,
): CardPos | null {
  if (rect == null) return null;

  if (placement === 'above') {
    return {
      bottom: Math.max(
        windowHeight - rect.y + HIGHLIGHT_PAD + space.lg,
        insetBottom + space.lg,
      ),
    };
  }

  return {
    top: Math.min(
      Math.max(rect.y + rect.height + HIGHLIGHT_PAD + space.lg, insetTop + space.lg),
      windowHeight - CARD_BOTTOM_CLAMP,
    ),
  };
}
