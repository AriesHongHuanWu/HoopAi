/**
 * Form Check → 3D adapter tests.
 *
 * The fixture is a SYNTHETIC but anatomically plausible shooting motion built
 * in PIXEL space and pushed through the exact path a real rep takes:
 * forward-kinematic skeleton (every bone exactly its Winter prior × standing
 * height) → orthographic projection → buildSequence → decodeSequence →
 * liftSequence. Because the fixture is built in 3D first, its true 3D angles
 * are known, so "is the lift plausible" is measured, not asserted by eye.
 */
import { buildSequence, decodeSequence } from '../formSequence';
import type { RawSeqFrame } from '../formSequence';
import type { FormCheckRep } from '../formCheck';
import { angleAtDeg } from '../geometry';
import {
  AGREE_TOL_DEG,
  MIN_DEPTH_C,
  angleOf,
  depthScaleCheck,
  liftRep,
} from '../formCheck3d';
import { LIFT_JOINTS } from '../pose3d/lift';
import type { FormMetrics, PoseKeypointName, ShootingHand } from '../types';
import {
  FOREARM_LEN,
  HIP_HALF_LEN,
  NECK_LEN,
  SHANK_LEN,
  SHOULDER_HALF_LEN,
  THIGH_LEN,
  TRUNK_LEN,
  UPPER_ARM_LEN,
} from '../pose3d/lift';

// ---------------------------------------------------------------------------
// Synthetic shooter (pixel space, +y DOWN, +z toward the camera)
// ---------------------------------------------------------------------------

interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Standing height px, floor line px, body centre x px. */
const H = 400;
const FLOOR = 560;
const CX = 320;
/** Winter standing fractions used for the floor-relative joint heights. */
const ANKLE_H = 0.039;
const HIP_H = 0.53;

const rad = (d: number) => (d * Math.PI) / 180;
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const len3 = (a: V3) => Math.hypot(a.x, a.y, a.z);
const norm = (a: V3): V3 => mul(a, 1 / len3(a));
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;

function angle3(a: V3, b: V3, c: V3): number {
  const u = sub(a, b);
  const v = sub(c, b);
  const cos = Math.min(1, Math.max(-1, dot(u, v) / (len3(u) * len3(v))));
  return (Math.acos(cos) * 180) / Math.PI;
}

type Skel = Partial<Record<PoseKeypointName, V3>>;

/**
 * Pose parameters: hip drop (body heights), trunk lean, and the shooting
 * arm's upper-arm / forearm angles measured from straight-DOWN toward the
 * direction the shooter faces (0 = hanging, 90 = forward, 180 = straight up).
 */
interface Pose {
  hipDrop: number;
  lean: number;
  alpha: number;
  beta: number;
}

/**
 * Stance (ball at the chest) → dip (knees loaded, ball at the waist) →
 * gather/rise → release → follow-through. The stance already holds the ball,
 * so the deepest WRIST really is the dip and not a hanging arm.
 */
const KEYS: readonly { t: number; p: Pose }[] = [
  { t: 0.0, p: { hipDrop: 0.0, lean: 5, alpha: 20, beta: 95 } },
  { t: 0.35, p: { hipDrop: 0.04, lean: 18, alpha: 5, beta: 78 } },
  { t: 0.75, p: { hipDrop: 0.01, lean: 10, alpha: 90, beta: 178 } },
  { t: 1.2, p: { hipDrop: 0.0, lean: 4, alpha: 150, beta: 168 } },
  { t: 1.7, p: { hipDrop: 0.0, lean: 3, alpha: 143, beta: 158 } },
];
const RELEASE_T = 1.2;
const FPS = 30;

const smooth = (u: number) => u * u * (3 - 2 * u);

