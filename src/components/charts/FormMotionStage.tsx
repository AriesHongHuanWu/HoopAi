/**
 * FormMotionStage — the Form Studio "theater": two stick-figure skeletons on
 * one stage, the user's captured shooting motion (leather-accent, solid) beside
 * a synthesized NBA reference form (chalk, dashed), both posed at the SAME
 * scrub position so the two motions read against each other frame-for-frame.
 *
 * PSEUDO-DEPTH (honest 2.5D, never a real 3D claim): MoveNet gives us 2D
 * keypoints. We *illustrate* depth three ways — (1) a soft ground shadow under
 * each figure, (2) limb LAYERING (the far-side arm/leg is drawn first, thinner
 * and dimmer, the near-side over it, thicker and brighter), and (3) a small
 * horizontal PARALLAX split between the near and far body planes. This reads as
 * volume without pretending we reconstructed a 3D pose. True 2D→3D lifting is
 * noted as a future upgrade in src/core/formSequence.ts.
 *
 * Presentation-only + pure render: it takes a scrub fraction and two decoded
 * normalized sequences (hip-center origin, +y DOWN, body-height units) and
 * draws them. No animation lives here — the screen owns the clock and passes
 * `pos` (0..1); this component just poses both skeletons at that instant, so it
 * works identically for autoplay, scrubbing, and the reduced-motion stepper.
 */
import { BlurMask, Canvas, Circle, Line, Oval, vec } from '@shopify/react-native-skia';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '@/constants/tokens';
import { angleAtDeg } from '@/core/geometry';
import type { DecodedFrame } from '@/core/formSequence';
import type { PoseKeypointName, ShootingHand } from '@/core/types';

/** Torso + limb segments; `side` marks which limbs get near/far layering. */
interface Bone {
  a: PoseKeypointName;
  b: PoseKeypointName;
  /** 'trunk' draws in the mid plane; 'left'/'right' get depth layering. */
  side: 'trunk' | 'left' | 'right';
}

const BONES: Bone[] = [
  { a: 'left_shoulder', b: 'right_shoulder', side: 'trunk' },
  { a: 'left_hip', b: 'right_hip', side: 'trunk' },
  { a: 'left_shoulder', b: 'left_hip', side: 'trunk' },
  { a: 'right_shoulder', b: 'right_hip', side: 'trunk' },
  { a: 'left_shoulder', b: 'left_elbow', side: 'left' },
  { a: 'left_elbow', b: 'left_wrist', side: 'left' },
  { a: 'right_shoulder', b: 'right_elbow', side: 'right' },
  { a: 'right_elbow', b: 'right_wrist', side: 'right' },
  { a: 'left_hip', b: 'left_knee', side: 'left' },
  { a: 'left_knee', b: 'left_ankle', side: 'left' },
  { a: 'right_hip', b: 'right_knee', side: 'right' },
  { a: 'right_knee', b: 'right_ankle', side: 'right' },
];

interface XY {
  x: number;
  y: number;
}

/** Linear-interpolate two decoded frames at fraction u for one keypoint. */
function lerpKp(a: DecodedFrame, b: DecodedFrame, name: PoseKeypointName, u: number): XY | null {
  const pa = a[name];
  const pb = b[name];
  if (pa && pb) return { x: pa.x + (pb.x - pa.x) * u, y: pa.y + (pb.y - pa.y) * u };
  return pa ?? pb ?? null;
}

/** Pose one sequence at scrub fraction `pos` (0..1) → interpolated keypoints. */
function poseAt(seq: readonly DecodedFrame[], pos: number): DecodedFrame {
  if (seq.length === 0) return {};
  if (seq.length === 1) return seq[0]!;
  const f = pos * (seq.length - 1);
  const i = Math.min(seq.length - 2, Math.max(0, Math.floor(f)));
  const u = f - i;
  const a = seq[i]!;
  const b = seq[i + 1]!;
  const out: DecodedFrame = {};
  for (const name of Object.keys({ ...a, ...b }) as PoseKeypointName[]) {
    const p = lerpKp(a, b, name, u);
    if (p) out[name] = p;
  }
  return out;
}

