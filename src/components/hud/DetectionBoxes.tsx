/**
 * Debug overlay: draws a bold colored box on EVERY raw model detection this
 * frame — ball (orange), rim (green), made (gold), person (blue) — so you can
 * SEE in real time whether the detector is firing, even with just a ball and no
 * hoop. Gated by Settings > Debug mode. Same analysis→view mapping as
 * TrajectoryOverlay ('contain' letterbox camera→square, composed with the
 * preview's 'contain' letterbox camera→view).
 *
 * TWO-TIER BALL RENDERING (honest acquisition bar): the tracker's ACTIVE cold
 * floor is per-model/per-light (e.g. 0.35 on nanoV2, 0.16 in dark) while this
 * overlay used to draw every ball at the static 0.2 gate — systematically
 * over-promising in the 0.2..0.35 band and under-showing in dark. Now ball
 * boxes render in two tiers against the REAL floor (OverlayState.acqFloor):
 *   - SOLID  (accent, stroke 4): score ≥ acqFloor — the tracker CAN start here.
 *   - FAINT  (thin, 45% opacity): 0.15 ≤ score < acqFloor — "the model sees
 *     it, the tracker will NOT start on it".
 * Until the engine publishes acqFloor the floor defaults to the static 0.2
 * gate, which reproduces the previous solid-tier behavior exactly.
 *
 * BREADCRUMBS: faint dots of the tracker's REAL history samples
 * (OverlayState.crumbs, published only in IDLE) — decouples "tracker alive"
 * from "FSM armed" in the field. Deliberately dots, not a stroke, so a raw
 * track trail can never be mistaken for a shot line. Strictly visual: this
 * surface never arms, judges, or feeds anything back into the pipeline.
 *
 * CRASH-SAFETY: every derived value is an explicit top-level hook (no hooks in a
 * helper), and each path builder guards `o.dets` / `o.crumbs` (defensive against
 * any overlay state without the array) — a throw inside a UI-thread worklet is a
 * hard crash.
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
import { DETECTION } from '../../core/config';
import { color } from '../../constants/tokens';
import { mapAnalysisToView, type Mapping } from './overlayMapping';

// Per-class score gates — draw only detections the app ACTUALLY acts on, not
// the raw 0.15 parser floor. On a degraded input (e.g. filming a screen) the
// model emits many low-confidence junk boxes; showing them all made the debug
// overlay look like "a mess of boxes" that doesn't reflect real tracking. Plain
// number consts so the worklet captures them cleanly.
const BALL_MIN = DETECTION.ballScoreMin;
const RIM_MIN = DETECTION.rimScoreMin;
const MADE_MIN = DETECTION.ballInBasketScoreMin;
const PERSON_MIN = DETECTION.personScoreMin;

/** Faint-tier floor: the raw parser floor — anything the model emits at all. */
const FAINT_MIN = 0.15;

/** Breadcrumb dot radius in VIEW px (not analysis px — constant on screen). */
const CRUMB_R = 3;

/**
 * Integration contract (the engine integrator adds these to OverlayState):
 * - acqFloor: the tracker's ACTIVE cold acquisition floor for THIS frame
 *   (per-model / per-light, e.g. 0.35 nanoV2, 0.16 dark).
 * - crumbs: flattened x,y pairs (analysis px) of the tracker's real history
 *   samples, published ONLY in IDLE (empty otherwise).
 * Read defensively (typeof / Array.isArray) so this file typechecks and
 * behaves identically before the wiring lands.
 */
type AcqOverlay = OverlayState & { acqFloor?: number; crumbs?: number[] };

/**
 * The ACTIVE cold acquisition floor for this frame. Falls back to the static
 * ball gate (0.2) when the engine hasn't published one — which reproduces the
 * pre-two-tier solid rendering exactly. Pure worklet.
 */
export function activeAcqFloor(o: OverlayState): number {
  'worklet';
  const f = (o as AcqOverlay).acqFloor;
  return typeof f === 'number' && f > 0 ? f : BALL_MIN;
}

/**
 * Build a Skia path of all detection boxes for one class within a score band.
 * `minScore` is inclusive; `maxScore` (optional) is EXCLUSIVE — a detection at
 * exactly the acquisition floor belongs to the solid tier, not the faint one.
 * Pure worklet.
 */
