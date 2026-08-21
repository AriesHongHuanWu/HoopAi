/**
 * FormCheck3DPanel — the Form Check report's 3D block: the lifted shooting
 * posture, the NAMED JOINT POSITIONS behind it, and the per-joint angles, with
 * every depth claim carrying its caveat.
 *
 * No math and no renderer live here. The skeleton is drawn by the existing
 * FormStage3D (unit-tested, already used by Form Studio 3D), the geometry
 * comes from src/core/pose3d/* and the judgment from src/core/formCheck3d.ts.
 * This file is layout, copy and the two pieces of interaction the brief asks
 * for: step to a phase, orbit the estimate.
 *
 * HONESTY, VISIBLE ON SCREEN (the app never reports what it did not see):
 * - x/y are MEASURED, z is ESTIMATED — {@link DEPTH_DISCLAIMER} sits under the
 *   stage and the coordinate table names its own units.
 * - a joint missing in 2D is ABSENT in 3D: its row says "not seen" and carries
 *   no numbers. Nothing is interpolated to complete a figure.
 * - an angle whose depth confidence is under {@link MIN_DEPTH_C} renders as
 *   WITHHELD — never a dimmed guess, never a number in a lighter grey.
 * - a bone the lift could not place out of plane is labeled IN PLANE, so a
 *   flat limb reads as "depth not resolved", not as "your arm is flat".
 * - COCO-17 has no hand or foot keypoints, so wrist and ankle angles do not
 *   exist here at all; the shooting wrist shows FOREARM TILT, labeled as the
 *   proxy it is (the angles3d contract).
 *
 * Presentation-only: the parent owns the rep. Motion runs through the shared
 * primitives (useCardStagger, SelectableChip), so the OS reduced-motion
 * setting is honoured by the app's one gate rather than a second one here.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import FormStage3D from '@/components/charts/FormStage3D';
import { SelectableChip, useCardStagger } from '@/components/motion';
import { SectionEyebrow } from '@/components/ScreenHeader';
import { Card, Chip, Row } from '@/components/ui';
import { color, layout, space, type } from '@/constants/tokens';
import {
  DEPTH_DISCLAIMER,
  DEPTH_FLAT_EPS,
  MIN_DEPTH_C,
  type Angle3DVerdict,
  type FormCheck3D,
  type Judged3DAngle,
  type PhaseId,
} from '@/core/formCheck3d';
import { forearmTiltDeg, jointAngleDeg } from '@/core/pose3d/angles3d';
import {
  presetCamera,
  type CameraPresetId,
  type OrbitCamera,
} from '@/core/pose3d/camera3d';
import { LIFT_JOINTS, type Frame3D, type Joint3D } from '@/core/pose3d/lift';
import type { PoseKeypointName, ShootingHand } from '@/core/types';

// ---------------------------------------------------------------------------
// Phase stepper model
// ---------------------------------------------------------------------------

/** The four phases the rep already located, in shot order. */
export const PHASE_LABELS: readonly { id: PhaseId; label: string }[] = [
  { id: 'dip', label: 'Dip' },
  { id: 'setPoint', label: 'Set point' },
  { id: 'release', label: 'Release' },
  { id: 'followThrough', label: 'Follow' },
] as const;

export interface PhaseStep {
  id: PhaseId;
  label: string;
  /** Frame index into the lifted sequence, or null when never located. */
  frame: number | null;
}

/**
 * The stepper's model. A phase the rep never located stays in the row as a
 * DISABLED chip — the reader learns which phase is missing instead of
 * silently getting three chips where four belong.
 */
export function phaseSteps(result: FormCheck3D): PhaseStep[] {
  return PHASE_LABELS.map(({ id, label }) => ({ id, label, frame: result.phases[id] }));
}

/** First located phase, preferring the release (the frame the rep is about). */
export function initialFrame(result: FormCheck3D): number {
  const p = result.phases;
  return p.release ?? p.setPoint ?? p.dip ?? p.followThrough ?? 0;
}