/**
 * Map a normalized (hip-center, body-height) frame into panel pixels. A shared
 * scale/offset for both figures keeps them the same visual height so the
 * comparison is fair regardless of the reference vs capture proportions.
 */
function project(
  frame: DecodedFrame,
  panelX: number,
  panelW: number,
  panelH: number,
  padTop: number,
): Map<PoseKeypointName, XY> {
  const out = new Map<PoseKeypointName, XY>();
  // Normalized coords sit roughly in y∈[-0.9, 0.6], x∈[-0.35, 0.4]. Use a fixed
  // reference span so a raised-arm frame doesn't rescale the whole figure
  // between scrub positions (which would look like zooming, not moving).
  const spanY = 1.7; // -0.95 .. +0.75
  const scale = (panelH - padTop - 30) / spanY;
  const cx = panelX + panelW / 2;
  const cyHip = padTop + 0.95 * scale; // hip-center y within the panel
  for (const [name, p] of Object.entries(frame) as [PoseKeypointName, XY][]) {
    out.set(name, { x: cx + p.x * scale, y: cyHip + p.y * scale });
  }
  return out;
}

/** Shooting-side joint name → whether it's the near (shooting) side. */
function nearSideFor(hand: ShootingHand): 'left' | 'right' {
  return hand === 'right' ? 'right' : 'left';
}

export type StagePhase = 'DIP' | 'RISE' | 'RELEASE' | 'FOLLOW';

export interface FormMotionStageProps {
  user: readonly DecodedFrame[];
  reference: readonly DecodedFrame[];
  /** Scrub position 0..1 across the aligned timeline. */
  pos: number;
  hand: ShootingHand;
  /** Phase label shown for the current scrub position. */
  phase: StagePhase;
  width: number;
  height: number;
  accessibilityLabel?: string;
}

/** Elbow / knee angle for the shooting side of a projected figure. */
function shootingAngles(
  pts: Map<PoseKeypointName, XY>,
  hand: ShootingHand,
): { elbow: number | null; knee: number | null } {
  const s = hand === 'right' ? 'right' : 'left';
  const sh = pts.get(`${s}_shoulder` as PoseKeypointName);
  const el = pts.get(`${s}_elbow` as PoseKeypointName);
  const wr = pts.get(`${s}_wrist` as PoseKeypointName);
  const hp = pts.get(`${s}_hip` as PoseKeypointName);
  const kn = pts.get(`${s}_knee` as PoseKeypointName);
  const an = pts.get(`${s}_ankle` as PoseKeypointName);
  return {
    elbow: sh && el && wr ? angleAtDeg(sh, el, wr) : null,
    knee: hp && kn && an ? angleAtDeg(hp, kn, an) : null,
  };
}

interface FigureGeom {
  pts: Map<PoseKeypointName, XY>;
  bones: { a: XY; b: XY; near: boolean; trunk: boolean }[];
  shadow: { cx: number; cy: number; rx: number } | null;
  elbowPt: XY | null;
  kneePt: XY | null;
  angles: { elbow: number | null; knee: number | null };
}

function buildFigure(
  frame: DecodedFrame,
  panelX: number,
  panelW: number,
  panelH: number,
  padTop: number,
  hand: ShootingHand,
): FigureGeom {
  const pts = project(frame, panelX, panelW, panelH, padTop);
  const near = nearSideFor(hand);
  const bones: FigureGeom['bones'] = [];
  for (const bone of BONES) {
    const a = pts.get(bone.a);
    const b = pts.get(bone.b);
    if (!a || !b) continue;
    bones.push({ a, b, near: bone.side === near, trunk: bone.side === 'trunk' });
  }
  // Ground shadow under the lowest visible foot.
  const ankles = [pts.get('left_ankle'), pts.get('right_ankle')].filter(Boolean) as XY[];
  let shadow: FigureGeom['shadow'] = null;
  if (ankles.length > 0) {
    const cy = Math.max(...ankles.map((a) => a.y)) + 6;
    const cx = ankles.reduce((s, a) => s + a.x, 0) / ankles.length;
    shadow = { cx, cy, rx: panelW * 0.18 };
  }
  const s = hand === 'right' ? 'right' : 'left';
  return {
    pts,
    bones,
    shadow,
    elbowPt: pts.get(`${s}_elbow` as PoseKeypointName) ?? null,
    kneePt: pts.get(`${s}_knee` as PoseKeypointName) ?? null,
    angles: shootingAngles(pts, hand),
  };
}

