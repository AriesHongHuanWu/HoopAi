import type { DecodedFrame } from '../../formSequence';
import type { PoseKeypointName } from '../../types';
import {
  BONE_PRIORS,
  FOREARM_LEN,
  HIP_HALF_LEN,
  LIFT_JOINTS,
  NECK_LEN,
  SHANK_LEN,
  SHOULDER_HALF_LEN,
  STANDING_SPAN_RATIO,
  THIGH_LEN,
  TRUNK_LEN,
  UNIT_SCALE_IDENTITY,
  UNIT_SCALE_MAX,
  UPPER_ARM_LEN,
  clampUnitScale,
  liftSequence,
  measureUnitScale,
  unitScaleFromSpanRatio,
} from '../lift';
import type { Frame3D, Joint3D } from '../lift';

// ---------------------------------------------------------------------------
// Synthetic-skeleton helpers (self-contained — no other pose3d imports)
// ---------------------------------------------------------------------------

interface P3 {
  x: number;
  y: number;
  z: number;
}

type Skeleton3D = Partial<Record<PoseKeypointName, P3>>;

/** Child placed at exact prior distance from parent, dz ≥ 0 (toward camera). */
function chainFrom(parent: P3, dx: number, dy: number, prior: number): P3 {
  return {
    x: parent.x + dx,
    y: parent.y + dy,
    z: parent.z + Math.sqrt(prior * prior - dx * dx - dy * dy),
  };
}

/**
 * Full 13-joint skeleton with EXACT prior bone lengths, torso yawed by
 * `yawRad` (positive = right shoulder toward the camera, matching the lift's
 * hand='right' initialization). Hip-center at the origin, +y down.
 */
function priorSkeletonAtYaw(yawRad: number): Skeleton3D {
  const cos = Math.cos(yawRad);
  const sin = Math.sin(yawRad);
  const sc: P3 = { x: 0, y: -TRUNK_LEN, z: 0 };
  const skel: Skeleton3D = {
    left_shoulder: { x: sc.x + cos * SHOULDER_HALF_LEN, y: sc.y, z: -sin * SHOULDER_HALF_LEN },
    right_shoulder: { x: sc.x - cos * SHOULDER_HALF_LEN, y: sc.y, z: sin * SHOULDER_HALF_LEN },
    left_hip: { x: cos * HIP_HALF_LEN, y: 0, z: -sin * HIP_HALF_LEN },
    right_hip: { x: -cos * HIP_HALF_LEN, y: 0, z: sin * HIP_HALF_LEN },
  };
  skel.nose = chainFrom(sc, 0.02, -0.12, NECK_LEN);
  skel.right_elbow = chainFrom(skel.right_shoulder!, -0.05, 0.1, UPPER_ARM_LEN);
  skel.right_wrist = chainFrom(skel.right_elbow!, 0.03, 0.08, FOREARM_LEN);
  skel.left_elbow = chainFrom(skel.left_shoulder!, 0.05, 0.1, UPPER_ARM_LEN);
  skel.left_wrist = chainFrom(skel.left_elbow!, -0.03, 0.08, FOREARM_LEN);
  skel.right_knee = chainFrom(skel.right_hip!, -0.02, 0.2, THIGH_LEN);
  skel.right_ankle = chainFrom(skel.right_knee!, 0.01, 0.2, SHANK_LEN);
  skel.left_knee = chainFrom(skel.left_hip!, 0.02, 0.2, THIGH_LEN);
  skel.left_ankle = chainFrom(skel.left_knee!, -0.01, 0.2, SHANK_LEN);
  return skel;
}

/** Orthographic projection: drop z. */
function project(skel: Skeleton3D): DecodedFrame {
  const frame: DecodedFrame = {};
  for (const name of Object.keys(skel) as PoseKeypointName[]) {
    const p = skel[name]!;
    frame[name] = { x: p.x, y: p.y };
  }
  return frame;
}

