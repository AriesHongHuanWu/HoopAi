/**
 * ReleaseSkeleton — stick-figure of the shooter's pose AT THE RELEASE
 * INSTANT, drawn from the FormReport's pose snapshot. The shooting arm is
 * highlighted in accent; the elbow and knee joints are annotated with their
 * measured angles, colored by whether they sit in the ideal band.
 *
 * Keypoints below the form keypoint-score gate are treated as missing; limbs
 * with a missing endpoint simply aren't drawn (never guessed).
 */
import { Canvas, Circle, Line, vec } from '@shopify/react-native-skia';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '@/constants/tokens';
import { FORM } from '@/core/config';
import type { PoseFrame, PoseKeypointName, ShootingHand } from '@/core/types';

const PAD = 26;
const MIN_SCORE = FORM.keypointScoreMin;

/** Torso + limb segments (drawn chalk unless on the shooting arm). */
const BONES: [PoseKeypointName, PoseKeypointName][] = [
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
];

export interface ReleaseSkeletonProps {
  pose: PoseFrame;
  hand: ShootingHand;
  /** Elbow/knee angles from FormMetrics, shown as joint annotations. */
  elbowDeg?: number | null;
  kneeDeg?: number | null;
  width: number;
  height: number;
}

interface Pt {
  x: number;
  y: number;
}

export function ReleaseSkeleton({ pose, hand, elbowDeg, kneeDeg, width, height }: ReleaseSkeletonProps) {
  const geom = useMemo(() => {
    // Collect usable keypoints.
    const pts = new Map<PoseKeypointName, Pt>();
    for (const [name, kp] of Object.entries(pose.keypoints)) {
      if (kp && kp.score >= MIN_SCORE && Number.isFinite(kp.x) && Number.isFinite(kp.y)) {
        pts.set(name as PoseKeypointName, { x: kp.x, y: kp.y });
      }
    }
    if (pts.size < 5) return null;
    // Fit the figure into the canvas preserving aspect.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts.values()) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const s = Math.min((width - PAD * 2) / spanX, (height - PAD * 2) / spanY);
    const ox = (width - spanX * s) / 2;
    const oy = (height - spanY * s) / 2;
    const map = (p: Pt): Pt => ({ x: ox + (p.x - minX) * s, y: oy + (p.y - minY) * s });
    const mapped = new Map<PoseKeypointName, Pt>();
    for (const [k, p] of pts) mapped.set(k, map(p));

    const armNames: PoseKeypointName[] =
      hand === 'right'
        ? ['right_shoulder', 'right_elbow', 'right_wrist']
        : ['left_shoulder', 'left_elbow', 'left_wrist'];
    const bones = BONES.filter(([a, b]) => mapped.has(a) && mapped.has(b)).map(([a, b]) => ({
      a: mapped.get(a)!,
      b: mapped.get(b)!,
      arm: armNames.includes(a) && armNames.includes(b),
    }));
    const elbowPt = mapped.get(hand === 'right' ? 'right_elbow' : 'left_elbow') ?? null;
    const kneePt = mapped.get(hand === 'right' ? 'right_knee' : 'left_knee') ?? null;
    const headPt = mapped.get('nose') ?? null;
    return { bones, joints: [...mapped.values()], elbowPt, kneePt, headPt };
  }, [pose, hand, width, height]);

  if (!geom) {
    return (
      <Text style={styles.noData}>
        The pose at release was too incomplete to draw for this shot.
      </Text>
    );
  }

  const elbowOk =
    elbowDeg != null &&
    elbowDeg >= FORM.followThrough.elbowMinDeg - 40 && // near-extended at release
    elbowDeg <= 185;
  const kneeOk =
    kneeDeg != null && kneeDeg >= FORM.kneeFlexion.min && kneeDeg <= FORM.kneeFlexion.max;

  return (
    <View style={{ width, height }}>
      <Canvas style={{ width, height }}>
        {geom.bones.map((b, i) => (
          <Line
            key={i}
            p1={vec(b.a.x, b.a.y)}
            p2={vec(b.b.x, b.b.y)}
            strokeWidth={b.arm ? 4 : 2.5}
            strokeCap="round"
            color={b.arm ? color.accent : color.textFaint}
          />
        ))}
        {geom.joints.map((p, i) => (
          <Circle key={`j-${i}`} cx={p.x} cy={p.y} r={3} color={color.text} />
        ))}
        {geom.headPt && (
          <Circle cx={geom.headPt.x} cy={geom.headPt.y - 6} r={8} style="stroke" strokeWidth={2.5} color={color.textFaint} />
        )}
      </Canvas>
      {geom.elbowPt && elbowDeg != null && (
        <View style={[styles.tag, { left: geom.elbowPt.x + 8, top: geom.elbowPt.y - 10 }]}>
          <Text style={[styles.tagText, { color: elbowOk ? color.make : color.unsure }]}>
            elbow {Math.round(elbowDeg)}°
          </Text>
        </View>
      )}
      {geom.kneePt && kneeDeg != null && (
        <View style={[styles.tag, { left: geom.kneePt.x + 8, top: geom.kneePt.y - 10 }]}>
          <Text style={[styles.tagText, { color: kneeOk ? color.make : color.unsure }]}>
            knee {Math.round(kneeDeg)}°
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    position: 'absolute',
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    paddingHorizontal: space.xs,
    paddingVertical: 1,
  },
  tagText: {
    ...type.micro,
    fontVariant: ['tabular-nums'],
  },
  noData: {
    ...type.caption,
    color: color.textFaint,
  },
});
