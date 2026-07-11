/**
 * FormStage3D — the orbitable 3D stage for the Form Studio's ESTIMATED
 * reconstruction. Draws a ground grid, the user's lifted skeleton (leather
 * accent, solid) and an optional NBA reference ghost (spectral chalk-dash —
 * the same dashed language as the 2D FormMotionStage) from a single merged
 * painter-sorted pass so the two figures occlude each other correctly.
 *
 * HONESTY BY CONSTRUCTION: every joint carries the lift's depth confidence;
 * joints below the low-confidence gate render as hollow rings and their bones
 * fade — the viewer can SEE which parts of the pose are inferred. No math
 * lives here: all lifting/projection comes from the unit-tested pure modules
 * in src/core/pose3d/*; this component only turns geometry into Skia nodes.
 *
 * Camera: EITHER self-contained (legacy — internal state, drag to orbit) OR
 * parent-controlled via the `camera` prop, which lets the screen run presets,
 * tweens, auto-orbit, and keep two side-by-side stages in lockstep. Even when
 * controlled this component never self-animates — the "no auto-rotation"
 * design holds: it only renders the camera it is given. `onCameraChange`
 * fires ONLY from user gestures (never from prop-driven renders), so parents
 * can rely on it to cancel their own tweens/auto-orbit.
 *
 * Overlays (both honesty-preserving; neither invents data): the optional
 * wrist trail draws the ESTIMATED wrist path with real gaps wherever the
 * wrist was missing — it never interpolates — and fades by lift confidence;
 * callout chips render parent-preformatted text (including the ≈
 * low-confidence prefix) anchored to projected user joints.
 *
 * Presentation-only + parent-clocked: the screen owns playback and passes a
 * scrub fraction `pos`, so autoplay, scrubbing and the reduced-motion stepper
 * all pose the stage identically. No auto-rotation, no idle animation.
 *
 * Gestures: this is NOT the live camera screen — per-interaction React state
 * (the pattern the 2D stage already uses for scrub re-renders) is fine here,
 * so Pan/Pinch run with runOnJS(true) as plain JS handlers (no worklets, no
 * SharedValues) and camera updates are throttled to display rate with delta
 * accumulation so no drag distance is dropped.
 */
import {
  Canvas,
  Circle,
  DashPathEffect,
  Group,
  Line,
  RoundedRect,
  Text as SkText,
  matchFont,
  vec,
} from '@shopify/react-native-skia';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { color } from '@/constants/tokens';
import { clamp } from '@/core/geometry';
import {
  DEFAULT_CAMERA,
  groundGrid,
  orbitFromDrag,
  pinchZoom,
  projectPoint,
  projectSkeleton,
  strokeWidthFor,
  type OrbitCamera,
  type Projected,
} from '@/core/pose3d/camera3d';
import { SKELETON_BONES, type Frame3D, type LiftedSequence } from '@/core/pose3d/lift';
import { sequenceGroundY, wristTrail, type TrailPoint } from '@/core/pose3d/trail';
import type { PoseKeypointName, ShootingHand } from '@/core/types';

/** Joints lifted below this confidence render as hollow rings, not dots. */
const LOW_CONFIDENCE = 0.55;
/** Minimum ms between camera setState calls during a gesture (~60 fps). */
const THROTTLE_MS = 16;
/** Base stroke px for the user skeleton / the reference ghost. */
const USER_STROKE = 5;
const REF_STROKE = 3.5;
/** Half-length (body heights) of the axis cross — matches groundGrid extent. */
const AXIS_HALF = 1.2;
/** Callout chips cap so the stage never turns into a label cloud. */
const MAX_CALLOUTS = 3;

// Condensed SYSTEM face via matchFont — Skia can't see expo-font families
// (same rationale and face as ShareCard's display font).
const CALLOUT_FONT = matchFont({
  fontFamily: Platform.select({ ios: 'Avenir Next Condensed', default: 'sans-serif-condensed' }),
  fontSize: 12,
  fontWeight: '600',
  fontStyle: 'normal',
});

/** Stable empty default so the scene memo doesn't churn on every render. */
const EMPTY_CALLOUTS: readonly StageCallout[] = [];

