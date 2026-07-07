/**
 * ReleaseSkeleton — stick-figure of the shooter's pose AT THE RELEASE
 * INSTANT, drawn from the FormReport's pose snapshot. The shooting arm is
 * the hero: accent stroke with a soft glow and ringed accent joints; the
 * rest of the body reads in quieter chalk with dark joint backings so
 * overlapping limbs stay separable. The measured elbow and knee wear a
 * status ring plus a glass tag chip (status dot + angle — color AND shape),
 * colored by whether the angle sits in the ideal band.
 *
 * Keypoints below the form keypoint-score gate are treated as missing; limbs
 * with a missing endpoint simply aren't drawn (never guessed).
 */
import { BlurMask, Canvas, Circle, Line, vec } from '@shopify/react-native-skia';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '@/constants/tokens';
import { FORM } from '@/core/config';
import type { PoseFrame, PoseKeypointName, ShootingHand } from '@/core/types';

const PAD = 26;
const MIN_SCORE = FORM.keypointScoreMin;
/** Accent hue (palette.leather) at glow alpha for the shooting arm. */
const ARM_GLOW = 'rgba(240, 90, 36, 0.5)';
/** Approximate rendered tag width, for edge clamping. */
const TAG_W = 84;

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
    const armSet = new Set<PoseKeypointName>(armNames);
    const bones = BONES.filter(([a, b]) => mapped.has(a) && mapped.has(b)).map(([a, b]) => ({
      a: mapped.get(a)!,
      b: mapped.get(b)!,
      arm: armSet.has(a) && armSet.has(b),
    }));
    const armJoints: Pt[] = [];
    const bodyJoints: Pt[] = [];
    for (const [k, p] of mapped) (armSet.has(k) ? armJoints : bodyJoints).push(p);
    const elbowPt = mapped.get(hand === 'right' ? 'right_elbow' : 'left_elbow') ?? null;
    const kneePt = mapped.get(hand === 'right' ? 'right_knee' : 'left_knee') ?? null;
    const headPt = mapped.get('nose') ?? null;
    return { bones, armJoints, bodyJoints, elbowPt, kneePt, headPt };
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

  // Glass tag chips, clamped inside the canvas so joints near an edge never
  // push their annotation off-screen.
  const tagPos = (p: Pt) => ({
    left: Math.max(2, Math.min(p.x + 10, width - TAG_W)),
    top: Math.max(2, Math.min(p.y - 11, height - 22)),
  });

  return (
    <View style={{ width, height }}>
      <Canvas style={{ width, height }}>
        {/* Dark underlay separates overlapping limbs on the card surface. */}
        {geom.bones.map((b, i) => (
          <Line
            key={`u-${i}`}
            p1={vec(b.a.x, b.a.y)}
            p2={vec(b.b.x, b.b.y)}
            strokeWidth={b.arm ? 7 : 5.5}
            strokeCap="round"
            color={color.bg}
            opacity={0.85}
          />
        ))}
        {/* Body: quiet chalk. */}
        {geom.bones
          .filter((b) => !b.arm)
          .map((b, i) => (
            <Line
              key={`b-${i}`}
              p1={vec(b.a.x, b.a.y)}
              p2={vec(b.b.x, b.b.y)}
              strokeWidth={3}
              strokeCap="round"
              color={color.textDim}
              opacity={0.9}
            />
          ))}
        {/* Shooting arm: glow underlay + solid accent stroke. */}
        {geom.bones
          .filter((b) => b.arm)
          .map((b, i) => (
            <Line
              key={`ag-${i}`}
              p1={vec(b.a.x, b.a.y)}
              p2={vec(b.b.x, b.b.y)}
              strokeWidth={8}
              strokeCap="round"
              color={ARM_GLOW}
            >
              <BlurMask blur={6} style="normal" />
            </Line>
          ))}
        {geom.bones
          .filter((b) => b.arm)
          .map((b, i) => (
            <Line
              key={`a-${i}`}
              p1={vec(b.a.x, b.a.y)}
              p2={vec(b.b.x, b.b.y)}
              strokeWidth={4.5}
              strokeCap="round"
              color={color.accent}
            />
          ))}
        {/* Body joints: chalk on a dark backing ring. */}
        {geom.bodyJoints.map((p, i) => (
          <React.Fragment key={`j-${i}`}>
            <Circle cx={p.x} cy={p.y} r={4.5} color={color.bg} />
            <Circle cx={p.x} cy={p.y} r={2.8} color={color.text} />
          </React.Fragment>
        ))}
        {/* Shooting-arm joints: bigger accent donuts — the joints that matter. */}
        {geom.armJoints.map((p, i) => (
          <React.Fragment key={`aj-${i}`}>
            <Circle cx={p.x} cy={p.y} r={5.5} color={color.bg} />
            <Circle cx={p.x} cy={p.y} r={4} color={color.accent} />
            <Circle cx={p.x} cy={p.y} r={1.6} color={color.bg} />
          </React.Fragment>
        ))}
        {/* Measured joints wear a status ring in the tag's verdict color. */}
        {geom.elbowPt && elbowDeg != null && (
          <Circle
            cx={geom.elbowPt.x}
            cy={geom.elbowPt.y}
            r={9}
            style="stroke"
            strokeWidth={2}
            color={elbowOk ? color.make : color.unsure}
            opacity={0.9}
          />
        )}
        {geom.kneePt && kneeDeg != null && (
          <Circle
            cx={geom.kneePt.x}
            cy={geom.kneePt.y}
            r={9}
            style="stroke"
            strokeWidth={2}
            color={kneeOk ? color.make : color.unsure}
            opacity={0.9}
          />
        )}
        {geom.headPt && (
          <>
            <Circle cx={geom.headPt.x} cy={geom.headPt.y - 6} r={8} color="rgba(245, 241, 236, 0.05)" />
            <Circle
              cx={geom.headPt.x}
              cy={geom.headPt.y - 6}
              r={8}
              style="stroke"
              strokeWidth={3}
              color={color.textDim}
            />
          </>
        )}
      </Canvas>
      {geom.elbowPt && elbowDeg != null && (
        <View style={[styles.tag, tagPos(geom.elbowPt)]}>
          <View
            style={[styles.statusDot, { backgroundColor: elbowOk ? color.make : color.unsure }]}
          />
          <Text style={styles.tagText}>ELBOW {Math.round(elbowDeg)}°</Text>
        </View>
      )}
      {geom.kneePt && kneeDeg != null && (
        <View style={[styles.tag, tagPos(geom.kneePt)]}>
          <View
            style={[styles.statusDot, { backgroundColor: kneeOk ? color.make : color.unsure }]}
          />
          <Text style={styles.tagText}>KNEE {Math.round(kneeDeg)}°</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  statusDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  tagText: {
    ...type.micro,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  noData: {
    ...type.caption,
    color: color.textFaint,
  },
});