function poseAt(t: number): Pose {
  if (t <= KEYS[0]!.t) return KEYS[0]!.p;
  const last = KEYS[KEYS.length - 1]!;
  if (t >= last.t) return last.p;
  for (let i = 1; i < KEYS.length; i++) {
    const a = KEYS[i - 1]!;
    const b = KEYS[i]!;
    if (t <= b.t) {
      const u = smooth((t - a.t) / (b.t - a.t));
      const mix = (x: number, y: number) => x + (y - x) * u;
      return {
        hipDrop: mix(a.p.hipDrop, b.p.hipDrop),
        lean: mix(a.p.lean, b.p.lean),
        alpha: mix(a.p.alpha, b.p.alpha),
        beta: mix(a.p.beta, b.p.beta),
      };
    }
  }
  return last.p;
}

interface SkelOpts {
  /** Torso yaw, degrees. 0 = square to the camera, 90 = strict side profile. */
  yawDeg: number;
  /** Aim the shooting arm 20° off the lens axis — near-maximal foreshortening. */
  armAtLens?: boolean;
}

/** One frame's skeleton with every bone at exactly its lift prior × H. */
function skeletonAt(t: number, opts: SkelOpts): Skel {
  const p = poseAt(t);
  const psi = rad(opts.yawDeg);
  // Facing direction and the shooter's LEFT, matching lift.ts's convention:
  // positive yaw puts the RIGHT shoulder toward the camera.
  const f: V3 = { x: Math.sin(psi), y: 0, z: Math.cos(psi) };
  const l: V3 = { x: Math.cos(psi), y: 0, z: -Math.sin(psi) };
  const dirDown = (aDeg: number): V3 => {
    const a = rad(aDeg);
    return { x: Math.sin(a) * f.x, y: Math.cos(a), z: Math.sin(a) * f.z };
  };
  const dirUp = (aDeg: number): V3 => {
    const a = rad(aDeg);
    return { x: Math.sin(a) * f.x, y: -Math.cos(a), z: Math.sin(a) * f.z };
  };

  const hipC: V3 = { x: CX, y: FLOOR - (HIP_H - p.hipDrop) * H, z: 0 };
  const shC = add(hipC, mul(dirUp(p.lean), TRUNK_LEN * H));
  const s: Skel = {
    left_hip: add(hipC, mul(l, HIP_HALF_LEN * H)),
    right_hip: add(hipC, mul(l, -HIP_HALF_LEN * H)),
    left_shoulder: add(shC, mul(l, SHOULDER_HALF_LEN * H)),
    right_shoulder: add(shC, mul(l, -SHOULDER_HALF_LEN * H)),
  };
  s.nose = add(shC, mul(dirUp(20), NECK_LEN * H));

  for (const side of ['right', 'left'] as const) {
    const shooting = side === 'right';
    // Off arm trails the shooting arm — a guide hand, not a mirror.
    const a = shooting ? p.alpha : p.alpha * 0.75;
    const b = shooting ? p.beta : p.beta * 0.8;
    const sh = s[`${side}_shoulder` as PoseKeypointName]!;
    // Arm at the lens: both segments 12° off +z, so each still projects to a
    // measurable 2D segment while nearly all of its length is depth.
    const toLens: V3 = { x: 0, y: -Math.sin(rad(12)), z: Math.cos(rad(12)) };
    const upperDir = shooting && opts.armAtLens ? toLens : dirDown(a);
    const foreDir = shooting && opts.armAtLens ? toLens : dirDown(b);
    const el = add(sh, mul(upperDir, UPPER_ARM_LEN * H));
    s[`${side}_elbow` as PoseKeypointName] = el;
    s[`${side}_wrist` as PoseKeypointName] = add(el, mul(foreDir, FOREARM_LEN * H));
  }

  // Legs: feet planted, two-link IK, knee toward the facing direction.
  for (const side of ['right', 'left'] as const) {
    const hip = s[`${side}_hip` as PoseKeypointName]!;
    const ankle: V3 = { x: hip.x, y: FLOOR - ANKLE_H * H, z: hip.z };
    const d = sub(ankle, hip);
    const L = len3(d);
    const dh = norm(d);
    const T = THIGH_LEN * H;
    const S = SHANK_LEN * H;
    let knee: V3;
    if (L >= T + S) {
      knee = add(hip, mul(dh, T));
    } else {
      const cosG = (T * T + L * L - S * S) / (2 * T * L);
      const g = Math.acos(Math.min(1, Math.max(-1, cosG)));
      const nRaw = sub(f, mul(dh, dot(f, dh)));
      const n = len3(nRaw) > 1e-6 ? norm(nRaw) : { x: 0, y: 0, z: 1 };
      knee = add(hip, add(mul(dh, T * Math.cos(g)), mul(n, T * Math.sin(g))));
    }
    s[`${side}_knee` as PoseKeypointName] = knee;
    s[`${side}_ankle` as PoseKeypointName] = ankle;
  }
  return s;
}

