/**
 * Single-view 2D→3D anthropometric lift for Form Studio 3D.
 *
 * Takes the already-persisted per-shot {@link DecodedFrame}s (MoveNet COCO-17
 * 2D keypoints, hip-center origin, body-height units, +y DOWN — see
 * src/core/formSequence.ts) and estimates per-joint depth with classic
 * Taylor-style bone-length priors: for a bone of prior length L whose 2D
 * projection spans len2D, the out-of-plane offset is
 * dz = sqrt(max(0, L² − len2D²)). Torso yaw (azimuth vs the camera) is
 * estimated from the apparent shoulder width; limb depth signs come from a
 * flex-toward-camera first-frame heuristic and are then locked frame-to-frame
 * by temporal continuity (pick the sign closest to the previous z).
 *
 * HONESTY IS STRUCTURAL (repo iron law — this is an ESTIMATE and the data
 * model never hides that):
 * - x/y are the MEASURED 2D coordinates, copied through untouched; only z is
 *   inferred. Smoothing touches z exclusively.
 * - every {@link Joint3D} carries a depth confidence c ∈ 0..1 that
 *   monotonically decreases with each degradation: a 2D bone longer than its
 *   anthropometric prior (depth unrecoverable → clamped), foreshortening
 *   (a bone pointing at the camera has maximal sign ambiguity), and a
 *   low-confidence parent (child can never be more certain than its anchor).
 * - a keypoint missing in 2D is ABSENT in 3D — joints are never fabricated.
 *   Eyes/ears are never lifted at all ({@link LIFT_JOINTS}); the renderer
 *   draws a head circle at the nose instead.
 * - fully deterministic: same input → deep-equal output, so recorded
 *   sessions replay identically.
 *
 * Coordinate contract: +x right, +y DOWN (unchanged from the 2D sequence),
 * +z toward the camera; units = body heights.
 *
 * UNITS ARE A PARAMETER, NOT AN ASSUMPTION (`unitScale`):
 * the priors below are fractions of STANDING body height, but the frames that
 * arrive are normalized by whatever the encoder divided by. formSequence.ts
 * divides each frame by that frame's nose→ankle VERTICAL SPAN, which is
 * ~{@link STANDING_SPAN_RATIO} of standing height upright and smaller in the
 * dip — so its limb bones measure ~1.11–1.13 × their prior. Read with the
 * priors as-is, every one of those bones looks "longer than the bone it is",
 * dz clamps to 0, and THE LIMBS COME OUT FLAT (the torso still gets depth: it
 * comes from the yaw, not from a bone solve). Every prior is therefore
 * multiplied by `unitScale` = normalized units per standing body height before
 * it is used. `unitScale` defaults to 1 — the pre-parameter behaviour, so an
 * existing caller's output is byte-identical — and it may be ONE number or ONE
 * PER FRAME. Per frame is what this pipeline actually needs: formSequence
 * divides each frame by that frame's own span, so the units move ~6% across a
 * rep and a single scale is right for at most one frame of it. {@link
 * measureUnitScales} measures the per-frame scale off the frames themselves;
 * {@link measureUnitScale} is the single-scale estimator, correct only when
 * every frame shares one normalization.
 *
 * Pure TypeScript: no I/O, no wall clock, no randomness.
 */
import type { DecodedFrame } from '../formSequence';
import { clamp } from '../geometry';
import type { PoseKeypointName, ShootingHand } from '../types';

// ---------------------------------------------------------------------------
// Types (owned here; every other pose3d module imports from this file)
// ---------------------------------------------------------------------------

/**
 * One lifted joint. Units = body heights; +x right, +y DOWN, +z toward the
 * camera. `c` is the 0..1 depth confidence (x/y are measured — c grades z).
 */
export interface Joint3D {
  x: number;
  y: number;
  z: number;
  c: number;
}

/** One lifted frame. Joints missing in 2D are absent here — never NaN. */
export type Frame3D = Partial<Record<PoseKeypointName, Joint3D>>;

