/**
 * Form Check → 3D adapter: one rep in, a lifted shooting posture + an honest
 * 3D-vs-2D judgment out.
 *
 * Form Check already persists a packed {@link FormSequence} per rep and the
 * 2D→3D lift already exists; the two were simply never wired together. This
 * file is the wire, and NOTHING else: it decodes the rep's sequence with
 * {@link decodeSequence}, hands the frames to {@link liftSequence}, locates
 * the rep's own phases on the lifted timeline, and reads the shot angles with
 * {@link jointAngleDeg}. No new 3D math lives here.
 *
 * MEASURED SCALE MISMATCH (read this before trusting any z):
 * formSequence normalizes each frame by that frame's nose→ankle VERTICAL
 * SPAN, while lift.ts's Winter priors are fractions of STANDING body height.
 * The span is ~0.90 of standing height upright and shrinks further in the dip,
 * so a real capture's limb bones measure ~1.11–1.13 × their prior. The lift
 * reads that as "2D bone longer than the prior", clamps dz to 0, and the limbs
 * come out FLAT — the torso still gets real depth (that comes from the yaw,
 * not from a bone solve), the limbs do not. Origin, units and axis convention
 * all line up; only the scale does not.
 *
 * FIXED WHERE IT BELONGS (in the lift, not here): lift.ts takes a `unitScale`
 * — normalized units per standing body height — and multiplies every prior by
 * it, so the priors are read in the units the frames actually arrived in. This
 * adapter measures that scale off the rep's own bones and hands it to {@link
 * liftSequence}.
 *
 * ONE SCALE PER FRAME, NOT ONE PER REP ({@link measureUnitScales}). The span
 * the encoder divides by is the shooter's own nose→ankle span in THAT frame,
 * and it shortens ~6% into the dip, so a single scale for the rep is right for
 * at most one frame of it — and wrong in the direction that FABRICATES depth,
 * because an over-long prior turns an in-plane bone into a bent one. Measured
 * on the profile fixture: at a strict 90° profile, where every joint's true z
 * is zero, the rep-wide scale bent a straight leg 36° at the release and
 * over-read a 75° torso turn as 75.55°. Per frame both go to zero error.
 *
 * Nothing is rescaled behind the reader's back: the scale each frame was
 * solved at rides on `lifted.unitScales`, every ratio this file quotes is
 * quoted against the priors AS THE LIFT READ THEM ON THAT FRAME, and {@link
 * DepthScaleCheck} measures the residual — so a rep whose scale could not be
 * recovered at all still collapses to `depthCollapsed` and still vetoes the 3D
 * claim. formSequence's normalization is NOT touched: exact-score pins in
 * formSimilarity and postureFix depend on it.
 *
 * HONESTY CONTRACT (inherited, enforced in the data):
 * - x/y are MEASURED, z is an ESTIMATE — see {@link DEPTH_DISCLAIMER}.
 * - a keypoint missing in 2D is ABSENT in 3D; nothing is fabricated.
 * - every reading carries the depth confidence of its weakest joint, and a
 *   reading under {@link MIN_DEPTH_C} is WITHHELD, not dimmed.
 * - a 3D angle is only called an upgrade when the depth it rests on was
 *   actually recovered AND it moves the number. Otherwise the verdict says
 *   2D is the one to trust.
 * - a reading that spans a bone the lift PLACED in the image plane instead of
 *   solving says so ({@link Judged3DAngle.restsOnUnresolvedBone}): part of it
 *   is an assumption, and no confidence number shows that — the depth was
 *   placed by policy, not solved badly.
 * - deterministic: same rep → deep-equal result.
 *
 * Pure TypeScript: no I/O, no wall clock, no randomness.
 */
import type { FormCheckRep } from './formCheck';
import { decodeSequence } from './formSequence';
import type { DecodedFrame } from './formSequence';
import { angleAtDeg } from './geometry';
import { jointAngleDeg, releaseFrameIndex } from './pose3d/angles3d';
import {
  BONE_PRIORS,
  MIN_RESOLVABLE_DZ_RATIO,
  liftSequence,
  measureUnitScales,
} from './pose3d/lift';
import type { Frame3D, Joint3D, LiftedSequence } from './pose3d/lift';
import type { FormSequence, PoseKeypointName, ShootingHand } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mandatory caption wherever a 3D number or skeleton is shown. */
export const DEPTH_DISCLAIMER = 'x/y measured · z estimated from bone-length priors';

