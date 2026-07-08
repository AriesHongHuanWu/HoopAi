/**
 * layoutMath — pure geometry for the share-card layouts. Everything here takes
 * a canvas size and returns rects/points; NO Skia, NO React. That split lets us
 * snapshot-test the layouts ("given a 1080×1920 canvas, the hero sits here")
 * without mounting a canvas, and keeps the drawing components dumb.
 *
 * Coordinate space matches the cards: CARD_W wide, origin top-left, +y DOWN.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TilePlacement extends Rect {
  /** Row/col in the 2×2 grid, for per-tile accent-bar orientation. */
  row: 0 | 1;
  col: 0 | 1;
}

/**
 * POSTER layout — a full-bleed vertical story built around one giant numeral.
 * The trajectory flourish lives in the upper third; the hero numeral anchors
 * the lower-middle; the watermark lockup sits at the very bottom.
 */
export interface PosterLayout {
  /** Baseline y + centered box for the giant hero numeral. */
  heroBaselineY: number;
  heroCenterX: number;
  /** Box the trajectory arc is fitted into (upper third, inset from edges). */
  arcBox: Rect;
  /** Eyebrow + date micro-line, top-left aligned to the content margin. */
  eyebrowY: number;
  dateY: number;
  heroLabelY: number;
  /** Watermark lockup baseline (wordmark + hook), bottom safe area. */
  watermarkY: number;
  /** Content left/right margins. */
  marginX: number;
}

export function posterLayout(w: number, h: number): PosterLayout {
  const marginX = Math.round(w * 0.093); // ~100 on 1080
  return {
    marginX,
    eyebrowY: Math.round(h * 0.11),
    dateY: Math.round(h * 0.155),
    // Arc lives in the upper-middle band, well clear of the hero below.
    arcBox: {
      x: marginX,
      y: Math.round(h * 0.2),
      width: w - marginX * 2,
      height: Math.round(h * 0.24),
    },
    // Giant numeral centered, sitting ~62% down so it reads as the anchor.
    heroCenterX: w / 2,
    heroBaselineY: Math.round(h * 0.66),
    heroLabelY: Math.round(h * 0.71),
    watermarkY: Math.round(h - h * 0.06),
  };
}

/**
 * STAT GRID layout — 2×2 broadcast tiles under a header. Given the canvas and
 * the content margins, returns the four tile rects (row-major) plus the header
 * baseline. Tiles are square-ish with a fixed gutter.
 */
export interface StatGridLayout {
  header: { eyebrowY: number; titleY: number; dateY: number; dividerY: number };
  tiles: [TilePlacement, TilePlacement, TilePlacement, TilePlacement];
  watermarkY: number;
  marginX: number;
}

export function statGridLayout(w: number, h: number): StatGridLayout {
  const marginX = Math.round(w * 0.078); // ~84 on 1080
  const gutter = Math.round(w * 0.033); // ~36
  const gridTop = Math.round(h * 0.3);
  const gridW = w - marginX * 2;
  const tileW = (gridW - gutter) / 2;
  // Keep tiles from crowding the watermark: fit within the middle band.
  const bandBottom = Math.round(h - h * 0.11);
  const tileH = Math.min(tileW, (bandBottom - gridTop - gutter) / 2);

  const cols = [marginX, marginX + tileW + gutter];
  const rows = [gridTop, gridTop + tileH + gutter];

  const mk = (row: 0 | 1, col: 0 | 1): TilePlacement => ({
    x: cols[col]!,
    y: rows[row]!,
    width: tileW,
    height: tileH,
    row,
    col,
  });

  return {
    marginX,
    header: {
      eyebrowY: Math.round(h * 0.115),
      titleY: Math.round(h * 0.17),
      dateY: Math.round(h * 0.115),
      dividerY: Math.round(h * 0.2),
    },
    tiles: [mk(0, 0), mk(0, 1), mk(1, 0), mk(1, 1)],
    watermarkY: Math.round(h - h * 0.055),
  };
}

/**
 * A glass stat panel rect for the photo-background v2 grade: a translucent
 * card the stats sit inside, hugging the bottom content zone. `contentH` is how
 * tall the enclosed stat block is; the panel pads around it.
 */
export function glassPanelRect(
  w: number,
  h: number,
  contentTop: number,
  contentBottom: number,
  marginX: number,
): Rect {
  const padY = Math.round(h * 0.02);
  const top = Math.max(0, contentTop - padY);
  const bottom = Math.min(h, contentBottom + padY);
  return {
    x: marginX,
    y: top,
    width: w - marginX * 2,
    height: bottom - top,
  };
}
