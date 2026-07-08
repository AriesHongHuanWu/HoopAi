/**
 * share/graphics — shared Skia drawing primitives for the v2 share layouts.
 *
 * All pure Skia elements (no hooks), safe under the offscreen `drawAsImage`
 * reconciler. They take absolute CARD-space coordinates from layoutMath, so a
 * layout component just wires data → geometry → these.
 *
 * Fonts: Skia can't see Barlow (expo-font registry), so numerals use a
 * condensed SYSTEM face via `matchFont` — same constraint the base ShareCard
 * documents. Callers pass an already-sized SkFont.
 */
import {
  BlurMask,
  Circle,
  Group,
  LinearGradient,
  Mask,
  Path,
  Rect,
  RoundedRect,
  Skia,
  Text as SkText,
  vec,
  type SkFont,
  type SkPath,
} from '@shopify/react-native-skia';
import React from 'react';

import { color, palette } from '../../constants/tokens';
import { arcToSvgPath, type ArcLayout } from './trajectoryArc';

// ---------------------------------------------------------------------------
// Palette helpers (raw rgba the Skia props consume directly)
// ---------------------------------------------------------------------------

/** Cinematic photo grade stops (coal #121010 ramp — deep bottom, clear middle). */
export const GRADE_TOP = 'rgba(18, 16, 16, 0.72)';
export const GRADE_MID = 'rgba(18, 16, 16, 0.10)';
/** Bottom 55% ramps to near-opaque coal so stats read on any frame. */
export const GRADE_BOT = 'rgba(18, 16, 16, 0.94)';
/** Vignette edge (corners) — transparent center. */
export const VIGNETTE = 'rgba(6, 5, 5, 0.55)';
export const VIGNETTE_CLEAR = 'rgba(6, 5, 5, 0)';

/** Glass panel fill + hairline (translucent leather-warmed coal). */
export const GLASS_FILL = 'rgba(24, 21, 20, 0.52)';
export const GLASS_STROKE = 'rgba(245, 241, 236, 0.16)';

/** Streak ember gradient — a warm ring behind a hot streak stat. */
export const EMBER_CORE = 'rgba(240, 90, 36, 0.55)';
export const EMBER_EDGE = 'rgba(240, 90, 36, 0)';

// ---------------------------------------------------------------------------
// Cinematic photo grade — vignette + coal bottom ramp + accent edge-light line
// ---------------------------------------------------------------------------

/**
 * The photo-background v2 grade, drawn OVER a full-bleed photo:
 *  - a soft corner vignette to pull focus in,
 *  - a coal gradient ramp weighting the bottom ~55% so stats stay legible,
 *  - a single accent edge-light line where the ramp begins (a premium "graded"
 *    seam rather than a muddy wash).
 */