export function classPath(
  o: OverlayState,
  m: Mapping,
  cls: string,
  minScore: number,
  maxScore?: number,
) {
  'worklet';
  const p = Skia.Path.Make();
  if (!m.ok) return p;
  const dets = o.dets;
  if (dets == null || !Array.isArray(dets)) return p;
  for (let i = 0; i < dets.length; i++) {
    const d = dets[i];
    if (d == null || d.cls !== cls) continue;
    // Only draw boxes at/above the class gate the app acts on — hides raw
    // low-confidence noise so the debug view reflects real tracking.
    if (!(d.score >= minScore)) continue;
    // Band ceiling (two-tier ball): the faint tier stops where the solid tier
    // starts, so a detection is never drawn twice.
    if (maxScore != null && d.score >= maxScore) continue;
    const x = d.x * m.scale + m.ox;
    const y = d.y * m.scale + m.oy;
    const w = d.w * m.scale;
    const h = d.h * m.scale;
    if (!(w > 0) || !(h > 0)) continue;
    p.addRRect(rrect(rect(x, y, w, h), 8, 8));
  }
  return p;
}

/**
 * Build a Skia path of breadcrumb dots from the tracker's raw history samples
 * (flattened x,y analysis px; published only in IDLE). Honest raw-track trail,
 * visibly not a shot line. Pure worklet.
 */
export function crumbsPath(o: OverlayState, m: Mapping) {
  'worklet';
  const p = Skia.Path.Make();
  if (!m.ok) return p;
  const c = (o as AcqOverlay).crumbs;
  if (c == null || !Array.isArray(c)) return p;
  for (let i = 0; i + 1 < c.length; i += 2) {
    const x = c[i] * m.scale + m.ox;
    const y = c[i + 1] * m.scale + m.oy;
    p.addCircle(x, y, CRUMB_R);
  }
  return p;
}

/**
 * PERF (memo): every pixel this component draws comes from the `overlay`
 * SharedValue on the UI thread — nothing here reads live.tsx React state. The
 * live screen re-renders on every shot, countdown tick and toast, and each of
 * those re-renders used to rebuild this Canvas's whole element tree for no
 * visual change. `overlay` is a stable SharedValue ref, so the memo compare
 * short-circuits all of them.
 */
export const DetectionBoxes = React.memo(function DetectionBoxes({
  overlay,
}: {
  overlay: SharedValue<OverlayState>;
}) {
  const viewSize = useSharedValue({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    viewSize.value = { w: width, h: height };
  };

  const mapping = useDerivedValue<Mapping>(() => mapAnalysisToView(overlay.value, viewSize.value));

  // Explicit top-level derived values (no hooks-in-a-helper).
  // Solid tier: score at/above the ACTIVE acquisition floor — trackable.
  const ballSolidPath = useDerivedValue(() =>
    classPath(overlay.value, mapping.value, 'ball', activeAcqFloor(overlay.value)),
  );
  // Faint tier: parser floor .. acquisition floor — seen but NOT trackable.
  // Empty band when the active floor equals the static gate and that gate is
  // at/below FAINT_MIN.
  const ballFaintPath = useDerivedValue(() =>
    classPath(overlay.value, mapping.value, 'ball', FAINT_MIN, activeAcqFloor(overlay.value)),
  );
  const rimPath = useDerivedValue(() => classPath(overlay.value, mapping.value, 'rim', RIM_MIN));
  const madePath = useDerivedValue(() => classPath(overlay.value, mapping.value, 'ball_in_basket', MADE_MIN));
  const personPath = useDerivedValue(() => classPath(overlay.value, mapping.value, 'person', PERSON_MIN));
  const crumbPath = useDerivedValue(() => crumbsPath(overlay.value, mapping.value));

  return (
    <Canvas style={StyleSheet.absoluteFill} onLayout={onLayout} pointerEvents="none">
      {/* Breadcrumbs UNDER every box path: raw-track dots, never a shot line. */}
      <Path path={crumbPath} color={color.textFaint} style="fill" opacity={0.5} />
      <Path path={personPath} color={color.info} style="stroke" strokeWidth={2.5} />
      <Path path={rimPath} color={color.make} style="stroke" strokeWidth={4} />
      <Path path={madePath} color={color.threePt} style="stroke" strokeWidth={4} />
      {/* Faint tier under the solid tier: seen-but-below-the-acquisition-bar. */}
      <Path path={ballFaintPath} color={color.accent} style="stroke" strokeWidth={2} opacity={0.45} />
      <Path path={ballSolidPath} color={color.accent} style="stroke" strokeWidth={4} />
    </Canvas>
  );
});