/**
 * Fewer decoded frames than this is a pose, not a motion — no partial lift.
 * Matches buildSequence's own "at least 4 usable frames" floor.
 */
export const MIN_LIFT_FRAMES = 4;

/**
 * Depth-confidence floor for reporting a 3D angle at all. MEASURED, not
 * picked: the lift floors torso confidence at 0.5 for a dead-on side profile
 * — the exact view Form Check asks for — so a gate at 0.5 would refuse every
 * good capture. 0.45 sits just under that floor and still catches the
 * foreshortening penalty (a bone pointing at the lens bottoms out at 0.4).
 */
export const MIN_DEPTH_C = 0.45;

/** Below this the 3D and 2D readings are the same number, not an upgrade. */
export const AGREE_TOL_DEG = 5;

/**
 * Torso yaw under this many degrees is a direction, not a measurement.
 * cos θ = width ÷ prior width, so dθ = Δratio ÷ sin θ: the 8% or so of spread
 * between one shooter's shoulders and Winter's average is ~1° at a profile and
 * ~25° at 20°, where it can flatten the reading to 0 outright. The number is
 * still reported — it is the only source there is — but the note stops quoting
 * it as degrees.
 */
export const YAW_TRUSTWORTHY_DEG = 25;

/**
 * Depth spread (body heights) under which three joints are FLAT in z: the 3D
 * angle is then arithmetically the 2D one. 1e-4 body heights is ~0.2 mm on a
 * 1.8 m shooter — numerically nothing.
 */
export const DEPTH_FLAT_EPS = 1e-4;

/**
 * A bone must measure at most this fraction of its prior before its depth is
 * resolvable at all — the length-space twin of lift.ts's
 * {@link MIN_RESOLVABLE_DZ_RATIO} (a bone 0.3 L out of plane projects to
 * sqrt(1 − 0.3²) = 0.954 of its length). Above it, "flat" is the measurement.
 */
export const RESOLVABLE_LEN_RATIO = Math.sqrt(
  1 - MIN_RESOLVABLE_DZ_RATIO * MIN_RESOLVABLE_DZ_RATIO,
);

/**
 * Limb bones only — the ones whose depth the lift solves from a prior. The
 * shoulder/hip WIDTH pairs are excluded: their 2D length shortens with torso
 * yaw by design, so they say nothing about normalization scale.
 */