/** A joint-anchored in-scene label. Text arrives fully formatted. */
export interface StageCallout {
  /** User-skeleton joint the chip anchors to. */
  joint: PoseKeypointName;
  /** Already-formatted honest text, e.g. "ELBOW ≈92°" (parent owns ≈ semantics). */
  text: string;
}

export interface FormStage3DProps {
  user: LiftedSequence;
  /** NBA ghost — may have a different frame count; indexed by the same `pos`. */
  reference?: LiftedSequence | null;
  /** Scrub position 0..1 across the sequence (parent owns playback). */
  pos: number;
  width: number;
  height: number;
  accessibilityLabel: string;
  /**
   * Controlled camera. When provided the PARENT owns the camera (presets /
   * auto-orbit / two synced stages); gestures dispatch via onCameraChange.
   * Omit for the legacy self-contained mode.
   */
  camera?: OrbitCamera;
  /**
   * Fires ONLY from user gestures (pan/pinch), never from prop-driven
   * renders — parents use it to cancel auto-orbit/tweens.
   */
  onCameraChange?: (cam: OrbitCamera) => void;
  /**
   * Draw the estimated wrist-path trail for this hand up to the current
   * frame. null/undefined → no trail.
   */
  trailHand?: ShootingHand | null;
  /** In-scene callout chips anchored to user joints (first 3 drawn). */
  callouts?: readonly StageCallout[];
}

