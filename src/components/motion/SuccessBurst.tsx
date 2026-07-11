/**
 * SuccessBurst — a small one-shot celebration burst (a compact sibling of
 * fx/Confetti for goal completions, record unlocks, etc. — NOT the session-end
 * personal-best confetti, which stays fx/Confetti's job).
 *
 * Same performance architecture as fx/Confetti:
 *   - the particle field is spawned ONCE into a pooled array (fx/particles);
 *     ZERO per-frame allocation of the field;
 *   - one scalar `clock` shared value drives everything; each frame re-records
 *     a single SkPicture from the pooled data inside a worklet;
 *   - pointerEvents="none" so it can never intercept a tap;
 *   - reduced motion renders null — callers MUST keep a static signal (banner,
 *     checkmark) carrying the meaning for the non-motion path.
 *
 * NEVER mount on the live HUD (thermal contract: ShotFlash is the only live
 * celebration).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Canvas, Picture, Skia } from '@shopify/react-native-skia';

import { palette } from '@/constants/tokens';
import { particleState, spawnConfetti, type ConfettiConfig, type Particle } from '../fx/particles';

/** Total lifetime of the burst (seconds) — shorter than Confetti's 1.2s. */
const LIFE_SEC = 0.9;

/**
 * HARD CAP on pieces. IRON RULE: at most 24 simultaneous particles across ALL
 * effects — 18 leaves headroom for anything else briefly on screen.
 */
export const MAX_BURST_PIECES = 18;

/**
 * Brand palette for the pieces, pre-parsed to SkColor once at module load
 * (immutable, shared across all instances — never re-created per frame).
 */
const BURST_COLORS = [
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

/** Requested piece count → the actual spawn count (floored, capped). Pure. */
export function burstPieceCount(pieces: number): number {
  const n = Math.floor(pieces);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_BURST_PIECES);
}

/**
 * The exact ConfettiConfig SuccessBurst spawns for a container of w×h. Pure
 * and exported so the spawn (count cap, determinism) is unit-testable without
 * rendering the component. Emitter sits low-center; the fan opens upward.
 */
export function burstConfig(pieces: number, w: number, h: number): ConfettiConfig {
  return {
    count: burstPieceCount(pieces),
    cx: w / 2,
    cy: h * 0.7,
    width: w * 0.6,
    paletteSize: BURST_COLORS.length,
    vyMin: h * 0.5,
    vyMax: h * 0.85,
    vxSpread: w * 0.4,
  };
}

export interface SuccessBurstProps {
  /** Bumping this restarts the burst. Omit for a single fire on mount. */
  trigger?: number | string;
  /** Extra seed mixed into the field so repeats don't look identical. */
  seed?: number;
  /** Requested piece count; hard-capped at {@link MAX_BURST_PIECES}. */
  pieces?: number;
  style?: StyleProp<ViewStyle>;
  /** Called once the burst has fully faded (for unmount/cleanup by the owner). */
  onDone?: () => void;
}

export function SuccessBurst({ trigger, seed = 1, pieces = 16, style, onDone }: SuccessBurstProps) {
  const reducedMotion = useReducedMotion();
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Absolute clock in SECONDS. Driven once per fire; the picture reads it.
  const clock = useSharedValue(0);

  // Numeric seed derived from trigger so string triggers still vary the field.
  const fieldSeed = useMemo(() => {
    const base = typeof trigger === 'number' ? trigger : hashString(String(trigger ?? ''));
    return (base ^ (seed * 0x9e3779b9)) >>> 0;
  }, [trigger, seed]);

  // Spawn the pooled field ONCE per (size, seed, pieces).
  const field = useMemo<Particle[]>(() => {
    if (size.w <= 0) return [];
    return spawnConfetti(fieldSeed, burstConfig(pieces, size.w, size.h));
  }, [fieldSeed, pieces, size]);

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
      paint.setColor(BURST_COLORS[s.colorIndex % BURST_COLORS.length]!);
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

  // Reduced motion: nothing — callers keep a static signal for the meaning.
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

export default SuccessBurst;
