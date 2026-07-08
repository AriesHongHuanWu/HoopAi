/**
 * FlameLicks — the short flame-lick particle set that garnishes a 7+ streak
 * make around the score area (the top ShotFlash escalation tier).
 *
 * A small pooled field (<=24) of ember→flame→tip particles rises from a narrow
 * mouth, drifts, and shrinks as it climbs, over ~600ms. Immediate-mode Picture
 * drawn from the pooled array — zero per-frame allocation of the field, one
 * scalar clock. pointerEvents="none". Fires once per mount.
 *
 * This is motion-only garnish: callers must not render it under reduced motion.
 * Not a standalone tier gate — ShotFlash decides when to mount it.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  Easing,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Canvas, Picture, Skia } from '@shopify/react-native-skia';

import { palette } from '@/constants/tokens';
import { particleState, spawnFlames, type Particle } from './particles';

/** Lifetime of the lick set (seconds) — snappy, matches motion.celebrate. */
const LIFE_SEC = 0.6;
/** Particle count — this is the ONLY particle field in the make celebration,
 * kept at 14 so the grand total stays well under the 24 budget. */
const FLAME_COUNT = 14;

/** Ember (base) → flame (body) → tip (hot). Pre-parsed once at module load. */
const FLAME_COLORS = [
  Skia.Color(palette.leatherDeep),
  Skia.Color(palette.leather),
  Skia.Color(palette.downtown),
];

const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

export interface FlameLicksProps {
  /** Re-fire when this changes (e.g. shot id). */
  trigger?: number | string;
  style?: StyleProp<ViewStyle>;
}

export function FlameLicks({ trigger, style }: FlameLicksProps) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const clock = useSharedValue(0);

  const seed = useMemo(() => {
    const n = typeof trigger === 'number' ? trigger : 0;
    return (n * 2654435761) >>> 0;
  }, [trigger]);

  // Spawn once per (size, seed). Mouth sits just below screen center — the
  // score sits there, so the licks appear to rise off the number.
  const field = useMemo<Particle[]>(() => {
    if (size.w <= 0) return [];
    return spawnFlames(seed, {
      count: FLAME_COUNT,
      cx: size.w / 2,
      cy: size.h * 0.56,
      spread: size.w * 0.16,
      riseMin: size.h * 0.18,
      riseMax: size.h * 0.34,
      paletteSize: FLAME_COLORS.length,
    });
  }, [seed, size]);

  useEffect(() => {
    if (field.length === 0) return;
    clock.value = 0;
    clock.value = withTiming(LIFE_SEC, {
      duration: LIFE_SEC * 1000,
      easing: Easing.out(Easing.quad),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field]);

  const picture = useDerivedValue(() => {
    'worklet';
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, size.w, size.h));
    const t = clock.value;
    const paint = Skia.Paint();
    for (let i = 0; i < field.length; i++) {
      const s = particleState(field[i]!, t, LIFE_SEC, {
        gravityMul: -0.15, // slight buoyancy: licks accelerate upward, not fall.
        fadeIn: 0.12,
        fadeOut: 0.55,
        shrink: 1.4, // taper to a tip as they rise.
      });
      if (s.alpha <= 0.01) continue;
      paint.setColor(FLAME_COLORS[s.colorIndex % FLAME_COLORS.length]!);
      paint.setAlphaf(s.alpha * 0.9);
      canvas.drawCircle(s.x, s.y, Math.max(0.5, s.size), paint);
    }
    return recorder.finishRecordingAsPicture();
  });

  return (
    <View
      style={[absoluteFill, style]}
      pointerEvents="none"
      onLayout={(e) =>
        setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
      }
    >
      {size.w > 0 && (
        <Canvas style={StyleSheet.absoluteFill ?? absoluteFill} pointerEvents="none">
          <Picture picture={picture} />
        </Canvas>
      )}
    </View>
  );
}

export default FlameLicks;
