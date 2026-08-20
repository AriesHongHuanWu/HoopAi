/**
 * calibrationSceneMath — pure keyframe math for the calibration guide's
 * animated Skia mini-scenes (rendered by CalibrationScenes.tsx).
 *
 * NOTE ON THE FILE NAME: the design brief called this module
 * calibrationScenes.ts, but that basename differs from CalibrationScenes.tsx
 * only in casing — TypeScript and Metro try the .ts candidate first and
 * resolve case-insensitively on Windows/macOS, so the component import would
 * silently land on this module. Hence the distinct name.
 *
 * Every helper maps a clamped clock progress t in [0, 1] to plain numbers so
 * the choreography is unit-testable without React or Skia. Each scene runs
 * 3 s of motion followed by a 0.6 s hold (SCENE_LOOP_MS = 3600), then loops.
 *
 * FINAL-POSE CONTRACT: at t = 1 every helper yields a complete, readable
 * static diagram. That exact frame is what reduced-motion users see — the
 * renderer pins its clock to 1 and never loops — so t = 1 must always carry
 * the sketch's full meaning on its own (same contract as the old static
 * placement diagrams).
 *
 * Court geometry is sourced from core/calibrationGuide (landmarkGuide) and
 * core/courtModel so the tap-order diagram can never drift from the real
 * 5-landmark calibration ritual.
 *
 * Pure TypeScript: no React, no Skia, no I/O, no clocks. Pose helpers carry
 * the 'worklet' directive so Reanimated derived values can call them on the
 * UI thread; on the JS thread (and in Jest) they run as ordinary functions.
 */
import { landmarkGuide } from '../../core/calibrationGuide';
import { FIBA_COURT, cornerJunctionY } from '../../core/courtModel';

/** One scene loop: 3 s of motion + 0.6 s hold on the final pose. */
export const SCENE_LOOP_MS = 3600;
/** Placement mini-scene canvas size (dp). */
export const SCENE_W = 96;
export const SCENE_H = 72;

// --- Keyframe anchors (normalized scene coordinates, 0..1) ------------------

/** 'side': phone starts "behind the shooter" and slides to the side spot. */
export const SIDE_PHONE_FROM_X = 0.75;
export const SIDE_PHONE_TO_X = 0.85;

/** 'frame': rim drifts from lower-left into the upper-third bracket center. */
export const FRAME_RIM_FROM_X = 0.28;
export const FRAME_RIM_FROM_Y = 0.72;
export const FRAME_RIM_TO_X = 0.5;
export const FRAME_RIM_TO_Y = 1 / 3;

/** 'height': phone rises from near the floor to the chest-height band. */
export const HEIGHT_PHONE_FROM_Y = 0.78;
export const HEIGHT_PHONE_TO_Y = 0.45;

/** Tap ritual: dot k lights at t = FIRST + k * SPACING; ripple spans 0.12. */
export const TAP_FIRST_LIGHT_T = 0.12;
export const TAP_LIGHT_SPACING_T = 0.15;
export const TAP_RIPPLE_SPAN_T = 0.12;

// --- Tiny local easing kit (no imports; every piece is a worklet) -----------

