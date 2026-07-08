/**
 * Confetti — a one-shot Skia confetti burst for session-end personal bests.
 *
 * Broadcast-grade juice, not a toy: 40 brand-palette rectangles fan up from a
 * low emitter, tumble on individual spin, then fall under gravity+drag and fade
 * out over 1.2s. It fires ONCE per mount (or per `trigger` change) and then
 * sits at zero cost — nothing is continuous.
 *
 * Performance contract:
 *   - The particle field is spawned ONCE into a pooled array (see particles.ts);
 *     there is ZERO per-frame allocation. Each frame only advances one scalar
 *     `clock` shared value and re-records a single SkPicture from the pooled
 *     data inside a worklet.
 *   - No React state changes during the animation — the whole thing is driven by
 *     `useSharedValue` + `useDerivedValue`, so the JS thread is idle after spawn.
 *   - pointerEvents="none": it can never intercept a tap on the court/summary.
 *   - Reduced motion: renders nothing (a falling-paper burst has no static
 *     equivalent that reads as "confetti"; the personal-best banner already
 *     carries the meaning). Callers keep the banner for the non-motion path.
 *
 * Exported but NOT wired — the summary owner drops it in when ready.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  useReducedMotion,
  useSharedValue,
  useDerivedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Canvas, Picture, Skia } from '@shopify/react-native-skia';

import { palette } from '@/constants/tokens';
import { particleState, spawnConfetti, type Particle } from './particles';

/** Total lifetime of the burst (seconds). */
const LIFE_SEC = 1.2;
/** Piece count — the visible budget for this effect. */
const PIECE_COUNT = 40;

/**
 * Brand palette for the pieces, pre-parsed to SkColor once at module load
 * (immutable, shared across all instances — never re-created per frame).
 * Leather orange leads, with make-green, downtown-gold and paint-blue accents.
 */
const CONFETTI_COLORS = [
  Skia.Color(palette.leather),
  Skia.Color(palette.swish),
  Skia.Color(palette.downtown),
  Skia.Color(palette.paintBlue),
  Skia.Color(palette.chalk),
];

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

export interface ConfettiProps {
  /**
   * Bumping this restarts the burst (e.g. a new personal best). Omit for a
   * single fire on mount. Any change to the value re-seeds and replays.
   */
  trigger?: number | string;
  /** Extra seed mixed into the field so repeats don't look identical. */
  seed?: number;
  style?: StyleProp<ViewStyle>;
  /** Called once the burst has fully faded (for unmount/cleanup by the owner). */
  onDone?: () => void;
}

export function Confetti({ trigger, seed = 1, style, onDone }: ConfettiProps) {
  const reducedMotion = useReducedMotion();
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Absolute clock in SECONDS. Driven once per fire; the picture reads it.
  const clock = useSharedValue(0);

  // Numeric seed derived from trigger so string triggers still vary the field.
  const fieldSeed = useMemo(() => {
    const base = typeof trigger === 'number' ? trigger : hashString(String(trigger ?? ''));
    return (base ^ (seed * 0x9e3779b9)) >>> 0;
  }, [trigger, seed]);

  // Spawn the pooled field ONCE per (size, seed). Emitter sits low-center so the
  // fan opens up into the frame like a popper fired at the score.
  const field = useMemo<Particle[]>(() => {
    if (size.w <= 0) return [];
    return spawnConfetti(fieldSeed, {
      count: PIECE_COUNT,
      cx: size.w / 2,
      cy: size.h * 0.72,
      width: size.w * 0.7,
      paletteSize: CONFETTI_COLORS.length,
      vyMin: size.h * 0.55,
      vyMax: size.h * 0.95,
      vxSpread: size.w * 0.45,
    });
  }, [fieldSeed, size]);

  // Fire (or re-fire) the clock whenever a fresh field is ready.
  useEffect(() => {
    if (reducedMotion || field.length === 0) return;
    clock.value = 0;
    clock.value = withTiming(LIFE_SEC, {
      duration: LIFE_SEC * 1000,
      easing: Easing.linear,
    });
    // Hand cleanup back to the owner after the tail has faded.
    const id = setTimeout(() => onDone?.(), LIFE_SEC * 1000 + 60);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, reducedMotion]);

  // Re-record a single SkPicture each frame from the pooled field. No JS-thread
  // work and no allocation beyond the recorder's own buffers.
  const picture = useDerivedValue(() => {
    'worklet';
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, size.w, size.h));
    const t = clock.value;
    const paint = Skia.Paint();
    for (let i = 0; i < field.length; i++) {
      const s = particleState(field[i]!, t, LIFE_SEC, {
        gravityMul: 1,
        fadeIn: 0.06,
        fadeOut: 0.4,
      });
      if (s.alpha <= 0.01) continue;
      paint.setColor(CONFETTI_COLORS[s.colorIndex % CONFETTI_COLORS.length]!);
      paint.setAlphaf(s.alpha);
      // Rotated rectangle: translate to the piece, spin about its center.
      canvas.save();
      canvas.translate(s.x, s.y);
      canvas.rotate((s.rot * 180) / Math.PI, 0, 0);
      const half = s.size;
      canvas.drawRect(Skia.XYWHRect(-half, -half * 0.6, half * 2, half * 1.2), paint);
      canvas.restore();
    }
    return recorder.finishRecordingAsPicture();
  });

  if (reducedMotion) return null;

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

/** Small deterministic string hash → uint32, for string triggers. */
function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export default Confetti;
