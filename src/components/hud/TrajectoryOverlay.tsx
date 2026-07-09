/**
 * TrajectoryOverlay — the broadcast-grade tracking canvas over the live scene.
 *
 * A transparent Skia layer that redraws every analysed frame straight from the
 * engine's OverlayState SharedValue (no per-frame React state). Stacked
 * effects, back to front:
 *
 *   1. Rim reticle — a lock-on with four corner brackets that "snap" toward the
 *      rim, resting chalk-white and flaring swish-green while a shot is live.
 *   2. Full-flight arc — the observed global parabola as a dashed guide, now
 *      GRADED by entry-angle quality (green ideal / amber flat-steep) with a
 *      diamond marker at the apex.
 *   3. Comet trail — the shot arc as a glowing multi-layer trail, tapered:
 *      the newer half keeps the full bloom/core/hot stack, the older half
 *      renders thinner and dimmer so the comet visibly cools toward its tail.
 *   4. Comet head — the ball as a bright chalk core inside a warm halo and an
 *      outer accent bloom, so it reads as light, not a sticker.
 *   5. Ball reticle — a thin tracking ring + crosshair ticks around the ball
 *      when no shot is live, so idle tracking still looks intentional.
 *   6. Landing ghost — the predicted-landing crosshair, now LATCHED into
 *      COOLDOWN with a 1.2s fade so the player sees where the fit said the
 *      ball would land vs where it actually went.
 *
 * The root is a pointer-transparent View wrapping the Canvas plus the
 * ArcReadout chip (live entry/release angle numbers), so live.tsx keeps
 * mounting a single element.
 *
 * COORDINATE MAPPING (orientation-correct)
 * ----------------------------------------
 * The detector input and the <Camera> preview both use scaleMode 'contain', so
 * every drawn point maps analysis-px → view-px with one uniform scale + offset.
 * That composition (and the reason it must read the REAL source frame dims, not
 * a hardcoded aspect) lives in ./overlayMapping so this and DetectionBoxes stay
 * pixel-identical. All per-frame math runs inside useDerivedValue worklets.
 */
import React from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import {
  BlurMask,
  Canvas,
  Circle,
  DashPathEffect,
  Group,
  Path,
  Skia,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  useDerivedValue,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';

import type { OverlayState } from '../../camera/useShotEngine';
import { color, glow } from '../../constants/tokens';
import { apexOfFlatArc, arcQuality, entryAngleDegFromFlat, splitFlatTail, type ArcQuality } from './arcHudGeometry';
import { ArcReadout } from './ArcReadout';
import { mapAnalysisToView } from './overlayMapping';

/** Widths of the three stacked trail passes (bloom → core → hot). */
const TRAIL_BLOOM = 16;
const TRAIL_CORE = 5;
const TRAIL_HOT = 2;
/** Widths of the two tapered TAIL passes (older half of the trail — no bloom
 *  pass on the tail: that is the perf save that keeps the taper at +2 elements). */
const TRAIL_TAIL_CORE = 3;
const TRAIL_TAIL_HOT = 1.2;
/**
 * Max time (seconds) to extrapolate the ball forward from its last processed
 * sample. Bounds the glide so a lost/occluded ball can't fly off screen: at
 * most ~120ms of (x+vx*dt), then it holds. Detection frames arrive every
 * ~33-66ms, so 120ms comfortably covers the gap between two samples.
 */
const MAX_EXTRAPOLATION_SEC = 0.12;
/** Corner-bracket arm length as a fraction of the rim box's shorter side. */
const BRACKET_FRAC = 0.28;
const BRACKET_STROKE = 3;
/** How long (ms) the latched landing ghost lingers + fades through COOLDOWN. */
const LANDING_GHOST_FADE_MS = 1200;

// RN 0.86 removed StyleSheet.absoluteFillObject — local const per the
// repo-documented pattern (see live.tsx).
const absoluteFill = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };

/**
 * Quad-smoothed Skia path from a flat [x,y,...] ANALYSIS-px polyline, mapped
 * into view px: quad through midpoints with the previous sample as control
 * point. Shared by the full arc + both trail segments. Declared ABOVE the
 * component — Babel captures worklet dependencies eagerly, so a worklet helper
 * must exist before any worklet that calls it.
 */