/** A projected 2D segment ready to draw. */
interface Seg2D {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface BoneDraw extends Seg2D {
  kind: 'ref' | 'user';
  strokeWidth: number;
  opacity: number;
}

interface DotDraw {
  x: number;
  y: number;
  r: number;
  solid: boolean;
}

interface HeadDraw {
  x: number;
  y: number;
  r: number;
}

/** One tapered, age/confidence-faded trail segment. */
interface TrailSegDraw extends Seg2D {
  opacity: number;
  strokeWidth: number;
}

/** One laid-out callout chip: leader line + rounded chip + baseline text. */
interface CalloutDraw {
  leader: Seg2D;
  chipX: number;
  chipY: number;
  chipW: number;
  chipH: number;
  textX: number;
  textY: number;
  text: string;
}

/** Frame at scrub fraction `pos` (nearest-frame; sequences are short). */
function frameAt(seq: LiftedSequence, pos: number): Frame3D {
  const n = seq.frames.length;
  if (n === 0) return {};
  const i = Math.min(n - 1, Math.max(0, Math.round(pos * (n - 1))));
  return seq.frames[i] ?? {};
}

export default function FormStage3D({
  user,
  reference,
  pos,
  width,
  height,
  accessibilityLabel,
  camera,
  onCameraChange,
  trailHand,
  callouts = EMPTY_CALLOUTS,
}: FormStage3DProps): React.JSX.Element | null {
  const [internalCam, setInternalCam] = useState<OrbitCamera>(DEFAULT_CAMERA);
  const controlled = camera != null;
  const cam = controlled ? camera : internalCam;

  // Gesture handlers read/advance the camera through refs (re-synced every
  // render) so the memoized gestures never close over a stale camera and the
  // controlled/uncontrolled split stays out of their dependency lists.
  const camRef = useRef(cam);
  camRef.current = cam;
  const controlledRef = useRef(controlled);
  controlledRef.current = controlled;
  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;

  /**
   * Route a gesture-produced camera to its owner: the parent when controlled,
   * internal state otherwise. This is the ONLY path that calls onCameraChange,
   * which keeps the "fires only from user gestures" contract by construction.
   */
  const applyCam = useCallback((next: OrbitCamera) => {
    // Controlled with no listener = a view-only stage: gestures no-op cheaply.
    if (controlledRef.current && onCameraChangeRef.current == null) return;
    camRef.current = next;
    if (controlledRef.current) {
      onCameraChangeRef.current?.(next);
    } else {
      setInternalCam(next);
      onCameraChangeRef.current?.(next);
    }
  }, []);

  // Gesture throttling: accumulate deltas between allowed updates so a fast
  // drag never loses distance, then flush leftovers when the gesture ends.
  const lastPanMs = useRef(0);
  const panDx = useRef(0);
  const panDy = useRef(0);
  const lastPinchMs = useRef(0);
  const pinchScale = useRef(1);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .maxPointers(1)
        .activeOffsetX([-8, 8])
        .activeOffsetY([-8, 8])
        .onChange((e) => {
          panDx.current += e.changeX;
          panDy.current += e.changeY;
          const now = Date.now();
          if (now - lastPanMs.current < THROTTLE_MS) return;
          lastPanMs.current = now;
          const dx = panDx.current;
          const dy = panDy.current;
          panDx.current = 0;
          panDy.current = 0;
          applyCam(orbitFromDrag(camRef.current, dx, dy, width));
        })
        .onFinalize(() => {
          const dx = panDx.current;
          const dy = panDy.current;
          panDx.current = 0;
          panDy.current = 0;
          if (dx !== 0 || dy !== 0) applyCam(orbitFromDrag(camRef.current, dx, dy, width));
        }),
    [applyCam, width],
  );

  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onChange((e) => {
          pinchScale.current *= e.scaleChange;
          const now = Date.now();
          if (now - lastPinchMs.current < THROTTLE_MS) return;
          lastPinchMs.current = now;
          const s = pinchScale.current;
          pinchScale.current = 1;
          applyCam(pinchZoom(camRef.current, s));
        })
        .onFinalize(() => {
          const s = pinchScale.current;
          pinchScale.current = 1;
          if (s !== 1) applyCam(pinchZoom(camRef.current, s));
        }),
    [applyCam],
  );

  const gesture = useMemo(() => Gesture.Simultaneous(pan, pinch), [pan, pinch]);

  // Ground plane: one fixed rule per sequence (shared with the offscreen
  // share still via sequenceGroundY) so the floor doesn't bob while scrubbing.
  const groundY = useMemo(() => sequenceGroundY(user), [user]);

  const userFrame = useMemo(() => frameAt(user, pos), [user, pos]);
  const refFrame = useMemo(
    () => (reference ? frameAt(reference, pos) : null),
    [reference, pos],
  );

  // Project everything into flat draw lists; the JSX below stays math-free.
  const scene = useMemo(() => {
    if (width <= 0 || height <= 0) return null;
    const vp = { w: width, h: height };

    const grid: Seg2D[] = groundGrid(cam, vp, { y: groundY }).map(([a, b]) => ({
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
    }));

    // Axis cross through the origin on the ground plane (subtle orientation
    // anchor while orbiting), built from projectPoint like everything else.
    const axes: Seg2D[] = [];
    const axisEnds: [{ x: number; y: number; z: number }, { x: number; y: number; z: number }][] = [
      [
        { x: -AXIS_HALF, y: groundY, z: 0 },
        { x: AXIS_HALF, y: groundY, z: 0 },
      ],
      [
        { x: 0, y: groundY, z: -AXIS_HALF },
        { x: 0, y: groundY, z: AXIS_HALF },
      ],
    ];
    for (const [a, b] of axisEnds) {
      const pa = projectPoint(a, cam, vp);
      const pb = projectPoint(b, cam, vp);
      if (pa && pb) axes.push({ x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y });
    }

    // Estimated wrist path up to the current frame. wristTrail only returns
    // frames where the wrist truly exists, and a source-frame jump > 1 SKIPS
    // the connecting segment — bridging a gap with a straight line would
    // fabricate motion the lift never saw.
    const trailSegs: TrailSegDraw[] = [];
    let trailTip: { x: number; y: number } | null = null;
    if (trailHand != null && user.frames.length > 0) {
      const last = user.frames.length - 1;
      const curIdx = Math.min(last, Math.max(0, Math.round(pos * last)));
      const projectedTrail: { p: Projected; src: TrailPoint }[] = [];
      for (const pt of wristTrail(user, trailHand, curIdx)) {
        const p = projectPoint(pt, cam, vp);
        if (p) projectedTrail.push({ p, src: pt });
      }
      const n = projectedTrail.length;
      for (let k = 0; k + 1 < n; k++) {
        const a = projectedTrail[k];
        const b = projectedTrail[k + 1];
        if (!a || !b) continue;
        // Honesty gap: non-adjacent source frames stay visually disconnected.
        if (b.src.frame - a.src.frame > 1) continue;
        // Taper + fade: older segments run thinner/fainter, and the whole
        // ribbon dims further wherever the lift's wrist confidence drops.
        const ageT = n < 2 ? 1 : k / (n - 2 || 1);
        trailSegs.push({
          x1: a.p.x,
          y1: a.p.y,
          x2: b.p.x,
          y2: b.p.y,
          opacity: Math.min(
            0.8,
            (0.2 + 0.5 * ageT) * Math.min(1, Math.min(a.src.c, b.src.c) + 0.25),
          ),
          strokeWidth: 1.5 + 1.5 * ageT,
        });
      }
      const tip = n >= 1 ? projectedTrail[n - 1] : undefined;
      if (tip) trailTip = { x: tip.p.x, y: tip.p.y };
    }

    // ONE painter-sorted pass across BOTH skeletons so ghost and user bones
    // occlude each other correctly instead of one always drawing on top.
    const refSegs = refFrame ? projectSkeleton(refFrame, SKELETON_BONES, cam, vp) : [];
    const userSegs = projectSkeleton(userFrame, SKELETON_BONES, cam, vp);
    const bones: BoneDraw[] = [
      ...refSegs.map((seg) => ({ seg, kind: 'ref' as const })),
      ...userSegs.map((seg) => ({ seg, kind: 'user' as const })),
    ]
      .sort((a, b) => b.seg.depth - a.seg.depth)
      .map(({ seg, kind }) => ({
        x1: seg.a.x,
        y1: seg.a.y,
        x2: seg.b.x,
        y2: seg.b.y,
        kind,
        strokeWidth: strokeWidthFor(seg.depth, cam, kind === 'user' ? USER_STROKE : REF_STROKE),
        // Low-confidence user bones read fainter — a visible honesty cue.
        opacity: kind === 'user' ? Math.min(1, 0.45 + seg.c) : 1,
      }));

    // User joints only (the ghost stays a clean dashed outline). Hollow ring
    // below the confidence gate = "this joint's depth is estimated".
    const joints: DotDraw[] = [];
    for (const name of Object.keys(userFrame) as PoseKeypointName[]) {
      const j = userFrame[name];
      if (!j) continue;
      const p = projectPoint(j, cam, vp);
      if (!p) continue;
      joints.push({
        x: p.x,
        y: p.y,
        r: strokeWidthFor(p.depth, cam, USER_STROKE) * 0.75,
        solid: j.c >= LOW_CONFIDENCE,
      });
    }

    const headAt = (frame: Frame3D, base: number): HeadDraw | null => {
      const nose = frame.nose;
      if (!nose) return null;
      const p = projectPoint(nose, cam, vp);
      if (!p) return null;
      return { x: p.x, y: p.y, r: strokeWidthFor(p.depth, cam, base) * 1.6 };
    };
    const userHead = headAt(userFrame, USER_STROKE);
    const refHead = refFrame ? headAt(refFrame, REF_STROKE) : null;

    // Callout chips: text is preformatted by the parent (≈ prefix included);
    // a callout whose joint is absent this frame simply doesn't render.
    const chips: CalloutDraw[] = [];
    for (const callout of callouts.slice(0, MAX_CALLOUTS)) {
      const joint = userFrame[callout.joint];
      if (!joint) continue;
      const p = projectPoint(joint, cam, vp);
      if (!p) continue;
      const measured = CALLOUT_FONT.measureText(callout.text).width;
      const textW = measured > 0 ? measured : 60;
      const chipW = textW + 16;
      const chipH = 20;
      const chipX = clamp(p.x + 12, 4, width - chipW - 4);
      const chipY = clamp(p.y - 30, 4, height - chipH - 4);
      chips.push({
        leader: { x1: p.x, y1: p.y, x2: chipX + 6, y2: chipY + chipH },
        chipX,
        chipY,
        chipW,
        chipH,
        textX: chipX + 8,
        textY: chipY + 14,
        text: callout.text,
      });
    }

    return { grid, axes, trailSegs, trailTip, bones, joints, userHead, refHead, chips };
  }, [cam, groundY, refFrame, userFrame, width, height, trailHand, user, pos, callouts]);

  if (!scene) return null;

  return (
    // Skia's Canvas can't carry accessibility props — the wrapper View does.
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={{ width, height }}
    >
      <GestureDetector gesture={gesture}>
        <View collapsable={false} style={{ width, height }}>
          <Canvas style={{ width, height }}>
            {/* Ground grid on the ankle plane. */}
            {scene.grid.map((ln, i) => (
              <Line
                key={`g-${i}`}
                p1={vec(ln.x1, ln.y1)}
                p2={vec(ln.x2, ln.y2)}
                strokeWidth={1}
                color={color.ghostTint}
              />
            ))}
            {scene.axes.map((ln, i) => (
              <Line
                key={`ax-${i}`}
                p1={vec(ln.x1, ln.y1)}
                p2={vec(ln.x2, ln.y2)}
                strokeWidth={1}
                color={color.ghost}
              />
            ))}

            {/* Estimated wrist path — under the skeletons; real gaps stay. */}
            {scene.trailSegs.map((seg, i) => (
              <Line
                key={`t-${i}`}
                p1={vec(seg.x1, seg.y1)}
                p2={vec(seg.x2, seg.y2)}
                strokeWidth={seg.strokeWidth}
                strokeCap="round"
                color={color.accent}
                opacity={seg.opacity}
              />
            ))}
            {scene.trailTip && (
              <Circle
                cx={scene.trailTip.x}
                cy={scene.trailTip.y}
                r={3}
                color={color.accent}
                opacity={0.9}
              />
            )}

            {/* Both skeletons, far→near from the single merged sort. */}
            {scene.bones.map((b, i) =>
              b.kind === 'ref' ? (
                <Line
                  key={`b-${i}`}
                  p1={vec(b.x1, b.y1)}
                  p2={vec(b.x2, b.y2)}
                  strokeWidth={b.strokeWidth}
                  strokeCap="round"
                  color={color.ghost}
                >
                  <DashPathEffect intervals={[6, 6]} />
                </Line>
              ) : (
                <Line
                  key={`b-${i}`}
                  p1={vec(b.x1, b.y1)}
                  p2={vec(b.x2, b.y2)}
                  strokeWidth={b.strokeWidth}
                  strokeCap="round"
                  color={color.accent}
                  opacity={b.opacity}
                />
              ),
            )}

            {/* User joints: filled = trusted depth, hollow ring = estimated. */}
            {scene.joints.map((j, i) =>
              j.solid ? (
                <Circle key={`j-${i}`} cx={j.x} cy={j.y} r={j.r} color={color.accent} />
              ) : (
                <Circle
                  key={`j-${i}`}
                  cx={j.x}
                  cy={j.y}
                  r={j.r}
                  style="stroke"
                  strokeWidth={2}
                  color={color.accent}
                />
              ),
            )}

            {/* Heads — the lift has no eye/ear depth, so a circle at the nose. */}
            {scene.refHead && (
              <Circle
                cx={scene.refHead.x}
                cy={scene.refHead.y}
                r={scene.refHead.r}
                style="stroke"
                strokeWidth={2}
                color={color.ghost}
              >
                <DashPathEffect intervals={[6, 6]} />
              </Circle>
            )}
            {scene.userHead && (
              <Circle
                cx={scene.userHead.x}
                cy={scene.userHead.y}
                r={scene.userHead.r}
                style="stroke"
                strokeWidth={3}
                color={color.accent}
              />
            )}

            {/* Callout chips draw last so they sit above both figures. */}
            {scene.chips.map((c, i) => (
              <Group key={`c-${i}`}>
                <Line
                  p1={vec(c.leader.x1, c.leader.y1)}
                  p2={vec(c.leader.x2, c.leader.y2)}
                  strokeWidth={1}
                  color={color.textFaint}
                />
                <RoundedRect
                  x={c.chipX}
                  y={c.chipY}
                  width={c.chipW}
                  height={c.chipH}
                  r={6}
                  color={color.surface}
                  opacity={0.94}
                />
                <RoundedRect
                  x={c.chipX}
                  y={c.chipY}
                  width={c.chipW}
                  height={c.chipH}
                  r={6}
                  style="stroke"
                  strokeWidth={1}
                  color={color.border}
                />
                <SkText x={c.textX} y={c.textY} text={c.text} font={CALLOUT_FONT} color={color.text} />
              </Group>
            ))}
          </Canvas>
        </View>
      </GestureDetector>
    </View>
  );
}