function clamp01(v: number): number {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smooth cubic ease-in-out. Local on purpose — this module imports no libs. */
function easeInOutCubic(t: number): number {
  'worklet';
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Eased progress of t through the window [from, to]: 0 before, 1 after.
 * Windows are expressed in loop progress, so "hold" is simply every window
 * being complete before t reaches 1.
 */
function seg(t: number, from: number, to: number): number {
  'worklet';
  return easeInOutCubic(clamp01((t - from) / (to - from)));
}

/** lerp in the a*(1-t)+b*t form so t = 1 returns EXACTLY b (final pose). */
function lerp(a: number, b: number, t: number): number {
  'worklet';
  return a * (1 - t) + b * t;
}

// --- Placement scene poses ---------------------------------------------------

export interface SidePose {
  /** Phone center X, normalized 0..1 of scene width. */
  phoneX: number;
  /** Sight-line draw progress 0..1 (phone to rim). */
  lineProgress: number;
  /** Rim pulse 0..1; holds at 1 so the rim stays highlighted at rest. */
  rimPulse: number;
}

/**
 * 'Shoot from the side': the phone slides along the right edge from "behind"
 * (t 0-0.35), the sight-line draws to the rim (0.35-0.7), the rim pulses lit
 * (0.7-0.85), then everything holds.
 * FINAL POSE (t = 1): { phoneX: SIDE_PHONE_TO_X, lineProgress: 1, rimPulse: 1 }.
 */
export function sidePose(t: number): SidePose {
  'worklet';
  const tc = clamp01(t);
  return {
    phoneX: lerp(SIDE_PHONE_FROM_X, SIDE_PHONE_TO_X, seg(tc, 0, 0.35)),
    lineProgress: seg(tc, 0.35, 0.7),
    rimPulse: seg(tc, 0.7, 0.85),
  };
}

export interface FramePose {
  /** Rim center, normalized 0..1 inside the viewfinder. */
  rimX: number;
  rimY: number;
  /** Framing-bracket scale (1.3 to 1 snap) and fade-in alpha. */
  bracketScale: number;
  bracketAlpha: number;
  /** Floor line fade-in alpha. */
  floorAlpha: number;
}

/**
 * 'Whole rim + some floor': the rim drifts from lower-left to the upper-third
 * center (t 0-0.5), the bracket snaps on (1.3 to 1 scale, alpha 0 to 1 at
 * 0.5-0.65), the floor line fades in (0.65-0.8), then hold.
 * FINAL POSE (t = 1): rim at (0.5, 1/3), bracketScale 1, bracketAlpha 1,
 * floorAlpha 1.
 */
export function framePose(t: number): FramePose {
  'worklet';
  const tc = clamp01(t);
  const drift = seg(tc, 0, 0.5);
  const snap = seg(tc, 0.5, 0.65);
  return {
    rimX: lerp(FRAME_RIM_FROM_X, FRAME_RIM_TO_X, drift),
    rimY: lerp(FRAME_RIM_FROM_Y, FRAME_RIM_TO_Y, drift),
    bracketScale: lerp(1.3, 1, snap),
    bracketAlpha: snap,
    floorAlpha: seg(tc, 0.65, 0.8),
  };
}

export interface HeightPose {
  /** Phone center Y, normalized 0..1 of scene height (smaller = higher). */
  phoneY: number;
  /** Chest-height band tick fade-in alpha. */
  tickAlpha: number;
}

/**
 * 'Chest height, locked down': the phone rises to the chest band (t 0-0.6),
 * the band tick fades in (0.6-0.75), then hold.
 * FINAL POSE (t = 1): { phoneY: HEIGHT_PHONE_TO_Y, tickAlpha: 1 }.
 */
export function heightPose(t: number): HeightPose {
  'worklet';
  const tc = clamp01(t);
  return {
    phoneY: lerp(HEIGHT_PHONE_FROM_Y, HEIGHT_PHONE_TO_Y, seg(tc, 0, 0.6)),
    tickAlpha: seg(tc, 0.6, 0.75),
  };
}

// --- Tap-order scene ---------------------------------------------------------

export interface TapDotPoint {
  /** Screen position inside a w x h half-court diagram (baseline at y = h). */
  x: number;
  y: number;
  /** Index in the CALIBRATION_LANDMARK_IDS ritual order (0 = basket). */
  order: number;
}

/**
 * The 5 calibration landmarks projected into a w x h half-court diagram, in
 * ritual order. landmarkGuide pos is x 0..1 left-to-right and y 0 at the
 * BASELINE growing toward halfcourt, so screenY = h - pos.y * h puts the
 * baseline at the bottom of the diagram. Mount-time only (not a worklet).
 */
export function tapDotPoints(w: number, h: number): TapDotPoint[] {
  return landmarkGuide(FIBA_COURT).map((entry, index) => ({
    x: entry.pos.x * w,
    y: h - entry.pos.y * h,
    order: index,
  }));
}

export interface TapPose {
  /** Dot is lit (its ritual moment has passed). */
  lit: boolean;
  /** Ripple expansion 0..1 over the 0.12 after lighting; 1 = fully expanded
   * (renderers draw the ripple invisible at 1, so t = 1 reads as a calm,
   * fully-lit static diagram). */
  ripple: number;
}

/**
 * Light state of dot `order` at loop progress t. Dot k lights at
 * t = 0.12 + k * 0.15 and its ripple expands over the following 0.12 — the
 * 5th dot finishes at t of about 0.84, inside the hold window.
 * FINAL POSE (t = 1): every dot { lit: true, ripple: 1 }.
 */
export function tapPose(t: number, order: number): TapPose {
  'worklet';
  const tc = clamp01(t);
  const tOn = TAP_FIRST_LIGHT_T + order * TAP_LIGHT_SPACING_T;
  return {
    lit: tc >= tOn,
    ripple: easeInOutCubic(clamp01((tc - tOn) / TAP_RIPPLE_SPAN_T)),
  };
}

// --- Half-court furniture path -----------------------------------------------

/** Arc polyline sample count — smooth at diagram scale, still one path. */
const ARC_SAMPLES = 16;

/**
 * The half-court furniture (baseline, corner-3 posts + arc, FT line) as one
 * SVG path string in the same w x h frame as tapDotPoints, so the drawn lines
 * pass exactly through the landmark dots. The diagram's metric frame is
 * recovered by inverting landmarkGuide's normalization (no duplicated margin
 * constants). Mount-time only (not a worklet).
 */
export function courtPathSvg(w: number, h: number): string {
  const spec = FIBA_COURT;
  const guide = landmarkGuide(spec);
  const top = guide.find((g) => g.id === 'topOfArc')!;
  const left = guide.find((g) => g.id === 'cornerThreeLeft')!;
  // topOfArc sits at court Y = arcRadius, so its pos.y recovers the diagram
  // depth; the left corner's pos.x recovers the diagram width the same way.
  const depthM = (spec.arcRadiusM + spec.basketFromBaselineM) / top.pos.y;
  const widthM = spec.cornerDistanceM / (0.5 - left.pos.x);
  const toX = (xM: number) => ((xM + widthM / 2) / widthM) * w;
  const toY = (yM: number) => h - ((yM + spec.basketFromBaselineM) / depthM) * h;
  const f = (v: number) => v.toFixed(1);

  const baseYM = -spec.basketFromBaselineM;
  const yJ = cornerJunctionY(spec);
  const parts: string[] = [];

  // Baseline across the full diagram (the dots' y = h edge).
  parts.push(`M 0 ${f(h)} L ${f(w)} ${f(h)}`);

  // 3-point line: left corner post up to the junction, the arc as a sampled
  // polyline over the apex, then the right corner post back to the baseline.
  parts.push(
    `M ${f(toX(-spec.cornerDistanceM))} ${f(toY(baseYM))}` +
      ` L ${f(toX(-spec.cornerDistanceM))} ${f(toY(yJ))}`,
  );
  const thetaL = Math.atan2(yJ, -spec.cornerDistanceM);
  const thetaR = Math.atan2(yJ, spec.cornerDistanceM);
  for (let i = 1; i <= ARC_SAMPLES; i++) {
    const theta = thetaL + ((thetaR - thetaL) * i) / ARC_SAMPLES;
    parts.push(
      `L ${f(toX(spec.arcRadiusM * Math.cos(theta)))} ${f(toY(spec.arcRadiusM * Math.sin(theta)))}`,
    );
  }
  parts.push(`L ${f(toX(spec.cornerDistanceM))} ${f(toY(baseYM))}`);

  // Free-throw line: a short horizontal bar through the FT landmark.
  const ftY = toY(spec.ftLineDistanceM);
  parts.push(`M ${f(0.38 * w)} ${f(ftY)} L ${f(0.62 * w)} ${f(ftY)}`);

  return parts.join(' ');
}