export function CinematicGrade({ w, h }: { w: number; h: number }) {
  const rampStart = h * 0.45; // top of the bottom-55% ramp
  return (
    <Group>
      {/* Corner vignette (radial, transparent center → dark corners). */}
      <Rect x={0} y={0} width={w} height={h} opacity={0.9}>
        <LinearGradient
          start={vec(0, 0)}
          end={vec(0, h)}
          colors={[VIGNETTE, VIGNETTE_CLEAR, VIGNETTE_CLEAR, VIGNETTE]}
          positions={[0, 0.18, 0.7, 1]}
        />
      </Rect>
      {/* Coal ramp: clear middle, deep bottom. */}
      <Rect x={0} y={0} width={w} height={h}>
        <LinearGradient
          start={vec(0, 0)}
          end={vec(0, h)}
          colors={[GRADE_TOP, GRADE_MID, GRADE_MID, GRADE_BOT]}
          positions={[0, 0.28, 0.45, 1]}
        />
      </Rect>
      {/* Accent edge-light line at the ramp seam. */}
      <Rect x={0} y={rampStart} width={w} height={2} color={color.accent} opacity={0.55}>
        <BlurMask blur={3} style="normal" />
      </Rect>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Glass panel — translucent fill + hairline, for stats over a photo
// ---------------------------------------------------------------------------

export function GlassPanel({
  x,
  y,
  width,
  height,
  radius = 40,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
}) {
  return (
    <Group>
      <RoundedRect x={x} y={y} width={width} height={height} r={radius} color={GLASS_FILL} />
      <RoundedRect
        x={x + 1}
        y={y + 1}
        width={width - 2}
        height={height - 2}
        r={radius - 1}
        style="stroke"
        strokeWidth={2}
        color={GLASS_STROKE}
      />
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Ember glow — warm radial behind a hot streak stat (streak >= 5)
// ---------------------------------------------------------------------------

export function EmberGlow({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <Group>
      <Circle cx={cx} cy={cy} r={r} color={EMBER_CORE} opacity={0.9}>
        <BlurMask blur={r * 0.55} style="normal" />
      </Circle>
      <Circle cx={cx} cy={cy} r={r * 0.6} color={palette.downtown} opacity={0.28}>
        <BlurMask blur={r * 0.4} style="normal" />
      </Circle>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Gradient-filled numeral — the POSTER hero, clipped to the glyphs
// ---------------------------------------------------------------------------

/**
 * A giant numeral filled with a vertical accent→gold clipped gradient. The text
 * is used as a MASK over a gradient rect, so the fill lands exactly inside the
 * glyphs (a "clipped-gradient fill"). `x`/`y` are the text origin (baseline),
 * matching Skia's <Text>.
 */
export function GradientNumeral({
  text,
  x,
  y,
  font,
  width,
  ascent,
  descent,
}: {
  text: string;
  x: number;
  y: number;
  font: SkFont;
  /** Measured glyph width (for the gradient rect bounds). */
  width: number;
  /** Font ascent (positive px above baseline) + descent (below). */
  ascent: number;
  descent: number;
}) {
  const top = y - ascent;
  const height = ascent + descent;
  return (
    <Mask
      mode="alpha"
      mask={<SkText x={x} y={y} text={text} font={font} color="white" />}
    >
      <Rect x={x} y={top} width={width} height={height}>
        <LinearGradient
          start={vec(x, top)}
          end={vec(x, top + height)}
          colors={[palette.chalk, color.accent, palette.leatherDeep]}
          positions={[0, 0.55, 1]}
        />
      </Rect>
    </Mask>
  );
}

// ---------------------------------------------------------------------------
// Trajectory flourish — the POSTER's actual-shot arc with a rim ball dot
// ---------------------------------------------------------------------------

/**
 * Draws a fitted {@link ArcLayout} as an elegant shot line: a soft accent bloom
 * under a crisp core stroke, a faint dotted "release" tail, and a glowing ball
 * dot at the rim end. Pure Skia; the geometry came from layoutTrajectoryArc.
 */
export function TrajectoryFlourish({ arc }: { arc: ArcLayout }) {
  const d = arcToSvgPath(arc.points);
  const path: SkPath | null = d !== '' ? Skia.Path.MakeFromSVGString(d) : null;
  if (path == null) return null;
  return (
    <Group>
      {/* Bloom under the line. */}
      <Path
        path={path}
        style="stroke"
        strokeWidth={16}
        strokeCap="round"
        strokeJoin="round"
        color={color.accent}
        opacity={0.22}
      >
        <BlurMask blur={18} style="normal" />
      </Path>
      {/* Crisp core stroke. */}
      <Path
        path={path}
        style="stroke"
        strokeWidth={5}
        strokeCap="round"
        strokeJoin="round"
        color={color.accent}
        opacity={0.9}
      />
      {/* Release-end marker (small hollow ring). */}
      <Circle
        cx={arc.release.x}
        cy={arc.release.y}
        r={9}
        style="stroke"
        strokeWidth={3}
        color={palette.chalkDim}
        opacity={0.7}
      />
      {/* Ball dot at the rim: bloom + warm core + white highlight. */}
      <Circle cx={arc.ball.x} cy={arc.ball.y} r={24} color={color.accent} opacity={0.4}>
        <BlurMask blur={12} style="normal" />
      </Circle>
      <Circle cx={arc.ball.x} cy={arc.ball.y} r={13} color={color.accent} />
      <Circle cx={arc.ball.x - 3} cy={arc.ball.y - 3} r={4} color={palette.chalk} opacity={0.8} />
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Broadcast stat tile — one cell of the STAT GRID (accent bar + value + label)
// ---------------------------------------------------------------------------

export interface StatTileData {
  value: string;
  label: string;
  /** Accent color for the bar + value (defaults to leather). */
  accent?: string;
  /** When true, an ember glow sits behind the value (hot streak). */
  ember?: boolean;
}

export function StatTile({
  x,
  y,
  width,
  height,
  data,
  valueFont,
  labelFont,
  labelTracking = 4,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  data: StatTileData;
  valueFont: SkFont;
  labelFont: SkFont;
  labelTracking?: number;
}) {
  const accent = data.accent ?? color.accent;
  const barW = Math.round(width * 0.24);
  const padX = Math.round(width * 0.09);
  const labelBaseline = y + height - Math.round(height * 0.16);
  const valueBaseline = y + Math.round(height * 0.62);
  const vW = valueFont.measureText(data.value).width;
  const valueX = x + padX;

  // Tracked label width (manual — Skia Text has no letterSpacing).
  let lw = 0;
  for (const ch of data.label) lw += labelFont.measureText(ch).width + labelTracking;
  lw = Math.max(0, lw - labelTracking);

  const nodes: React.JSX.Element[] = [];
  let cx = x + padX;
  for (let i = 0; i < data.label.length; i++) {
    const ch = data.label[i]!;
    nodes.push(
      <SkText key={`l${i}`} x={cx} y={labelBaseline} text={ch} font={labelFont} color={color.textDim} />,
    );
    cx += labelFont.measureText(ch).width + labelTracking;
  }

  return (
    <Group>
      {/* Tile card. */}
      <RoundedRect x={x} y={y} width={width} height={height} r={28} color={color.surface} />
      <RoundedRect
        x={x + 1}
        y={y + 1}
        width={width - 2}
        height={height - 2}
        r={27}
        style="stroke"
        strokeWidth={1.5}
        color={color.border}
      />
      {/* Top accent bar. */}
      <RoundedRect x={x + padX} y={y + Math.round(height * 0.16)} width={barW} height={6} r={3} color={accent} />
      {data.ember === true && (
        <EmberGlow cx={valueX + vW * 0.5} cy={valueBaseline - Math.round(height * 0.14)} r={Math.round(height * 0.34)} />
      )}
      {/* Value. */}
      <SkText x={valueX} y={valueBaseline} text={data.value} font={valueFont} color={data.ember === true ? color.text : accent} />
      {/* Micro-label (tracked). */}
      {nodes}
    </Group>
  );
}
