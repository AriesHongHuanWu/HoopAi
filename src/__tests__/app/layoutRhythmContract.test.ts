/**
 * Layout-rhythm + type-scale contracts.
 *
 * The four-lens polish audit found the app tightening under the user's thumb:
 * Coach and Profile stacked their top-level cards on space.lg while Home and
 * Records used space.xl, so the 140 ms tab cross-fade showed two different
 * grids and the page visibly compressed mid-swipe. The same drift had happened
 * to type — three screens each re-declared an 18 px card heading with line
 * heights of 24 / 25 / 22, and two re-declared a 22 px stat numeral.
 *
 * These pins exist because BOTH failures are invisible in review: nothing
 * breaks, the screen just stops feeling like one app. Source-level assertions
 * (same idiom as summaryScreenContract.test.ts) because these screens pull in
 * SQLite, VisionCamera and Skia, so rendering them under jest is not honest
 * coverage.
 *
 * If one of these goes red: do NOT relax the assertion. Either the screen went
 * back to a hand-picked value (fix the screen) or the shared rhythm genuinely
 * moved (move it in constants/tokens.ts, and every screen follows for free).
 */
import * as fs from 'fs';
import * as path from 'path';

import { layout, space, type } from '@/constants/tokens';

const APP = path.join(__dirname, '..', '..', 'app');
const SRC = path.join(__dirname, '..', '..');

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(APP, ...parts), 'utf8');

/** For pins that reach outside app/ (the shared kit). */
const readSrc = (...parts: string[]): string =>
  fs.readFileSync(path.join(SRC, ...parts), 'utf8');

/**
 * Line comments stripped. These files DOCUMENT the values they no longer use
 * ("no paddingBottom here — Screen already tails the scroll"), so a structural
 * regex run over raw source matches the explanation and reports the very thing
 * that was fixed.
 */
const code = (src: string): string => src.replace(/\/\/.*$/gm, '');

/** Every screen whose top-level stack must breathe on the SAME grid. */
const RHYTHM_SCREENS: readonly [name: string, src: string][] = [
  // Home joined the pin in the storefront wave: its stack already sat on the
  // space.xl grid but hand-picked the value, so a future rhythm move in
  // tokens.ts would have silently left the FIRST tab behind. Deliberate
  // tightening owned by the home package — styles.stack now pulls
  // layout.sectionGap like every sibling below.
  ['home', read('(tabs)', 'index.tsx')],
  ['coach', read('(tabs)', 'coach.tsx')],
  ['profile', read('(tabs)', 'profile.tsx')],
  ['jump', read('jump.tsx')],
  ['trends', read('trends.tsx')],
  ['records', read('records.tsx')],
];

describe('layout rhythm tokens', () => {
  it('exposes the three rhythm steps, drawn from the 4pt space scale', () => {
    expect(layout.sectionGap).toBe(space.xl);
    expect(layout.cardGap).toBe(space.lg);
    // Mirrors `card` padding in components/ui.tsx — a card's inside and the
    // gap between cards must not be picked independently.
    expect(layout.cardPadding).toBe(space.lg);
  });

  it('keeps sections looser than the items inside them', () => {
    expect(layout.sectionGap).toBeGreaterThan(layout.cardGap);
  });
});

describe('screens pull the shared rhythm rather than picking their own', () => {
  for (const [name, src] of RHYTHM_SCREENS) {
    it(`${name} stacks on layout.sectionGap`, () => {
      expect(src).toContain('layout.sectionGap');
    });

    it(`${name} never hand-picks a top-level stack gap`, () => {
      // The exact regression: `stack: { gap: space.lg }` on a tab that sits
      // beside a space.xl tab.
      expect(code(src)).not.toMatch(/stack:\s*\{[^}]*\bgap:\s*space\./s);
    });
  }

  it('no screen re-adds a bottom pad that Screen already provides', () => {
    // components/ui.tsx Screen tails its ScrollView with
    // insets.bottom + space.xxl; a local paddingBottom stacks a second dead
    // gap above the tab bar and desynchronises scroll ends between tabs.
    for (const [name, src] of RHYTHM_SCREENS) {
      expect([name, /stack:\s*\{[^}]*paddingBottom/s.test(code(src))]).toEqual([name, false]);
    }
  });
});

