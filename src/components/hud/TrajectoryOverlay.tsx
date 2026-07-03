/**
 * TrajectoryOverlay — the broadcast-grade tracking canvas over the live scene.
 *
 * A transparent Skia layer that redraws every analysed frame straight from the
 * engine's OverlayState SharedValue (no per-frame React state). Four stacked
 * effects, back to front:
 *
 *   1. Rim reticle — a lock-on with four corner brackets that "snap" toward the
 *      rim, resting chalk-white and flaring swish-green while a shot is live.
 *   2. Comet trail — the shot arc as a glowing multi-layer trail: a wide soft
 *      bloom, a bright core stroke, and a tapered head, all quad-smoothed.
 *   3. Comet head — the ball as a bright chalk core inside a warm halo and an
 *      outer accent bloom, so it reads as light, not a sticker.
 *   4. Ball reticle — a thin tracking ring + crosshair ticks around the ball
 *      when no shot is live, so idle tracking still looks intentional.
 *
 * Coordinate mapping (unchanged): analysis frame → view pixels via the mirrored
 * "cover" transform (scale so the analysis square covers the view, center-crop).
 * All per-frame math lives inside useDerivedValue worklets.
 */
import React from 'react';
import { StyleSheet, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import {
  BlurMask,
  Canvas,
  Circle,
  Group,
  Path,
  Skia,
} from '@shopify/react-native-skia';
import {
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';

import type { OverlayState } from '../../camera/useShotEngine';
import { color, glow } from '../../constants/tokens';

/** Widths of the three stacked trail passes (bloom → core → hot). */
const TRAIL_BLOOM = 16;
const TRAIL_CORE = 5;
const TRAIL_HOT = 2;
/** Corner-bracket arm length as a fraction of the rim box's shorter side. */
const BRACKET_FRAC = 0.28;
const BRACKET_STROKE = 3;

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

  // A free-running 0→1→0 pulse drives the rim's "breathing" glow. Ambient, so
  // the lock never looks frozen even between shots.
  const pulse = useSharedValue(0);
  React.useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse]);

  // --- cover transform helpers (worklet-local) -----------------------------
  const mapping = useDerivedValue(() => {
    const o = overlay.value;
    const { w, h } = viewSize.value;
    if (w <= 0 || h <= 0 || o.frameW <= 0 || o.frameH <= 0) {
      return { ok: false, scale: 0, ox: 0, oy: 0 };
    }
    const scale = Math.max(w / o.frameW, h / o.frameH);
    return {
      ok: true,
      scale,
      ox: (w - o.frameW * scale) / 2,
      oy: (h - o.frameH * scale) / 2,
    };
  });

  // --- shot-arc trail ------------------------------------------------------
  const trajPath = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const o = overlay.value;
    const m = mapping.value;
    if (!m.ok) return path;
    const pts = o.traj;
    const n = pts.length >> 1;
    if (n < 2) return path;

    const x0 = pts[0]! * m.scale + m.ox;
    const y0 = pts[1]! * m.scale + m.oy;
    path.moveTo(x0, y0);
    // Smooth: quad through midpoints, previous sample as control point.
    let px = x0;
    let py = y0;
    for (let i = 1; i < n; i++) {
      const x = pts[i * 2]! * m.scale + m.ox;
      const y = pts[i * 2 + 1]! * m.scale + m.oy;
      path.quadTo(px, py, (px + x) / 2, (py + y) / 2);
      px = x;
      py = y;
    }
    path.lineTo(px, py);
    return path;
  });

  const trailOpacity = useDerivedValue(() => {
    const phase = overlay.value.phase;
    if (phase === 'SHOT_LIVE') return 1;
    if (phase === 'COOLDOWN') return 0.45;
    return 0;
  });
  const bloomOpacity = useDerivedValue(() => trailOpacity.value * 0.5);

  // --- ball comet ----------------------------------------------------------
  const ballCx = useDerivedValue(() => {
    const o = overlay.value;
    const m = mapping.value;
    if (o.ball == null || !m.ok) return -100;
    return o.ball.x * m.scale + m.ox;
  });
  const ballCy = useDerivedValue(() => {
    const o = overlay.value;
    const m = mapping.value;
    if (o.ball == null || !m.ok) return -100;
    return o.ball.y * m.scale + m.oy;
  });
  const ballR = useDerivedValue(() => {
    const o = overlay.value;
    const m = mapping.value;
    if (o.ball == null || !m.ok) return 0;
    return Math.max(3, o.ball.r * m.scale);
  });
  const coreR = useDerivedValue(() => ballR.value * 0.62);
  const haloR = useDerivedValue(() => ballR.value * 1.05);
  const bloomR = useDerivedValue(() => ballR.value * 2.3);
  const ballBloomOpacity = useDerivedValue(() =>
    ballR.value > 0 ? (overlay.value.phase === 'SHOT_LIVE' ? 0.6 : 0.4) : 0,
  );
  const ballVisible = useDerivedValue(() => (ballR.value > 0 ? 1 : 0));

  // Idle tracking reticle: a thin ring + four crosshair ticks around the ball,
  // shown only when no shot is live so a live comet stays clean.
  const reticlePath = useDerivedValue(() => {
    const p = Skia.Path.Make();
    if (ballR.value <= 0 || overlay.value.phase === 'SHOT_LIVE') return p;
    const cx = ballCx.value;
    const cy = ballCy.value;
    const rr = ballR.value * 1.55;
    const tick = ballR.value * 0.5;
    p.addCircle(cx, cy, rr);
    // top / bottom / left / right ticks
    p.moveTo(cx, cy - rr - tick);
    p.lineTo(cx, cy - rr);
    p.moveTo(cx, cy + rr);
    p.lineTo(cx, cy + rr + tick);
    p.moveTo(cx - rr - tick, cy);
    p.lineTo(cx - rr, cy);
    p.moveTo(cx + rr, cy);
    p.lineTo(cx + rr + tick, cy);
    return p;
  });
  const reticleOpacity = useDerivedValue(() =>
    ballR.value > 0 && overlay.value.phase !== 'SHOT_LIVE'
      ? 0.35 + pulse.value * 0.25
      : 0,
  );

  // --- rim lock-on ---------------------------------------------------------
  const rimRect = useDerivedValue(() => {
    const o = overlay.value;
    const m = mapping.value;
    if (o.rim == null || !m.ok) return null;
    return {
      x: o.rim.x * m.scale + m.ox,
      y: o.rim.y * m.scale + m.oy,
      w: o.rim.width * m.scale,
      h: o.rim.height * m.scale,
    };
  });

  const rimLive = useDerivedValue(() => overlay.value.phase === 'SHOT_LIVE');

  /** Four corner brackets; on a live shot they cinch inward toward the rim. */
  const bracketPath = useDerivedValue(() => {
    const p = Skia.Path.Make();
    const r = rimRect.value;
    if (r == null) return p;
    const arm = Math.min(r.w, r.h) * BRACKET_FRAC;
    // inset grows on live so the lock visibly "snaps"
    const inset = rimLive.value ? Math.min(r.w, r.h) * 0.08 : 0;
    const x0 = r.x + inset;
    const y0 = r.y + inset;
    const x1 = r.x + r.w - inset;
    const y1 = r.y + r.h - inset;
    // TL
    p.moveTo(x0, y0 + arm); p.lineTo(x0, y0); p.lineTo(x0 + arm, y0);
    // TR
    p.moveTo(x1 - arm, y0); p.lineTo(x1, y0); p.lineTo(x1, y0 + arm);
    // BR
    p.moveTo(x1, y1 - arm); p.lineTo(x1, y1); p.lineTo(x1 - arm, y1);
    // BL
    p.moveTo(x0 + arm, y1); p.lineTo(x0, y1); p.lineTo(x0, y1 - arm);
    return p;
  });

  const bracketColor = useDerivedValue(() =>
    rimLive.value ? glow.rimLive : glow.rimIdle,
  );
  const bracketOpacity = useDerivedValue(() => {
    if (rimRect.value == null) return 0;
    return rimLive.value ? 1 : 0.55 + pulse.value * 0.2;
  });

  // A soft fill wash inside the rim while the shot is live — the "target
  // acquired" glow that reads as green from across the court.
  const rimFillCx = useDerivedValue(() => {
    const r = rimRect.value;
    return r == null ? -100 : r.x + r.w / 2;
  });
  const rimFillCy = useDerivedValue(() => {
    const r = rimRect.value;
    return r == null ? -100 : r.y + r.h / 2;
  });
  const rimFillR = useDerivedValue(() => {
    const r = rimRect.value;
    return r == null ? 0 : Math.max(r.w, r.h) * 0.62;
  });
  const rimFillOpacity = useDerivedValue(() =>
    rimRect.value != null && rimLive.value ? 0.22 + pulse.value * 0.12 : 0,
  );

  return (
    <Canvas style={[StyleSheet.absoluteFill, style]} pointerEvents="none" onLayout={onLayout}>
      {/* Rim: live fill wash (blurred green bloom) */}
      <Circle cx={rimFillCx} cy={rimFillCy} r={rimFillR} color={glow.rimLiveGlow} opacity={rimFillOpacity}>
        <BlurMask blur={18} style="normal" />
      </Circle>

      {/* Rim: corner brackets, glow pass then crisp pass */}
      <Group>
        <Path
          path={bracketPath}
          style="stroke"
          strokeWidth={BRACKET_STROKE + 4}
          strokeCap="round"
          strokeJoin="round"
          color={bracketColor}
          opacity={bracketOpacity}
        >
          <BlurMask blur={7} style="normal" />
        </Path>
        <Path
          path={bracketPath}
          style="stroke"
          strokeWidth={BRACKET_STROKE}
          strokeCap="round"
          strokeJoin="round"
          color={bracketColor}
          opacity={bracketOpacity}
        />
      </Group>

      {/* Trail: soft bloom pass */}
      <Path
        path={trajPath}
        style="stroke"
        strokeWidth={TRAIL_BLOOM}
        strokeCap="round"
        strokeJoin="round"
        color={glow.trailBloom}
        opacity={bloomOpacity}
      >
        <BlurMask blur={12} style="normal" />
      </Path>
      {/* Trail: core stroke */}
      <Path
        path={trajPath}
        style="stroke"
        strokeWidth={TRAIL_CORE}
        strokeCap="round"
        strokeJoin="round"
        color={glow.trail}
        opacity={trailOpacity}
      />
      {/* Trail: hot white centerline */}
      <Path
        path={trajPath}
        style="stroke"
        strokeWidth={TRAIL_HOT}
        strokeCap="round"
        strokeJoin="round"
        color={glow.cometHalo}
        opacity={trailOpacity}
      />

      {/* Idle ball reticle */}
      <Path
        path={reticlePath}
        style="stroke"
        strokeWidth={1.5}
        strokeCap="round"
        color={glow.reticle}
        opacity={reticleOpacity}
      />

      {/* Comet head: outer bloom → warm halo → chalk core */}
      <Circle cx={ballCx} cy={ballCy} r={bloomR} color={glow.trailBloom} opacity={ballBloomOpacity}>
        <BlurMask blur={14} style="normal" />
      </Circle>
      <Circle cx={ballCx} cy={ballCy} r={haloR} color={glow.cometHalo} opacity={ballVisible}>
        <BlurMask blur={4} style="normal" />
      </Circle>
      <Circle cx={ballCx} cy={ballCy} r={coreR} color={glow.cometCore} opacity={ballVisible} />
      {/* faint accent ring so the ball keeps leather identity up close */}
      <Circle
        cx={ballCx}
        cy={ballCy}
        r={ballR}
        style="stroke"
        strokeWidth={1.5}
        color={color.accent}
        opacity={ballVisible}
      />
    </Canvas>
  );
}
