/**
 * share/lockup — the brand lockup + tracked-text primitive shared across
 * layouts. Every card leaves the app branded (the wordmark + hook line), so the
 * watermark is a first-class element, not an afterthought.
 */
import { Group, Text as SkText, type SkFont } from '@shopify/react-native-skia';
import React from 'react';

import { color } from '../../constants/tokens';
import { displayFont, textW, trackedWidth } from './typography';

/** The line every viewer of a shared card reads. "ILOT" picks up the accent. */
export const HOOK_TEXT = 'TRACK YOUR GAME · HOOPILOT';
export const HOOK_ACCENT_INDEX = HOOK_TEXT.indexOf('ILOT');
const WORDMARK = 'HOOPILOT';
const WORDMARK_ACCENT_INDEX = WORDMARK.indexOf('ILOT');

/** Letter-spaced text (Skia Text has no letterSpacing — drawn per glyph). */
export function TrackedText({
  text,
  x,
  y,
  font,
  tracking,
  fg,
  accentFromIndex,
}: {
  text: string;
  x: number;
  y: number;
  font: SkFont;
  tracking: number;
  fg: string;
  accentFromIndex?: number;
}) {
  const nodes: React.JSX.Element[] = [];
  let cx = x;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    nodes.push(
      <SkText
        key={i}
        x={cx}
        y={y}
        text={ch}
        font={font}
        color={accentFromIndex != null && i >= accentFromIndex ? color.accent : fg}
      />,
    );
    cx += textW(font, ch) + tracking;
  }
  return <>{nodes}</>;
}

/**
 * Bottom brand lockup: the HOOPILOT wordmark centered over the hook line. Used
 * by the poster/grid layouts as their watermark. `y` is the wordmark baseline;
 * the hook sits just below it.
 */
export function Watermark({
  centerX,
  y,
  wordmarkSize = 44,
  hookSize = 26,
  tracking = 6,
}: {
  centerX: number;
  y: number;
  wordmarkSize?: number;
  hookSize?: number;
  tracking?: number;
}) {
  const wm = displayFont(wordmarkSize);
  const hook = displayFont(hookSize);
  const wmW = trackedWidth(wm, WORDMARK, tracking + 2);
  const hookW = trackedWidth(hook, HOOK_TEXT, tracking - 1);
  return (
    <Group>
      <TrackedText
        text={WORDMARK}
        x={centerX - wmW / 2}
        y={y}
        font={wm}
        tracking={tracking + 2}
        fg={color.text}
        accentFromIndex={WORDMARK_ACCENT_INDEX}
      />
      <TrackedText
        text={HOOK_TEXT}
        x={centerX - hookW / 2}
        y={y + Math.round(wordmarkSize * 0.9)}
        font={hook}
        tracking={tracking - 1}
        fg={color.textDim}
        accentFromIndex={HOOK_ACCENT_INDEX}
      />
    </Group>
  );
}
