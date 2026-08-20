/**
 * CalibrationScenes — animated Skia mini-scenes for the calibration guide.
 *
 * Three 96x72 placement scenes (side / frame / height) replace the old static
 * pure-View sketches, plus a full-width TapOrderScene that lights the 5
 * calibration landmarks in ritual order on a half-court diagram.
 *
 * Motion contract:
 * - ONE shared-value clock per mounted scene, looped with withRepeat/
 *   withTiming over SCENE_LOOP_MS and cancelled on unmount.
 * - useReducedMotion() ⇒ no loop; the clock is pinned to 1, which every pose
 *   helper defines as a complete, readable static diagram (same meaning as
 *   the old static sketches).
 * - Retained-mode Skia elements only, driven by useDerivedValue scalars; all
 *   Paths and points are precomputed at mount from the pure keyframe module
 *   (calibrationSceneMath.ts), so the per-frame work is allocation-light.
 * - Tokens-only colors (glow.* for the rim pulse / lock bracket).
 *
 * Accessibility: scenes are decorative. Each Canvas is wrapped in a View with
 * accessible={false} + importantForAccessibility="no-hide-descendants" — the
 * row title/body (and the TapOrderScene caption rendered OUTSIDE the canvas
 * by the guide screen) carry the meaning.
 */
import { Canvas, Circle, Path, Rect, RoundedRect, Skia } from '@shopify/react-native-skia';
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  Easing,
  cancelAnimation,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { color, glow, radius } from '@/constants/tokens';
import {
  HEIGHT_PHONE_TO_Y,
  SCENE_H,
  SCENE_LOOP_MS,
  SCENE_W,
  SIDE_PHONE_TO_X,
  courtPathSvg,
  framePose,
  heightPose,
  sidePose,
  tapDotPoints,
  tapPose,
} from './calibrationSceneMath';

/**
 * One clock per mounted scene: 0 → 1 over SCENE_LOOP_MS, looping forever.
 * Under reduced motion the loop never starts and the clock is pinned to 1 —
 * the final pose, which the pure module guarantees is a full static diagram.
 */
