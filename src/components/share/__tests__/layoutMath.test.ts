import { describe, expect, test } from '@jest/globals';

import {
  posterLayout,
  statGridLayout,
  glassPanelRect,
} from '../layoutMath';

// The share canvases are always CARD_W (1080) wide; story/poster are 1920 tall,
// feed/grid 1350. These tests pin the layout MATH (positions given a size) so a
// refactor of the drawing code can't silently move the anchors.
const W = 1080;
const H_STORY = 1920;
const H_FEED = 1350;

describe('posterLayout', () => {
  const L = posterLayout(W, H_STORY);

  test('hero is horizontally centered', () => {
    expect(L.heroCenterX).toBe(W / 2);
  });

  test('hero sits in the lower-middle, below the arc box', () => {
    // Anchor numeral ~66% down.
    expect(L.heroBaselineY).toBeGreaterThan(H_STORY * 0.6);
    expect(L.heroBaselineY).toBeLessThan(H_STORY * 0.72);
    // Arc box is entirely above the hero baseline.
    expect(L.arcBox.y + L.arcBox.height).toBeLessThan(L.heroBaselineY);
  });

  test('header micro-lines stack (eyebrow above date) in the top zone', () => {
    expect(L.eyebrowY).toBeLessThan(L.dateY);
    expect(L.dateY).toBeLessThan(H_STORY * 0.2);
  });

  test('arc box + margins stay inside the canvas', () => {
    expect(L.marginX).toBeGreaterThan(0);
    expect(L.arcBox.x).toBe(L.marginX);
    expect(L.arcBox.x + L.arcBox.width).toBe(W - L.marginX);
  });

  test('watermark sits in the bottom safe area, below the hero label', () => {
    expect(L.watermarkY).toBeGreaterThan(L.heroLabelY);
    expect(L.watermarkY).toBeLessThan(H_STORY);
  });

  test('scales with canvas size (proportional, not fixed px)', () => {
    const tall = posterLayout(W, H_STORY * 2);
    expect(tall.heroBaselineY).toBeCloseTo(L.heroBaselineY * 2, -1);
  });
});

describe('statGridLayout', () => {
  const L = statGridLayout(W, H_FEED);

  test('produces exactly four tiles in a 2×2 grid', () => {
    expect(L.tiles).toHaveLength(4);
    const [tl, tr, bl, br] = L.tiles;
    expect(tl.row).toBe(0);
    expect(tl.col).toBe(0);
    expect(tr.row).toBe(0);
    expect(tr.col).toBe(1);
    expect(bl.row).toBe(1);
    expect(bl.col).toBe(0);
    expect(br.row).toBe(1);
    expect(br.col).toBe(1);
  });

  test('columns align (top/bottom of a column share x) and rows align', () => {
    const [tl, tr, bl, br] = L.tiles;
    expect(tl.x).toBe(bl.x);
    expect(tr.x).toBe(br.x);
    expect(tl.y).toBe(tr.y);
    expect(bl.y).toBe(br.y);
  });

  test('tiles are equal-sized and do not overlap the gutter', () => {
    const [tl, tr, , br] = L.tiles;
    expect(tr.width).toBe(tl.width);
    expect(br.height).toBe(tl.height);
    // Right tile starts after the left tile ends (positive gutter).
    expect(tr.x).toBeGreaterThan(tl.x + tl.width);
  });

  test('grid stays within margins and clears the watermark', () => {
    const [tl, tr, bl, br] = L.tiles;
    expect(tl.x).toBe(L.marginX);
    expect(tr.x + tr.width).toBe(W - L.marginX);
    // Bottom row ends above the watermark.
    const bottom = Math.max(bl.y + bl.height, br.y + br.height);
    expect(bottom).toBeLessThan(L.watermarkY);
  });

  test('header divider sits below the eyebrow/title, above the grid', () => {
    expect(L.header.dividerY).toBeGreaterThan(L.header.titleY);
    expect(L.header.dividerY).toBeLessThan(L.tiles[0].y);
  });
});

describe('glassPanelRect', () => {
  test('pads around the content band and clamps to the canvas', () => {
    const r = glassPanelRect(W, H_STORY, 760, 1338, 60);
    expect(r.x).toBe(60);
    expect(r.width).toBe(W - 120);
    // Panel encloses the content band with vertical padding.
    expect(r.y).toBeLessThan(760);
    expect(r.y + r.height).toBeGreaterThan(1338);
  });

  test('never extends past the top or bottom edges', () => {
    const r = glassPanelRect(W, H_FEED, 5, H_FEED - 2, 40);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.height).toBeLessThanOrEqual(H_FEED);
  });
});