const SCALE_BONES = BONE_PRIORS.filter(
  (b) => !(b.a === 'left_shoulder' && b.b === 'right_shoulder') && !(b.a === 'left_hip' && b.b === 'right_hip'),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Phases the rep report cares about, in shot order. */
export type PhaseId = 'dip' | 'setPoint' | 'release' | 'followThrough';

/** Where the release frame index came from. */
export type ReleaseAnchor =
  /** The sequence's own pose-gated release marker. */
  | 'sequenceMarker'
  /** Shooting wrist apex in the MEASURED 2D frames (angles3d). */
  | 'wristApex2d'
  /** Neither was available — every phase index is null. */
  | 'none';

/**
 * Frame indices into the lifted sequence, so the 3D scrubber can jump to a
 * phase. Each is null when the rep did not measure the segment it hangs off;
 * an index is never clamped into range to keep a marker alive.
 */
export interface Phase3DIndices {
  dip: number | null;
  setPoint: number | null;
  release: number | null;
  followThrough: number | null;
  releaseAnchor: ReleaseAnchor;
}

export type Angle3DId = 'elbow' | 'knee' | 'shoulder' | 'torsoYaw';

/** Is the 3D number worth more than the 2D one Form Check already reports? */
export type Angle3DVerdict =
  /** Depth was recovered and it moves the number: 3D corrects a foreshortened 2D. */
  | 'prefer3d'
  /** Depth was recovered and confirms 2D. Same number, more evidence. */
  | 'parity'
  /** 3D adds nothing here — 2D stays the reported number. */
  | 'prefer2d'
  /** 2D cannot report this at all; 3D is the only source. */
  | 'only3d'
  /** Not reported: too little depth confidence, or a joint is missing. */
  | 'withheld';

export type Angle3DReason =
  | 'foreshortened2d'
  | 'agrees2d'
  | 'depthCollapsed'
  | 'lowDepthConfidence'
  | 'missingJoint'
  | 'no2dEquivalent'
  | 'noPhaseFrame';

/** One judged joint angle. `deg` is null whenever the verdict is 'withheld'. */
export interface Judged3DAngle {
  id: Angle3DId;
  /** Phase the reading was taken at; null for whole-sequence readings. */
  phase: PhaseId | null;
  /** Frame it was taken at; null for whole-sequence readings. */
  frame: number | null;
  /** 3D degrees. Null when withheld or unmeasurable. */
  deg: number | null;
  /**
   * The SAME angle on the same frame's measured x/y (angleAtDeg — the exact
   * helper Form Check's own metrics use). Normalization is a translate +
   * uniform scale, so this is directly comparable to the rep's degrees. This,
   * not {@link repDeg2d}, is what the verdict is decided against: same joints,
   * same frame.
   */
  deg2d: number | null;
  /**
   * The number Form Check already reports for this angle, when it has one and
   * the reading was taken at the phase that number describes. Form Check reads
   * it off its OneEuro-filtered series, so expect a degree or two of daylight
   * from {@link deg2d} even on the same frame.
   */
  repDeg2d: number | null;
  /** Depth confidence of the weakest contributing joint, 0..1. */
  c: number | null;
  /**
   * BEST (smallest) measured/prior 2D length ratio across the bones this angle
   * rests on, at that frame — the bone with the most depth left to recover.
   * With the scale measured off the frame's own bones this cannot exceed 1:
   * the frame's scale IS the largest ratio in it (see measureFrameUnitScale).
   * It only reaches 1 when this angle's bone is the one that set the scale.
   */
  boneRatio: number | null;
  /**
   * WORST (largest) of the same ratios. At or above
   * {@link RESOLVABLE_LEN_RATIO} at least one bone under this angle was placed
   * IN the image plane rather than measured out of it, and the reading carries
   * that assumption — see {@link restsOnUnresolvedBone}.
   */
  worstBoneRatio: number | null;
  /**
   * True when a bone this angle rests on had its depth placed by the
   * resolution floor instead of solved. The reading is then part measurement,
   * part assumption. NOT an error bar: the unseen offset is bounded by
   * dz ≤ L·sqrt(1 − ratio²) only if the frame's scale is right, and square to
   * the camera — where nothing in frame lies in the image plane to measure the
   * scale off — it need not be. Measured on the test fixture, such a bound
   * covered the true angle in 230 of 504 readings, so this stays a disclosure
   * and never becomes a number.
   */
  restsOnUnresolvedBone: boolean;
  verdict: Angle3DVerdict;
  reason: Angle3DReason;
  /** One short honest sentence, ready to render. */
  note: string;
}

/**
 * How far this capture's 2D bones run over their anthropometric priors. A 2D
 * projection can only be SHORTER than the true bone, so any ratio above 1 is a
 * lower bound on how much the normalizer over-scaled the shooter.
 */
export interface DepthScaleCheck {
  /** Bone samples measured (limb bones × frames where both ends exist). */
  bonesMeasured: number;
  /** How many of those measured at or over their prior. */
  bonesOverPrior: number;
  /** Largest ratio seen — the lower bound on the scale inflation. */
  maxRatio: number | null;
  medianRatio: number | null;
  /** Most bones over prior: no limb depth was recoverable in this rep. */
  collapsed: boolean;
}

/**
 * A rep's 3D posture plus the judgment built on it. Any surface that renders
 * the skeleton or a `deg` from here carries {@link DEPTH_DISCLAIMER}.
 */
export interface FormCheck3D {
  hand: ShootingHand;
  /** The MEASURED 2D frames the lift consumed (hip-centre, body-height units). */
  frames2d: DecodedFrame[];
  /** Feed straight to FormStage3D as `user`. */
  lifted: LiftedSequence;
  phases: Phase3DIndices;
  angles: readonly Judged3DAngle[];
  scale: DepthScaleCheck;
}

// ---------------------------------------------------------------------------
// Phase indices
// ---------------------------------------------------------------------------

/** Shooting-side joint names. */
function sideNames(hand: ShootingHand) {
  const s = hand === 'right' ? 'right' : 'left';
  return {
    shoulder: `${s}_shoulder` as PoseKeypointName,
    elbow: `${s}_elbow` as PoseKeypointName,
    wrist: `${s}_wrist` as PoseKeypointName,
    hip: `${s}_hip` as PoseKeypointName,
    knee: `${s}_knee` as PoseKeypointName,
    ankle: `${s}_ankle` as PoseKeypointName,
  };
}

/**
 * Locate dip / set point / release / follow-through on the sequence timeline.
 *
 * The release frame is an ANCHOR the sequence already carries (the pose-gated
 * marker buildSequence matched within 0.2 s), falling back to the 2D wrist
 * apex only when the marker is absent AND the wrist was actually seen. The
 * other three are the rep's OWN phase durations walked out from that anchor —
 * nothing new is sensed:
 *   dip           = release − (riseMs + releaseMs)
 *   set point     = release − releaseMs   (wrist crossing above the shoulder)
 *   follow-through= release + followMs
 * The walk assumes the output frames are evenly spaced in time, which is how
 * buildSequence samples them; a frame-rate hiccup can shift a marker by a
 * frame. A marker that lands outside the sequence is dropped, not clamped.
 */
export function phaseIndices(
  rep: FormCheckRep,
  seq: FormSequence,
  frames2d: readonly DecodedFrame[],
  hand: ShootingHand,
): Phase3DIndices {
  const n = frames2d.length;
  const marker = seq.releaseFrame;
  let release: number | null = null;
  let releaseAnchor: ReleaseAnchor = 'none';
  if (marker != null && Number.isInteger(marker) && marker >= 0 && marker < n) {
    release = marker;
    releaseAnchor = 'sequenceMarker';
  } else {
    const wrist = sideNames(hand).wrist;
    const seen = frames2d.some((f) => f[wrist] != null);
    if (seen) {
      release = Math.max(0, Math.min(releaseFrameIndex(frames2d, hand), n - 1));
      releaseAnchor = 'wristApex2d';
    }
  }

  // Seconds per output frame. Without it only the anchor is knowable.
  const secPerFrame = n > 1 && seq.durationSec > 0 ? seq.durationSec / (n - 1) : null;
  const at = (offsetMs: number | null): number | null => {
    if (release == null || secPerFrame == null) return null;
    if (offsetMs == null || !Number.isFinite(offsetMs)) return null;
    const idx = Math.round(release + offsetMs / 1000 / secPerFrame);
    return idx >= 0 && idx < n ? idx : null;
  };

  const { riseMs, releaseMs, followMs } = rep.phases;
  const toDip = riseMs != null && releaseMs != null ? -(riseMs + releaseMs) : null;
  return {
    dip: at(toDip),
    setPoint: at(releaseMs != null ? -releaseMs : null),
    release,
    followThrough: at(followMs),
    releaseAnchor,
  };
}

// ---------------------------------------------------------------------------
// Depth-scale check
// ---------------------------------------------------------------------------

/**
 * The scale frame `i` was actually solved at. Per-frame first: a rep whose
 * units move between frames has no single scale to quote, and quoting the
 * wrong one is how a ratio starts meaning something else.
 */
export function scaleAt(lifted: LiftedSequence, i: number): number {
  return lifted.unitScales?.[i] ?? lifted.unitScale ?? 1;
}

/** 2D length of a bone in a frame, or null when an end is missing. */
function bone2D(frame: DecodedFrame, a: PoseKeypointName, b: PoseKeypointName): number | null {
  const pa = frame[a];
  const pb = frame[b];
  if (!pa || !pb) return null;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

/**
 * Measure how far this rep's limb bones run over their priors.
 *
 * `unitScale` is the scale the lift READ those priors in — ONE number, or one
 * per frame, matching what was handed to the lift. The default 1 measures
 * against the raw standing-height priors, which is the mismatch measurement
 * itself. Passing the applied scales — what {@link liftRep} does — turns this
 * into the residual check: whatever still runs over its prior AFTER the units
 * were reconciled is depth the lift genuinely could not recover, and with a
 * per-frame scale that means the scale itself could not be measured (a frame's
 * scale is the largest ratio in it, so nothing in a measured frame can exceed
 * it).
 */
export function depthScaleCheck(
  frames2d: readonly DecodedFrame[],
  unitScale: number | readonly number[] = 1,
): DepthScaleCheck {
  const ratios: number[] = [];
  let over = 0;
  const scaleOf = (i: number): number =>
    typeof unitScale === 'number' ? unitScale : (unitScale[i] ?? 1);
  for (let i = 0; i < frames2d.length; i++) {
    const frame = frames2d[i]!;
    for (const bp of SCALE_BONES) {
      const len = bone2D(frame, bp.a, bp.b);
      if (len == null) continue;
      const ratio = len / (bp.len * scaleOf(i));
      ratios.push(ratio);
      if (ratio >= 1) over++;
    }
  }
  if (ratios.length === 0) {
    return { bonesMeasured: 0, bonesOverPrior: 0, maxRatio: null, medianRatio: null, collapsed: false };
  }
  const sorted = [...ratios].sort((x, y) => x - y);
  return {
    bonesMeasured: ratios.length,
    bonesOverPrior: over,
    maxRatio: sorted[sorted.length - 1]!,
    medianRatio: sorted[Math.floor(sorted.length / 2)]!,
    collapsed: over / ratios.length >= 0.5,
  };
}

// ---------------------------------------------------------------------------
// Angle judgment
// ---------------------------------------------------------------------------

interface AngleSpec {
  id: Angle3DId;
  /** Phase the reading belongs at, then the fallback chain. */
  phase: PhaseId;
  fallback: PhaseId | null;
  /** a–b–c with the angle taken at b. */
  joints: [PoseKeypointName, PoseKeypointName, PoseKeypointName];
  /** Bones whose prior the depth of this angle rests on. */
  bones: [PoseKeypointName, PoseKeypointName][];
  /** Form Check's own 2D number for this angle — only valid at `phase`. */
  repDeg2d: number | null;
  label: string;
}

/**
 * Measured/prior 2D length ratios for an angle's bones at one frame: the BEST
 * (smallest — most depth left to recover) and the WORST (largest — closest to
 * lying in the image plane). Both null if a bone end is missing.
 */
function boneRatios(
  frame: DecodedFrame,
  bones: readonly [PoseKeypointName, PoseKeypointName][],
  unitScale = 1,
): { best: number | null; worst: number | null } {
  let best: number | null = null;
  let worst: number | null = null;
  for (const [a, b] of bones) {
    const prior = BONE_PRIORS.find((p) => p.a === a && p.b === b)?.len;
    const len = bone2D(frame, a, b);
    if (prior == null || len == null) return { best: null, worst: null };
    const ratio = len / (prior * unitScale);
    if (best == null || ratio < best) best = ratio;
    if (worst == null || ratio > worst) worst = ratio;
  }
  return { best, worst };
}

/**
 * The sentence a reading owes the reader when a bone under it was PLACED in
 * the image plane rather than measured out of it (ratio at or over
 * {@link RESOLVABLE_LEN_RATIO}, the length-space twin of the lift's dz floor).
 * Empty when every bone the angle rests on had its depth solved.
 *
 * Deliberately NOT a number. The unseen offset is bounded by
 * dz <= L*sqrt(1 - ratio^2) only if the frame's scale is right, and square to
 * the camera — where nothing in frame lies in the image plane for the scale to
 * be measured off — it need not be: on the test fixture that bound held for
 * 230 of 504 readings and missed by up to 30°. A tolerance nobody can stand
 * behind is worse than naming the assumption.
 */
function unresolvedBoneNote(worst: number | null, label: string): string {
  if (worst == null || worst < RESOLVABLE_LEN_RATIO) return '';
  const why =
    worst >= 1
      ? 'over its prior, so the priors and this capture disagree and no depth was recoverable for it'
      : 'closer to its prior than a bone length can resolve depth to';
  return ` One bone under this ${label} measures ×${worst.toFixed(
    2,
  )} of its prior — ${why} — so the lift placed it in the image plane, and the reading carries that as an assumption, not a measurement.`;
}

/**
 * Largest pairwise depth difference among three lifted joints. Zero means the
 * lift recovered no depth between them, so the 3D angle IS the 2D angle — the
 * only test that catches a flat reading whatever clamped it.
 */
function zSpread(a: Joint3D, b: Joint3D, c: Joint3D): number {
  return Math.max(Math.abs(a.z - b.z), Math.abs(b.z - c.z), Math.abs(a.z - c.z));
}

function judgeAngle(
  spec: AngleSpec,
  lifted: LiftedSequence,
  frames2d: readonly DecodedFrame[],
  phases: Phase3DIndices,
): Judged3DAngle {
  const primary = phases[spec.phase];
  const fallback = spec.fallback != null ? phases[spec.fallback] : null;
  const usedPhase: PhaseId | null = primary != null ? spec.phase : fallback != null ? spec.fallback : null;
  const frame = primary ?? fallback ?? null;
  // Ratios are quoted against the priors AS THE LIFT READ THEM ON THIS FRAME,
  // so a ratio always means the same thing wherever it is read.
  const unitScale = frame != null ? scaleAt(lifted, frame) : 1;
  // Form Check's number describes ITS phase; drop it if we fell back.
  const repDeg2d = usedPhase === spec.phase ? spec.repDeg2d : null;
  const base = { id: spec.id, phase: usedPhase, frame, repDeg2d };

  if (frame == null) {
    return {
      ...base,
      deg: null,
      deg2d: null,
      c: null,
      boneRatio: null,
      worstBoneRatio: null,
      restsOnUnresolvedBone: false,
      verdict: 'withheld',
      reason: 'noPhaseFrame',
      note: `No ${spec.label} reading: this rep never located its ${spec.phase} frame.`,
    };
  }

  const f2 = frames2d[frame] ?? {};
  const f3: Frame3D = lifted.frames[frame] ?? {};
  const [a, b, c] = spec.joints;
  const p2a = f2[a];
  const p2b = f2[b];
  const p2c = f2[c];
  const deg2d = p2a && p2b && p2c ? angleAtDeg(p2a, p2b, p2c) : null;
  const reading = jointAngleDeg(f3[a], f3[b], f3[c]);

  if (!reading) {
    return {
      ...base,
      deg: null,
      deg2d,
      c: null,
      boneRatio: null,
      worstBoneRatio: null,
      restsOnUnresolvedBone: false,
      verdict: 'withheld',
      reason: 'missingJoint',
      note: `No 3D ${spec.label}: a joint it needs was not detected, so it is absent in 3D too.`,
    };
  }
  const { best: boneRatio, worst: worstBoneRatio } = boneRatios(f2, spec.bones, unitScale);
  const restsOnUnresolvedBone = worstBoneRatio != null && worstBoneRatio >= RESOLVABLE_LEN_RATIO;
  const unresolved = unresolvedBoneNote(worstBoneRatio, spec.label);
  if (reading.c < MIN_DEPTH_C) {
    return {
      ...base,
      deg: null,
      deg2d,
      c: reading.c,
      boneRatio,
      worstBoneRatio,
      restsOnUnresolvedBone,
      verdict: 'withheld',
      reason: 'lowDepthConfidence',
      note: `3D ${spec.label} withheld: depth confidence ${reading.c.toFixed(2)} is under ${MIN_DEPTH_C}.`,
    };
  }
  // Flat in z ⇒ this "3D" number is the 2D number. Say so; never dress it up.
  if (zSpread(f3[a]!, f3[b]!, f3[c]!) <= DEPTH_FLAT_EPS) {
    const why =
      boneRatio == null
        ? ''
        : boneRatio >= 1
          ? ` Its bones measure ×${boneRatio.toFixed(2)} of the anthropometric prior, so there was no depth left to recover.`
          : boneRatio >= RESOLVABLE_LEN_RATIO
            ? ` Its bones sit within ${Math.round((1 - boneRatio) * 100)}% of their anthropometric priors — closer than a bone length can resolve depth to — so the lift keeps them in the image plane instead of guessing a bend.`
            : '';
    return {
      ...base,
      deg: reading.deg,
      deg2d,
      c: reading.c,
      boneRatio,
      worstBoneRatio,
      restsOnUnresolvedBone,
      verdict: 'prefer2d',
      reason: 'depthCollapsed',
      note: `3D ${spec.label} equals the 2D reading — the lift placed these joints flat.${why} Trust the 2D number.`,
    };
  }
  if (deg2d == null) {
    return {
      ...base,
      deg: reading.deg,
      deg2d,
      c: reading.c,
      boneRatio,
      worstBoneRatio,
      restsOnUnresolvedBone,
      verdict: 'only3d',
      reason: 'no2dEquivalent',
      note: `3D ${spec.label} — no 2D reading on this frame to compare against.${unresolved}`,
    };
  }
  const delta = Math.abs(reading.deg - deg2d);
  if (delta >= AGREE_TOL_DEG) {
    return {
      ...base,
      deg: reading.deg,
      deg2d,
      c: reading.c,
      boneRatio,
      worstBoneRatio,
      restsOnUnresolvedBone,
      verdict: 'prefer3d',
      reason: 'foreshortened2d',
      note: `3D ${spec.label} ${reading.deg.toFixed(0)}° vs 2D ${deg2d.toFixed(0)}°: the camera foreshortens this joint by ${delta.toFixed(0)}°, so the 3D estimate is the better read.${unresolved}`,
    };
  }
  return {
    ...base,
    deg: reading.deg,
    deg2d,
    c: reading.c,
    boneRatio,
    worstBoneRatio,
    restsOnUnresolvedBone,
    verdict: 'parity',
    reason: 'agrees2d',
    note: `3D ${spec.label} agrees with 2D within ${delta.toFixed(0)}° — same number, one more witness.${unresolved}`,
  };
}

/**
 * Torso yaw: the one reading 2D cannot produce at all. cos θ = apparent
 * shoulder half-width ÷ (the prior half-width × the frame's scale), so its
 * error is the error in that denominator — and both terms of it are stated,
 * because neither is small:
 *
 * - THE SCALE IS A LOWER BOUND (measureFrameUnitScale) ON CLEAN KEYPOINTS, so
 *   the prior width is not over-long and the turn is not over-claimed — at a
 *   true 0° the noiseless fixture reads 0.2°, the floor of acos itself. Real
 *   keypoints break the bound in one direction: noise makes bones look SHORT,
 *   which inflates the measured scale and the prior width with it. Measured
 *   over 24 noise realizations at a true 75°, the reading drifts UP by +0.4°,
 *   +0.9° and +1.8° at 0.5%, 1% and 2% of standing height per keypoint.
 * - THE WIDTH PRIOR IS WINTER'S, NOT THIS SHOOTER'S. dθ = Δratio ÷ sin θ, so
 *   the same 8% of anthropometric spread is ~1° near a profile and swallows
 *   the whole reading near square-on (cos 20° + 8% > 1 → reads 0°). Near a
 *   profile this number is worth a few degrees; near square-on it is worth
 *   only its own sign, and the note says so instead of the digits.
 *
 * Measured on the profile fixture: a 75° turn reads 74.996°, a 90° turn reads
 * 90.000°, a 0° turn reads 0.21° (formCheck3d.test.ts).
 */
function judgeTorsoYaw(lifted: LiftedSequence, scale: DepthScaleCheck): Judged3DAngle {
  let sum = 0;
  let count = 0;
  for (const frame of lifted.frames) {
    for (const name of ['left_shoulder', 'right_shoulder'] as const) {
      const joint = frame[name];
      if (joint) {
        sum += joint.c;
        count++;
      }
    }
  }
  const c = count > 0 ? sum / count : null;
  const base = {
    id: 'torsoYaw' as const,
    phase: null,
    frame: null,
    deg2d: null,
    repDeg2d: null,
    // Rep-wide residual, not one bone under one angle: the yaw rests on the
    // shoulder-width prior, which is not a bone the lift ever solves depth for.
    boneRatio: scale.maxRatio,
    worstBoneRatio: scale.maxRatio,
    restsOnUnresolvedBone: false,
  };
  if (c == null) {
    return {
      ...base,
      deg: null,
      c: null,
      verdict: 'withheld',
      reason: 'missingJoint',
      note: 'No torso yaw: this rep never showed both shoulders.',
    };
  }
  if (c < MIN_DEPTH_C) {
    return {
      ...base,
      deg: null,
      c,
      verdict: 'withheld',
      reason: 'lowDepthConfidence',
      note: `Torso yaw withheld: depth confidence ${c.toFixed(2)} is under ${MIN_DEPTH_C}.`,
    };
  }
  // The tolerance is unconditional: it comes from the shoulder-width prior
  // being an anthropometric average, which no rep can measure away. What IS
  // conditional is the floor language, and it keys off a fact — this rep's
  // bones still running over their priors after the scale was reconciled,
  // i.e. a scale that could not be recovered — rather than off the last bit of
  // a float. (With a per-frame scale the residual max sits AT 1 by
  // construction: the frame's scale is the largest ratio in it.)
  const near = Math.abs(lifted.azimuthDeg) < YAW_TRUSTWORTHY_DEG;
  const tolerance = near
    ? ` Under ${YAW_TRUSTWORTHY_DEG}° the shoulder width barely changes with turn, so read this as "close to square-on" and not as a number.`
    : ' Read from shoulder width against an average build, so it carries a few degrees — never the digit.';
  const under = scale.collapsed
    ? ` This rep's bones still measure up to ×${(scale.maxRatio ?? 1).toFixed(
        2,
      )} of their priors, so the width is over-scaled and the turn is a lower bound.`
    : '';
  return {
    ...base,
    deg: lifted.azimuthDeg,
    c,
    verdict: 'only3d',
    reason: 'no2dEquivalent',
    note: `Torso yaw ${lifted.azimuthDeg.toFixed(
      0,
    )}° from square-on — 2D cannot report this at all.${tolerance}${under}`,
  };
}

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

/**
 * Lift one Form Check rep into a 3D shooting posture plus its judgment.
 *
 * Returns null — never a partial guess — when the rep carries no sequence,
 * when fewer than {@link MIN_LIFT_FRAMES} frames decode, or when the lift
 * itself refuses (fewer than 2 frames with both hips and both shoulders).
 */
export function liftRep(rep: FormCheckRep): FormCheck3D | null {
  const seq = rep.sequence;
  if (!seq) return null;
  const frames2d = decodeSequence(seq);
  if (frames2d.length < MIN_LIFT_FRAMES) return null;
  const hand = seq.hand;
  // Units first, THEN the lift: the priors are fractions of standing height
  // and these frames are in nose→ankle spans, so reading them as-is is what
  // flattened every limb. The scale is measured off this rep's own bones.
  // PER FRAME, not once per rep: formSequence divides every frame by that
  // frame's own nose→ankle span, so the units move ~6% between the dip and the
  // release. One scale for the whole rep over-scales most of it, and an
  // over-scaled prior invents depth (a straight leg read against the dip's
  // scale bends 36°). See measureUnitScales.
  const unitScales = measureUnitScales(frames2d);
  const lifted = liftSequence(frames2d, hand, unitScales);
  if (!lifted) return null;

  const phases = phaseIndices(rep, seq, frames2d, hand);
  const scale = depthScaleCheck(frames2d, lifted.unitScales ?? lifted.unitScale ?? 1);
  const s = sideNames(hand);
  const specs: AngleSpec[] = [
    {
      // Form Check reads setPointElbowDeg off the DIP frame (its set point IS
      // the deepest dip), so the comparison has to be taken there — pairing it
      // with the wrist-crossing frame would compare two different instants.
      id: 'elbow',
      phase: 'dip',
      fallback: 'release',
      joints: [s.shoulder, s.elbow, s.wrist],
      bones: [
        [s.shoulder, s.elbow],
        [s.elbow, s.wrist],
      ],
      repDeg2d: rep.metrics.setPointElbowDeg,
      label: 'elbow',
    },
    {
      id: 'knee',
      phase: 'dip',
      fallback: 'release',
      joints: [s.hip, s.knee, s.ankle],
      bones: [
        [s.hip, s.knee],
        [s.knee, s.ankle],
      ],
      repDeg2d: rep.metrics.kneeFlexionDeg,
      label: 'knee',
    },
    {
      // Arm elevation at the shoulder (hip–shoulder–elbow). Form Check has no
      // 2D equivalent, but the reading still rests on the upper-arm prior.
      id: 'shoulder',
      phase: 'release',
      fallback: null,
      joints: [s.hip, s.shoulder, s.elbow],
      bones: [[s.shoulder, s.elbow]],
      repDeg2d: null,
      label: 'shoulder',
    },
  ];

  const angles: Judged3DAngle[] = specs.map((spec) => judgeAngle(spec, lifted, frames2d, phases));
  angles.push(judgeTorsoYaw(lifted, scale));
  return { hand, frames2d, lifted, phases, angles, scale };
}

/** Pick one judged angle out of a result. */
export function angleOf(result: FormCheck3D, id: Angle3DId): Judged3DAngle | null {
  return result.angles.find((a) => a.id === id) ?? null;
}
