/**
 * Debug overlay: draws a bold colored box on EVERY raw model detection this
 * frame — ball (orange), rim (green), made (gold), person (blue) — so you can
 * SEE in real time whether the detector is firing, even with just a ball and no
 * hoop. Gated by Settings > Debug mode. Same analysis→view mapping as
 * TrajectoryOverlay (letterbox camera→640 square, composed with cover→view).
 */
import React from 'react';
import { StyleSheet, type LayoutChangeEvent } from 'react-native';
import { Canvas, Path, Skia, rect, rrect } from '@shopify/react-native-skia';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';

import type { OverlayState } from '../../camera/useShotEngine';
import { color } from '../../constants/tokens';

const DEFAULT_SOURCE_ASPECT = 9 / 16;

/** class → stroke color. */
const CLASS_COLOR: Record<string, string> = {
  ball: color.accent,
  rim: color.make,
  ball_in_basket: color.threePt,
  person: color.info,
};

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

  const mapping = useDerivedValue(() => {
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

  const pathFor = (cls: string) =>
    useDerivedValue(() => {
      const p = Skia.Path.Make();
      const o = overlay.value;
      const m = mapping.value;
      if (!m.ok) return p;
      for (const d of o.dets) {
        if (d.cls !== cls) continue;
        const x = d.x * m.scale + m.ox;
        const y = d.y * m.scale + m.oy;
        const w = d.w * m.scale;
        const h = d.h * m.scale;
        p.addRRect(rrect(rect(x, y, w, h), 8, 8));
      }
      return p;
    });

  const ballPath = pathFor('ball');
  const rimPath = pathFor('rim');
  const madePath = pathFor('ball_in_basket');
  const personPath = pathFor('person');

  return (
    <Canvas style={StyleSheet.absoluteFill} onLayout={onLayout} pointerEvents="none">
      <Path path={personPath} color={CLASS_COLOR.person} style="stroke" strokeWidth={2.5} />
      <Path path={rimPath} color={CLASS_COLOR.rim} style="stroke" strokeWidth={4} />
      <Path path={madePath} color={CLASS_COLOR.ball_in_basket} style="stroke" strokeWidth={4} />
      <Path path={ballPath} color={CLASS_COLOR.ball} style="stroke" strokeWidth={4} />
    </Canvas>
  );
}
