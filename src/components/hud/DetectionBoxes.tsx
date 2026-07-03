/**
 * Debug overlay: draws a bold colored box on EVERY raw model detection this
 * frame — ball (orange), rim (green), made (gold), person (blue) — so you can
 * SEE in real time whether the detector is firing, even with just a ball and no
 * hoop. Gated by Settings > Debug mode. Same analysis→view mapping as
 * TrajectoryOverlay (letterbox camera→square, composed with cover→view).
 *
 * CRASH-SAFETY: every derived value is an explicit top-level hook (no hooks in a
 * helper), and each path builder guards `o.dets` (defensive against any overlay
 * state without the array) — a throw inside a UI-thread worklet is a hard crash.
 */
import React from 'react';
import { StyleSheet, type LayoutChangeEvent } from 'react-native';
import { Canvas, Path, Skia, rect, rrect } from '@shopify/react-native-skia';
import {
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

import type { OverlayState } from '../../camera/useShotEngine';
import { color } from '../../constants/tokens';

const DEFAULT_SOURCE_ASPECT = 9 / 16;

interface Mapping {
  ok: boolean;
  scale: number;
  ox: number;
  oy: number;
}

/** Build a Skia path of all detection boxes for one class. Pure worklet. */
function classPath(o: OverlayState, m: Mapping, cls: string) {
  'worklet';
  const p = Skia.Path.Make();
  if (!m.ok) return p;
  const dets = o.dets;
  if (dets == null || !Array.isArray(dets)) return p;
  for (let i = 0; i < dets.length; i++) {
    const d = dets[i];
    if (d == null || d.cls !== cls) continue;
    const x = d.x * m.scale + m.ox;
    const y = d.y * m.scale + m.oy;
    const w = d.w * m.scale;
    const h = d.h * m.scale;
    if (!(w > 0) || !(h > 0)) continue;
    p.addRRect(rrect(rect(x, y, w, h), 8, 8));
  }
  return p;
}

export function DetectionBoxes({
  overlay,
  sourceAspect = DEFAULT_SOURCE_ASPECT,
}: {
  overlay: SharedValue<OverlayState>;
  sourceAspect?: number;
}) {
  const viewSize = useSharedValue({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    viewSize.value = { w: width, h: height };
  };

  const mapping = useDerivedValue<Mapping>(() => {
    const o = overlay.value;
    const { w, h } = viewSize.value;
    if (w <= 0 || h <= 0 || o.frameW <= 0 || o.frameH <= 0) {
      return { ok: false, scale: 0, ox: 0, oy: 0 };
    }
    const aspect = Math.min(1, Math.max(0.1, sourceAspect));
    const side = Math.max(o.frameW, o.frameH);
    const landscape = w > h;
    const contentW = landscape ? side : side * aspect;
    const contentH = landscape ? side * aspect : side;
    const scale = Math.max(w / contentW, h / contentH);
    return { ok: true, scale, ox: w / 2 - (o.frameW / 2) * scale, oy: h / 2 - (o.frameH / 2) * scale };
  });

  // Explicit top-level derived values (no hooks-in-a-helper).
  const ballPath = useDerivedValue(() => classPath(overlay.value, mapping.value, 'ball'));
  const rimPath = useDerivedValue(() => classPath(overlay.value, mapping.value, 'rim'));
  const madePath = useDerivedValue(() => classPath(overlay.value, mapping.value, 'ball_in_basket'));
  const personPath = useDerivedValue(() => classPath(overlay.value, mapping.value, 'person'));

  return (
    <Canvas style={StyleSheet.absoluteFill} onLayout={onLayout} pointerEvents="none">
      <Path path={personPath} color={color.info} style="stroke" strokeWidth={2.5} />
      <Path path={rimPath} color={color.make} style="stroke" strokeWidth={4} />
      <Path path={madePath} color={color.threePt} style="stroke" strokeWidth={4} />
      <Path path={ballPath} color={color.accent} style="stroke" strokeWidth={4} />
    </Canvas>
  );
}