export interface LiftedSequence {
  /** Same length as the input; frames that could not be lifted are `{}`. */
  frames: Frame3D[];
  /** Mean joint confidence over all present joints in all frames, 0..1. */
  confidence: number;
  /** Mean signed torso azimuth vs the camera, degrees (0 = square-on). */
  azimuthDeg: number;
  /**
   * The ONE `unitScale` the priors were read in (normalized units per standing
   * body height) — see {@link clampUnitScale}. Absent when the scale was
   * measured per frame ({@link unitScales} is then the record), and on a
   * sequence produced before the parameter existed, which means the identity
   * scale 1.
   */
  unitScale?: number;
  /**
   * The scale applied to EACH frame, same length and order as {@link frames}.
   * Present on anything this version lifted; absent only on a sequence
   * produced before per-frame scales existed. A reader that needs the scale a
   * given frame was solved at must use this, not {@link unitScale}.
   */
  unitScales?: readonly number[];
}

// ---------------------------------------------------------------------------
// Anthropometric priors (Winter), fractions of standing body height
// ---------------------------------------------------------------------------

/** shoulderCenter → each shoulder (half the biacromial width). */
export const SHOULDER_HALF_LEN = 0.129;
/** hipCenter → each hip (half the inter-hip width). */
export const HIP_HALF_LEN = 0.0955;
/** hipCenter → shoulderCenter (reference; the lift pivots both on z = 0). */
export const TRUNK_LEN = 0.288;
/** shoulderCenter → nose. */
export const NECK_LEN = 0.13;
/** shoulder → elbow. */
export const UPPER_ARM_LEN = 0.186;
/** elbow → wrist. */
export const FOREARM_LEN = 0.146;
/** hip → knee. */
export const THIGH_LEN = 0.245;
/** knee → ankle. */
export const SHANK_LEN = 0.246;

/**
 * The 13 joints the lift produces: COCO-17 minus eyes/ears. Order follows
 * SEQ_KEYPOINT_ORDER (src/core/formSequence.ts) with the face points removed.
 */