function useSceneClock(): SharedValue<number> {
  const reducedMotion = useReducedMotion();
  const clock = useSharedValue(0);
  useEffect(() => {
    if (reducedMotion) {
      clock.value = 1;
      return;
    }
    clock.value = 0;
    clock.value = withRepeat(
      withTiming(1, { duration: SCENE_LOOP_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(clock);
  }, [clock, reducedMotion]);
  return clock;
}

// --- 'side' scene: phone glides to the side, sight-line draws to the rim ----

const PHONE_W = 7;
const PHONE_H = 13;
const SIDE_BAND = { x: 8, y: SCENE_H - 22, w: SCENE_W - 16, h: 14 };
const SIDE_RIM = { cx: 17, cy: 20, r: 4 };
const SIDE_POLE = { x: 16, y: SIDE_RIM.cy + 2, w: 2, h: SIDE_BAND.y - SIDE_RIM.cy - 2 };
const SIDE_PHONE_Y = SIDE_BAND.y - PHONE_H + 4;

function SideScene({ clock }: { clock: SharedValue<number> }) {
  const pose = useDerivedValue(() => sidePose(clock.value));
  const phoneX = useDerivedValue(() => pose.value.phoneX * SCENE_W - PHONE_W / 2);
  const lineEnd = useDerivedValue(() => pose.value.lineProgress);
  const pulseR = useDerivedValue(() => SIDE_RIM.r + 1.5 + pose.value.rimPulse * 4);
  const pulseOpacity = useDerivedValue(() => pose.value.rimPulse * 0.45);

  // Sight-line from the phone's SIDE spot to the rim. The line only starts
  // drawing at t = 0.35, when the phone has already settled at its end X, so
  // a static path is exact.
  const sightPath = useMemo(() => {
    const p = Skia.Path.Make();
    p.moveTo(SIDE_PHONE_TO_X * SCENE_W - PHONE_W / 2 - 2, SIDE_PHONE_Y + 3);
    p.lineTo(SIDE_RIM.cx + SIDE_RIM.r + 1, SIDE_RIM.cy + 1);
    return p;
  }, []);

  return (
    <Canvas style={styles.scene}>
      <RoundedRect
        x={SIDE_BAND.x}
        y={SIDE_BAND.y}
        width={SIDE_BAND.w}
        height={SIDE_BAND.h}
        r={2}
        color={color.surfaceRaised}
      />
      <Rect
        x={SIDE_POLE.x}
        y={SIDE_POLE.y}
        width={SIDE_POLE.w}
        height={SIDE_POLE.h}
        color={color.hudGlassBorder}
      />
      <Circle
        cx={SIDE_RIM.cx}
        cy={SIDE_RIM.cy}
        r={pulseR}
        color={glow.trailBloom}
        opacity={pulseOpacity}
      />
      <Circle cx={SIDE_RIM.cx} cy={SIDE_RIM.cy} r={SIDE_RIM.r} color={color.accent} />
      <Path
        path={sightPath}
        style="stroke"
        strokeWidth={1.5}
        color={color.textDim}
        start={0}
        end={lineEnd}
      />
      <RoundedRect
        x={phoneX}
        y={SIDE_PHONE_Y}
        width={PHONE_W}
        height={PHONE_H}
        r={1.5}
        color={color.surfaceRaised}
      />
      <RoundedRect
        x={phoneX}
        y={SIDE_PHONE_Y}
        width={PHONE_W}
        height={PHONE_H}
        r={1.5}
        style="stroke"
        strokeWidth={1}
        color={color.textDim}
      />
    </Canvas>
  );
}

// --- 'frame' scene: rim drifts into the upper-third bracket -----------------

/** Viewfinder rectangle (the phone's screen) centered in the scene. */
const VF = { x: 31, y: 6, w: 34, h: 60 };
const BRACKET_W = 18;
const BRACKET_H = 13;
const BRACKET_CX = VF.x + VF.w / 2;
const BRACKET_CY = VF.y + VF.h / 3;
const VF_FLOOR = { x: VF.x + 4, y: VF.y + VF.h - 10, w: VF.w - 8, h: 1 };

function FrameScene({ clock }: { clock: SharedValue<number> }) {
  const pose = useDerivedValue(() => framePose(clock.value));
  const rimCx = useDerivedValue(() => VF.x + pose.value.rimX * VF.w);
  const rimCy = useDerivedValue(() => VF.y + pose.value.rimY * VF.h);
  const brX = useDerivedValue(() => BRACKET_CX - (BRACKET_W / 2) * pose.value.bracketScale);
  const brY = useDerivedValue(() => BRACKET_CY - (BRACKET_H / 2) * pose.value.bracketScale);
  const brW = useDerivedValue(() => BRACKET_W * pose.value.bracketScale);
  const brH = useDerivedValue(() => BRACKET_H * pose.value.bracketScale);
  const brOpacity = useDerivedValue(() => pose.value.bracketAlpha);
  const floorOpacity = useDerivedValue(() => pose.value.floorAlpha * 0.9);

  return (
    <Canvas style={styles.scene}>
      <RoundedRect
        x={VF.x}
        y={VF.y}
        width={VF.w}
        height={VF.h}
        r={4}
        style="stroke"
        strokeWidth={1}
        color={color.textDim}
      />
      <Rect
        x={VF_FLOOR.x}
        y={VF_FLOOR.y}
        width={VF_FLOOR.w}
        height={VF_FLOOR.h}
        color={color.hudGlassBorder}
        opacity={floorOpacity}
      />
      <Circle cx={rimCx} cy={rimCy} r={4} color={color.accent} />
      <RoundedRect
        x={brX}
        y={brY}
        width={brW}
        height={brH}
        r={2}
        style="stroke"
        strokeWidth={1.5}
        color={glow.rimIdle}
        opacity={brOpacity}
      />
    </Canvas>
  );
}

// --- 'height' scene: phone rises to the chest-height band -------------------

const H_FLOOR = { x: 10, y: SCENE_H - 8, w: SCENE_W - 20, h: 1 };
const H_POLE = { x: SCENE_W / 2 - 1, y: 12, w: 2, h: SCENE_H - 8 - 12 };
const H_TICK_Y = HEIGHT_PHONE_TO_Y * SCENE_H;
const H_TICK = { x: SCENE_W / 2 - 11, y: H_TICK_Y - 1, w: 22, h: 2 };
const H_PHONE_W = 9;
const H_PHONE_H = 15;
const H_PHONE_X = SCENE_W / 2 - H_PHONE_W / 2;

function HeightScene({ clock }: { clock: SharedValue<number> }) {
  const pose = useDerivedValue(() => heightPose(clock.value));
  const phoneY = useDerivedValue(() => pose.value.phoneY * SCENE_H - H_PHONE_H / 2);
  const tickOpacity = useDerivedValue(() => pose.value.tickAlpha);

  // Tripod feet at the floor — a filled triangle under the pole.
  const tripod = useMemo(
    () =>
      Skia.Path.MakeFromSVGString(
        `M ${SCENE_W / 2 - 9} ${H_FLOOR.y} L ${SCENE_W / 2 + 9} ${H_FLOOR.y} L ${SCENE_W / 2} ${H_FLOOR.y - 12} Z`,
      ),
    [],
  );

  return (
    <Canvas style={styles.scene}>
      <Rect x={H_FLOOR.x} y={H_FLOOR.y} width={H_FLOOR.w} height={H_FLOOR.h} color={color.hudGlassBorder} />
      <Rect x={H_POLE.x} y={H_POLE.y} width={H_POLE.w} height={H_POLE.h} color={color.hudGlassBorder} />
      {tripod && <Path path={tripod} color={color.surfaceRaised} />}
      <Rect
        x={H_TICK.x}
        y={H_TICK.y}
        width={H_TICK.w}
        height={H_TICK.h}
        color={color.accent}
        opacity={tickOpacity}
      />
      <RoundedRect
        x={H_PHONE_X}
        y={phoneY}
        width={H_PHONE_W}
        height={H_PHONE_H}
        r={2}
        color={color.surfaceRaised}
      />
      <RoundedRect
        x={H_PHONE_X}
        y={phoneY}
        width={H_PHONE_W}
        height={H_PHONE_H}
        r={2}
        style="stroke"
        strokeWidth={1}
        color={color.textDim}
      />
    </Canvas>
  );
}

/** One 96x72 placement mini-scene. Decorative — hidden from screen readers. */
export function CalibrationScene({ kind }: { kind: 'side' | 'frame' | 'height' }) {
  const clock = useSceneClock();
  return (
    <View style={styles.sceneBox} accessible={false} importantForAccessibility="no-hide-descendants">
      {kind === 'side' && <SideScene clock={clock} />}
      {kind === 'frame' && <FrameScene clock={clock} />}
      {kind === 'height' && <HeightScene clock={clock} />}
    </View>
  );
}

// --- Tap-order scene ---------------------------------------------------------

const TAP_SCENE_H = 140;
/** Inset so baseline/corner dots at the diagram edge are never clipped. */
const TAP_PAD = 14;
const DOT_R = 5;

/** One landmark dot + its tap ripple, lit at its ritual moment. */
function TapDot({
  clock,
  x,
  y,
  order,
}: {
  clock: SharedValue<number>;
  x: number;
  y: number;
  order: number;
}) {
  const pose = useDerivedValue(() => tapPose(clock.value, order));
  const dotOpacity = useDerivedValue(() => (pose.value.lit ? 1 : 0.28));
  const rippleR = useDerivedValue(() => DOT_R + pose.value.ripple * 11);
  const rippleOpacity = useDerivedValue(() => {
    const r = pose.value.ripple;
    // Invisible both before the tap (0) and once fully expanded (1), so the
    // reduced-motion frame (clock = 1) shows five calm lit dots.
    return r > 0 && r < 1 ? (1 - r) * 0.55 : 0;
  });
  return (
    <>
      <Circle
        cx={x}
        cy={y}
        r={rippleR}
        style="stroke"
        strokeWidth={1.5}
        color={color.accent}
        opacity={rippleOpacity}
      />
      <Circle cx={x} cy={y} r={DOT_R} color={color.accent} opacity={dotOpacity} />
    </>
  );
}

/**
 * Full-width half-court diagram (height 140): baseline at the bottom, the
 * corner-3 posts + arc and the FT line, with the 5 calibration landmarks
 * lighting up in ritual order. Decorative — callers render the tap-order
 * caption OUTSIDE this canvas so the meaning stays accessible.
 */
export function TapOrderScene({ style }: { style?: StyleProp<ViewStyle> }) {
  const clock = useSceneClock();
  const [size, setSize] = useState({ w: 0, h: 0 });

  const dots = useMemo(() => {
    if (size.w <= 0 || size.h <= 0) return [];
    return tapDotPoints(size.w - TAP_PAD * 2, size.h - TAP_PAD * 2).map((p) => ({
      ...p,
      x: p.x + TAP_PAD,
      y: p.y + TAP_PAD,
    }));
  }, [size]);

  const court = useMemo(() => {
    if (size.w <= 0 || size.h <= 0) return null;
    return Skia.Path.MakeFromSVGString(courtPathSvg(size.w - TAP_PAD * 2, size.h - TAP_PAD * 2));
  }, [size]);

  return (
    <View
      style={[styles.tapBox, style]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      {court && (
        <Canvas style={styles.fill}>
          <Path
            path={court}
            style="stroke"
            strokeWidth={1.5}
            color={color.hudGlassBorder}
            transform={[{ translateX: TAP_PAD }, { translateY: TAP_PAD }]}
          />
          {dots.map((d) => (
            <TapDot key={d.order} clock={clock} x={d.x} y={d.y} order={d.order} />
          ))}
        </Canvas>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sceneBox: {
    width: SCENE_W,
    height: SCENE_H,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    backgroundColor: color.bg,
    overflow: 'hidden',
  },
  scene: {
    width: SCENE_W,
    height: SCENE_H,
  },
  tapBox: {
    alignSelf: 'stretch',
    height: TAP_SCENE_H,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    backgroundColor: color.bg,
    overflow: 'hidden',
  },
  fill: {
    flex: 1,
  },
});