describe('type scale covers the steps screens were re-inventing', () => {
  it('has a card-leading heading step', () => {
    expect(type.headingLarge.fontSize).toBe(18);
    expect(type.headingLarge.lineHeight).toBe(24);
    // One step above the sub-block heading, same face — it is a rank, not a
    // different voice.
    expect(type.headingLarge.fontSize).toBeGreaterThan(type.heading.fontSize);
    expect(type.headingLarge.fontFamily).toBe(type.heading.fontFamily);
  });

  it('has a dense-grid numeral step below statMedium', () => {
    expect(type.statSmall.fontSize).toBe(22);
    expect(type.statSmall.fontSize).toBeLessThan(type.statMedium.fontSize);
    // Broadcast display face, like every other numeral step.
    expect(type.statSmall.fontFamily).toBe(type.statMedium.fontFamily);
  });

  it('keeps the numeral ladder strictly descending', () => {
    const ladder = [
      type.scoreboard.fontSize,
      type.statLarge.fontSize,
      type.statMedium.fontSize,
      type.statSmall.fontSize,
    ];
    expect(ladder).toEqual([...ladder].sort((a, b) => b - a));
  });
});

describe('owned screens honour the scale instead of overriding it', () => {
  const SCALED: readonly [name: string, src: string][] = [
    ['coach', read('(tabs)', 'coach.tsx')],
    ['jump', read('jump.tsx')],
  ];

  for (const [name, src] of SCALED) {
    it(`${name} spreads a type step without patching its fontSize`, () => {
      // e.g. `...type.heading, fontSize: 18` — the exact drift that produced
      // three different line heights for one rank of text.
      expect(code(src)).not.toMatch(/\.\.\.type\.\w+,\s*\n\s*fontSize:/);
    });
  }
});

describe('status tints are one value per status', () => {
  it('the amber caution fill is the token, never a local alpha', () => {
    // jump.tsx used rgba(232,184,79,0.10) while the shared Chip used 0.14, so
    // the identical warning read weaker in Jump Lab than anywhere else. The
    // kit and the licenses screen carried the same literal at 0.14 — now that
    // all three pull the token, none of them may re-inline the alpha.
    const sources: readonly [name: string, src: string][] = [
      ['jump', read('jump.tsx')],
      ['ui kit', readSrc('components', 'ui.tsx')],
      ['licenses', read('legal', 'licenses.tsx')],
    ];
    for (const [name, src] of sources) {
      expect([name, /rgba\(\s*232\s*,\s*184\s*,\s*79/.test(code(src))]).toEqual([name, false]);
      expect([name, src.includes('color.unsureTint')]).toEqual([name, true]);
    }
  });

  it('coach carries no raw accent/miss rgba edges', () => {
    const src = read('(tabs)', 'coach.tsx');
    expect(code(src)).not.toMatch(/rgba\(\s*240\s*,\s*90\s*,\s*36/);
    expect(code(src)).not.toMatch(/rgba\(\s*232\s*,\s*87\s*,\s*79/);
  });
});

describe('hierarchy: each flat card stack gets one entry point', () => {
  it('Coach raises the weekly hero above its eight sibling cards', () => {
    const src = read('(tabs)', 'coach.tsx');
    // Attribute order/wrapping is prettier's business; what matters is that
    // exactly one Card on this screen wears the hero style.
    expect(src).toMatch(/<Card[^>]*style=\{styles\.heroCard\}/s);
    expect(src.match(/style=\{styles\.heroCard\}/g)).toHaveLength(1);
    expect(src).toMatch(/heroCard:\s*\{[^}]*backgroundColor:\s*color\.surfaceRaised/s);
    expect(src).toMatch(/heroCard:\s*\{[^}]*borderColor:\s*color\.accentEdge/s);
  });

  it('Profile lifts the player card above its five identical cards', () => {
    const src = read('(tabs)', 'profile.tsx');
    // Deliberately `surface`, not surfaceRaised — the header holds a
    // default-tone Chip whose own ground is surfaceRaised. The accent edge is
    // what carries the emphasis, so THAT is the load-bearing pin.
    expect(src).toMatch(/\n {2}header:\s*\{[^}]*backgroundColor:\s*color\.surface,/s);
    expect(src).toMatch(/\n {2}header:\s*\{[^}]*borderColor:\s*color\.accentEdge/s);
    expect(src).toMatch(/\n {2}header:\s*\{[^}]*borderWidth:\s*1,/s);
  });

  it('the raised Coach hero does not swallow the receipt tiles inside it', () => {
    // Regression guard: the receipts used to BE surfaceRaised, which is now
    // the hero card's own ground.
    const src = read('(tabs)', 'coach.tsx');
    expect(src).not.toMatch(/\n {2}receipt:\s*\{[^}]*backgroundColor:\s*color\.surfaceRaised/s);
  });
});
