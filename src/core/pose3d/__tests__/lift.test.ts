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
  THIGH_LEN,
  TRUNK_LEN,
  UPPER_ARM_LEN,
  liftSequence,
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
    for (let i = 0; i < zs.length; i++) {
      expect(zs[i]).toBeGreaterThan(0); // first-frame + sign held throughout
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