interface Motion {
  raw: RawSeqFrame[];
  truth: Skel[];
  /** Index of the deepest-wrist frame in `raw`. */
  dipIdx: number;
  /** First post-dip frame with the wrist above the shoulder. */
  crossIdx: number;
  releaseIdx: number;
}

interface MotionOpts extends SkelOpts {
  /** Keypoints the detector never saw (missing in 2D). */
  drop?: readonly PoseKeypointName[];
  /** Frame count override — used for the too-thin rep. */
  frames?: number;
  fps?: number;
}

function buildMotion(opts: MotionOpts): Motion {
  const fps = opts.fps ?? FPS;
  const n = opts.frames ?? Math.round(1.7 * fps) + 1;
  const raw: RawSeqFrame[] = [];
  const truth: Skel[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const skel = skeletonAt(t, opts);
    truth.push(skel);
    const pts = new Map<PoseKeypointName, { x: number; y: number }>();
    for (const name of Object.keys(skel) as PoseKeypointName[]) {
      if (opts.drop?.includes(name)) continue;
      const p = skel[name]!;
      pts.set(name, { x: p.x, y: p.y });
    }
    raw.push({ t, pts });
  }
  // Phase events, read off the motion itself (+y down: bigger y = lower).
  let dipIdx = 0;
  for (let i = 0; i < truth.length; i++) {
    if (truth[i]!.right_wrist!.y > truth[dipIdx]!.right_wrist!.y) dipIdx = i;
  }
  let crossIdx = dipIdx;
  for (let i = dipIdx; i < truth.length; i++) {
    if (truth[i]!.right_wrist!.y < truth[i]!.right_shoulder!.y) {
      crossIdx = i;
      break;
    }
  }
  const releaseIdx = Math.min(truth.length - 1, Math.round(RELEASE_T * fps));
  return { raw, truth, dipIdx, crossIdx, releaseIdx };
}

/** A rep exactly as FormCheckSession.finalizeRep would hand it over. */
function makeRep(motion: Motion, hand: ShootingHand = 'right', fps = FPS): FormCheckRep {
  const tOf = (i: number) => i / fps;
  const dipFrame = motion.truth[motion.dipIdx]!;
  const flat = (p: V3) => ({ x: p.x, y: p.y });
  const metrics: FormMetrics = {
    setPointElbowDeg: angleAtDeg(
      flat(dipFrame.right_shoulder!),
      flat(dipFrame.right_elbow!),
      flat(dipFrame.right_wrist!),
    ),
    kneeFlexionDeg: angleAtDeg(
      flat(dipFrame.right_hip!),
      flat(dipFrame.right_knee!),
      flat(dipFrame.right_ankle!),
    ),
    releaseAngleDeg: null,
    entryAngleDeg: null,
    releaseTimeMs: (RELEASE_T - tOf(motion.dipIdx)) * 1000,
    followThroughHeldMs: 300,
    followThroughElbowDeg: 160,
    releaseHeightNorm: 0.8,
  };
  return {
    index: 1,
    releaseT: RELEASE_T,
    sequence: buildSequence(motion.raw, hand, RELEASE_T),
    metrics,
    phases: {
      dipMs: tOf(motion.dipIdx) * 1000,
      riseMs: (tOf(motion.crossIdx) - tOf(motion.dipIdx)) * 1000,
      releaseMs: (RELEASE_T - tOf(motion.crossIdx)) * 1000,
      followMs: 300,
    },
    releaseHeightM: null,
    flags: [],
    tips: [],
    poseFps: fps,
    lowConfidence: [],
    refusals: [],
  };
}

