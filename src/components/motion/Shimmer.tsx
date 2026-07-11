/**
 * Shimmer — a skeleton loading block (Skia): a token-colored rounded rect with
 * a faint highlight band swept across it by one shared-value clock.
 *
 * CONTRACT: Loading states only. Unmount when content arrives. NEVER mount on
 * the live HUD — this is the only sanctioned continuous loop, and it stays
 * off-HUD (thermal contract: ShotFlash is the only live-camera celebration).
 *
 * Reduced motion: renders the static rect; the sweep loop never starts.
 * The rgba highlight literal is fine for a Skia canvas per the glow precedent
 * in tokens (Skia color props, not RN styles).
 */
import React, { useEffect, useMemo } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import {
  Easing,
  cancelAnimation,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import {
  Canvas,
  Group,
  LinearGradient,
  Rect,
  RoundedRect,
  rect,
  rrect,
  vec,
} from '@shopify/react-native-skia';

import { color, radius as radiusTokens } from '@/constants/tokens';

/** Highlight band: transparent → faint chalk white → transparent. */
const BAND_COLORS = ['rgba(255,255,255,0)', 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0)'];
/** One full sweep (ms). */
const SWEEP_MS = 1200;

export interface ShimmerProps {
  width: number;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

export function Shimmer({ width, height, radius = radiusTokens.md, style }: ShimmerProps) {
  const reducedMotion = useReducedMotion();
  // 0..1 sweep clock — the ONE continuous loop this component owns.
  const clock = useSharedValue(0);

  const bandW = Math.max(48, width * 0.5);
  // Clip the band to the rounded block so the sweep never bleeds outside.
  const clip = useMemo(() => rrect(rect(0, 0, width, height), radius, radius), [
    width,
    height,
    radius,
  ]);

  useEffect(() => {
    if (reducedMotion) return; // Static rect: the loop never starts.
    clock.value = 0;
    clock.value = withRepeat(
      withTiming(1, { duration: SWEEP_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(clock);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);

  // Band travels from fully-left-of the block to fully-right-of it.
  const bandTransform = useDerivedValue(() => [
    { translateX: -bandW + clock.value * (width + 2 * bandW) },
  ]);

  return (
    <Canvas style={[{ width, height }, style]} pointerEvents="none">
      <RoundedRect x={0} y={0} width={width} height={height} r={radius} color={color.surfaceRaised} />
      {!reducedMotion && (
        <Group clip={clip}>
          <Group transform={bandTransform}>
            <Rect x={0} y={0} width={bandW} height={height}>
              <LinearGradient start={vec(0, 0)} end={vec(bandW, 0)} colors={BAND_COLORS} />
            </Rect>
          </Group>
        </Group>
      )}
    </Canvas>
  );
}

export default Shimmer;