/** Torso-only base frame facing the camera square-on (apparent = priors). */
function frontFacingBase(): DecodedFrame {
  return {
    left_shoulder: { x: SHOULDER_HALF_LEN, y: -TRUNK_LEN },
    right_shoulder: { x: -SHOULDER_HALF_LEN, y: -TRUNK_LEN },
    left_hip: { x: HIP_HALF_LEN, y: 0 },
    right_hip: { x: -HIP_HALF_LEN, y: 0 },
  };
}

function dist3(a: Joint3D, b: Joint3D): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function presentJoints(frame: Frame3D): Joint3D[] {
  const out: Joint3D[] = [];
  for (const name of LIFT_JOINTS) {
    const j = frame[name];
    if (j) out.push(j);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('liftSequence', () => {
  test('recovers exact prior bone lengths and the yaw from an orthographic projection', () => {
    const yaw = (30 * Math.PI) / 180;
    const frames = Array.from({ length: 6 }, () => project(priorSkeletonAtYaw(yaw)));
    const seq = liftSequence(frames, 'right')!;
    expect(seq).not.toBeNull();
    expect(seq.frames.length).toBe(6);
    for (const frame of seq.frames) {
      for (const bone of BONE_PRIORS) {
        const a = frame[bone.a]!;
        const b = frame[bone.b]!;
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect(Math.abs(dist3(a, b) - bone.len)).toBeLessThan(1e-6);
      }
      // Neck prior: nose vs the lifted shoulder midpoint.
      const sc: Joint3D = {
        x: (frame.left_shoulder!.x + frame.right_shoulder!.x) / 2,
        y: (frame.left_shoulder!.y + frame.right_shoulder!.y) / 2,
        z: (frame.left_shoulder!.z + frame.right_shoulder!.z) / 2,
        c: 1,
      };
      expect(Math.abs(dist3(frame.nose!, sc) - NECK_LEN)).toBeLessThan(1e-6);
    }
    expect(Math.abs(seq.azimuthDeg - 30)).toBeLessThan(5);
    expect(seq.confidence).toBeGreaterThan(0);
    expect(seq.confidence).toBeLessThanOrEqual(1);
  });

  test('an elbow flexing toward the camera keeps a continuous z (no sign flips)', () => {
    const frames: DecodedFrame[] = [];
    for (let i = 0; i < 10; i++) {
      const phi = ((5 + (80 * i) / 9) * Math.PI) / 180; // 5° → 85° out of plane
      const frame = frontFacingBase();
      frame.right_elbow = {
        x: -SHOULDER_HALF_LEN,
        y: -TRUNK_LEN + UPPER_ARM_LEN * Math.cos(phi),
      };
      frames.push(frame);
    }
    const seq = liftSequence(frames, 'right')!;
    const zs = seq.frames.map((f) => f.right_elbow!.z);
    // RE-PINNED (was: every frame z > 0) for MIN_RESOLVABLE_DZ_RATIO. The
    // sweep opens at 5° out of plane, where the bone is 0.4% shorter than its
    // prior — under the resolution of a length prior, so those frames are now
    // placed IN the image plane (z = 0) instead of at a shallow positive
    // number the measurement cannot support. The contract this test exists for
    // is unchanged and still asserted in full: never negative (no sign flip),
    // strictly positive as soon as the depth is resolvable, and continuous.
    const resolvable = zs.findIndex((z) => z > 0);
    expect(resolvable).toBeGreaterThan(0);
    expect(resolvable).toBeLessThan(4);
    for (let i = 0; i < zs.length; i++) {
      expect(zs[i]).toBeGreaterThanOrEqual(0);
      if (i >= resolvable) expect(zs[i]).toBeGreaterThan(0);
      if (i > 0) expect(Math.abs(zs[i]! - zs[i - 1]!)).toBeLessThan(0.2);
    }
  });

  test('a 2D bone longer than its prior clamps dz to 0 and lowers confidence, never NaN', () => {
    const frame = frontFacingBase();
    frame.right_elbow = { x: -SHOULDER_HALF_LEN, y: -TRUNK_LEN + UPPER_ARM_LEN };
    frame.right_wrist = {
      x: -SHOULDER_HALF_LEN,
      y: -TRUNK_LEN + UPPER_ARM_LEN + FOREARM_LEN * 1.3,
    };
    const seq = liftSequence([frame, frame, frame, frame], 'right')!;
    for (const lifted of seq.frames) {
      const elbow = lifted.right_elbow!;
      const wrist = lifted.right_wrist!;
      expect(wrist).toBeDefined();
      expect(Math.abs(wrist.z - elbow.z)).toBeLessThan(1e-12); // dz contribution 0
      expect(wrist.c).toBeLessThan(elbow.c);
      for (const j of presentJoints(lifted)) {
        expect(Number.isFinite(j.x)).toBe(true);
        expect(Number.isFinite(j.y)).toBe(true);
        expect(Number.isFinite(j.z)).toBe(true);
        expect(Number.isFinite(j.c)).toBe(true);
      }
    }
  });

  test('a keypoint missing in 2D is absent in 3D and leaves the other side bit-equal', () => {
    const yaw = (30 * Math.PI) / 180;
    const full = Array.from({ length: 6 }, () => project(priorSkeletonAtYaw(yaw)));
    const gutted = full.map((f) => {
      const copy: DecodedFrame = { ...f };
      delete copy.left_wrist;
      return copy;
    });
    const a = liftSequence(full, 'right')!;
    const b = liftSequence(gutted, 'right')!;
    const rightArm: PoseKeypointName[] = ['right_shoulder', 'right_elbow', 'right_wrist'];
    for (let i = 0; i < b.frames.length; i++) {
      expect(b.frames[i]!.left_wrist).toBeUndefined();
      for (const name of rightArm) {
        expect(JSON.stringify(b.frames[i]![name])).toBe(JSON.stringify(a.frames[i]![name]));
      }
    }
  });

  test('returns null when fewer than 2 frames have both hips and both shoulders', () => {
    const frames = Array.from({ length: 6 }, () => frontFacingBase());
    for (let i = 1; i < frames.length; i++) {
      delete frames[i]!.left_hip;
      delete frames[i]!.right_hip;
    }
    expect(liftSequence(frames, 'right')).toBeNull();
  });

  test('is deterministic — two calls on the same input are deep-equal', () => {
    const frames: DecodedFrame[] = [];
    for (let i = 0; i < 10; i++) {
      const phi = ((5 + (80 * i) / 9) * Math.PI) / 180;
      const frame = frontFacingBase();
      frame.right_elbow = {
        x: -SHOULDER_HALF_LEN,
        y: -TRUNK_LEN + UPPER_ARM_LEN * Math.cos(phi),
      };
      frames.push(frame);
    }
    const a = liftSequence(frames, 'right');
    const b = liftSequence(frames, 'right');
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('preserves the +y-down convention — a below-hip ankle keeps its positive y', () => {
    const frame = frontFacingBase();
    frame.right_knee = { x: -0.09, y: 0.26 };
    frame.right_ankle = { x: -0.09, y: 0.5 };
    const seq = liftSequence([frame, frame, frame], 'right')!;
    for (const lifted of seq.frames) {
      expect(lifted.right_ankle!.y).toBe(0.5);
      expect(lifted.right_ankle!.y).toBeGreaterThan(0);
    }
  });
});

describe('lift contract', () => {
  test('LIFT_JOINTS is the 13-joint COCO subset without eyes/ears', () => {
    expect(LIFT_JOINTS.length).toBe(13);
    for (const face of ['left_eye', 'right_eye', 'left_ear', 'right_ear'] as const) {
      expect(LIFT_JOINTS.includes(face)).toBe(false);
    }
    expect(LIFT_JOINTS.includes('nose')).toBe(true);
  });

  test('eyes/ears in the 2D input are never lifted', () => {
    const frame = frontFacingBase();
    frame.left_eye = { x: 0.02, y: -0.42 };
    const seq = liftSequence([frame, frame], 'right')!;
    expect(seq.frames[0]!.left_eye).toBeUndefined();
  });

  test('a left-handed shooter initializes the azimuth with the LEFT shoulder toward the camera', () => {
    const yaw = (30 * Math.PI) / 180;
    // Mirror the yaw-30 skeleton so the LEFT shoulder is the near one.
    const frames = Array.from({ length: 4 }, () => project(priorSkeletonAtYaw(yaw)));
    const seq = liftSequence(frames, 'left')!;
    expect(seq.frames[0]!.left_shoulder!.z).toBeGreaterThan(0);
    expect(seq.azimuthDeg).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// UNIT SCALE — the bug that made the limbs come out flat
//
// formSequence.ts divides every frame by that frame's nose→ankle VERTICAL
// SPAN; these priors are fractions of STANDING height. The span is ~0.9 of
// standing height, so a frame it encoded is ~1.11 × too big for the priors,
// every limb bone reads as "longer than the bone it is", dz clamps to 0 and
// the limbs come out FLAT. The fixture below is the SAME synthetic motion
// lifted twice — once with the default (identity) scale and once with the
// scale measured off the frames — so the difference is the fix and nothing
// else.
// ---------------------------------------------------------------------------

/** The over-scaling formSequence's normalizer introduces, as a multiplier. */
const SPAN_RATIO = 0.9;
const OVER = 1 / SPAN_RATIO;

/** Third component that puts a bone at exactly its prior length. */
function closing(prior: number, a: number, b: number): number {
  return Math.sqrt(prior * prior - a * a - b * b);
}

/**
 * Known truths, in standing-height units, before any over-scaling. THIGH_DZ
 * is 0.41 of the thigh — comfortably over MIN_RESOLVABLE_DZ_RATIO, so it is a
 * depth a length prior can actually resolve. OFF_ARM_DY makes the off-hand
 * upper arm's true depth 0.21 of the bone: real, and UNDER the floor.
 */
const YAW_DEG = 25;
const THIGH_DZ = 0.1;
const OFF_ARM_DY = 0.175;
const OFF_ARM_DZ = closing(UPPER_ARM_LEN, 0.05, OFF_ARM_DY);
const SHANK_DY = closing(SHANK_LEN, 0.01, 0);

/**
 * A shooter turned 25° off square with REAL, KNOWN out-of-plane depth in the
 * thighs and the shooting arm, and three bones (both shanks + the off-hand
 * forearm) lying exactly in the image plane. That mix is the real capture
 * geometry: something in frame is always unforeshortened, which is what
 * measureUnitScale's envelope reads the scale off.
 */
function mixedDepthSkeleton(): Skeleton3D {
  const yaw = (YAW_DEG * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const sc: P3 = { x: 0, y: -TRUNK_LEN, z: 0 };
  const skel: Skeleton3D = {
    left_shoulder: { x: cos * SHOULDER_HALF_LEN, y: sc.y, z: -sin * SHOULDER_HALF_LEN },
    right_shoulder: { x: -cos * SHOULDER_HALF_LEN, y: sc.y, z: sin * SHOULDER_HALF_LEN },
    left_hip: { x: cos * HIP_HALF_LEN, y: 0, z: -sin * HIP_HALF_LEN },
    right_hip: { x: -cos * HIP_HALF_LEN, y: 0, z: sin * HIP_HALF_LEN },
  };
  const off = (from: P3, dx: number, dy: number, dzz: number): P3 => ({
    x: from.x + dx,
    y: from.y + dy,
    z: from.z + dzz,
  });
  skel.nose = off(sc, 0.02, -closing(NECK_LEN, 0.02, 0.03), 0.03);
  // Shooting (right) arm reaching toward the camera: most of its length is
  // depth, so its 2D projection is short and it never clamps — it just comes
  // out at the WRONG depth until the priors are in the frames' units.
  skel.right_elbow = off(skel.right_shoulder!, -0.02, 0.09, closing(UPPER_ARM_LEN, 0.02, 0.09));
  skel.right_wrist = off(skel.right_elbow!, 0.04, -0.1, closing(FOREARM_LEN, 0.04, 0.1));
  // Off arm: upper arm nearly in-plane, forearm exactly in it.
  skel.left_elbow = off(skel.left_shoulder!, 0.05, OFF_ARM_DY, OFF_ARM_DZ);
  skel.left_wrist = off(skel.left_elbow!, 0, FOREARM_LEN, 0);
  // Knees forward (real depth), shanks in the image plane.
  skel.right_knee = off(skel.right_hip!, 0.02, closing(THIGH_LEN, 0.02, THIGH_DZ), THIGH_DZ);
  skel.right_ankle = off(skel.right_knee!, -0.01, SHANK_DY, 0);
  skel.left_knee = off(skel.left_hip!, -0.02, closing(THIGH_LEN, 0.02, THIGH_DZ), THIGH_DZ);
  skel.left_ankle = off(skel.left_knee!, 0.01, SHANK_DY, 0);
  return skel;
}

/** What the encoder hands over: the projection, over-scaled by 1/spanRatio. */
function overScaledFrames(n: number): DecodedFrame[] {
  const flat = project(mixedDepthSkeleton());
  const scaled: DecodedFrame = {};
  for (const name of Object.keys(flat) as PoseKeypointName[]) {
    const p = flat[name]!;
    scaled[name] = { x: p.x * OVER, y: p.y * OVER };
  }
  return Array.from({ length: n }, () => ({ ...scaled }));
}

const dzOf = (a: Joint3D, b: Joint3D) => Math.abs(a.z - b.z);

/** The fixture's bones whose true depth clears MIN_RESOLVABLE_DZ_RATIO. */
const RESOLVED_BONES = BONE_PRIORS.filter(
  (b) =>
    (b.a === 'right_shoulder' && b.b === 'right_elbow') ||
    (b.a === 'right_elbow' && b.b === 'right_wrist') ||
    b.b === 'left_knee' ||
    b.b === 'right_knee',
);

function angle3(a: P3, b: P3, c: P3): number {
  const u = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const lu = Math.hypot(u.x, u.y, u.z);
  const lv = Math.hypot(v.x, v.y, v.z);
  const d = (u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv);
  return (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI;
}

describe('unitScale — priors in the units the frames actually arrived in', () => {
  test('the span this pipeline normalizes by is ~0.9 of standing height', () => {
    // Derived from the priors themselves, not typed in: hip + trunk + neck
    // − ankle. It is what formSequence's nose→ankle span measures upright.
    expect(STANDING_SPAN_RATIO).toBeCloseTo(0.909, 3);
    expect(unitScaleFromSpanRatio(STANDING_SPAN_RATIO)).toBeCloseTo(1.1, 2);
  });

  test('measures the over-scaling off the frames, and reads a clean capture as identity', () => {
    expect(measureUnitScale(overScaledFrames(6))).toBeCloseTo(OVER, 6);
    // A capture already in standing-height units must measure as identity, so
    // opting in can never perturb a caller that was already correct.
    const clean = Array.from({ length: 6 }, () => project(priorSkeletonAtYaw(0.4)));
    expect(measureUnitScale(clean)).toBe(UNIT_SCALE_IDENTITY);
    // Too little to measure is identity, never a guess off one bone.
    expect(measureUnitScale([project(mixedDepthSkeleton())])).toBe(UNIT_SCALE_IDENTITY);
    // Garbage is clamped, not believed.
    expect(clampUnitScale(9)).toBe(UNIT_SCALE_MAX);
    expect(clampUnitScale(Number.NaN)).toBe(UNIT_SCALE_IDENTITY);
    expect(clampUnitScale(0.2)).toBe(UNIT_SCALE_IDENTITY);
  });

  test('BEFORE: the identity scale flattens the limbs (and a shallow torso turn)', () => {
    const frames = overScaledFrames(6);
    const seq = liftSequence(frames, 'right')!;
    expect(seq.unitScale).toBe(UNIT_SCALE_IDENTITY);
    for (const f of seq.frames) {
      // Every bone whose 2D length ran over its prior is placed dead flat.
      expect(dzOf(f.right_hip!, f.right_knee!)).toBeLessThan(1e-12);
      expect(dzOf(f.left_hip!, f.left_knee!)).toBeLessThan(1e-12);
      expect(dzOf(f.right_knee!, f.right_ankle!)).toBeLessThan(1e-12);
      expect(dzOf(f.left_shoulder!, f.left_elbow!)).toBeLessThan(1e-12);
      // …and pays confidence for it: a bone over its prior is degraded.
      expect(f.right_knee!.c).toBeLessThan(f.right_hip!.c);
    }
    // A 25° torso turn reads as dead square-on: the over-scaled shoulder
    // width is WIDER than the prior, so cosθ clamps to 1 — and it does so at
    // full torso confidence, which is the worst kind of wrong.
    expect(Math.abs(seq.azimuthDeg)).toBeLessThan(1e-9);
    expect(seq.frames[0]!.right_shoulder!.z).toBe(0);
    expect(seq.frames[0]!.right_shoulder!.c).toBe(1);
  });

  test('AFTER: the measured scale recovers the known depth, the yaw and the angles', () => {
    const frames = overScaledFrames(6);
    const seq = liftSequence(frames, 'right', measureUnitScale(frames))!;
    expect(seq.unitScale).toBeCloseTo(OVER, 6);

    for (const f of seq.frames) {
      // The thigh's known forward depth, in the frames' over-scaled units —
      // non-zero, and the RIGHT non-zero number.
      expect(dzOf(f.right_hip!, f.right_knee!)).toBeCloseTo(THIGH_DZ * OVER, 9);
      expect(dzOf(f.left_hip!, f.left_knee!)).toBeCloseTo(THIGH_DZ * OVER, 9);
      // The in-plane shank stays in-plane — depth is recovered, not sprayed.
      expect(dzOf(f.right_knee!, f.right_ankle!)).toBeLessThan(1e-9);
      // Bones whose depth the priors can RESOLVE come out at prior length in
      // the frames' own units.
      for (const bone of RESOLVED_BONES) {
        expect(dist3(f[bone.a]!, f[bone.b]!)).toBeCloseTo(bone.len * OVER, 9);
      }
      // The off arm's upper bone is genuinely 21% out of plane — under the
      // resolution of a length prior, so it is placed IN the plane rather
      // than at a shallow number with a confident sign, and its 3D length is
      // its measured 2D length, visibly short of the prior.
      expect(dzOf(f.left_shoulder!, f.left_elbow!)).toBe(0);
      expect(dist3(f.left_shoulder!, f.left_elbow!)).toBeLessThan(UPPER_ARM_LEN * OVER);
    }
    // The 25° turn is read as a 25° turn.
    expect(seq.azimuthDeg).toBeCloseTo(YAW_DEG, 6);

    // And the angles the report shows land on the truth they were built from.
    const truth = mixedDepthSkeleton();
    const f0 = seq.frames[0]!;
    const trueElbow = angle3(truth.right_shoulder!, truth.right_elbow!, truth.right_wrist!);
    const trueKnee = angle3(truth.right_hip!, truth.right_knee!, truth.right_ankle!);
    expect(angle3(f0.right_shoulder!, f0.right_elbow!, f0.right_wrist!)).toBeCloseTo(trueElbow, 6);
    expect(angle3(f0.right_hip!, f0.right_knee!, f0.right_ankle!)).toBeCloseTo(trueKnee, 6);

    // Before the fix the same elbow was off by a wide margin — the number the
    // report would have shown as an upgrade over 2D.
    const flat = liftSequence(frames, 'right')!.frames[0]!;
    const flatElbow = angle3(flat.right_shoulder!, flat.right_elbow!, flat.right_wrist!);
    expect(Math.abs(flatElbow - trueElbow)).toBeGreaterThan(10);
  });

  test('the default is byte-identical to the pre-parameter lift', () => {
    const frames = overScaledFrames(5);
    const implicit = liftSequence(frames, 'right')!;
    const explicit = liftSequence(frames, 'right', UNIT_SCALE_IDENTITY)!;
    expect(JSON.stringify(implicit.frames)).toBe(JSON.stringify(explicit.frames));
    expect(implicit.azimuthDeg).toBe(explicit.azimuthDeg);
    expect(implicit.confidence).toBe(explicit.confidence);
    // Deterministic with a scale, too: same input twice, deep-equal out.
    const a = liftSequence(frames, 'right', 1.1);
    const b = liftSequence(frames, 'right', 1.1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
