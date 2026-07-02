/**
 * TrajectoryOverlay — transparent Skia canvas over the camera/demo scene.
 *
 * Draws, at 30fps, entirely from the engine's OverlayState SharedValue:
 * - the shot-arc trail (quad-smoothed path in leather orange, fading by phase)
 * - the ball "comet" head (chalk core + translucent accent glow)
 * - the locked rim box (swish green while a shot is live)
 *
 * All per-frame math lives inside useDerivedValue worklets — no React state
 * is touched per frame. Analysis coords (640×640, resizer scaleMode 'cover')
 * are mapped to view pixels with the mirrored cover transform: scale so the
 * analysis square covers the view, then center-crop offsets.
 */
import React from 'react';
import { StyleSheet, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { Canvas, Circle, Path, RoundedRect, Skia } from '@shopify/react-native-skia';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';

import type { OverlayState } from '../../camera/useShotEngine';
import { color, radius } from '../../constants/tokens';

const TRAIL_WIDTH = 4;
const RIM_STROKE = 3;

export function TrajectoryOverlay({
  overlay,
  style,
}: {
  overlay: SharedValue<OverlayState>;
  style?: StyleProp<ViewStyle>;
}) {
  const viewSize = useSharedValue({ w: 0, h: 0 });

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    viewSize.value = { w: width, h: height };
  };

  // --- shot-arc trail ------------------------------------------------------
  const trajPath = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const o = overlay.value;
    const { w, h } = viewSize.value;
    if (w <= 0 || h <= 0 || o.frameW <= 0 || o.frameH <= 0) return path;
    const pts = o.traj;
    const n = pts.length >> 1;
    if (n < 2) return path;

    // cover mapping: analysis frame scaled up to cover the view, centered.
    const scale = Math.max(w / o.frameW, h / o.frameH);
    const ox = (w - o.frameW * scale) / 2;
    const oy = (h - o.frameH * scale) / 2;

    const x0 = pts[0]! * scale + ox;
    const y0 = pts[1]! * scale + oy;
    path.moveTo(x0, y0);
    // Smooth: quad through midpoints, previous sample as control point.
    let px = x0;
    let py = y0;
    for (let i = 1; i < n; i++) {
      const x = pts[i * 2]! * scale + ox;
      const y = pts[i * 2 + 1]! * scale + oy;
      path.quadTo(px, py, (px + x) / 2, (py + y) / 2);
      px = x;
      py = y;
    }
    path.lineTo(px, py);
    return path;
  });

  const trailOpacity = useDerivedValue(() => {
    const phase = overlay.value.phase;
    if (phase === 'SHOT_LIVE') return 0.95;
    if (phase === 'COOLDOWN') return 0.4;
    return 0;
  });

  // --- ball comet head -----------------------------------------------------
  const ballCx = useDerivedValue(() => {
    const o = overlay.value;
    const { w, h } = viewSize.value;
    if (o.ball == null || w <= 0 || h <= 0) return 0;
    const scale = Math.max(w / o.frameW, h / o.frameH);
    return o.ball.x * scale + (w - o.frameW * scale) / 2;
  });
  const ballCy = useDerivedValue(() => {
    const o = overlay.value;
    const { w, h } = viewSize.value;
    if (o.ball == null || w <= 0 || h <= 0) return 0;
    const scale = Math.max(w / o.frameW, h / o.frameH);
    return o.ball.y * scale + (h - o.frameH * scale) / 2;
  });
  const ballR = useDerivedValue(() => {
    const o = overlay.value;
    const { w, h } = viewSize.value;
    if (o.ball == null || w <= 0 || h <= 0) return 0;
    return o.ball.r * Math.max(w / o.frameW, h / o.frameH);
  });
  const glowR = useDerivedValue(() => ballR.value * 1.9);
  const glowOpacity = useDerivedValue(() => (ballR.value > 0 ? 0.35 : 0));

  // --- rim box --------------------------------------------------------------
  const rimX = useDerivedValue(() => {
    const o = overlay.value;
    const { w, h } = viewSize.value;
    if (o.rim == null || w <= 0 || h <= 0) return 0;
    const scale = Math.max(w / o.frameW, h / o.frameH);
    return o.rim.x * scale + (w - o.frameW * scale) / 2;
  });
  const rimY = useDerivedValue(() => {
    const o = overlay.value;
    const { w, h } = viewSize.value;
    if (o.rim == null || w <= 0 || h <= 0) return 0;
    const scale = Math.max(w / o.frameW, h / o.frameH);
    return o.rim.y * scale + (h - o.frameH * scale) / 2;
  });
  const rimW = useDerivedValue(() => {
    const o = overlay.value;
    const { w, h } = viewSize.value;
    if (o.rim == null || w <= 0 || h <= 0) return 0;
    return o.rim.width * Math.max(w / o.frameW, h / o.frameH);
  });
  const rimH = useDerivedValue(() => {
    const o = overlay.value;
    const { w, h } = viewSize.value;
    if (o.rim == null || w <= 0 || h <= 0) return 0;
    return o.rim.height * Math.max(w / o.frameW, h / o.frameH);
  });
  const rimColor = useDerivedValue(() =>
    overlay.value.phase === 'SHOT_LIVE' ? color.make : color.border,
  );
  const rimOpacity = useDerivedValue(() =>
    overlay.value.phase === 'SHOT_LIVE' ? 1 : 0.6,
  );

  return (
    <Canvas style={[StyleSheet.absoluteFill, style]} pointerEvents="none" onLayout={onLayout}>
      <RoundedRect
        x={rimX}
        y={rimY}
        width={rimW}
        height={rimH}
        r={radius.sm}
        style="stroke"
        strokeWidth={RIM_STROKE}
        color={rimColor}
        opacity={rimOpacity}
      />
      <Path
        path={trajPath}
        style="stroke"
        strokeWidth={TRAIL_WIDTH}
        strokeCap="round"
        strokeJoin="round"
        color={color.accent}
        opacity={trailOpacity}
      />
      <Circle cx={ballCx} cy={ballCy} r={glowR} color={color.accent} opacity={glowOpacity} />
      <Circle cx={ballCx} cy={ballCy} r={ballR} color={color.text} />
    </Canvas>
  );
}
