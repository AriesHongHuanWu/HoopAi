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
import { SEQ_TARGET_FRAMES, buildSequence, decodeSequence } from '../formSequence';
import type { RawSeqFrame } from '../formSequence';
import type { FormCheckRep } from '../formCheck';
import { angleAtDeg } from '../geometry';
import {
  AGREE_TOL_DEG,
  MIN_DEPTH_C,
  RESOLVABLE_LEN_RATIO,
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

/**
 * The RAW frame the packed sequence actually sampled for output frame `k`.
 * buildSequence keeps an even {@link SEQ_TARGET_FRAMES}-frame grid over the
 * window, so a truth comparison has to read the instant the grid landed on —
 * otherwise up to one raw frame of motion (1.1° of elbow at the release here)
 * is charged to the lift.
 */
function sampledRaw(motion: Motion, k: number): number {
  return Math.round((k * (motion.raw.length - 1)) / (SEQ_TARGET_FRAMES - 1));
}

/**
 * The same motion with DETECTOR NOISE on every keypoint: independent uniform
 * jitter of ±sigma (as a fraction of standing height) in x and y, from a
 * fixed LCG so the run is reproducible. MoveNet on a phone sits around
 * 0.5–1% of body height on limb ends, worse on the wrist.
 */
function jittered(motion: Motion, sigmaFrac: number, seed0 = 12345): Motion {
  let seed = seed0;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648) * 2 - 1;
  };
  const px = sigmaFrac * H;
  const raw = motion.raw.map((f) => {
    const pts = new Map<PoseKeypointName, { x: number; y: number }>();
    for (const [name, q] of f.pts) {
      pts.set(name, { x: q.x + next() * px, y: q.y + next() * px });
    }
    return { t: f.t, pts };
  });
  // truth stays the CLEAN skeleton: the noise is the detector's, not the body's.
  return { ...motion, raw };
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
    // height and shrinks in the dip, so bones measure ~1.1× their prior. Read
    // that way — at the identity scale, which is what depthScaleCheck's default
    // measures — every limb clamps to zero depth. liftRep does NOT read them
    // that way any more: it measures a scale per frame and hands it to the
    // lift, so this is the size of the mismatch it reconciles, pinned so a
    // change to either side trips it.
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

  /**
   * SQUARE TO THE CAMERA, MEASURED (yawDeg 0), against the 3D truth the
   * fixture was generated from, at the instants the sequence grid sampled:
   *
   *   joint          phase     true      3D       2D
   *   elbow          release   160.9   148.0    180.0
   *   knee           dip       134.8   136.8    180.0
   *   arm elevation  release   152.4   147.5    173.4
   *
   * THIS TEST USED TO ASSERT THE LIFTED ELBOW LANDS WITHIN 5° OF THE TRUTH.
   * It does not, and it cannot. The 2D elbow here is not foreshortened, it is
   * DEGENERATE — at yaw 0 the whole arm projects onto one vertical line, so 2D
   * reports 180° for a 161° elbow — and the lift beats that by only 6.2°
   * because at the release the forearm's true out-of-plane offset is 0.20 of
   * the bone, UNDER lift.ts's MIN_RESOLVABLE_DZ_RATIO of 0.3. Its 2D length is
   * therefore 0.979 of its prior, inside the 4.6% band a length prior cannot
   * resolve, and the lift places it in the image plane rather than solving a
   * bend out of the last 2% of a bone length. Recovering those 13° means
   * reading dz off exactly that 2%, where d(dz)/dl = −l/dz ≈ 4.8: one percent
   * of keypoint noise, of scale error, or of the gap between this shooter's
   * forearm and Winter's average moves the wrist by 5% of a forearm and the
   * elbow by ~3°. So the claim is withdrawn from the product, not from the
   * test: what is pinned here is the mechanism, the disclosure, and the
   * recovery where the depth IS resolvable.
   */
  it('recovers the depth a length prior can resolve, and flags the depth it cannot', () => {
    const motion = buildMotion({ yawDeg: 0 });
    const out = liftRep(makeRep(motion))!;

    // --- the elbow at the release: better than 2D, and not a reading -------
    const i = out.phases.release!;
    const truth = motion.truth[sampledRaw(motion, i)]!;
    const trueElbow = angle3(truth.right_shoulder!, truth.right_elbow!, truth.right_wrist!);
    const f3 = out.lifted.frames[i]!;
    const lifted = angle3(f3.right_shoulder!, f3.right_elbow!, f3.right_wrist!);
    const f2 = out.frames2d[i]!;
    const flat2d = angleAtDeg(f2.right_shoulder!, f2.right_elbow!, f2.right_wrist!)!;
    expect(Math.abs(flat2d - trueElbow)).toBeGreaterThan(10);
    // The lift moves the number toward the truth…
    expect(Math.abs(lifted - trueElbow)).toBeLessThan(Math.abs(flat2d - trueElbow));
    // A REGRESSION CEILING, deliberately not an accuracy claim. "Better than
    // 2D" alone tolerates 19.1° here, because square-on the 2D arm is
    // degenerate (180° for a true 161°) — so that assertion on its own would
    // let today's 12.9° rot most of the way back without a single test going
    // red. The 5° the original assertion asked for is unreachable (see below);
    // this pins the measured behaviour so DRIFT is caught.
    // If this fails, the depth got worse. Work out why — do not raise 13.5.
    expect(Math.abs(lifted - trueElbow)).toBeLessThan(13.5);
    // …and stops there because the forearm was PLACED, not solved: its 2D
    // length sits inside the resolution band, so it comes out dead flat and
    // the wrist inherits the elbow's depth exactly.
    const forearm2d = Math.hypot(
      f2.right_wrist!.x - f2.right_elbow!.x,
      f2.right_wrist!.y - f2.right_elbow!.y,
    );
    const scale = out.lifted.unitScales![i]!;
    expect(forearm2d / (FOREARM_LEN * scale)).toBeGreaterThanOrEqual(RESOLVABLE_LEN_RATIO);
    expect(f3.right_wrist!.z).toBe(f3.right_elbow!.z);

    // --- where the depth IS resolvable, the lift lands on the truth --------
    // The dip knee is loaded straight into the camera: 2D cannot see it at all
    // (180° for a 135° knee), both leg bones project to 0.93 of their priors,
    // and the lift recovers the bend to 2°.
    const d = out.phases.dip!;
    const dipTruth = motion.truth[sampledRaw(motion, d)]!;
    const trueKnee = angle3(dipTruth.right_hip!, dipTruth.right_knee!, dipTruth.right_ankle!);
    const knee = angleOf(out, 'knee')!;
    expect(knee.frame).toBe(d);
    expect(Math.abs(knee.deg! - trueKnee)).toBeLessThan(3);
    expect(Math.abs(knee.deg2d! - trueKnee)).toBeGreaterThan(40);
    expect(knee.verdict).toBe('prefer3d');
    // Nothing under it was assumed: both bones had their depth solved.
    expect(knee.restsOnUnresolvedBone).toBe(false);

    // --- and the elbow the REPORT shows square-on is not shown at all ------
    // Its forearm points almost straight down the lens at the dip (×0.19 of
    // the prior), so the foreshortening penalty takes the depth confidence to
    // 0.42 and the reading is withheld rather than dimmed.
    const elbow = angleOf(out, 'elbow')!;
    expect(elbow.verdict).toBe('withheld');
    expect(elbow.deg).toBeNull();
    expect(elbow.deg2d).not.toBeNull();
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

  /**
   * WHAT MOVED HERE. This used to assert boneRatio > 1 — every bone under the
   * reading measuring LONGER than its prior — and at 1.11–1.13 it did, because
   * the priors were read in standing-height units against frames formSequence
   * had normalized by a nose→ankle span. That ratio was measuring a units bug,
   * not a side view. With the scale measured off each frame's own bones it
   * cannot exceed 1 at all: the frame's scale IS the largest measured/prior
   * ratio in that frame, so every ratio in it is at most 1 by construction.
   *
   * What is true at a profile — and what the flat verdict now keys off — is
   * that every bone under the reading sits INSIDE the band a length prior
   * cannot resolve (>= RESOLVABLE_LEN_RATIO = 0.954). Measured at yawDeg 75:
   * elbow 0.967, knee 0.995. Depth is not collapsed by arithmetic any more; it
   * is collapsed because the shooter really is side-on to the lens.
   */
  it('refuses to call 3D an upgrade in the side view Form Check asks for', () => {
    const motion = buildMotion({ yawDeg: 75 });
    const out = liftRep(makeRep(motion))!;
    const elbow = angleOf(out, 'elbow')!;
    const knee = angleOf(out, 'knee')!;
    for (const a of [elbow, knee]) {
      expect(a.verdict).toBe('prefer2d');
      expect(a.reason).toBe('depthCollapsed');
      // The number is still there for the scrubber — it is simply the 2D one.
      expect(Math.abs(a.deg! - a.deg2d!)).toBeLessThan(0.5);
      expect(a.boneRatio!).toBeGreaterThanOrEqual(RESOLVABLE_LEN_RATIO);
      expect(a.boneRatio!).toBeLessThanOrEqual(1);
      expect(a.restsOnUnresolvedBone).toBe(true);
      expect(a.note).toContain('Trust the 2D number');
    }
    // The payoff of reading the priors in each frame's own units: at a profile
    // the flat reading is also the RIGHT reading. Measured against the 3D
    // truth at the dip — elbow 0.2°, knee 1.4°.
    const dipTruth = motion.truth[sampledRaw(motion, out.phases.dip!)]!;
    const trueElbow = angle3(dipTruth.right_shoulder!, dipTruth.right_elbow!, dipTruth.right_wrist!);
    const trueKnee = angle3(dipTruth.right_hip!, dipTruth.right_knee!, dipTruth.right_ankle!);
    expect(Math.abs(elbow.deg! - trueElbow)).toBeLessThan(2);
    expect(Math.abs(knee.deg! - trueKnee)).toBeLessThan(2);
    // And it is compared against the number Form Check itself reports — at the
    // dip, the frame that number is read off. They agree to a degree or two:
    // the sequence keeps a downsampled grid, so the located frame is the
    // nearest one, not the same one.
    expect(Math.abs(elbow.repDeg2d! - elbow.deg2d!)).toBeLessThan(3);
    expect(Math.abs(knee.repDeg2d! - knee.deg2d!)).toBeLessThan(3);
  });

  it('does not invent depth at a strict profile: a straight leg stays straight', () => {
    // THE BUG THIS PINS. One scale for the whole rep is effectively the deepest
    // dip's scale — the nose→ankle span the encoder divides by is shortest
    // there — so every upright frame's priors came out ~6% too long. An
    // in-plane bone then measures 0.94 of its prior and solves to
    // dz = 0.33 × the bone: a third of a bone of depth that is not there.
    // Measured at yawDeg 90, where the shooter is exactly side-on and EVERY
    // joint's true z is 0, at the release frame: the knee read 141.6° for a
    // true 177.1° and the elbow 137.4° for a true 160.9°. With the scale
    // measured per frame every error below is 0.0°.
    const motion = buildMotion({ yawDeg: 90 });
    const out = liftRep(makeRep(motion))!;
    const phases: [string, number][] = [
      ['dip', out.phases.dip!],
      ['setPoint', out.phases.setPoint!],
      ['release', out.phases.release!],
      ['followThrough', out.phases.followThrough!],
    ];
    for (const [, idx] of phases) {
      const t = motion.truth[sampledRaw(motion, idx)]!;
      const f3 = out.lifted.frames[idx]!;
      const triples: [PoseKeypointName, PoseKeypointName, PoseKeypointName][] = [
        ['right_shoulder', 'right_elbow', 'right_wrist'],
        ['right_hip', 'right_knee', 'right_ankle'],
        ['right_hip', 'right_shoulder', 'right_elbow'],
      ];
      for (const [a, b, c] of triples) {
        const truth = angle3(t[a]!, t[b]!, t[c]!);
        expect(Math.abs(angle3(f3[a]!, f3[b]!, f3[c]!) - truth)).toBeLessThan(1);
      }
    }
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
    // Honest about the half it did not measure: at the dip the upper arm hangs
    // nearly in the image plane (×1.00 of its prior) while the forearm points
    // into the lens (×0.60). The verdict stands — the depth that moved the
    // number is the forearm's, and that one was solved — but the reading says
    // out loud that one of its bones was placed rather than measured.
    expect(elbow.restsOnUnresolvedBone).toBe(true);
    expect(elbow.worstBoneRatio!).toBeGreaterThanOrEqual(RESOLVABLE_LEN_RATIO);
    expect(elbow.boneRatio!).toBeLessThan(RESOLVABLE_LEN_RATIO);
    expect(elbow.note).toContain('assumption');
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
    // DOES NOT OVER-CLAIM THE TURN, and on clean keypoints that is
    // structural: cos θ = apparent shoulder half-width ÷ (the prior half-width
    // × the frame's scale), and that scale is the largest measured/prior ratio
    // in the frame — never larger than the frame's true scale, because a
    // projection is never longer than the bone. So the denominator is not
    // over-long and θ does not over-read. AT HEAD IT DID: one scale for the
    // whole rep was effectively the deepest dip's, ~5% long at the upright
    // frames, and this 75° fixture read 75.55°. It now reads 74.996°.
    // (Detector noise breaks the bound the other way — short-looking bones
    // inflate the measured scale — by a measured +0.4°/+0.9°/+1.8° at
    // 0.5%/1%/2% keypoint noise. The bound is a property of the estimator,
    // not a promise about a phone.)
    expect(yaw.deg!).toBeGreaterThan(60);
    expect(yaw.deg!).toBeLessThan(75);
    expect(75 - yaw.deg!).toBeLessThan(0.5);
    // The tolerance is stated unconditionally, because it comes from the
    // shoulder-width prior being an average build — nothing one rep can
    // measure away. dθ = Δratio ÷ sin θ, so 8% of anthropometric spread is
    // ~1° at a profile and swallows the reading whole near square-on.
    expect(yaw.note).toContain('carries a few degrees');
  });

  it('calls the torso turn a lower bound exactly when it is one', () => {
    // The old test asserted "lower bound" on a clean profile rep, where the
    // trigger was a residual ratio over 1 — a float that now sits AT 1 by
    // construction, so the sentence appeared or vanished on its last bit
    // (measured: it fired at yawDeg 0/35/75 and not at 55/90, on identical
    // geometry). The floor language belongs where the floor is real: a rep
    // whose units could not be reconciled at all. Here the detector never saw
    // the wrists or the knees, so no frame carries the three limb bones a
    // scale needs, every prior is read as-is, the shoulder width is over-
    // scaled by ~1.1 — and the 75° fixture reads 73.0°, under, as promised.
    const out = liftRep(
      makeRep(
        buildMotion({
          yawDeg: 75,
          drop: ['right_wrist', 'left_wrist', 'right_knee', 'left_knee'],
        }),
      ),
    )!;
    expect(out.lifted.unitScales!.every((u) => u === 1)).toBe(true);
    expect(out.scale.collapsed).toBe(true);
    const yaw = angleOf(out, 'torsoYaw')!;
    expect(yaw.deg!).toBeGreaterThan(70);
    expect(yaw.deg!).toBeLessThan(75);
    expect(yaw.note).toContain('lower bound');
  });

  /**
   * WHERE THIS LAYER STOPS BEING WORTH SHOWING. RMS error over 24 noise
   * realizations, ±sigma of standing height on every keypoint in every frame,
   * against the clean 3D truth (dip frame for elbow and knee):
   *
   *   sigma           0.5%          1%            2%
   *   profile  elbow  3.0 (2D 2.9)  6.4 (2D 5.8)  12.3 (2D 11.6)
   *   profile  knee   1.6 (2D 1.8)  7.5 (2D 2.9)  16.1 (2D  5.4)
   *   square   knee   9.1 (2D 43.8) 14.0 (2D 42.4) 19.5 (2D 39.7)
   *   square   elbow  withheld 24/24, 23/24, 16/24
   *   torso yaw error 0.4 at a true 75°, 7.4 at a true 0° (0.5%)
   *
   * Read two things off it. Off-axis, 3D beats 2D at every noise level tested,
   * because 2D there is not slightly wrong but blind — the knee bent into the
   * lens is 44° out in 2D and 9° out in 3D. AT A PROFILE the two are level at
   * 0.5% and 3D LOSES from about 1% up: noise makes bones look short, the
   * measured scale creeps up with it, and the lift starts recovering depth that
   * is not there — exactly the failure the rep-wide scale used to cause on
   * purpose. MoveNet on a phone sits near 0.5% on the trunk and worse on the
   * wrist, so this test pins the 0.5% regime and the table above is the honest
   * statement of the rest. Nothing in the app may claim a profile capture is
   * MORE accurate in 3D than in 2D.
   */
  it('holds up under detector noise: level with 2D at a profile, ahead of it square-on', () => {
    const SEEDS = 24;
    const sigma = 0.005;
    const rms = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length);

    const profile = buildMotion({ yawDeg: 75 });
    const pElbow3: number[] = [];
    const pElbow2: number[] = [];
    const pKnee3: number[] = [];
    const pKnee2: number[] = [];
    const square = buildMotion({ yawDeg: 0 });
    const sKnee3: number[] = [];
    const sKnee2: number[] = [];
    let squareElbowWithheld = 0;

    for (let sd = 0; sd < SEEDS; sd++) {
      const seed = 1000 + sd * 7919;
      const pOut = liftRep(makeRep(jittered(profile, sigma, seed)))!;
      const pDip = profile.truth[sampledRaw(profile, pOut.phases.dip!)]!;
      const trueElbow = angle3(pDip.right_shoulder!, pDip.right_elbow!, pDip.right_wrist!);
      const trueKnee = angle3(pDip.right_hip!, pDip.right_knee!, pDip.right_ankle!);
      const pe = angleOf(pOut, 'elbow')!;
      const pk = angleOf(pOut, 'knee')!;
      pElbow3.push(pe.deg! - trueElbow);
      pElbow2.push(pe.deg2d! - trueElbow);
      pKnee3.push(pk.deg! - trueKnee);
      pKnee2.push(pk.deg2d! - trueKnee);

      const sOut = liftRep(makeRep(jittered(square, sigma, seed)))!;
      const sDip = square.truth[sampledRaw(square, sOut.phases.dip!)]!;
      const trueSquareKnee = angle3(sDip.right_hip!, sDip.right_knee!, sDip.right_ankle!);
      const sk = angleOf(sOut, 'knee')!;
      sKnee3.push(sk.deg! - trueSquareKnee);
      sKnee2.push(sk.deg2d! - trueSquareKnee);
      // Square-on the shooting forearm points down the lens at the dip, so the
      // foreshortening penalty keeps the elbow under the confidence floor.
      if (angleOf(sOut, 'elbow')!.deg == null) squareElbowWithheld++;
    }

    // At a profile the 3D reading is level with 2D — never sold as better.
    expect(rms(pElbow3)).toBeLessThan(4);
    expect(rms(pKnee3)).toBeLessThan(3);
    expect(rms(pElbow3)).toBeLessThan(rms(pElbow2) + 1);
    expect(rms(pKnee3)).toBeLessThan(rms(pKnee2) + 1);
    // Square-on it is the only reading there is: 2D is blind to a knee bent
    // into the lens, and stays blind however clean the keypoints are.
    expect(rms(sKnee3)).toBeLessThan(12);
    expect(rms(sKnee2)).toBeGreaterThan(40);
    expect(squareElbowWithheld).toBe(SEEDS);
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