export const LIFT_JOINTS: readonly PoseKeypointName[] = [
  'nose',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;

/**
 * Keypoint-pair bone-length priors (fraction of body height). The width
 * entries are the full spans (2 × half-width). Center-anchored priors
 * (trunk, neck) have no keypoint endpoints and live as the scalar constants
 * above instead.
 */
export const BONE_PRIORS: readonly {
  a: PoseKeypointName;
  b: PoseKeypointName;
  len: number;
}[] = [
  { a: 'left_shoulder', b: 'right_shoulder', len: 2 * SHOULDER_HALF_LEN },
  { a: 'left_hip', b: 'right_hip', len: 2 * HIP_HALF_LEN },
  { a: 'left_shoulder', b: 'left_elbow', len: UPPER_ARM_LEN },
  { a: 'right_shoulder', b: 'right_elbow', len: UPPER_ARM_LEN },
  { a: 'left_elbow', b: 'left_wrist', len: FOREARM_LEN },
  { a: 'right_elbow', b: 'right_wrist', len: FOREARM_LEN },
  { a: 'left_hip', b: 'left_knee', len: THIGH_LEN },
  { a: 'right_hip', b: 'right_knee', len: THIGH_LEN },
  { a: 'left_knee', b: 'left_ankle', len: SHANK_LEN },
  { a: 'right_knee', b: 'right_ankle', len: SHANK_LEN },
] as const;

/**
 * The bones whose depth is SOLVED from a prior (both two-link chains, both
 * sides). The shoulder/hip WIDTH pairs are excluded on purpose: their 2D
 * length shortens with torso yaw by design, so they carry yaw, not scale —
 * measuring scale off them would read every turned torso as square-on.
 */
export const LIMB_BONE_PRIORS: readonly { a: PoseKeypointName; b: PoseKeypointName; len: number }[] =
  BONE_PRIORS.filter(
    (b) =>
      !(b.a === 'left_shoulder' && b.b === 'right_shoulder') &&
      !(b.a === 'left_hip' && b.b === 'right_hip'),
  );

/**
 * Render bone list (12 bones). The head is NOT a bone — the renderer draws a
 * circle at the nose.
 */
export const SKELETON_BONES: readonly [PoseKeypointName, PoseKeypointName][] = [
  ['left_shoulder', 'right_shoulder'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
] as const;

/** Fraction of confidence lost at full foreshortening (dz = L). */
const FORESHORTEN_PENALTY = 0.6;

/**
 * First-frame depth sign of a chain's END bone, relative to the sign its MID
 * bone was solved with. See {@link liftChain}: the projection cannot tell the
 * two apart, so this is the shot's anatomy, stated once.
 */
export const ARM_END_SIGN = 1;
export const LEG_END_SIGN = -1;

/**
 * Smallest out-of-plane offset, as a fraction of the bone, that a LENGTH prior
 * can actually resolve.
 *
 * dz = L·sqrt(1 − (l/L)²) is FLAT in l near the image plane: at dz = 0.3 L the
 * 2D bone is only 4.5% shorter than its prior, so a couple of percent of
 * keypoint noise — or of error in {@link measureUnitScale} — swings dz by tens
 * of percent of L and takes the joint angle with it. Below this floor the
 * honest reading is "this bone lies in the image plane": dz snaps to 0 and the
 * child inherits its parent's depth exactly, so the 3D angle equals the
 * measured 2D one instead of a shallow number with a confident sign. A near-
 * profile capture — the view Form Check asks for — is mostly this case by
 * construction, and saying so beats inventing a bend in depth.
 */
export const MIN_RESOLVABLE_DZ_RATIO = 0.3;

// ---------------------------------------------------------------------------
// Unit scale — what "1.0" means in the frames that arrive
// ---------------------------------------------------------------------------

/** Winter hip-joint height, fraction of standing height. */
export const HIP_HEIGHT = 0.53;
/** Winter ankle height, fraction of standing height. */
export const ANKLE_HEIGHT = 0.039;

/**
 * Vertical nose→ankle span of an UPRIGHT shooter ÷ standing height, derived
 * from this file's own priors (hip 0.53 + trunk 0.288 + neck 0.13 − ankle
 * 0.039 ≈ 0.909). This is the span formSequence.ts normalizes by, so a frame
 * it encoded upright is in units ~1/0.909 = 1.10 × too big for these priors —
 * and MORE than that in the dip, where the span shortens but the bones do not.
 */
export const STANDING_SPAN_RATIO = HIP_HEIGHT + TRUNK_LEN + NECK_LEN - ANKLE_HEIGHT;

/** Priors read as-is: the frames are already in standing-height units. */
export const UNIT_SCALE_IDENTITY = 1;

/**
 * Clamp range for `unitScale`. The floor is 1 by physics, not by taste: a 2D
 * projection can never be LONGER than the bone it projects, and an encoder
 * that divides by a body span can only ever divide by something no larger
 * than standing height — so in this pipeline the frames can only ever be too
 * BIG for the priors, never too small. The ceiling is the deepest dip /
 * legs-hidden trunk fallback worth trusting (a span of ~0.6 of standing
 * height); past it the number is a detector artifact, not a normalization,
 * and it is clamped rather than believed.
 */
export const UNIT_SCALE_MIN = 1;
export const UNIT_SCALE_MAX = 1.6;

/** Bone samples below which a measured scale is a guess — identity instead. */
export const UNIT_SCALE_MIN_SAMPLES = 8;

/**
 * Upper-envelope quantile for {@link measureUnitScale}. The estimator wants
 * the LEAST foreshortened bone in the capture (its 2D length is closest to
 * its true length), which is the top of the ratio distribution — but the very
 * top is one bad keypoint away from nonsense, so it reads just under it.
 */
export const UNIT_SCALE_QUANTILE = 0.95;

/** Fold any incoming scale into the trusted range; non-finite → identity. */
export function clampUnitScale(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return UNIT_SCALE_IDENTITY;
  return clamp(value, UNIT_SCALE_MIN, UNIT_SCALE_MAX);
}

/**
 * `unitScale` from an explicit span-to-standing-height ratio — the direct
 * form when the caller knows what the encoder divided by (e.g. 0.9 for
 * formSequence's upright nose→ankle span).
 */
export function unitScaleFromSpanRatio(spanRatio: number): number {
  if (!Number.isFinite(spanRatio) || spanRatio <= 0) return UNIT_SCALE_IDENTITY;
  return clampUnitScale(1 / spanRatio);
}

/**
 * MEASURE one `unitScale` for a whole sequence: the {@link
 * UNIT_SCALE_QUANTILE} quantile of measured/prior 2D length over every limb
 * bone in every frame.
 *
 * ONLY FOR FRAMES THAT SHARE ONE NORMALIZATION. Pooling bones across frames
 * assumes every frame was divided by the same number. When it was not — and
 * formSequence divides each frame by that frame's own span — the pooled
 * envelope lands near the LARGEST per-frame scale in the rep and over-scales
 * every other frame's priors, which fabricates depth in the frames it
 * over-scales. Use {@link measureUnitScales} for that pipeline; this one is
 * for a caller whose units are fixed (a single pose, or frames normalized once).
 *
 * Why the envelope is the honest estimator WITHIN one normalization: a
 * projection is never longer than the bone, so every sample is a LOWER bound
 * on the scale and the envelope is the smallest scale consistent with all of
 * them. Under-shooting keeps priors short, which keeps dz small or clamped —
 * depth is lost, never invented. The bone that set the envelope solves to
 * dz ≈ 0, which is exactly right: it is the one lying in the image plane.
 *
 * Returns {@link UNIT_SCALE_IDENTITY} when there is too little to measure
 * ({@link UNIT_SCALE_MIN_SAMPLES}), and exactly 1 for a capture already in
 * standing-height units — so opting in cannot perturb a well-scaled caller.
 */
export function measureUnitScale(frames: readonly DecodedFrame[]): number {
  const ratios: number[] = [];
  for (const frame of frames) {
    for (const bone of LIMB_BONE_PRIORS) {
      const a = frame[bone.a];
      const b = frame[bone.b];
      if (!a || !b) continue;
      ratios.push(Math.hypot(a.x - b.x, a.y - b.y) / bone.len);
    }
  }
  if (ratios.length < UNIT_SCALE_MIN_SAMPLES) return UNIT_SCALE_IDENTITY;
  ratios.sort((x, y) => x - y);
  const idx = Math.floor(UNIT_SCALE_QUANTILE * (ratios.length - 1));
  return clampUnitScale(ratios[idx]!);
}

/** Smallest number of limb bones a PER-FRAME scale may be measured from. */
export const UNIT_SCALE_MIN_FRAME_BONES = 3;

/**
 * `unitScale` for ONE frame: the largest measured/prior 2D length over that
 * frame's limb bones.
 *
 * WHY PER FRAME AND NOT ONCE PER REP: formSequence divides EVERY frame by
 * THAT frame's own nose→ankle span, so the units move frame to frame — the
 * span is ~0.90 of standing height upright and shorter in the dip, a ~6% swing
 * inside one rep. One sequence-wide scale is therefore right for at most one
 * frame and wrong for the rest, and it is wrong in the dangerous direction:
 * read against a scale measured off the dip, an upright frame's IN-PLANE bones
 * measure ~0.94 of their prior, which solves to dz = 0.33 × the bone — a third
 * of a bone of depth that is not there. On a straight leg at the release that
 * is a 36° phantom bend (measured; see formCheck3d.test.ts).
 *
 * Per frame the estimator's guarantee holds again: a projection is never
 * longer than the bone, so every sample is a LOWER bound on THIS frame's
 * scale and the largest is the tightest bound the frame supports. Undershoot
 * keeps priors short, which keeps dz small or clamps it — depth is lost, never
 * invented. What residual is left, {@link MIN_RESOLVABLE_DZ_RATIO} absorbs up
 * to 4.6% of scale (a bone 0.3 L out of plane projects to 0.954 of its
 * length): that floor IS the estimator's error budget.
 *
 * The bound is against WINTER proportions, not against this shooter: a body
 * whose limbs run long for its height reads as a smaller scale. That error is
 * the same size as the anthropometric spread and it is why nothing downstream
 * quotes depth to better than a few degrees.
 *
 * Null when the frame shows fewer than {@link UNIT_SCALE_MIN_FRAME_BONES} limb
 * bones — too little to place an envelope on.
 */
export function measureFrameUnitScale(frame: DecodedFrame): number | null {
  let best: number | null = null;
  let samples = 0;
  for (const bone of LIMB_BONE_PRIORS) {
    const a = frame[bone.a];
    const b = frame[bone.b];
    if (!a || !b) continue;
    samples++;
    const ratio = Math.hypot(a.x - b.x, a.y - b.y) / bone.len;
    if (best == null || ratio > best) best = ratio;
  }
  if (best == null || samples < UNIT_SCALE_MIN_FRAME_BONES) return null;
  return clampUnitScale(best);
}

/**
 * Per-frame `unitScale` for a whole sequence — one entry per input frame, in
 * order, ready to hand to {@link liftSequence}.
 *
 * A frame too thin to measure borrows its nearest measured neighbour's scale
 * (earlier one first, so the result is deterministic) instead of the identity:
 * the scale tracks the shooter's span, which moves smoothly across 40 ms,
 * whereas the identity would flatten that frame's limbs AND tell the torso yaw
 * it was square-on at full confidence. When NO frame can be measured every
 * entry is {@link UNIT_SCALE_IDENTITY} — priors as-is, the pre-parameter
 * behaviour, depth lost rather than guessed.
 */
export function measureUnitScales(frames: readonly DecodedFrame[]): number[] {
  const raw = frames.map((f) => measureFrameUnitScale(f));
  return raw.map((v, i) => {
    if (v != null) return v;
    for (let d = 1; d < raw.length; d++) {
      const near = raw[i - d] ?? raw[i + d] ?? null;
      if (near != null) return near;
    }
    return UNIT_SCALE_IDENTITY;
  });
}

/** Every prior this lift uses, in the units one sequence actually arrived in. */
interface ScaledPriors {
  unitScale: number;
  shoulderHalf: number;
  hipHalf: number;
  neck: number;
  upperArm: number;
  forearm: number;
  thigh: number;
  shank: number;
}

/** Multiply the priors through by `unitScale` (×1 is exact — hence identical). */
function scalePriors(unitScale: number): ScaledPriors {
  const u = clampUnitScale(unitScale);
  return {
    unitScale: u,
    shoulderHalf: SHOULDER_HALF_LEN * u,
    hipHalf: HIP_HALF_LEN * u,
    neck: NECK_LEN * u,
    upperArm: UPPER_ARM_LEN * u,
    forearm: FOREARM_LEN * u,
    thigh: THIGH_LEN * u,
    shank: SHANK_LEN * u,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** A frame is liftable only when both hips AND both shoulders were detected. */
function isUsable(frame: DecodedFrame): boolean {
  return Boolean(
    frame.left_hip && frame.right_hip && frame.left_shoulder && frame.right_shoulder,
  );
}

/** Apparent shoulder half-width of a usable frame (body heights). */
function apparentShoulderHalf(frame: DecodedFrame): number {
  return Math.abs(frame.left_shoulder!.x - frame.right_shoulder!.x) / 2;
}

/**
 * Azimuth sign convention: positive θ puts the RIGHT shoulder toward the
 * camera (right_shoulder.z = sin(θ)·SHOULDER_HALF_LEN > 0).
 */
function handInitSign(hand: ShootingHand): 1 | -1 {
  return hand === 'right' ? 1 : -1;
}

/**
 * Resolve the azimuth sign for one frame. First usable frame (no previous
 * shoulders): the shooting-hand shoulder faces the camera. Later frames: the
 * sign minimizing Σ|z_shoulder − z_shoulder_prev|; the rigid symmetric
 * placement makes left z = −right z, so comparing the right shoulder alone
 * decides both. Ties (previous frame dead square-on) fall back to the hand
 * initialization — deterministic by construction.
 */
function resolveAzimuthSign(
  hand: ShootingHand,
  prev: Frame3D | null,
  thetaMag: number,
  shoulderHalf: number,
): 1 | -1 {
  const init = handInitSign(hand);
  const prevRight = prev?.right_shoulder;
  if (!prevRight || thetaMag === 0) return init;
  const zPlus = Math.sin(thetaMag) * shoulderHalf;
  const costPlus = Math.abs(zPlus - prevRight.z);
  const costMinus = Math.abs(-zPlus - prevRight.z);
  if (costPlus < costMinus) return 1;
  if (costMinus < costPlus) return -1;
  return init;
}

interface BoneSolve {
  z: number;
  c: number;
  /** Sign actually used — chained children inherit it on their first frame. */
  sign: 1 | -1;
}

/** The previous frame's solve for the SAME bone: both ends' depth. */
interface PrevBone {
  /** Child z last frame. */
  z: number;
  /** Parent z last frame — so this frame can tell dz = 0 from dz ≠ 0. */
  parentZ: number;
}

/**
 * Generic single-bone depth rule. Given the lifted parent (z, c), the 2D
 * offset parent→child and the bone's prior length, returns the child z and
 * confidence. Confidence starts at 1 and only ever decreases:
 * - 2D bone longer than the prior → depth unrecoverable, dz clamped to 0 and
 *   c ×= prior/len2D (the violation itself is the honesty signal);
 * - foreshortening → c ×= 1 − FORESHORTEN_PENALTY·(dz/L)² (a bone pointing at
 *   the camera has maximal sign ambiguity);
 * - c = min(c, parent.c) — a child is never more certain than its anchor.
 * Sign: previous-frame continuity when the previous frame ACTUALLY RESOLVED a
 * depth for this bone, else `fallbackSign`.
 */
function solveBone(
  parentZ: number,
  parentC: number,
  dx: number,
  dy: number,
  prior: number,
  prev: PrevBone | null,
  fallbackSign: 1 | -1,
): BoneSolve {
  const len2D = Math.hypot(dx, dy);
  let dz = 0;
  let c = 1;
  if (len2D > prior) {
    c *= prior / len2D;
  } else {
    dz = Math.sqrt(prior * prior - len2D * len2D);
  }
  const ratio = dz / prior;
  c *= 1 - FORESHORTEN_PENALTY * ratio * ratio;
  // Depth under the resolution of a length prior is reported as none at all —
  // see MIN_RESOLVABLE_DZ_RATIO. The penalty above is read off the MEASURED
  // ratio, before the snap, so the snap hides nothing.
  if (ratio < MIN_RESOLVABLE_DZ_RATIO) dz = 0;
  let sign: 1 | -1 = fallbackSign;
  // A bone the floor placed IN the plane last frame has dz exactly 0, so its z
  // carries no sign — it is the parent's z, not evidence. Locking onto it
  // hands the sign to whichever way the parent happened to drift, and the lock
  // then keeps it: measured square-on, a forearm that spent seven frames
  // pinned flat came out of the floor with the right magnitude and the WRONG
  // sign, and the follow-through elbow read 121° against a true 165°. Only a
  // frame that resolved a depth gets to vote.
  const prevResolved = prev != null && prev.z !== prev.parentZ;
  if (prevResolved && dz > 0) {
    // Continuity on absolute z (not the raw dz sign): candidate z is
    // parentZ ± dz; pick whichever lands closest to last frame's z.
    sign = Math.abs(parentZ + dz - prev.z) <= Math.abs(parentZ - dz - prev.z) ? 1 : -1;
  }
  return { z: parentZ + sign * dz, c: Math.min(c, parentC), sign };
}

/**
 * Lift one two-bone chain (shoulder→elbow→wrist or hip→knee→ankle).
 *
 * The mid joint's first-frame sign is + (toward the torso front: the front
 * z-component is +cosθ ≥ 0 — elbows and knees flex toward the camera when the
 * shooter faces it). The END joint's is `endSignVsMid` × the mid bone's chosen
 * sign, and THE TWO CHAINS WANT OPPOSITE ANSWERS — a projection cannot tell
 * them apart, so the anatomy of a jump shot has to:
 * - ARM (+1, {@link ARM_END_SIGN}): the shooting arm stays on ONE side of the
 *   torso plane from dip to follow-through — the ball is in front of the chest
 *   and then pushed further out — so the forearm continues the upper arm's
 *   depth direction.
 * - LEG (−1, {@link LEG_END_SIGN}): the foot is planted under the hip while
 *   the knee travels forward over the toes, so the shank comes BACK toward the
 *   torso plane. Continuing the thigh's sign puts the ankle most of a shank in
 *   front of the hip, which is how a loaded leg reads as straight: measured
 *   square-on, that mistake read a true 135° knee as 180°.
 *
 * A chain broken by a missing mid keypoint leaves the end joint absent too —
 * there is no anchor to lift it from honestly.
 */
function liftChain(
  frame: DecodedFrame,
  out: Frame3D,
  prev: Frame3D | null,
  root: PoseKeypointName,
  mid: PoseKeypointName,
  end: PoseKeypointName,
  midPrior: number,
  endPrior: number,
  endSignVsMid: 1 | -1,
): void {
  const rootJ = out[root];
  const mid2D = frame[mid];
  if (!rootJ || !mid2D) return;
  const prevRoot = prev?.[root];
  const prevMid = prev?.[mid];
  const midSolve = solveBone(
    rootJ.z,
    rootJ.c,
    mid2D.x - rootJ.x,
    mid2D.y - rootJ.y,
    midPrior,
    prevMid && prevRoot ? { z: prevMid.z, parentZ: prevRoot.z } : null,
    1,
  );
  out[mid] = { x: mid2D.x, y: mid2D.y, z: midSolve.z, c: midSolve.c };
  const end2D = frame[end];
  if (!end2D) return;
  const prevEnd = prev?.[end];
  const endSolve = solveBone(
    midSolve.z,
    midSolve.c,
    end2D.x - mid2D.x,
    end2D.y - mid2D.y,
    endPrior,
    prevEnd && prevMid ? { z: prevEnd.z, parentZ: prevMid.z } : null,
    (midSolve.sign * endSignVsMid) as 1 | -1,
  );
  out[end] = { x: end2D.x, y: end2D.y, z: endSolve.z, c: endSolve.c };
}

/**
 * 3-tap [1, 2, 1]/4 moving average on z per joint across frames, in place.
 * Neighbors outside the sequence or missing the joint are dropped and the
 * kernel renormalized. x/y are measured and never modified; confidence is
 * untouched. Reads a pre-smoothing snapshot per joint so the filter is a true
 * (non-recursive) moving average.
 */
function smoothZ(frames: Frame3D[]): void {
  for (const name of LIFT_JOINTS) {
    const col: (number | null)[] = frames.map((f) => f[name]?.z ?? null);
    for (let i = 0; i < frames.length; i++) {
      const joint = frames[i]![name];
      if (!joint) continue;
      let acc = 2 * col[i]!;
      let w = 2;
      const before = i > 0 ? col[i - 1]! : null;
      if (before != null) {
        acc += before;
        w += 1;
      }
      const after = i < frames.length - 1 ? col[i + 1]! : null;
      if (after != null) {
        acc += after;
        w += 1;
      }
      joint.z = acc / w;
    }
  }
}

// ---------------------------------------------------------------------------
// Public lift
// ---------------------------------------------------------------------------

/**
 * Lift a single frame given the torso azimuth for that frame.
 *
 * `azimuthRad` is the torso azimuth MAGNITUDE in radians (a signed value is
 * accepted — |azimuthRad| is used); the sign is always re-resolved here from
 * `hand` (first frame: shooting-hand shoulder toward the camera) and `prev`
 * (temporal continuity), so a caller can never flip the torso against the
 * sequence convention. `prev` is the previous SOLVED frame (pre-smoothing) or
 * null on the first frame.
 *
 * `unitScale` is normalized units per standing body height — every prior is
 * multiplied by it before use. Default 1 = the frames are already in
 * standing-height units (the pre-parameter behaviour, bit-for-bit).
 *
 * Returns `{}` when the frame is not liftable (needs both hips AND both
 * shoulders). The result is un-smoothed; {@link liftSequence} applies the
 * temporal z filter across frames.
 */
export function liftFrame(
  frame: DecodedFrame,
  hand: ShootingHand,
  prev: Frame3D | null,
  azimuthRad: number,
  unitScale: number = UNIT_SCALE_IDENTITY,
): Frame3D {
  if (!isUsable(frame)) return {};
  const p = scalePriors(unitScale);
  const ls = frame.left_shoulder!;
  const rs = frame.right_shoulder!;
  const lh = frame.left_hip!;
  const rh = frame.right_hip!;
  const thetaMag = Math.abs(azimuthRad);
  const theta = resolveAzimuthSign(hand, prev, thetaMag, p.shoulderHalf) * thetaMag;
  const sinT = Math.sin(theta);
  // Yaw is best-determined near profile (wide sin sensitivity) and most
  // ambiguous square-on; floor at 0.5 rather than pretending certainty.
  const torsoC = Math.min(1, 0.5 + (0.5 * apparentShoulderHalf(frame)) / p.shoulderHalf);
  const out: Frame3D = {
    left_shoulder: { x: ls.x, y: ls.y, z: -sinT * p.shoulderHalf, c: torsoC },
    right_shoulder: { x: rs.x, y: rs.y, z: sinT * p.shoulderHalf, c: torsoC },
    left_hip: { x: lh.x, y: lh.y, z: -sinT * p.hipHalf, c: torsoC },
    right_hip: { x: rh.x, y: rh.y, z: sinT * p.hipHalf, c: torsoC },
  };
  // Nose chains from the shoulder-center pivot (z = 0 plane). First-frame
  // sign +: the head sits toward the torso front.
  const nose = frame.nose;
  if (nose) {
    const prevNose = prev?.nose;
    const solve = solveBone(
      0,
      torsoC,
      nose.x - (ls.x + rs.x) / 2,
      nose.y - (ls.y + rs.y) / 2,
      p.neck,
      // The neck hangs off the shoulder-centre pivot, which the lift holds at
      // z = 0 in every frame — so that pivot IS the previous parent z.
      prevNose ? { z: prevNose.z, parentZ: 0 } : null,
      1,
    );
    out.nose = { x: nose.x, y: nose.y, z: solve.z, c: solve.c };
  }
  const arm = ARM_END_SIGN;
  const leg = LEG_END_SIGN;
  liftChain(frame, out, prev, 'left_shoulder', 'left_elbow', 'left_wrist', p.upperArm, p.forearm, arm);
  liftChain(frame, out, prev, 'right_shoulder', 'right_elbow', 'right_wrist', p.upperArm, p.forearm, arm);
  liftChain(frame, out, prev, 'left_hip', 'left_knee', 'left_ankle', p.thigh, p.shank, leg);
  liftChain(frame, out, prev, 'right_hip', 'right_knee', 'right_ankle', p.thigh, p.shank, leg);
  return out;
}

/**
 * Lift a whole decoded sequence. Returns null when fewer than 2 frames have
 * both hips and both shoulders — one anchor frame is not a motion. Output
 * `frames` has the SAME length as the input; unliftable frames are `{}` so
 * frame indices (scrubber positions, release markers) stay aligned.
 *
 * Per frame: torso azimuth magnitude from the apparent shoulder width
 * (cosθ = clamp(halfWidth / (SHOULDER_HALF_LEN · unitScale), 0, 1)), sign from
 * the hand initialization + temporal continuity, then {@link liftFrame}. After
 * all frames are solved, z gets the [1,2,1]/4 temporal filter. `azimuthDeg` is
 * the mean signed per-frame azimuth; `confidence` the mean joint confidence.
 *
 * `unitScale` (normalized units per standing body height) rescales every
 * prior, INCLUDING the shoulder half-width the yaw is read against — so a
 * caller whose frames are 1.1 × too big gets both real limb depth and a real
 * yaw instead of flat limbs and a square-on torso. Pass ONE number for one
 * scale over the whole sequence, or an ARRAY of one scale per frame when the
 * encoder's units move frame to frame — which is exactly what formSequence's
 * per-frame normalization does, so {@link measureUnitScales} is what a Form
 * Check rep should hand in. Default 1 keeps the pre-parameter output
 * bit-for-bit.
 */
export function liftSequence(
  frames: readonly DecodedFrame[],
  hand: ShootingHand,
  unitScale: number | readonly number[] = UNIT_SCALE_IDENTITY,
): LiftedSequence | null {
  let usable = 0;
  for (const f of frames) if (isUsable(f)) usable++;
  if (usable < 2) return null;

  // One scale or one per frame; a short/ragged array falls back to identity
  // for the frames it does not cover rather than borrowing another frame's.
  const uniform = typeof unitScale === 'number' ? clampUnitScale(unitScale) : null;
  const unitScales = frames.map((_, i) =>
    uniform ?? clampUnitScale((unitScale as readonly number[])[i]),
  );
  const out: Frame3D[] = [];
  let prev: Frame3D | null = null;
  let thetaSumRad = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (!isUsable(f)) {
      out.push({});
      continue; // prev stays: continuity bridges detection dropouts
    }
    const p = scalePriors(unitScales[i]!);
    const cosT = clamp(apparentShoulderHalf(f) / p.shoulderHalf, 0, 1);
    const thetaMag = Math.acos(cosT);
    // Same deterministic resolution liftFrame performs — keeps the reported
    // azimuth and the placed geometry in lockstep.
    thetaSumRad += resolveAzimuthSign(hand, prev, thetaMag, p.shoulderHalf) * thetaMag;
    const lifted = liftFrame(f, hand, prev, thetaMag, p.unitScale);
    out.push(lifted);
    prev = lifted;
  }

  smoothZ(out);

  let cSum = 0;
  let cCount = 0;
  for (const f of out) {
    for (const name of LIFT_JOINTS) {
      const joint = f[name];
      if (joint) {
        cSum += joint.c;
        cCount++;
      }
    }
  }
  const result: LiftedSequence = {
    frames: out,
    confidence: cCount > 0 ? cSum / cCount : 0,
    azimuthDeg: (thetaSumRad / usable) * (180 / Math.PI),
    unitScales,
  };
  // Only a sequence solved at ONE scale gets to report one.
  if (uniform != null) result.unitScale = uniform;
  return result;
}
