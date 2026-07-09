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
import { Canvas, Circle, DashPathEffect, Line, vec } from '@shopify/react-native-skia';
import React, { useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { color } from '@/constants/tokens';
import {
  DEFAULT_CAMERA,
  groundGrid,
  orbitFromDrag,
  pinchZoom,
  projectPoint,
  projectSkeleton,
  strokeWidthFor,
  type OrbitCamera,
} from '@/core/pose3d/camera3d';
import { SKELETON_BONES, type Frame3D, type LiftedSequence } from '@/core/pose3d/lift';
import type { PoseKeypointName } from '@/core/types';

/** Joints lifted below this confidence render as hollow rings, not dots. */
const LOW_CONFIDENCE = 0.55;
/** Minimum ms between camera setState calls during a gesture (~60 fps). */
const THROTTLE_MS = 16;
/** Base stroke px for the user skeleton / the reference ghost. */
const USER_STROKE = 5;
const REF_STROKE = 3.5;
/** Half-length (body heights) of the axis cross — matches groundGrid extent. */
const AXIS_HALF = 1.2;

export interface FormStage3DProps {
  user: LiftedSequence;
  /** NBA ghost — may have a different frame count; indexed by the same `pos`. */
  reference?: LiftedSequence | null;
  /** Scrub position 0..1 across the sequence (parent owns playback). */
  pos: number;
  width: number;
  height: number;
  accessibilityLabel: string;
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
}: FormStage3DProps): React.JSX.Element | null {
  const [cam, setCam] = useState<OrbitCamera>(DEFAULT_CAMERA);

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
          setCam((c) => orbitFromDrag(c, dx, dy, width));
        })
        .onFinalize(() => {
          const dx = panDx.current;
          const dy = panDy.current;
          panDx.current = 0;
          panDy.current = 0;
          if (dx !== 0 || dy !== 0) setCam((c) => orbitFromDrag(c, dx, dy, width));
        }),
    [width],
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
          setCam((c) => pinchZoom(c, s));
        })
        .onFinalize(() => {
          const s = pinchScale.current;
          pinchScale.current = 1;
          if (s !== 1) setCam((c) => pinchZoom(c, s));
        }),
    [],
  );

  const gesture = useMemo(() => Gesture.Simultaneous(pan, pinch), [pan, pinch]);

  // Ground plane: lowest (max, +y is down) ankle seen in the first frames —
  // fixed per sequence so the floor doesn't bob while scrubbing.
  const groundY = useMemo(() => {
    let g = -Infinity;
    for (const frame of user.frames.slice(0, 3)) {
      for (const name of ['left_ankle', 'right_ankle'] as const) {
        const j = frame[name];
        if (j) g = Math.max(g, j.y);
      }
    }
    return Number.isFinite(g) ? g : 0.5;
  }, [user]);

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

    return { grid, axes, bones, joints, userHead, refHead };
  }, [cam, groundY, refFrame, userFrame, width, height]);

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
          </Canvas>
        </View>
      </GestureDetector>
    </View>
  );
}