/** The view Form Check actually asks for: a near-side profile. */
const profileRep = () => makeRep(buildMotion({ yawDeg: 75 }));

// ---------------------------------------------------------------------------
// Step 1 — does the persisted sequence actually feed the lift?
// ---------------------------------------------------------------------------

describe('formSequence → lift compatibility', () => {
  it('decodes into the frame the lift documents: hip-centre origin, +y down', () => {
    const rep = profileRep();
    const frames = decodeSequence(rep.sequence!);
    const mid = frames[Math.floor(frames.length / 2)]!;
    const hipMidX = (mid.left_hip!.x + mid.right_hip!.x) / 2;
    const hipMidY = (mid.left_hip!.y + mid.right_hip!.y) / 2;
    expect(Math.abs(hipMidX)).toBeLessThan(0.01);
    expect(Math.abs(hipMidY)).toBeLessThan(0.01);
    // +y DOWN: shoulders sit above the hips, so their y is negative.
    expect(mid.left_shoulder!.y).toBeLessThan(-0.1);
    // Body-height units: the trunk lands near its prior fraction.
    expect(Math.abs(mid.left_shoulder!.y)).toBeGreaterThan(0.2);
    expect(Math.abs(mid.left_shoulder!.y)).toBeLessThan(0.45);
  });

  it('MEASURED MISMATCH: the encoder over-scales, so limb bones run over their priors', () => {
    // formSequence divides by the per-frame nose→ankle vertical SPAN; lift.ts's
    // priors are fractions of STANDING height. The span is ~0.9 of standing
    // height and shrinks in the dip, so bones measure ~1.1× their prior and the
    // lift clamps their depth to zero. Pinned so a fix to either side trips it.
    const rep = profileRep();
    const scale = depthScaleCheck(decodeSequence(rep.sequence!));
    expect(scale.collapsed).toBe(true);
    expect(scale.medianRatio!).toBeGreaterThan(1.08);
    expect(scale.maxRatio!).toBeGreaterThan(1.1);
    expect(scale.bonesOverPrior / scale.bonesMeasured).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — the adapter
// ---------------------------------------------------------------------------

describe('liftRep', () => {
  it('lifts a profile rep into a skeleton with plausible angles at each phase', () => {
    const motion = buildMotion({ yawDeg: 75 });
    const rep = makeRep(motion);
    const out = liftRep(rep)!;
    expect(out).not.toBeNull();
    expect(out.hand).toBe('right');
    expect(out.lifted.frames.length).toBe(out.frames2d.length);

    const { dip, setPoint, release, followThrough } = out.phases;
    expect(dip).not.toBeNull();
    expect(setPoint).not.toBeNull();
    expect(release).not.toBeNull();
    expect(followThrough).not.toBeNull();

    const kneeAt = (i: number) =>
      angle3(
        out.lifted.frames[i]!.right_hip!,
        out.lifted.frames[i]!.right_knee!,
        out.lifted.frames[i]!.right_ankle!,
      );
    const elbowAt = (i: number) =>
      angle3(
        out.lifted.frames[i]!.right_shoulder!,
        out.lifted.frames[i]!.right_elbow!,
        out.lifted.frames[i]!.right_wrist!,
      );

    // Dip: knees loaded, elbow gathered under the ball.
    expect(kneeAt(dip!)).toBeGreaterThan(120);
    expect(kneeAt(dip!)).toBeLessThan(165);
    expect(elbowAt(dip!)).toBeGreaterThan(60);
    expect(elbowAt(dip!)).toBeLessThan(120);
    // Legs extend from the dip into the release.
    expect(kneeAt(release!)).toBeGreaterThan(kneeAt(dip!));
    // Set point: the wrist has crossed above the shoulder.
    expect(out.frames2d[setPoint!]!.right_wrist!.y).toBeLessThan(
      out.frames2d[setPoint!]!.right_shoulder!.y,
    );
    // Release: the arm is extended and the wrist is at its highest.
    expect(elbowAt(release!)).toBeGreaterThan(145);
    // The pose-gated marker lands on the wrist apex, within a frame of the
    // downsampled grid (+y is down, so the apex is the minimum).
    const wristYs = out.frames2d.map((f) => f.right_wrist?.y ?? Infinity);
    const apex = wristYs.indexOf(Math.min(...wristYs));
    expect(Math.abs(release! - apex)).toBeLessThanOrEqual(1);
    // Follow-through is held after the release.
    expect(followThrough!).toBeGreaterThan(release!);
    expect(elbowAt(followThrough!)).toBeGreaterThan(140);
  });

  it('places the phases in shot order and anchors the release on the rep marker', () => {
    const motion = buildMotion({ yawDeg: 75 });
    const out = liftRep(makeRep(motion))!;
    const { dip, setPoint, release, followThrough } = out.phases;
    expect(out.phases.releaseAnchor).toBe('sequenceMarker');
    expect(dip!).toBeLessThan(setPoint!);
    expect(setPoint!).toBeLessThan(release!);
    expect(release!).toBeLessThan(followThrough!);
    // The located dip is the frame the motion really dipped at.
    const trueDipFrac = motion.dipIdx / (motion.raw.length - 1);
    const gotDipFrac = dip! / (out.frames2d.length - 1);
    expect(Math.abs(gotDipFrac - trueDipFrac)).toBeLessThan(0.06);
  });

  it('recovers the lift itself: the 3D skeleton tracks the true 3D angles it was built from', () => {
    const motion = buildMotion({ yawDeg: 0 });
    const out = liftRep(makeRep(motion))!;
    const i = out.phases.release!;
    const rawIdx = motion.releaseIdx;
    const truth = motion.truth[rawIdx]!;
    const trueElbow = angle3(truth.right_shoulder!, truth.right_elbow!, truth.right_wrist!);
    const f3 = out.lifted.frames[i]!;
    const lifted = angle3(f3.right_shoulder!, f3.right_elbow!, f3.right_wrist!);
    const f2 = out.frames2d[i]!;
    const flat2d = angleAtDeg(f2.right_shoulder!, f2.right_elbow!, f2.right_wrist!)!;
    // Square to the camera the 2D elbow is badly foreshortened; the lift's
    // depth estimate pulls it back to the truth it was generated from.
    expect(Math.abs(flat2d - trueElbow)).toBeGreaterThan(10);
    expect(Math.abs(lifted - trueElbow)).toBeLessThan(5);
  });

  it('returns null — never a partial guess — for a rep it cannot lift', () => {
    const rep = profileRep();
    expect(liftRep({ ...rep, sequence: null })).toBeNull();
    // Three frames is a pose, not a motion: buildSequence refuses outright.
    const thin = buildMotion({ yawDeg: 75, frames: 3, fps: 10 });
    expect(buildSequence(thin.raw, 'right', RELEASE_T)).toBeNull();
    // A four-frame sequence packs, but three of them show nothing: the lift
    // needs two anchored frames and gets one, so the adapter returns null.
    const short = buildMotion({ yawDeg: 75, frames: 4, fps: 10 });
    const seq = buildSequence(short.raw, 'right', RELEASE_T)!;
    const stride = seq.data.length / seq.frames;
    const blanked = {
      ...seq,
      data: seq.data.map((v, i) => (i >= stride ? -32768 : v)),
    };
    expect(liftRep({ ...rep, sequence: blanked })).toBeNull();
  });

  it('is deterministic: the same rep twice is deep-equal', () => {
    const rep = profileRep();
    expect(liftRep(rep)).toEqual(liftRep(rep));
  });
});

// ---------------------------------------------------------------------------
// Step 3 — honesty
// ---------------------------------------------------------------------------

describe('honesty', () => {
  it('a keypoint missing in 2D is absent in 3D, and the angle it fed is withheld', () => {
    const rep = makeRep(buildMotion({ yawDeg: 75, drop: ['right_wrist'] }));
    const out = liftRep(rep)!;
    for (const frame of out.lifted.frames) {
      expect(frame.right_wrist).toBeUndefined();
      // The rest of the skeleton is untouched — nothing is fabricated to
      // complete it, and nothing else is dropped either.
      if (Object.keys(frame).length > 0) expect(frame.right_elbow).toBeDefined();
    }
    const elbow = angleOf(out, 'elbow')!;
    expect(elbow.verdict).toBe('withheld');
    expect(elbow.reason).toBe('missingJoint');
    expect(elbow.deg).toBeNull();
    // The knee is untouched by a missing wrist.
    expect(angleOf(out, 'knee')!.deg).not.toBeNull();
  });

  it('depth confidence falls on a foreshortened bone and never rises past the parent', () => {
    const out = liftRep(profileRep())!;
    for (const frame of out.lifted.frames) {
      for (const [parent, child] of [
        ['right_shoulder', 'right_elbow'],
        ['right_elbow', 'right_wrist'],
        ['left_hip', 'left_knee'],
        ['left_knee', 'left_ankle'],
      ] as [PoseKeypointName, PoseKeypointName][]) {
        const p = frame[parent];
        const c = frame[child];
        if (!p || !c) continue;
        expect(c.c).toBeLessThanOrEqual(p.c + 1e-12);
      }
    }
    // An arm aimed at the lens is the maximally foreshortened case: its depth
    // confidence collapses while the torso it hangs off stays certain.
    const lens = liftRep(makeRep(buildMotion({ yawDeg: 0, armAtLens: true })))!;
    const f = lens.lifted.frames[lens.phases.release!]!;
    expect(f.right_shoulder!.c).toBeGreaterThan(0.9);
    expect(f.right_elbow!.c).toBeLessThan(f.right_shoulder!.c);
    // The wrist can never outrank the elbow it hangs off.
    expect(f.right_wrist!.c).toBeLessThanOrEqual(f.right_elbow!.c);
    expect(f.right_wrist!.c).toBeLessThan(MIN_DEPTH_C);
  });

  it('WITHHOLDS a 3D angle whose joints have low depth confidence', () => {
    const out = liftRep(makeRep(buildMotion({ yawDeg: 0, armAtLens: true })))!;
    const elbow = angleOf(out, 'elbow')!;
    expect(elbow.verdict).toBe('withheld');
    expect(elbow.reason).toBe('lowDepthConfidence');
    expect(elbow.deg).toBeNull();
    // Withheld, not silent: the confidence that failed the gate is reported,
    // and the 2D reading it would have replaced is still there.
    expect(elbow.c!).toBeLessThan(MIN_DEPTH_C);
    expect(elbow.deg2d).not.toBeNull();
    expect(elbow.note).toContain('withheld');
  });

  it('refuses to call 3D an upgrade in the side view Form Check asks for', () => {
    const out = liftRep(profileRep())!;
    const elbow = angleOf(out, 'elbow')!;
    const knee = angleOf(out, 'knee')!;
    for (const a of [elbow, knee]) {
      expect(a.verdict).toBe('prefer2d');
      expect(a.reason).toBe('depthCollapsed');
      // The number is still there for the scrubber — it is simply the 2D one.
      expect(Math.abs(a.deg! - a.deg2d!)).toBeLessThan(0.5);
      expect(a.boneRatio!).toBeGreaterThan(1);
      expect(a.note).toContain('Trust the 2D number');
    }
    // And it is compared against the number Form Check itself reports — at the
    // dip, the frame that number is read off. They agree to a degree or two:
    // the sequence keeps a downsampled grid, so the located frame is the
    // nearest one, not the same one.
    expect(Math.abs(elbow.repDeg2d! - elbow.deg2d!)).toBeLessThan(3);
    expect(Math.abs(knee.repDeg2d! - knee.deg2d!)).toBeLessThan(3);
  });

  it('prefers 3D only when the depth it recovered actually moves the number', () => {
    // A shooter turned 35° toward the camera — the phone off the shooting
    // line, the case Form Check cannot fix in 2D. The gather now has real
    // depth in it AND enough of the bone still projects for the lift to
    // recover that depth: the one situation where 3D beats 2D.
    const motion = buildMotion({ yawDeg: 35 });
    const out = liftRep(makeRep(motion))!;
    const elbow = angleOf(out, 'elbow')!;
    expect(elbow.verdict).toBe('prefer3d');
    expect(elbow.reason).toBe('foreshortened2d');
    expect(Math.abs(elbow.deg! - elbow.deg2d!)).toBeGreaterThanOrEqual(AGREE_TOL_DEG);
    expect(elbow.c!).toBeGreaterThanOrEqual(MIN_DEPTH_C);
    expect(elbow.note).toContain('foreshortens');
    // The claim has to be true, not just consistent: against the angle the
    // fixture was BUILT from, the 3D reading really is the closer one.
    const dipTruth = motion.truth[motion.dipIdx]!;
    const trueElbow = angle3(
      dipTruth.right_shoulder!,
      dipTruth.right_elbow!,
      dipTruth.right_wrist!,
    );
    expect(Math.abs(elbow.deg! - trueElbow)).toBeLessThan(Math.abs(elbow.deg2d! - trueElbow));
  });

  it('reports torso yaw as the 3D-only reading it is, with its bias stated', () => {
    const out = liftRep(profileRep())!;
    const yaw = angleOf(out, 'torsoYaw')!;
    expect(yaw.verdict).toBe('only3d');
    expect(yaw.reason).toBe('no2dEquivalent');
    expect(yaw.deg2d).toBeNull();
    expect(yaw.repDeg2d).toBeNull();
    // The fixture is yawed 75°; the over-scaled shoulder width reads it low,
    // so the note has to say the number is a floor, not a measurement.
    expect(yaw.deg!).toBeGreaterThan(60);
    expect(yaw.deg!).toBeLessThan(75);
    expect(yaw.note).toContain('lower bound');
  });

  it('every angle carries its depth confidence and a verdict, never a bare number', () => {
    const out = liftRep(profileRep())!;
    expect(out.angles.map((a) => a.id)).toEqual(['elbow', 'knee', 'shoulder', 'torsoYaw']);
    for (const a of out.angles) {
      expect(a.note.length).toBeGreaterThan(0);
      if (a.deg == null) expect(a.verdict).toBe('withheld');
      else expect(a.c!).toBeGreaterThanOrEqual(MIN_DEPTH_C);
    }
  });

  it('lifts only the 13 joints it can, never the eyes and ears', () => {
    const out = liftRep(profileRep())!;
    for (const frame of out.lifted.frames) {
      for (const name of Object.keys(frame) as PoseKeypointName[]) {
        expect(LIFT_JOINTS).toContain(name);
      }
    }
  });

  it('follows the sequence hand to the left side', () => {
    // Structure only: the fixture shoots right-handed, so its rep metrics stay
    // right-handed. What is pinned here is that a left-handed sequence reads
    // the left joints and finds their bone priors.
    const out = liftRep(makeRep(buildMotion({ yawDeg: -75 }), 'left'))!;
    expect(out.hand).toBe('left');
    const knee = angleOf(out, 'knee')!;
    expect(knee.frame).not.toBeNull();
    expect(knee.deg).not.toBeNull();
    expect(knee.boneRatio).not.toBeNull();
    expect(out.lifted.frames[knee.frame!]!.left_knee).toBeDefined();
  });
});