// ---------------------------------------------------------------------------
// Joint readout model
// ---------------------------------------------------------------------------

/** Bone-solved joints and the parent whose depth plane they hang off. */
const PARENT_OF: Partial<Record<PoseKeypointName, PoseKeypointName>> = {
  left_elbow: 'left_shoulder',
  right_elbow: 'right_shoulder',
  left_wrist: 'left_elbow',
  right_wrist: 'right_elbow',
  left_knee: 'left_hip',
  right_knee: 'right_hip',
  left_ankle: 'left_knee',
  right_ankle: 'right_knee',
};

/** a–b–c triples whose angle is taken AT the joint (b). */
const ANGLE_AT: Partial<
  Record<PoseKeypointName, [PoseKeypointName, PoseKeypointName, PoseKeypointName]>
> = {
  left_shoulder: ['left_hip', 'left_shoulder', 'left_elbow'],
  right_shoulder: ['right_hip', 'right_shoulder', 'right_elbow'],
  left_elbow: ['left_shoulder', 'left_elbow', 'left_wrist'],
  right_elbow: ['right_shoulder', 'right_elbow', 'right_wrist'],
  left_hip: ['left_shoulder', 'left_hip', 'left_knee'],
  right_hip: ['right_shoulder', 'right_hip', 'right_knee'],
  left_knee: ['left_hip', 'left_knee', 'left_ankle'],
  right_knee: ['right_hip', 'right_knee', 'right_ankle'],
};

/** Where a joint's z came from — the reader is told, per row. */
export type DepthSource =
  /** Solved from a bone-length prior, out of the image plane. */
  | 'bone'
  /** The bone's depth was under the resolution of a length prior. */
  | 'inPlane'
  /** Placed by the torso yaw (shoulders/hips), not by a bone solve. */
  | 'yaw'
  /** Not seen in 2D — absent in 3D. */
  | 'absent';

export interface JointRow {
  joint: PoseKeypointName;
  /** "R ELBOW" / "L KNEE" / "NOSE". */
  label: string;
  /** True when this is on the shooting side. */
  shooting: boolean;
  pos: Joint3D | null;
  depth: DepthSource;
  /** 3D angle at this joint, or null when there is none to take. */
  angleDeg: number | null;
  /** Which joints the angle spans, for the row's fine print. */
  angleSpan: string | null;
  /** The angle exists but its depth confidence is under the floor. */
  angleWithheld: boolean;
}

const SHORT: Record<string, string> = {
  nose: 'NOSE',
  shoulder: 'SHOULDER',
  elbow: 'ELBOW',
  wrist: 'WRIST',
  hip: 'HIP',
  knee: 'KNEE',
  ankle: 'ANKLE',
};

/** "right_elbow" → "R ELBOW". */
export function jointLabel(joint: PoseKeypointName): string {
  if (joint === 'nose') return SHORT.nose!;
  const [side, part] = joint.split('_') as [string, string];
  return `${side === 'right' ? 'R' : 'L'} ${SHORT[part] ?? part.toUpperCase()}`;
}

/** Human span for a row's angle, e.g. "shoulder → elbow → wrist". */
function spanLabel(triple: [PoseKeypointName, PoseKeypointName, PoseKeypointName]): string {
  return triple.map((n) => n.split('_').pop()!).join(' → ');
}

/**
 * One row per liftable joint for ONE frame: its measured x/y, its estimated z,
 * where that z came from, and the angle taken at it.
 *
 * Shooting side first — that is the side the report is about. A joint the
 * detector never saw is still listed, with no numbers: the reader should see
 * WHICH joint is missing rather than a shorter table.
 */
