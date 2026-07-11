import { describe, expect, test } from '@jest/globals';

import { space } from '../../../constants/tokens';
import {
  CARD_BOTTOM_CLAMP,
  cardPosFor,
  HIGHLIGHT_PAD,
  type CardPos,
} from '../coachMarkLayout';

// A phone-ish window with notch + home-indicator insets. The formulas are pure
// arithmetic, so pinning them at one realistic size pins them everywhere.
const WINDOW_H = 800;
const INSET_TOP = 59;
const INSET_BOTTOM = 34;

const rect = (y: number, height: number) => ({ x: 20, y, width: 200, height });

const posFor = (
  r: ReturnType<typeof rect> | undefined,
  placement: 'below' | 'above',
): CardPos | null => cardPosFor(r, placement, WINDOW_H, INSET_TOP, INSET_BOTTOM);

describe('cardPosFor — no target rect', () => {
  test('returns null (caller centers the card) for both placements', () => {
    expect(posFor(undefined, 'below')).toBeNull();
    expect(posFor(undefined, 'above')).toBeNull();
  });
});

describe('cardPosFor — below placement (legacy formula)', () => {
  test('unclamped: card top = rect bottom + highlight pad + gap', () => {
    const r = rect(100, 40);
    expect(posFor(r, 'below')).toEqual({
      top: r.y + r.height + HIGHLIGHT_PAD + space.lg, // 100+40+10+16 = 166
    });
  });

  test('sets only top, never bottom', () => {
    const pos = posFor(rect(100, 40), 'below')!;
    expect(pos.bottom).toBeUndefined();
    expect(typeof pos.top).toBe('number');
  });

  test('clamps at the top: never above insetTop + gap', () => {
    // Raw would be 5+10+10+16 = 41, inside the notch inset.
    expect(posFor(rect(5, 10), 'below')).toEqual({ top: INSET_TOP + space.lg });
  });

  test('clamps at the bottom: never below windowHeight - CARD_BOTTOM_CLAMP', () => {
    // Raw would be 700+60+10+16 = 786, off the bottom of the card budget.
    expect(posFor(rect(700, 60), 'below')).toEqual({
      top: WINDOW_H - CARD_BOTTOM_CLAMP,
    });
  });

  test('honors a larger top inset', () => {
    const tall = cardPosFor(rect(5, 10), 'below', WINDOW_H, 120, INSET_BOTTOM);
    expect(tall).toEqual({ top: 120 + space.lg });
  });
});

describe('cardPosFor — above placement (bottom-anchored targets)', () => {
  test('card bottom = distance from window bottom to rect top + pad + gap', () => {
    const r = rect(650, 80); // e.g. the live bottom action bar
    expect(posFor(r, 'above')).toEqual({
      bottom: WINDOW_H - r.y + HIGHLIGHT_PAD + space.lg, // 800-650+10+16 = 176
    });
  });

  test('sets only bottom, never top', () => {
    const pos = posFor(rect(650, 80), 'above')!;
    expect(pos.top).toBeUndefined();
    expect(typeof pos.bottom).toBe('number');
  });

  test('clamps so the card never sinks below insetBottom + gap', () => {
    // Target hugs the very bottom edge: raw 800-795+10+16 = 31 < 34+16 = 50.
    expect(posFor(rect(795, 5), 'above')).toEqual({
      bottom: INSET_BOTTOM + space.lg,
    });
  });

  test('honors a larger bottom inset', () => {
    const clamped = cardPosFor(rect(795, 5), 'above', WINDOW_H, INSET_TOP, 80);
    expect(clamped).toEqual({ bottom: 80 + space.lg });
  });

  test('card sits fully above the target: bottom offset exceeds the space under the rect top', () => {
    const r = rect(650, 80);
    const pos = posFor(r, 'above')!;
    // bottom > windowHeight - rect.y  ⇔  card bottom edge is above rect top.
    expect(pos.bottom!).toBeGreaterThan(WINDOW_H - r.y);
  });
});

describe('constants', () => {
  test('HIGHLIGHT_PAD stays in sync with the highlight ring (10)', () => {
    expect(HIGHLIGHT_PAD).toBe(10);
  });

  test('CARD_BOTTOM_CLAMP keeps the legacy 260px card budget', () => {
    expect(CARD_BOTTOM_CLAMP).toBe(260);
  });
});
