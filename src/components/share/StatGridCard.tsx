/**
 * StatGridCard — a 2×2 broadcast-tile layout: PTS / FG% / BEST STREAK / 3PT,
 * each in its own tile with a per-tile accent bar and micro-label. A session
 * that ran hot (streak >= 5) gets an ember glow behind the BEST STREAK value.
 *
 * Pure Skia element (no hooks). Tile rects come from statGridLayout so the grid
 * is driven by canvas size.
 */
import {
  Group,
  Image as SkiaImage,
  Rect,
  Text as SkText,
  vec,
  RadialGradient,
  type SkImage,
} from '@shopify/react-native-skia';
import React from 'react';

import { color } from '../../constants/tokens';
import { CinematicGrade, StatTile, type StatTileData } from './graphics';
import { TrackedText, Watermark } from './lockup';
import { statGridLayout } from './layoutMath';
import { displayFont, fitFont, textW } from './typography';

export interface GridData {
  eyebrow: string;
  title: string;
  dateLabel: string;
  /** Exactly four tiles, row-major (top-left, top-right, bottom-left, bottom-right). */
  tiles: [StatTileData, StatTileData, StatTileData, StatTileData];
}

const GLOW_FADE = 'rgba(240, 90, 36, 0)';

export function StatGridCard({
  w,
  h,
  data,
  bgImage,
}: {
  w: number;
  h: number;
  data: GridData;
  bgImage?: SkImage | null;
}) {
  const L = statGridLayout(w, h);
  const eyebrowFont = displayFont(30);
  const titleFont = fitFont(data.title, 76, w - L.marginX * 2);
  const dateFont = displayFont(28);
  const dateW = textW(dateFont, data.dateLabel);

  const tileValueFont = fitFont('000%', 128, L.tiles[0].width * 0.82, 64);
  const tileLabelFont = displayFont(28);

  return (
    <Group>
      <Rect x={0} y={0} width={w} height={h} color={color.bg} />
      {bgImage != null ? (
        <>
          <SkiaImage image={bgImage} x={0} y={0} width={w} height={h} fit="cover" />
          <CinematicGrade w={w} h={h} />
        </>
      ) : (
        <Rect x={0} y={0} width={w} height={h}>
          <RadialGradient c={vec(w / 2, h * 0.5)} r={w * 0.9} colors={[color.accentTint, GLOW_FADE]} />
        </Rect>
      )}

      {/* Header: eyebrow + title (left) and date (right), hairline divider. */}
      <TrackedText
        text={data.eyebrow}
        x={L.marginX}
        y={L.header.eyebrowY}
        font={eyebrowFont}
        tracking={6}
        fg={color.accent}
      />
      <SkText
        x={w - L.marginX - dateW}
        y={L.header.dateY}
        text={data.dateLabel}
        font={dateFont}
        color={color.textDim}
      />
      <SkText x={L.marginX} y={L.header.titleY} text={data.title} font={titleFont} color={color.text} />
      <Rect x={L.marginX} y={L.header.dividerY} width={w - L.marginX * 2} height={2} color={color.border} />

      {/* 2×2 broadcast tiles. */}
      {L.tiles.map((t, i) => (
        <StatTile
          key={i}
          x={t.x}
          y={t.y}
          width={t.width}
          height={t.height}
          data={data.tiles[i]!}
          valueFont={tileValueFont}
          labelFont={tileLabelFont}
        />
      ))}

      <Watermark centerX={w / 2} y={L.watermarkY} />
    </Group>
  );
}