export function jointRows(frame: Frame3D, hand: ShootingHand): JointRow[] {
  const rows: JointRow[] = LIFT_JOINTS.map((joint) => {
    const pos = frame[joint] ?? null;
    const parent = PARENT_OF[joint];
    let depth: DepthSource;
    if (!pos) depth = 'absent';
    else if (joint === 'nose') {
      // The neck chains off the shoulder-centre pivot, which the lift holds
      // at z = 0 — so the nose is in-plane exactly when its own z is.
      depth = Math.abs(pos.z) <= DEPTH_FLAT_EPS ? 'inPlane' : 'bone';
    } else if (!parent) depth = 'yaw';
    else {
      const p = frame[parent];
      depth = p && Math.abs(pos.z - p.z) <= DEPTH_FLAT_EPS ? 'inPlane' : 'bone';
    }
    const triple = ANGLE_AT[joint];
    const reading = triple ? jointAngleDeg(frame[triple[0]], frame[triple[1]], frame[triple[2]]) : null;
    return {
      joint,
      label: jointLabel(joint),
      shooting: joint.startsWith(hand),
      pos,
      depth,
      angleDeg: reading && reading.c >= MIN_DEPTH_C ? reading.deg : null,
      angleSpan: triple ? spanLabel(triple) : null,
      angleWithheld: reading != null && reading.c < MIN_DEPTH_C,
    };
  });
  // Shooting side, then the off side, then the head — order, not filtering.
  const rank = (r: JointRow) => (r.joint === 'nose' ? 2 : r.shooting ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Body-height coordinate, signed, three decimals — instrument precision. */
export function coord(v: number): string {
  return (v < 0 ? '' : '+') + v.toFixed(3);
}

/** Degrees, one decimal. Never rounded to a whole number it did not measure. */
export function deg(v: number): string {
  return `${v.toFixed(1)}°`;
}

/** Confidence as a percentage, no decimals. */
export function conf(c: number): string {
  return `${Math.round(c * 100)}%`;
}

export interface VerdictBadge {
  label: string;
  tone: 'default' | 'make' | 'accent' | 'unsure';
}

/** One short badge per verdict — the same words the notes use. */
export function verdictBadge(v: Angle3DVerdict): VerdictBadge {
  switch (v) {
    case 'prefer3d':
      return { label: '3D corrects 2D', tone: 'accent' };
    case 'parity':
      return { label: 'agrees with 2D', tone: 'make' };
    case 'prefer2d':
      return { label: 'trust the 2D', tone: 'default' };
    case 'only3d':
      return { label: '3D only', tone: 'accent' };
    case 'withheld':
    default:
      return { label: 'withheld', tone: 'unsure' };
  }
}

/** Title-case label per judged angle id. */
const ANGLE_TITLE: Record<Judged3DAngle['id'], string> = {
  elbow: 'Shooting elbow',
  knee: 'Knee flexion',
  shoulder: 'Arm elevation',
  torsoYaw: 'Torso turn',
};

const PHASE_WORD: Record<PhaseId, string> = {
  dip: 'dip',
  setPoint: 'set point',
  release: 'release',
  followThrough: 'follow-through',
};

/** Camera presets offered under the stage. */
const CAMERA_PRESETS: readonly { id: CameraPresetId; label: string; a11y: string }[] = [
  { id: 'side', label: 'Side', a11y: 'Orbit to the side view' },
  { id: 'front', label: 'Front', a11y: 'Orbit to the front view' },
  { id: 'top', label: 'Top', a11y: 'Orbit to the overhead view' },
] as const;

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface FormCheck3DPanelProps {
  result: FormCheck3D;
  /** Content width available inside the report's cards. */
  width: number;
}

export default function FormCheck3DPanel({
  result,
  width,
}: FormCheck3DPanelProps): React.JSX.Element {
  // The canonical entrance ladder, which returns undefined under reduced
  // motion — the app's one gate, not a second hand-rolled one.
  const cardEnter = useCardStagger();
  const frames = result.lifted.frames;
  const lastIdx = Math.max(0, frames.length - 1);
  const [frameIdx, setFrameIdx] = useState(() => Math.min(initialFrame(result), lastIdx));
  const [cam, setCam] = useState<OrbitCamera>(() => presetCamera('side', result.hand));
  const [preset, setPreset] = useState<CameraPresetId | null>('side');

  const steps = useMemo(() => phaseSteps(result), [result]);
  const activePhase = steps.find((s) => s.frame === frameIdx)?.id ?? null;
  const rows = useMemo(
    () => jointRows(frames[frameIdx] ?? {}, result.hand),
    [frames, frameIdx, result.hand],
  );
  const tilt = useMemo(
    () => forearmTiltDeg(frames[frameIdx] ?? {}, result.hand),
    [frames, frameIdx, result.hand],
  );

  const goToPreset = useCallback(
    (id: CameraPresetId) => {
      setPreset(id);
      setCam(presetCamera(id, result.hand));
    },
    [result.hand],
  );
  // A drag is the user taking the camera back: the preset row stops claiming
  // to describe where the camera is.
  const onCamera = useCallback((next: OrbitCamera) => {
    setPreset(null);
    setCam(next);
  }, []);

  const stageW = Math.max(160, Math.round(width));
  const stageH = Math.round(stageW * 1.05);
  const seen = rows.filter((r) => r.pos != null).length;

  return (
    <View style={styles.stack}>
      {/* ---- Stage ------------------------------------------------------- */}
      <Card entering={cardEnter(0)}>
        <Row gap={space.sm} style={styles.headRow}>
          <SectionEyebrow icon="cube-outline">3D estimate</SectionEyebrow>
          <Text style={styles.counter}>
            {frameIdx + 1}/{frames.length}
          </Text>
        </Row>

        <Text style={styles.lede}>
          {activePhase != null
            ? `Your ${PHASE_WORD[activePhase]}, reconstructed.`
            : 'Scrub by phase, then orbit to read depth.'}
        </Text>

        {/* Phase stepper. A phase the rep never located stays visible and
            disabled — the absence is the information. */}
        <Row gap={space.xs} style={styles.chipRow}>
          {steps.map((s) => (
            <SelectableChip
              key={s.id}
              label={s.label}
              selected={activePhase === s.id}
              disabled={s.frame == null}
              accessibilityRole="radio"
              accessibilityState={{ selected: activePhase === s.id, disabled: s.frame == null }}
              onPress={() => {
                if (s.frame != null) setFrameIdx(s.frame);
              }}
              accessibilityLabel={
                s.frame == null
                  ? `${s.label}: not located in this rep`
                  : `Show the ${s.label.toLowerCase()} frame`
              }
            />
          ))}
        </Row>

        <View style={styles.stageWrap}>
          <FormStage3D
            user={result.lifted}
            pos={lastIdx === 0 ? 0 : frameIdx / lastIdx}
            width={stageW}
            height={stageH}
            camera={cam}
            onCameraChange={onCamera}
            trailHand={result.hand}
            accessibilityLabel={`Estimated 3D reconstruction of your shooting motion at frame ${
              frameIdx + 1
            } of ${frames.length}. Drag to orbit.`}
          />
        </View>

        <Row gap={space.xs} style={styles.chipRow}>
          {CAMERA_PRESETS.map((p) => (
            <SelectableChip
              key={p.id}
              label={p.label}
              selected={preset === p.id}
              accessibilityRole="radio"
              onPress={() => goToPreset(p.id)}
              accessibilityLabel={p.a11y}
            />
          ))}
        </Row>
        <Text style={styles.caption}>Drag to orbit · pinch to zoom</Text>
        <Text style={styles.caption}>
          Wrist path is estimated from pose — not ball tracking.
        </Text>
        <Text style={styles.caption}>{DEPTH_DISCLAIMER}</Text>
        {result.scale.collapsed && (
          <Text style={styles.warn}>
            This rep&rsquo;s limbs stayed inside the image plane, so their depth could not be
            recovered. Every reading below that needed depth is withheld or flat — the 2D
            numbers in the report are the ones to read.
          </Text>
        )}
      </Card>

      {/* ---- Joint positions -------------------------------------------- */}
      <Card entering={cardEnter(1)}>
        <SectionEyebrow icon="git-commit-outline">Joint positions</SectionEyebrow>
        <Text style={styles.subhead}>
          {`${seen} of ${rows.length} joints seen · body heights from the hip centre · +x right, +y down, +z toward the camera`}
        </Text>
        <Row gap={space.sm} style={[styles.tableRow, styles.tableHead]}>
          <Text style={[styles.cellJoint, styles.headCell]}>JOINT</Text>
          <Text style={[styles.cellNum, styles.headCell]}>X</Text>
          <Text style={[styles.cellNum, styles.headCell]}>Y</Text>
          <Text style={[styles.cellNum, styles.headCell]}>Z</Text>
          <Text style={[styles.cellAngle, styles.headCell]}>ANGLE</Text>
        </Row>
        {rows.map((r, i) => (
          <View key={r.joint} style={[styles.tableRow, i > 0 && styles.rowDivider]}>
            <Row gap={space.sm}>
              <Text
                style={[styles.cellJoint, styles.jointName, r.shooting && styles.jointShooting]}
                numberOfLines={1}
              >
                {r.label}
              </Text>
              {r.pos != null ? (
                <>
                  <Text style={[styles.cellNum, styles.num]}>{coord(r.pos.x)}</Text>
                  <Text style={[styles.cellNum, styles.num]}>{coord(r.pos.y)}</Text>
                  <Text
                    style={[
                      styles.cellNum,
                      styles.num,
                      r.depth === 'inPlane' && styles.numFlat,
                    ]}
                  >
                    {coord(r.pos.z)}
                  </Text>
                </>
              ) : (
                <Text style={[styles.cellSpan3, styles.notSeen]}>not seen</Text>
              )}
              {r.angleDeg != null ? (
                <Text style={[styles.cellAngle, styles.angle]}>{deg(r.angleDeg)}</Text>
              ) : r.angleWithheld ? (
                <Text style={[styles.cellAngle, styles.withheld]}>withheld</Text>
              ) : (
                <Text style={[styles.cellAngle, styles.dash]}>—</Text>
              )}
            </Row>
            <Text style={styles.rowNote}>
              {r.pos == null
                ? 'the detector never saw this joint, so it is absent in 3D'
                : [
                    r.angleSpan ?? 'no angle at this joint — COCO-17 has no hand or foot points',
                    r.depth === 'inPlane'
                      ? 'in image plane · depth not resolved'
                      : r.depth === 'yaw'
                        ? 'depth from torso turn'
                        : null,
                    `depth confidence ${conf(r.pos.c)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </Text>
          </View>
        ))}
        {tilt != null && (
          <View style={[styles.tableRow, styles.rowDivider]}>
            <Row gap={space.sm}>
              <Text style={[styles.cellJoint, styles.jointName, styles.jointShooting]}>
                FOREARM TILT
              </Text>
              <Text style={[styles.cellSpan3, styles.num]}>elbow → wrist vs vertical</Text>
              {tilt.c >= MIN_DEPTH_C ? (
                <Text style={[styles.cellAngle, styles.angle]}>{deg(tilt.deg)}</Text>
              ) : (
                <Text style={[styles.cellAngle, styles.withheld]}>withheld</Text>
              )}
            </Row>
            <Text style={styles.rowNote}>
              the closest honest stand-in for wrist flex — there are no hand keypoints to
              measure the wrist itself
            </Text>
          </View>
        )}
      </Card>

      {/* ---- Judged angles ---------------------------------------------- */}
      <Card entering={cardEnter(2)}>
        <SectionEyebrow icon="analytics-outline">3D against your 2D numbers</SectionEyebrow>
        {result.angles.map((a, i) => {
          const badge = verdictBadge(a.verdict);
          return (
            <View key={a.id} style={[styles.angleBlock, i > 0 && styles.rowDivider]}>
              <Row gap={space.sm} style={styles.angleHead}>
                <View style={styles.angleTitleWrap}>
                  <Text style={styles.angleTitle}>{ANGLE_TITLE[a.id]}</Text>
                  <Text style={styles.angleWhere}>
                    {a.phase != null ? `at the ${PHASE_WORD[a.phase]}` : 'whole motion'}
                    {a.frame != null ? ` · frame ${a.frame + 1}` : ''}
                  </Text>
                </View>
                {a.deg != null ? (
                  <Text style={styles.angleValue}>{deg(a.deg)}</Text>
                ) : (
                  <Text style={styles.angleWithheld}>withheld</Text>
                )}
              </Row>
              <Row gap={space.xs} style={styles.badgeRow}>
                <Chip compact label={badge.label} tone={badge.tone} />
                {a.deg2d != null && <Chip compact label={`2D ${deg(a.deg2d)}`} />}
                {a.c != null && <Chip compact label={`depth ${conf(a.c)}`} />}
              </Row>
              <Text style={styles.rowNote}>{a.note}</Text>
            </View>
          );
        })}
        <Text style={styles.caption}>
          {`A 3D reading under ${Math.round(MIN_DEPTH_C * 100)}% depth confidence is withheld, not dimmed. Estimated depth never overrules a measured 2D number by itself.`}
        </Text>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: layout.sectionGap,
  },
  headRow: {
    justifyContent: 'space-between',
  },
  counter: {
    ...type.caption,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  lede: {
    ...type.headingLarge,
    color: color.text,
    marginTop: space.xs,
  },
  chipRow: {
    flexWrap: 'wrap',
    marginTop: space.sm,
  },
  stageWrap: {
    marginTop: space.sm,
    alignItems: 'center',
  },
  caption: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.xs,
  },
  warn: {
    ...type.caption,
    color: color.unsure,
    marginTop: space.sm,
  },
  subhead: {
    ...type.caption,
    color: color.textDim,
    marginTop: space.xs,
    marginBottom: space.sm,
  },
  tableRow: {
    paddingVertical: space.xs,
  },
  tableHead: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  headCell: {
    ...type.micro,
    color: color.textFaint,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  cellJoint: {
    width: 96,
  },
  cellNum: {
    width: 56,
    textAlign: 'right',
  },
  cellSpan3: {
    width: 56 * 3 + space.sm * 2,
  },
  cellAngle: {
    flex: 1,
    textAlign: 'right',
  },
  jointName: {
    ...type.caption,
    color: color.textDim,
  },
  jointShooting: {
    color: color.text,
  },
  num: {
    ...type.caption,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  numFlat: {
    color: color.textFaint,
  },
  angle: {
    ...type.bodyMedium,
    color: color.accent,
    fontVariant: ['tabular-nums'],
  },
  withheld: {
    ...type.caption,
    color: color.unsure,
  },
  dash: {
    ...type.caption,
    color: color.textFaint,
  },
  notSeen: {
    ...type.caption,
    color: color.textFaint,
  },
  rowNote: {
    ...type.micro,
    color: color.textFaint,
    marginTop: 2,
  },
  angleBlock: {
    paddingVertical: space.sm,
  },
  angleHead: {
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  angleTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  angleTitle: {
    ...type.heading,
    color: color.text,
  },
  angleWhere: {
    ...type.micro,
    color: color.textFaint,
    marginTop: 2,
  },
  angleValue: {
    ...type.statSmall,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  angleWithheld: {
    ...type.caption,
    color: color.unsure,
    paddingTop: space.xs,
  },
  badgeRow: {
    flexWrap: 'wrap',
    marginTop: space.xs,
  },
});
