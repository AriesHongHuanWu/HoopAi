/**
 * share/typography — the condensed-numeral font machinery shared by every
 * share layout.
 *
 * Skia can't see Barlow (it lives in RN's expo-font registry, not the system
 * font manager), so the cards render numerals with `matchFont` against a
 * condensed SYSTEM face — Avenir Next Condensed on iOS, sans-serif-condensed on
 * Android. This module centralizes that so the base ShareCard and the new
 * poster/grid layouts pull from one cache and one measuring path.
 */
import { matchFont, type SkFont } from '@shopify/react-native-skia';
import { Platform } from 'react-native';

export const DISPLAY_FAMILY = Platform.select({
  ios: 'Avenir Next Condensed',
  default: 'sans-serif-condensed',
});

const fontCache = new Map<number, SkFont>();

/** A cached bold condensed face at `size` px. */
export function displayFont(size: number): SkFont {
  let font = fontCache.get(size);
  if (font == null) {
    font = matchFont({
      fontFamily: DISPLAY_FAMILY,
      fontSize: size,
      fontStyle: 'normal',
      fontWeight: 'bold',
    });
    fontCache.set(size, font);
  }
  return font;
}

export function textW(font: SkFont, text: string): number {
  return font.measureText(text).width;
}

/** Largest font ≤ `size` whose rendering of `text` fits in `maxW`. */
export function fitFont(text: string, size: number, maxW: number, min = 24): SkFont {
  let current = size;
  let font = displayFont(current);
  for (let i = 0; i < 4; i++) {
    const w = textW(font, text);
    if (w <= maxW || current <= min) break;
    current = Math.max(min, Math.floor((current * maxW) / w));
    font = displayFont(current);
  }
  return font;
}

/** Total width of `text` set with per-glyph `tracking` (Skia has no letterSpacing). */
export function trackedWidth(font: SkFont, text: string, tracking: number): number {
  let w = 0;
  for (const ch of text) w += textW(font, ch) + tracking;
  return Math.max(0, w - tracking);
}
