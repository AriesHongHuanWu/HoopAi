/**
 * EscalationLayers — the streak-aware make garnishes that sit BETWEEN the base
 * burst and the (tier-3) flame particles:
 *
 *   EmberRingPulse  (tier 1, streak 3+): a single brief ring that expands and
 *     fades once around the score — a "the rim is warming up" beat.
 *   HeatShimmerBand (tier 2, streak 5+): a low, rising heat-haze band under the
 *     score, a soft vertical gradient that lifts and dissolves.
 *
 * Both are retained-mode Skia (no particles) driven by one shared-value clock
 * each, one-shot, pointerEvents inherited none from the parent. Motion-only —
 * ShotFlash renders them only when not reduced-motion. Kept here (not inline in
 * ShotFlash) so the HUD file stays legible and each layer is independently
 * reasoned about.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Easing, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated';
import {
  BlurMask,
  Canvas,
  Circle,
  LinearGradient,
  Rect,
  vec,
} from '@shopify/react-native-skia';

import { glow, palette } from '@/constants/tokens';

const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

/** Ember pulse duration — a touch faster than the full celebrate window. */
const RING_MS = 460;
/** Shimmer band duration — the slowest layer, a lingering heat lift. */
const BAND_MS = 560;

/**
 * EmberRingPulse — tier 1. One expanding ember-orange ring around center that
 * fades as it grows. Leather-hot, distinct from the base burst's green ring.
 */
export function EmberRingPulse() {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = 0;
    t.value = withTiming(1, { duration: RING_MS, easing: Easing.out(Easing.cubic) });
  }, [t]);

  const cx = size.w / 2;
  const cy = size.h / 2;
  const maxR = Math.min(size.w, size.h) * 0.34;

  const r = useDerivedValue(() => maxR * (0.35 + t.value * 0.65));
  const opacity = useDerivedValue(() => (1 - t.value) * 0.75);
  const stroke = useDerivedValue(() => 5 * (1 - t.value) + 1.5);

  return (
    <Canvas
      style={absoluteFill}
      pointerEvents="none"
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      {size.w > 0 && (
        <Circle
          cx={cx}
          cy={cy}
          r={r}
          style="stroke"
          strokeWidth={stroke}
          color={palette.leather}
          opacity={opacity}
        >
          <BlurMask blur={4} style="normal" />
        </Circle>
      )}
    </Canvas>
  );
}

/**
 * HeatShimmerBand — tier 2. A soft leather→transparent vertical band beneath
 * the score that rises and dissolves, reading as heat haze off the number.
 */
export function HeatShimmerBand() {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = 0;
    t.value = withTiming(1, { duration: BAND_MS, easing: Easing.out(Easing.quad) });
  }, [t]);

  // Band height and its upward lift; it eases in then fades out.
  const bandH = size.h * 0.26;
  const startTop = size.h * 0.5;

  const rect = useDerivedValue(() => ({
    x: 0,
    y: startTop - t.value * (size.h * 0.14),
    width: size.w,
    height: bandH,
  }));
  // Ease in (first 25%) then fade out — peak ~0.4 opacity, never a wash.
  const opacity = useDerivedValue(() => {
    const u = t.value;
    const rampIn = Math.min(1, u / 0.25);
    const rampOut = 1 - Math.max(0, (u - 0.4) / 0.6);
    return Math.max(0, rampIn * rampOut) * 0.4;
  });
  const start = useDerivedValue(() => vec(0, rect.value.y + bandH));
  const end = useDerivedValue(() => vec(0, rect.value.y));

  return (
    <Canvas
      style={absoluteFill}
      pointerEvents="none"
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      {size.w > 0 && (
        <Rect rect={rect} opacity={opacity}>
          <LinearGradient
            start={start}
            end={end}
            colors={[glow.trailBloom, palette.leatherTint, 'rgba(240, 90, 36, 0)']}
          />
          <BlurMask blur={12} style="normal" />
        </Rect>
      )}
    </Canvas>
  );
}

/** Convenience: renders the ring and/or band appropriate to `tier`. Flames are
 * mounted separately by ShotFlash (they carry their own particle field). */
export function EscalationLayers({ tier }: { tier: 0 | 1 | 2 | 3 }) {
  if (tier <= 0) return null;
  return (
    <View style={styles.fill} pointerEvents="none">
      {tier >= 1 && <EmberRingPulse />}
      {tier >= 2 && <HeatShimmerBand />}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { ...absoluteFill },
});

export default EscalationLayers;