function flatToQuadPath(
  pts: readonly number[],
  m: { scale: number; ox: number; oy: number },
): SkPath {
  'worklet';
  const path = Skia.Path.Make();
  const n = pts.length >> 1;
  if (n < 2) return path;
  const x0 = pts[0]! * m.scale + m.ox;
  const y0 = pts[1]! * m.scale + m.oy;
  path.moveTo(x0, y0);
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
}

/**
 * Shared empty path returned by predPath whenever no crosshair should draw.
 * A single cached object (never mutated) instead of a fresh Skia.Path.Make()
 * per run, so the idle branch doesn't churn native SkPath allocations.
 */
const EMPTY_PATH = Skia.Path.Make();

/** Landing-ghost crosshair: ring + four airy ticks, in VIEW px. Declared above
 *  the component for the same worklet capture-order reason as flatToQuadPath. */
function crosshairPath(x: number, y: number): SkPath {
  'worklet';
  const p = Skia.Path.Make();
  const r = 10;
  p.addCircle(x, y, r);
  // four crosshair ticks (gap between ring and tick keeps it airy)
  p.moveTo(x - r * 1.8, y); p.lineTo(x - r * 0.7, y);
  p.moveTo(x + r * 0.7, y); p.lineTo(x + r * 1.8, y);
  p.moveTo(x, y - r * 1.8); p.lineTo(x, y - r * 0.7);
  p.moveTo(x, y + r * 0.7); p.lineTo(x, y + r * 1.8);
  return p;
}

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
  // the lock never looks frozen even between shots. Under reduced motion the
  // pulse stays at 0 and everything pulse-driven renders at its base opacity.
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(0);
  React.useEffect(() => {
    if (reducedMotion) {
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse, reducedMotion]);

  // --- analysis → view transform (worklet-local) ---------------------------
  // 'contain' letterbox (camera → analysis square) composed with the preview's
  // 'contain' letterbox (camera → view) → one uniform scale + centering. Shared
  // with DetectionBoxes so every layer lands on the same pixels. See
  // ./overlayMapping for the derivation.
  const mapping = useDerivedValue(() => mapAnalysisToView(overlay.value, viewSize.value));

  // --- shot-arc trail (tapered comet) --------------------------------------
  // The trail is split at its midpoint: the newer half (head, nearest the
  // ball) keeps the full bloom/core/hot stack; the older half (tail) renders
  // as two thin dim passes so the comet visibly cools toward its origin.
  const trailSplit = useDerivedValue(() => splitFlatTail(overlay.value.traj, 0.5));
  const trailHeadPath = useDerivedValue(() => {
    const m = mapping.value;
    if (!m.ok) return Skia.Path.Make();
    return flatToQuadPath(trailSplit.value.head, m);
  });
  const trailTailPath = useDerivedValue(() => {
    const m = mapping.value;
    if (!m.ok) return Skia.Path.Make();
    return flatToQuadPath(trailSplit.value.tail, m);
  });

  const trailOpacity = useDerivedValue(() => {
    const phase = overlay.value.phase;
    if (phase === 'SHOT_LIVE') return 1;
    if (phase === 'COOLDOWN') return 0.45;
    return 0;
  });
  const bloomOpacity = useDerivedValue(() => trailOpacity.value * 0.5);
  const tailCoreOpacity = useDerivedValue(() => trailOpacity.value * 0.5);
  const tailHotOpacity = useDerivedValue(() => trailOpacity.value * 0.45);

  // --- full-flight arc (phase-independent) ---------------------------------
  // The whole OBSERVED parabola from the global FlightArc, drawn from the first
  // sample across the entire flight — the fix for "the line only shows near the
  // rim". The near-rim FSM comet (trail above) only exists once a shot arms;
  // this quiet guide line traces a 3-pointer or high arc long before that. It is
  // purely visual and already curvature-gated in the pipeline (a rim rattle
  // yields an empty fullArc, never a 90° line).
  const fullArcPath = useDerivedValue(() => {
    const m = mapping.value;
    if (!m.ok) return Skia.Path.Make();
    return flatToQuadPath(overlay.value.fullArc, m);
  });
  // Shown whenever a confident arc exists (≥2 points), dimmer while the bright
  // comet is also live so it reads as a guide, not a competing line.
  const fullArcOpacity = useDerivedValue(() => {
    if (overlay.value.fullArc.length < 4) return 0;
    return overlay.value.phase === 'SHOT_LIVE' ? 0.4 : 0.6;
  });

  // --- arc quality grading ---------------------------------------------------
  // HOUSE RULE: this grading is arc-SHAPE feedback only — green for the ideal
  // entry band (43–52°), amber for flat/steep. It must NEVER use color.miss
  // red (red would read as a make/miss judgment) and NEVER feeds the FSM or
  // any outcome. planeY ≈ the rim box's top edge — a display approximation of
  // core RimGeometry.planeY, which OverlayState does not carry.
  const arcEntryQuality = useDerivedValue<ArcQuality | null>(() => {
    const o = overlay.value;
    if (o.rim == null || o.fullArc.length < 10) return null;
    return arcQuality(entryAngleDegFromFlat(o.fullArc, o.rim.y));
  });
  const arcColor = useDerivedValue(() => {
    const q = arcEntryQuality.value;
    if (q === 'ideal') return glow.rimLive;
    if (q != null) return color.unsure;
    return color.accent;
  });

  // --- apex marker ----------------------------------------------------------
  // A small diamond at the arc's highest point (min y — analysis px are +y
  // DOWN), so the peak of the flight reads at a glance.
  const apexPath = useDerivedValue(() => {
    const p = Skia.Path.Make();
    const o = overlay.value;
    const m = mapping.value;
    if (!m.ok) return p;
    const apex = apexOfFlatArc(o.fullArc);
    if (apex == null) return p;
    const x = apex.x * m.scale + m.ox;
    const y = apex.y * m.scale + m.oy;
    const r = 5;
    p.moveTo(x, y - r);
    p.lineTo(x + r, y);
    p.lineTo(x, y + r);
    p.lineTo(x - r, y);
    p.close();
    return p;
  });
  const apexFillOpacity = useDerivedValue(() => Math.min(1, fullArcOpacity.value * 1.4));

  // --- ball glide clock ----------------------------------------------------
  // The ball's x,y,vx,vy arrive only on each PROCESSED detection frame
  // (~15-30fps). To track smoothly at display rate we extrapolate every UI
  // frame from the Kalman velocity: drawn = pos + vel·dt (dt = time since this
  // sample landed). overlay.ball.t is on the camera clock (unrelated to the UI
  // clock), so we never subtract it — we treat a CHANGE in ball.t as "new
  // sample" and stamp the UI-clock instant it became visible; dt is then a pure
  // UI-clock delta. displayNowMs advances every frame so the position worklets
  // below re-run at display rate. Cheap + worklet-side.
  const displayNowMs = useSharedValue(0);
  const sampleArrivalMs = useSharedValue(0);
  const lastSampleKey = useSharedValue(-1);
  // Landing-ghost latch: the last predicted landing seen during SHOT_LIVE,
  // held (as SharedValues — never closed-over JS state) so the crosshair can
  // linger through COOLDOWN. Cleared on IDLE.
  const lastPred = useSharedValue<{ x: number; y: number; inSpan: boolean } | null>(null);
  const lastPredAtMs = useSharedValue(0);
  useFrameCallback((frameInfo) => {
    'worklet';
    const nowMs = frameInfo.timestamp;
    displayNowMs.value = nowMs;
    const o = overlay.value;
    const key = o.ball?.t ?? -1;
    if (key !== lastSampleKey.value) {
      lastSampleKey.value = key;
      sampleArrivalMs.value = nowMs;
    }
    if (o.pred != null && o.phase === 'SHOT_LIVE') {
      // Re-stamp the time every frame (fade starts from the LAST live moment)
      // but only allocate a new latch object when the prediction moved.
      const lp = lastPred.value;
      if (lp == null || lp.x !== o.pred.x || lp.y !== o.pred.y || lp.inSpan !== o.pred.inSpan) {
        lastPred.value = { x: o.pred.x, y: o.pred.y, inSpan: o.pred.inSpan };
      }
      lastPredAtMs.value = nowMs;
    } else if (o.phase === 'IDLE') {
      lastPred.value = null;
    }
  });

  // Seconds since the current sample landed, clamped to the cap. Only glide
  // while a shot is live — a settled/lost ball holds its last position. A
  // PREDICTED (Kalman-coast) sample never glides: extrapolating a ball we can't
  // actually see is exactly what made a lost ball "fall" across the screen.
  const extrapSec = useDerivedValue(() => {
    if (overlay.value.phase !== 'SHOT_LIVE') return 0;
    if (overlay.value.ball?.predicted) return 0;
    const dt = (displayNowMs.value - sampleArrivalMs.value) / 1000;
    if (!(dt > 0)) return 0;
    return dt < MAX_EXTRAPOLATION_SEC ? dt : MAX_EXTRAPOLATION_SEC;
  });

  // Fade factor for a coasting (predicted) ball — a lost ball reads as a faint
  // "best guess", never a confident detection. Real detections draw full.
  const predictedFade = useDerivedValue(() => (overlay.value.ball?.predicted ? 0.35 : 1));

  // --- ball comet ----------------------------------------------------------
  // Extrapolate in ANALYSIS px (x + vx·dt) BEFORE the *scale+offset view
  // mapping — vx,vy are analysis px/s, so one m.scale converts the whole thing.
  const ballCx = useDerivedValue(() => {
    const o = overlay.value;
    const m = mapping.value;
    if (o.ball == null || !m.ok) return -100;
    return (o.ball.x + o.ball.vx * extrapSec.value) * m.scale + m.ox;
  });
  const ballCy = useDerivedValue(() => {
    const o = overlay.value;
    const m = mapping.value;
    if (o.ball == null || !m.ok) return -100;
    return (o.ball.y + o.ball.vy * extrapSec.value) * m.scale + m.oy;
  });
  const ballR = useDerivedValue(() => {
    const o = overlay.value;
    const m = mapping.value;
    if (o.ball == null || !m.ok) return 0;
    return Math.max(3, o.ball.r * m.scale);
  });
  const coreR = useDerivedValue(() => ballR.value * 0.62);
  const haloR = useDerivedValue(() => ballR.value * 1.05);
  const bloomR = useDerivedValue(() => ballR.value * 1.6);
  const ballBloomOpacity = useDerivedValue(() =>
    ballR.value > 0 ? (overlay.value.phase === 'SHOT_LIVE' ? 0.6 : 0.4) * predictedFade.value : 0,
  );
  const ballVisible = useDerivedValue(() => (ballR.value > 0 ? predictedFade.value : 0));

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

  // --- predicted FUTURE path (dashed) ---------------------------------------
  // The fitted arc from the ball's latest sample to the predicted landing —
  // visible even while the ball itself goes UNDETECTED, so the flight never
  // "disappears": the dashes carry the story until detection picks back up.
  const predTrajPath = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const o = overlay.value;
    const m = mapping.value;
    if (!m.ok || o.phase !== 'SHOT_LIVE') return path;
    const pts = o.predTraj;
    const n = pts.length >> 1;
    if (n < 2) return path;
    path.moveTo(pts[0]! * m.scale + m.ox, pts[1]! * m.scale + m.oy);
    for (let i = 1; i < n; i++) {
      path.lineTo(pts[i * 2]! * m.scale + m.ox, pts[i * 2 + 1]! * m.scale + m.oy);
    }
    return path;
  });

  // --- predicted landing ghost ---------------------------------------------
  // Where the fitted arc says the ball is COMING DOWN through the rim plane —
  // drawn as a pulsing crosshair target mid-flight, green when the prediction
  // is inside the rim span (on target), miss-red when it's sailing wide.
  // After the shot resolves, the LAST live prediction stays latched through
  // COOLDOWN with a 1.2s linear fade (no pulse) — a visual echo of where the
  // fit predicted the landing vs where the ball actually went. Trust/education
  // beat, display only: the latch never touches the FSM or any outcome.
  // PERF: this mapper must NOT read displayNowMs — useDerivedValue re-runs on
  // every closure-captured shared value regardless of which branch reads it,
  // so a display-clock read here re-ran the mapper (allocating a fresh SkPath
  // and dirtying the whole blurred canvas) at 60-120Hz for the entire camera
  // session, even fully idle / under reduced motion. The crosshair GEOMETRY
  // is static through the cooldown fade — predOpacity alone (a deduped
  // primitive) animates it to 0, which makes a time-based path cutoff
  // redundant; lastPred is cleared on IDLE by the frame callback.
  const predPath = useDerivedValue(() => {
    const o = overlay.value;
    const m = mapping.value;
    if (!m.ok) return EMPTY_PATH;
    if (o.phase === 'SHOT_LIVE' && o.pred != null) {
      return crosshairPath(o.pred.x * m.scale + m.ox, o.pred.y * m.scale + m.oy);
    }
    const lp = lastPred.value;
    if (o.phase === 'COOLDOWN' && lp != null) {
      return crosshairPath(lp.x * m.scale + m.ox, lp.y * m.scale + m.oy);
    }
    return EMPTY_PATH;
  });
  const predColor = useDerivedValue(() => {
    const o = overlay.value;
    const inSpan =
      o.phase === 'SHOT_LIVE' && o.pred != null ? o.pred.inSpan : lastPred.value?.inSpan === true;
    return inSpan ? glow.rimLive : color.miss;
  });
  const predOpacity = useDerivedValue(() => {
    const o = overlay.value;
    if (o.pred != null && o.phase === 'SHOT_LIVE') return 0.55 + pulse.value * 0.35;
    if (o.phase === 'COOLDOWN' && lastPred.value != null) {
      const age = displayNowMs.value - lastPredAtMs.value;
      if (age < LANDING_GHOST_FADE_MS) return 0.5 * (1 - age / LANDING_GHOST_FADE_MS);
    }
    return 0;
  });

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
    <View pointerEvents="none" style={[absoluteFill, style]}>
      <Canvas style={absoluteFill} onLayout={onLayout}>
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

        {/* Full-flight arc: the whole observed parabola as a quiet dashed
            guide, drawn under the bright comet so the flight reads end-to-end.
            Color = shape grade (green ideal / amber flat-steep / accent when
            unknown) — see arcEntryQuality's house rule. */}
        <Path
          path={fullArcPath}
          style="stroke"
          strokeWidth={2}
          strokeCap="round"
          strokeJoin="round"
          color={arcColor}
          opacity={fullArcOpacity}
        >
          <DashPathEffect intervals={[7, 7]} />
        </Path>

        {/* Apex diamond: glow pass + crisp fill, same grade color as the arc */}
        <Path
          path={apexPath}
          style="stroke"
          strokeWidth={4}
          strokeJoin="round"
          color={arcColor}
          opacity={fullArcOpacity}
        >
          <BlurMask blur={4} style="normal" />
        </Path>
        <Path path={apexPath} style="fill" color={arcColor} opacity={apexFillOpacity} />

        {/* Trail tail (older half): two thin dim passes, no bloom — the taper */}
        <Path
          path={trailTailPath}
          style="stroke"
          strokeWidth={TRAIL_TAIL_CORE}
          strokeCap="round"
          strokeJoin="round"
          color={glow.trail}
          opacity={tailCoreOpacity}
        />
        <Path
          path={trailTailPath}
          style="stroke"
          strokeWidth={TRAIL_TAIL_HOT}
          strokeCap="round"
          strokeJoin="round"
          color={glow.cometHalo}
          opacity={tailHotOpacity}
        />

        {/* Trail head (newer half): soft bloom pass */}
        <Path
          path={trailHeadPath}
          style="stroke"
          strokeWidth={TRAIL_BLOOM}
          strokeCap="round"
          strokeJoin="round"
          color={glow.trailBloom}
          opacity={bloomOpacity}
        >
          <BlurMask blur={12} style="normal" />
        </Path>
        {/* Trail head: core stroke */}
        <Path
          path={trailHeadPath}
          style="stroke"
          strokeWidth={TRAIL_CORE}
          strokeCap="round"
          strokeJoin="round"
          color={glow.trail}
          opacity={trailOpacity}
        />
        {/* Trail head: hot white centerline */}
        <Path
          path={trailHeadPath}
          style="stroke"
          strokeWidth={TRAIL_HOT}
          strokeCap="round"
          strokeJoin="round"
          color={glow.cometHalo}
          opacity={trailOpacity}
        />

        {/* Predicted future path: dashed arc to the landing point */}
        <Path
          path={predTrajPath}
          style="stroke"
          strokeWidth={2.5}
          strokeCap="round"
          color={predColor}
          opacity={predOpacity}
        >
          <DashPathEffect intervals={[9, 8]} />
        </Path>

        {/* Predicted landing ghost: soft glow pass + crisp crosshair (latched
            through COOLDOWN with a fade — see predPath) */}
        <Path
          path={predPath}
          style="stroke"
          strokeWidth={4.5}
          strokeCap="round"
          color={predColor}
          opacity={predOpacity}
        >
          <BlurMask blur={6} style="normal" />
        </Path>
        <Path
          path={predPath}
          style="stroke"
          strokeWidth={2}
          strokeCap="round"
          color={predColor}
          opacity={predOpacity}
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

      {/* Live arc readout chip (measured degrees only — no outcome words).
          Mounted here, inside the overlay's pointer-transparent root, so
          live.tsx keeps mounting a single element. */}
      <ArcReadout overlay={overlay} />
    </View>
  );
}
