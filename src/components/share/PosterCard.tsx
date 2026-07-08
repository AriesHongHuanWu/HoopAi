/**
 * PosterCard — the full-bleed vertical STORY poster. One giant clipped-gradient
 * numeral anchors the frame; the session's best make is drawn as its ACTUAL
 * stored trajectory arc (a flourish, sourced via bestMakeTrajectory upstream);
 * a date micro-line and the brand watermark frame it.
 *
 * Pure Skia element (no hooks) — safe offscreen. Geometry comes entirely from
 * posterLayout + layoutTrajectoryArc so it's driven by canvas size, not magic
 * numbers sprinkled here.
 */
import {
  BlurMask,
  Circle,
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
import type { BallSample } from '../../core/types';
import {
  CinematicGrade,
  EmberGlow,
  GradientNumeral,
  TrajectoryFlourish,
} from './graphics';
import { TrackedText, Watermark } from './lockup';
import { posterLayout } from './layoutMath';
import { layoutTrajectoryArc } from './trajectoryArc';
import { displayFont, fitFont, trackedWidth } from './typography';

export interface PosterData {
  /** Small tracked eyebrow, e.g. "SESSION REPORT". */
  eyebrow: string;
  /** The giant numeral, e.g. "68%" or "24". */
  hero: string;
  /** Tracked label under the hero, e.g. "FIELD GOALS". */
  heroLabel: string;
  /** Date micro-line, e.g. "JUL 7, 2026 · CROSSOVER PARK". */
  dateLine: string;
  /** Best made shot's raw trajectory (analysis-frame px) for the flourish. */
  trajectory?: readonly BallSample[] | null;
  /** True when this session earned an ember (streak >= 5). */
  ember?: boolean;
}

const GLOW_FADE = 'rgba(240, 90, 36, 0)';

export function PosterCard({
  w,
  h,
  data,
  bgImage,
}: {
  w: number;
  h: number;
  data: PosterData;
  bgImage?: SkImage | null;
}) {
  const L = posterLayout(w, h);
  const eyebrowFont = displayFont(30);
  const dateFont = displayFont(28);
  const labelFont = displayFont(34);
  // Giant hero — 240px+ per the brief, shrunk to fit ultra-wide values.
  const heroFont = fitFont(data.hero, 380, w - L.marginX * 2, 200);
  const heroM = heroFont.measureText(data.hero);
  const heroW = heroM.width;
  const metrics = heroFont.getMetrics();
  // matchFont metrics: ascent is negative (above baseline), descent positive.
  const ascent = metrics != null ? Math.abs(metrics.ascent) : heroFont.getSize() * 0.75;
  const descent = metrics != null ? Math.abs(metrics.descent) : heroFont.getSize() * 0.25;
  const heroX = L.heroCenterX - heroW / 2;

  const arc =
    data.trajectory != null ? layoutTrajectoryArc(data.trajectory, L.arcBox, { inset: 0.06 }) : null;

  const heroLabelW = trackedWidth(labelFont, data.heroLabel, 8);
  const eyebrowW = trackedWidth(eyebrowFont, data.eyebrow, 6);

  return (
    <Group>
      {/* Base coal (also the letterbox fill). */}
      <Rect x={0} y={0} width={w} height={h} color={color.bg} />
      {bgImage != null ? (
        <>
          <SkiaImage image={bgImage} x={0} y={0} width={w} height={h} fit="cover" />
          <CinematicGrade w={w} h={h} />
        </>
      ) : (
        /* No photo → a tall leather radial glow behind the hero. */
        <Rect x={0} y={0} width={w} height={h}>
          <RadialGradient
            c={vec(w / 2, L.heroBaselineY - ascent * 0.4)}
            r={w * 0.85}
            colors={[color.accentTint, GLOW_FADE]}
          />
        </Rect>
      )}

      {/* Eyebrow + date micro-line, top-left. */}
      <TrackedText
        text={data.eyebrow}
        x={L.marginX}
        y={L.eyebrowY}
        font={eyebrowFont}
        tracking={6}
        fg={color.accent}
      />
      <SkText x={L.marginX} y={L.dateY} text={data.dateLine} font={dateFont} color={color.textDim} />
      {/* Hairline under the header line, matching eyebrow width band. */}
      <Rect x={L.marginX} y={L.dateY + 20} width={Math.max(eyebrowW, 220)} height={2} color={color.border} />

      {/* Trajectory flourish (the session's best make's real arc). */}
      {arc != null && <TrajectoryFlourish arc={arc} />}

      {/* Ember behind the hero when the session ran hot. */}
      {data.ember === true && (
        <EmberGlow cx={L.heroCenterX} cy={L.heroBaselineY - ascent * 0.42} r={Math.round(w * 0.34)} />
      )}

      {/* Giant clipped-gradient hero numeral. */}
      <GradientNumeral
        text={data.hero}
        x={heroX}
        y={L.heroBaselineY}
        font={heroFont}
        width={heroW}
        ascent={ascent}
        descent={descent}
      />

      {/* Tracked hero label. */}
      <TrackedText
        text={data.heroLabel}
        x={L.heroCenterX - heroLabelW / 2}
        y={L.heroLabelY}
        font={labelFont}
        tracking={8}
        fg={color.text}
      />

      {/* Bottom accent tick + watermark lockup. */}
      <Circle cx={L.heroCenterX} cy={L.watermarkY - 64} r={4} color={color.accent}>
        <BlurMask blur={2} style="normal" />
      </Circle>
      <Watermark centerX={L.heroCenterX} y={L.watermarkY} />
    </Group>
  );
}