export function FormMotionStage({
  user,
  reference,
  pos,
  hand,
  phase,
  width,
  height,
  accessibilityLabel,
}: FormMotionStageProps) {
  const geom = useMemo(() => {
    if (width <= 0 || height <= 0) return null;
    const padTop = 30;
    const half = width / 2;
    const uFrame = poseAt(user, pos);
    const rFrame = poseAt(reference, pos);
    // Parallax: near side nudged out, far side in — a subtle 2.5D split.
    const userFig = buildFigure(uFrame, 0, half, height, padTop, hand);
    const refFig = buildFigure(rFrame, half, half, height, padTop, hand);
    return { userFig, refFig, half };
  }, [user, reference, pos, hand, width, height]);

  if (!geom) {
    return <View style={{ width: Math.max(0, width), height: Math.max(0, height) }} />;
  }

  const { userFig, refFig, half } = geom;
  const PARALLAX = 3;

  const renderFigure = (
    fig: FigureGeom,
    opts: {
      stroke: string;
      glow: string;
      dashed: boolean;
      jointColor: string;
    },
  ) => {
    const nearBones = fig.bones.filter((b) => b.near);
    const midBones = fig.bones.filter((b) => b.trunk);
    const farBones = fig.bones.filter((b) => !b.near && !b.trunk);
    // Parallax offset: far limbs shift one way, near limbs the other.
    const px = (near: boolean, mid: boolean) => (mid ? 0 : near ? PARALLAX : -PARALLAX);
    return (
      <>
        {/* Ground shadow — the flat anchor that sells the standing figure. */}
        {fig.shadow && (
          <Oval
            x={fig.shadow.cx - fig.shadow.rx}
            y={fig.shadow.cy - 4}
            width={fig.shadow.rx * 2}
            height={8}
            color="rgba(0,0,0,0.45)"
          >
            <BlurMask blur={5} style="normal" />
          </Oval>
        )}
        {/* FAR limbs: thin + dim, drawn first so near limbs overlap them. */}
        {farBones.map((b, i) => (
          <Line
            key={`far-${i}`}
            p1={vec(b.a.x - PARALLAX, b.a.y)}
            p2={vec(b.b.x - PARALLAX, b.b.y)}
            strokeWidth={opts.dashed ? 2 : 3}
            strokeCap="round"
            color={opts.stroke}
            opacity={0.4}
          />
        ))}
        {/* Trunk: mid plane. */}
        {midBones.map((b, i) => (
          <Line
            key={`mid-${i}`}
            p1={vec(b.a.x, b.a.y)}
            p2={vec(b.b.x, b.b.y)}
            strokeWidth={opts.dashed ? 2.5 : 4}
            strokeCap="round"
            color={opts.stroke}
            opacity={0.85}
          />
        ))}
        {/* NEAR limbs: glow underlay + bold stroke, shifted out for parallax. */}
        {!opts.dashed &&
          nearBones.map((b, i) => (
            <Line
              key={`ng-${i}`}
              p1={vec(b.a.x + PARALLAX, b.a.y)}
              p2={vec(b.b.x + PARALLAX, b.b.y)}
              strokeWidth={9}
              strokeCap="round"
              color={opts.glow}
            >
              <BlurMask blur={6} style="normal" />
            </Line>
          ))}
        {nearBones.map((b, i) => (
          <Line
            key={`near-${i}`}
            p1={vec(b.a.x + PARALLAX, b.a.y)}
            p2={vec(b.b.x + PARALLAX, b.b.y)}
            strokeWidth={opts.dashed ? 3 : 5}
            strokeCap="round"
            color={opts.stroke}
          />
        ))}
        {/* Head. */}
        {fig.pts.get('nose') && (
          <Circle
            cx={fig.pts.get('nose')!.x}
            cy={fig.pts.get('nose')!.y - 4}
            r={9}
            style="stroke"
            strokeWidth={opts.dashed ? 2.5 : 3.5}
            color={opts.stroke}
          />
        )}
        {/* Shooting elbow + knee joint pips (the measured joints). */}
        {[fig.elbowPt, fig.kneePt].map((p, i) =>
          p ? (
            <React.Fragment key={`j-${i}`}>
              <Circle cx={p.x + px(true, false)} cy={p.y} r={4.5} color={color.bg} />
              <Circle cx={p.x + px(true, false)} cy={p.y} r={2.8} color={opts.jointColor} />
            </React.Fragment>
          ) : null,
        )}
      </>
    );
  };

  const uA = userFig.angles;

  return (
    <View
      accessible={accessibilityLabel != null}
      accessibilityLabel={accessibilityLabel}
      style={{ width, height }}
    >
      <Canvas style={{ width, height }}>
        {/* Center divider — the two lanes of the stage. */}
        <Line
          p1={vec(half, 24)}
          p2={vec(half, height - 8)}
          strokeWidth={StyleSheet.hairlineWidth}
          color={color.border}
          opacity={0.6}
        />
        {renderFigure(userFig, {
          stroke: color.accent,
          glow: 'rgba(240, 90, 36, 0.5)',
          dashed: false,
          jointColor: color.accent,
        })}
        {renderFigure(refFig, {
          stroke: color.textDim,
          glow: 'transparent',
          dashed: true,
          jointColor: color.text,
        })}
      </Canvas>

      {/* Lane labels. */}
      <View style={[styles.laneLabel, { left: space.sm }]} pointerEvents="none">
        <View style={[styles.swatch, { backgroundColor: color.accent }]} />
        <Text style={styles.laneText}>YOU</Text>
      </View>
      <View style={[styles.laneLabel, { right: space.sm }]} pointerEvents="none">
        <View style={styles.dashSwatch}>
          <View style={styles.dashSeg} />
          <View style={styles.dashSeg} />
        </View>
        <Text style={styles.laneText}>REFERENCE</Text>
      </View>

      {/* Phase pill, centered on the divider. */}
      <View style={[styles.phasePill, { left: half - 42 }]} pointerEvents="none">
        <Text style={styles.phaseText}>{phase}</Text>
      </View>

      {/* Angle callout for the user's shooting joints at this instant. */}
      {(uA.elbow != null || uA.knee != null) && (
        <View style={styles.angleCallout} pointerEvents="none">
          {uA.elbow != null && (
            <Text style={styles.angleText}>ELBOW {Math.round(uA.elbow)}°</Text>
          )}
          {uA.knee != null && (
            <Text style={styles.angleText}>KNEE {Math.round(uA.knee)}°</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  laneLabel: {
    position: 'absolute',
    top: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  laneText: {
    ...type.micro,
    color: color.textDim,
  },
  swatch: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  dashSwatch: {
    flexDirection: 'row',
    gap: 2,
  },
  dashSeg: {
    width: 5,
    height: 2,
    borderRadius: 1,
    backgroundColor: color.textDim,
  },
  phasePill: {
    position: 'absolute',
    top: 2,
    width: 84,
    alignItems: 'center',
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: radius.pill,
    paddingVertical: 2,
  },
  phaseText: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1,
  },
  angleCallout: {
    position: 'absolute',
    left: space.sm,
    bottom: space.sm,
    gap: 2,
  },
  angleText: {
    ...type.micro,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
});
