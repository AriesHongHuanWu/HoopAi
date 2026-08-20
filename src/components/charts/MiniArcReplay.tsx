/**
 * MiniArcReplay — animated comet sweep over a resolved shot's PERSISTED
 * trajectory (ResolvedShot.trajectory, round-tripped via shots.trajectoryJson,
 * so history rows replay with zero schema change), for the "Arc replay" card
 * opened from the recap shot chart.
 *
 * Honesty boundary: purely presentational. It redraws stored samples and its
 * a11y label reads the shot's REAL persisted entryAngleDeg — nothing here
 * re-derives an angle or re-judges an outcome, and nothing feeds the FSM.
 *
 * PERF: exactly ONE MiniArcReplay is ever mounted (the selection-gated replay
 * card). Deliberately NOT used as a per-row thumbnail — ShotList is a
 * non-virtualized scrollEnabled={false} FlatList rendering every row, and ~60
 * live Skia canvases would tank the summary screen. "Persisted arc
 * thumbnails" are satisfied by rendering from trajectoryJson on demand.
 *
 * Tap replays the sweep; under reduced motion the full arc renders static and
 * taps do nothing.
 */
import {
  BlurMask,
  Canvas,
  Circle,
  DashPathEffect,
  Path,
  Skia,
} from '@shopify/react-native-skia';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { color, glow } from '@/constants/tokens';
import type { Point, ResolvedShot } from '@/core/types';

import { buildSparklinePoints } from '../hud/shotSparkline';
import { partialPolyline, replayDurationMs } from './miniArcReplayGeometry';

/** Inset so stroke caps and the comet head never clip at the box edges. */
const INSET = 8;
/** Trajectories shorter than this can't read as an arc — render nothing. */
const MIN_SAMPLES = 5;
/** Off-canvas parking spot for the comet head while the sweep is empty. */
const OFFSCREEN = -100;

export interface MiniArcReplayProps {
  shot: ResolvedShot;
  /** Canvas height in px; width fills the container via onLayout. */
  height?: number;
  /** Set false to render the finished arc without the sweep. */
  animate?: boolean;
}

export function MiniArcReplay({ shot, height = 96, animate = true }: MiniArcReplayProps) {
  const [width, setWidth] = useState(0);
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0);

  // Normalization reuses the ShotToast sparkline geometry: per-axis fit of
  // +y-down analysis px into the box, no axis flip (screen is +y down too).
  const points = useMemo(
    () => buildSparklinePoints(shot.trajectory, width, height, INSET),
    [shot, width, height],
  );

  // Screen apex = min y (+y down): the peak of the flight in box space.
  const apex = useMemo(() => {
    let best: Point | null = null;
    for (const p of points) if (best == null || p.y < best.y) best = p;
    return best;
  }, [points]);

  // Full-arc ghost under the sweep — static, built once per layout.
  const ghostPath = useMemo(() => {
    const p = Skia.Path.Make();
    if (points.length < 2) return p;
    p.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) p.lineTo(points[i]!.x, points[i]!.y);
    return p;
  }, [points]);

  // One partial polyline per animation frame; the path and the head are both
  // views of it. Stored samples are dense, so straight lineTo segments read
  // clean at this size (no quad smoothing needed).
  const partial = useDerivedValue(() => partialPolyline(points, progress.value));
  const cometPath = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const pts = partial.value;
    if (pts.length < 2) return path;
    path.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i]!.x, pts[i]!.y);
    return path;
  });
  const headX = useDerivedValue(() => {
    const pts = partial.value;
    return pts.length > 0 ? pts[pts.length - 1]!.x : OFFSCREEN;
  });
  const headY = useDerivedValue(() => {
    const pts = partial.value;
    return pts.length > 0 ? pts[pts.length - 1]!.y : OFFSCREEN;
  });

  // Sweep duration tracks the shot's real flight time (clamped in geometry).
  const runSweep = useCallback(() => {
    progress.value = 0;
    progress.value = withTiming(1, {
      duration: replayDurationMs(shot.trajectory),
      easing: Easing.out(Easing.quad),
    });
  }, [progress, shot]);

  useEffect(() => {
    if (!animate || reducedMotion) {
      progress.value = 1;
      return;
    }
    runSweep();
    // width in deps: the first sweep should start when the canvas gets real
    // points, not against the pre-layout empty polyline.
  }, [shot.id, width, animate, reducedMotion, progress, runSweep]);

  const replay = useCallback(() => {
    if (reducedMotion) return;
    runSweep();
  }, [reducedMotion, runSweep]);

  if (shot.trajectory.length < MIN_SAMPLES) return null;

  const label = `Shot arc replay${
    shot.entryAngleDeg != null ? `, entry angle ${Math.round(shot.entryAngleDeg)} degrees` : ''
  }. Tap to replay.`;

  return (
    <View style={{ height }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && points.length >= 2 && (
        <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={replay}>
          <Canvas style={{ width, height }}>
            {/* Full-arc ghost: dashed and quiet — the sweep draws over it. */}
            <Path
              path={ghostPath}
              style="stroke"
              strokeWidth={1.5}
              color={color.accent}
              opacity={0.28}
            >
              <DashPathEffect intervals={[5, 5]} />
            </Path>

            {/* Comet: soft glow pass under the core stroke */}
            <Path
              path={cometPath}
              style="stroke"
              strokeWidth={7}
              strokeCap="round"
              strokeJoin="round"
              color={glow.trailBloom}
              opacity={0.35}
            >
              <BlurMask blur={6} style="normal" />
            </Path>
            <Path
              path={cometPath}
              style="stroke"
              strokeWidth={3}
              strokeCap="round"
              strokeJoin="round"
              color={glow.trail}
              opacity={0.9}
            />

            {/* Comet head: warm halo + chalk core */}
            <Circle cx={headX} cy={headY} r={7} color={glow.cometHalo} opacity={0.7}>
              <BlurMask blur={4} style="normal" />
            </Circle>
            <Circle cx={headX} cy={headY} r={4.5} color={glow.cometCore} />

            {/* Apex tick */}
            {apex != null && (
              <Circle cx={apex.x} cy={apex.y} r={2.5} color={color.accent} opacity={0.8} />
            )}
          </Canvas>
        </Pressable>
      )}
    </View>
  );
}
