/**
 * Motion-sequence capture + compact serialization for Form Studio.
 *
 * The {@link FormAnalyzer} (src/core/formAnalysis.ts) already detects the shot
 * phases and snapshots the single RELEASE pose. Form Studio needs the whole
 * MOTION — the shooter's body through dip → rise → release → follow-through —
 * so it can play the user's form back beside a reference form and annotate the
 * angle differences over time.
 *
 * {@link FormSequenceBuffer} does exactly that, ADDITIVELY: it consumes the
 * same per-frame poses the analyzer sees (fed alongside, never replacing it),
 * keeps a rolling window, and on finalize downsamples to a fixed ~24-frame
 * grid, normalizes each frame to the shooter's hip-center + body height (so
 * absolute pixel size cancels and any two shooters overlay directly), and
 * quantizes to a small int16 grid. The output {@link FormSequence} serializes
 * as flat ints, so a whole shot's motion adds only a few KB to formJson.
 *
 * IMPORTANT (honesty): these are 2D MoveNet keypoints. The studio ILLUSTRATES
 * depth with limb layering + parallax — it does NOT reconstruct real 3D.
 * Genuine 2D→3D lifting (a lifter model) is a future upgrade; nothing here
 * claims a true depth capture.
 *
 * THE PACKER REFUSES. Normalizing is not the same as trusting: a capture that
 * is not a standing body has no honest normalization, and this module's job
 * ends at saying so. {@link bodyFrameOf} gates every frame on anatomy against a
 * ROLL-INVARIANT scale, out-of-reach joints are stored MISSING rather than
 * clamped, and {@link isReconstructibleMotion} vetoes the whole sequence — a
 * null return, no rows at all — when what came out is not a body. See the
 * "Anatomy gates" block for the shapes that used to ship instead.
 *
 * Pure TypeScript: no I/O, no wall clock (time comes from frame timestamps).
 */
import { clamp } from './geometry';
import type {
  FormSequence,
  PoseFrame,
  PoseKeypoint,
  PoseKeypointName,
  ShootingHand,
} from './types';

// ---------------------------------------------------------------------------
// Encoding constants
// ---------------------------------------------------------------------------

/**
 * COCO-17 keypoint order the flat `data` array is packed in. Fixed and
 * exported so packer, unpacker and any renderer share one index mapping. This
 * is exactly MoveNet's output order (src/ml/poseParser.ts).
 */
export const SEQ_KEYPOINT_ORDER: readonly PoseKeypointName[] = [
  'nose',
  'left_eye',
  'right_eye',
  'left_ear',
  'right_ear',
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

/** Two coordinates (x, y) per keypoint. */
const DIMS = 2;
/** Ints per frame (17 keypoints × 2). */
export const SEQ_STRIDE = SEQ_KEYPOINT_ORDER.length * DIMS;

/**
 * Quantization scale: grid units per one body-height. Normalized coordinates
 * sit within roughly ±2 body-heights of the hip-center, so 8000 units/height
 * maps that into ±16000 — safely inside int16 range (±32767) with sub-pixel
 * resolution to spare.
 */
export const SEQ_SCALE = 8000;

/**
 * Sentinel for a keypoint that was missing/low-confidence in a frame. Chosen
 * below the int16 floor so it can never collide with a real quantized value.
 */
export const SEQ_MISSING = -32768;

/** Target downsampled frame count (~24 over the ~1.2 s window). */
export const SEQ_TARGET_FRAMES = 24;

/**
 * Shot-window duration to retain, seconds. The buffer keeps a rolling window
 * this long; on finalize the last {@link SEQ_TARGET_FRAMES} are sampled from
 * it. ~1.2 s comfortably spans dip → follow-through for a normal jumper.
 */
export const SEQ_WINDOW_SEC = 1.2;

/** Score gate below which a keypoint is treated as missing (matches FORM). */
const KP_SCORE_MIN = 0.3;

/**
 * Max |sampled frame t − releaseT| (seconds) accepted when locating the
 * release marker. Beyond this the marker is OMITTED rather than snapped to a
 * far-away frame — never fabricate an alignment.
 */
export const RELEASE_MATCH_SLACK_SEC = 0.2;

// ---------------------------------------------------------------------------
// Body-frame normalization
// ---------------------------------------------------------------------------

interface XY {
  x: number;
  y: number;
}

/** One buffered raw frame: timestamp + usable keypoints (px, analysis space). */
export interface RawSeqFrame {
  t: number;
  pts: Map<PoseKeypointName, XY>;
}

/**
 * Hip-center of a frame (midpoint of both hips; falls back to whichever hip is
 * present). Null when no hip is visible — such a frame can't be normalized.
 */
function hipCenterOf(pts: ReadonlyMap<PoseKeypointName, XY>): XY | null {
  const l = pts.get('left_hip');
  const r = pts.get('right_hip');
  if (l && r) return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  return l ?? r ?? null;
}

// ---------------------------------------------------------------------------
// Anatomy gates
//
// THE BUG THESE EXIST FOR (the "theater draws a straight line" bug): this
// module used to accept ANY frame that had a hip and an AXIS-ALIGNED
// |ankle.y − nose.y| gap greater than ONE PIXEL, and it divided every
// coordinate by that gap. Three consequences, all of which shipped:
//
//   1. The scale was not roll-invariant. Rotate the same body 45° in the image
//      and |Δy| shrinks by cos45, so every normalized coordinate GREW 1.41×;
//      at 90° the gap collapses to the body's lateral width and the figure
//      magnifies ~10×, saturating the int16 grid at ±4.096 body-heights. That
//      is the "two long horizontal lines spanning the card" shape.
//   2. Nothing checked which way was UP. Past 90° of roll the gap is still
//      positive (it was an absolute value), so an upside-down capture encoded
//      cleanly as a body with its head BELOW its hips. That is the "head
//      circle at the bottom of a vertical line" shape.
//   3. A 2-pixel body, or a degenerate keypoint cluster with no lateral
//      extent at all, passed every check and was scored as a shooting form.
//
// So the gates below are anatomy, not cosmetics: a frame is encoded only when
// it reads as a standing human, and a coordinate is encoded only when it was
// actually measured. Everything refused is refused OUT LOUD (the frame is a
// missing row, the sequence is null) — never smoothed into something that
// merely looks like a body.
// ---------------------------------------------------------------------------

/**
 * Smallest body, in analysis-frame pixels, worth encoding as a motion. The
 * analysis square is 192 px, so this is a shooter filling ~1/8 of the frame:
 * below it a quantized joint is a couple of pixels of pose noise, and the
 * angles read off it are noise too. The old floor was `h > 1` — literally a
 * two-pixel human.
 */
export const SEQ_MIN_BODY_PX = 24;

/**
 * Cosine of the largest body-axis roll a capture may carry, i.e. how much of
 * the head→foot distance must survive as a DOWNWARD image span. 0.5 = 60°.
 *
 * Generous on purpose: the scale below is roll-invariant, so a tilted capture
 * is drawn tilted at its true size rather than magnified, and a shooter who
 * leans is not a broken capture. What this refuses is the catastrophic case —
 * a body lying on its side (90°) or standing on its head (180°), which is a
 * mis-latched buffer orientation or a garbage pose, never a jump shot. We
 * refuse it instead of rotating it upright: nothing here can tell a rolled
 * camera from a fallen shooter, and inventing the difference would be a lie.
 */
export const SEQ_MIN_UPRIGHT_COS = 0.5;

/**
 * How far inside the head→foot span the hip-center must sit, as a fraction of
 * body height. A real hip is ~40% down that span; anything that puts it at or
 * past an end is a collapsed keypoint cluster, not a person.
 */
const SEQ_HIP_INSIDE_FRAC = 0.08;

/**
 * Largest |normalized coordinate| a real joint can take, in body-heights from
 * the hip-center. A raised wrist reaches ~0.9, an ankle ~0.6; 1.6 is loose
 * enough for any pose and any of the shorter fallback scales below. Past it
 * the joint was mis-detected or the scale is wrong, and the value is stored as
 * MISSING rather than as the ±4.096 the int16 clamp used to fabricate.
 */
export const SEQ_MAX_JOINT_N = 1.6;

/**
 * Encoded joints below which a frame is not a body worth a timeline slot.
 *
 * Five = a hip pair, a head point and a foot pair — the least from which a
 * trunk, a stance and therefore a horizontal extent can be read at all. NOT a
 * defence against this bug: the degenerate captures that shipped carried all
 * thirteen joints, so joint count was never what separated a body from a line.
 * This only stops a two-joint fragment from voting on the gates below.
 */
const SEQ_MIN_FRAME_JOINTS = 5;

/**
 * Smallest total horizontal extent, in body-heights, that a whole motion must
 * reach in at least one frame. Even a dead-on side profile spreads this far —
 * the nose leads the hips, the knees track forward, the shooting wrist travels
 * out. A motion flatter than this is the vertical line this bug shipped, and
 * it is refused rather than drawn.
 */
export const SEQ_MIN_LATERAL_N = 0.04;

/** Plausible band for a frame's total vertical extent, body-heights. */
export const SEQ_MIN_VERTICAL_N = 0.35;
export const SEQ_MAX_VERTICAL_N = 2.2;

/** The hip-center + body scale one frame is normalized against. */
export interface BodyFrame {
  /** Hip-center in analysis pixels — the normalized origin. */
  center: XY;
  /** Body height in analysis pixels — the normalized unit. */
  height: number;
}

/**
 * Is this head→foot pair a standing body, at a scale worth encoding?
 *
 * `dist` is the ROLL-INVARIANT (Euclidean) head→foot distance, so the size
 * test is independent of image rotation; the upright test then asks how much
 * of that distance points DOWN the image, and the hip test asks that the hips
 * sit inside the span. All three have to hold.
 */
function standingBody(top: XY, bottom: XY, center: XY, dist: number): boolean {
  if (!(dist >= SEQ_MIN_BODY_PX)) return false;
  if (!(bottom.y - top.y >= SEQ_MIN_UPRIGHT_COS * dist)) return false;
  const margin = SEQ_HIP_INSIDE_FRAC * dist;
  return center.y > top.y + margin && center.y < bottom.y - margin;
}

/**
 * The normalization frame for one raw frame: hip-center origin plus a
 * ROLL-INVARIANT body height in pixels — the Euclidean head→foot distance,
 * not the axis-aligned |Δy| this module used to divide by.
 *
 * Head is the nose (falling back to a shoulder), foot the lowest visible
 * ankle (falling back to a knee); with neither leg visible the shoulder→hip
 * trunk stands in at ×2.5, the same coarse full-body estimate as before, also
 * measured Euclidean.
 *
 * Returns null — the frame is refused, not rescued — when the points that ARE
 * visible do not describe a standing human. A body that fails the head→foot
 * gate never falls through to the trunk estimate: a broken pose with a
 * plausible-looking trunk is still a broken pose.
 *
 * Exported so the readiness side-profile gauge in src/core/formCheck.ts can
 * abstain on exactly the frames this refuses, instead of reading a collapsed
 * keypoint cluster as a PERFECT side profile.
 */
export function bodyFrameOf(pts: ReadonlyMap<PoseKeypointName, XY>): BodyFrame | null {
  const center = hipCenterOf(pts);
  if (!center) return null;
  const top =
    pts.get('nose') ??
    pts.get('left_shoulder') ??
    pts.get('right_shoulder') ??
    null;
  const bottom =
    pts.get('left_ankle') ??
    pts.get('right_ankle') ??
    pts.get('left_knee') ??
    pts.get('right_knee') ??
    null;
  if (top && bottom) {
    const dist = Math.hypot(bottom.x - top.x, bottom.y - top.y);
    return standingBody(top, bottom, center, dist) ? { center, height: dist } : null;
  }
  // Trunk fallback: shoulder→hip is ~0.4 of standing height.
  const shoulder = pts.get('left_shoulder') ?? pts.get('right_shoulder') ?? null;
  const hip = pts.get('left_hip') ?? pts.get('right_hip') ?? null;
  if (shoulder && hip) {
    const trunk = Math.hypot(hip.x - shoulder.x, hip.y - shoulder.y);
    const height = trunk * 2.5;
    // Shoulders above hips by most of the trunk, and a plausible stature.
    if (
      height >= SEQ_MIN_BODY_PX &&
      hip.y - shoulder.y >= SEQ_MIN_UPRIGHT_COS * trunk
    ) {
      return { center, height };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// FormSequenceBuffer
// ---------------------------------------------------------------------------

/**
 * Rolling per-shot pose-sequence recorder. Feed EVERY frame's pose while a
 * shot is in progress (the same poses the FormAnalyzer receives), then call
 * {@link finalize} once the shot resolves and {@link reset} before the next.
 *
 * Allocation-light: keeps at most the frames inside {@link SEQ_WINDOW_SEC}.
 */
export class FormSequenceBuffer {
  private readonly hand: ShootingHand;
  private frames: RawSeqFrame[] = [];

  constructor(opts: { hand: ShootingHand }) {
    this.hand = opts.hand;
  }

  /** Feed one frame's pose. Low-confidence keypoints are dropped per frame. */
  push(pose: PoseFrame): void {
    const pts = new Map<PoseKeypointName, XY>();
    for (const name of SEQ_KEYPOINT_ORDER) {
      const kp: PoseKeypoint | undefined = pose.keypoints[name];
      if (
        kp &&
        kp.score >= KP_SCORE_MIN &&
        Number.isFinite(kp.x) &&
        Number.isFinite(kp.y)
      ) {
        pts.set(name, { x: kp.x, y: kp.y });
      }
    }
    // Ignore frames with no usable landmarks at all.
    if (pts.size === 0) return;
    this.frames.push({ t: pose.t, pts });
    this.pruneOld(pose.t);
  }

  /** Drop frames older than the retained window relative to the newest time. */
  private pruneOld(nowT: number): void {
    const cutoff = nowT - SEQ_WINDOW_SEC;
    // Frames arrive in time order; drop from the front.
    let i = 0;
    while (i < this.frames.length && this.frames[i]!.t < cutoff) i++;
    if (i > 0) this.frames = this.frames.slice(i);
  }

  /**
   * Build the compact {@link FormSequence} from the buffered window, or null
   * when too little was captured to be meaningful (fewer than 4 usable frames
   * or no frame with both a hip-center and a body-height estimate).
   *
   * Downsamples to at most {@link SEQ_TARGET_FRAMES} evenly across the window,
   * normalizes each frame to hip-center + body height, and quantizes.
   *
   * `releaseT` (camera seconds, e.g. the pose-gated release pose timestamp)
   * optionally marks the output frame nearest the release — see
   * {@link buildSequence}.
   */
  finalize(releaseT: number | null = null): FormSequence | null {
    return buildSequence(this.frames, this.hand, releaseT);
  }

  /** Clear buffered frames for the next shot. */
  reset(): void {
    this.frames = [];
  }

  /** Number of buffered frames (diagnostics/tests). */
  get length(): number {
    return this.frames.length;
  }
}

// ---------------------------------------------------------------------------
// Pure builders (exported for tests + non-streaming callers)
// ---------------------------------------------------------------------------

/**
 * Evenly pick up to `target` indices spanning [0, n). Always includes the
 * first and last so the motion's endpoints (dip start, follow-through end)
 * survive downsampling.
 */
function pickIndices(n: number, target: number): number[] {
  if (n <= target) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < target; i++) {
    out.push(Math.round((i * (n - 1)) / (target - 1)));
  }
  // De-dup (rounding can collide at the ends).
  return out.filter((v, i) => i === 0 || v !== out[i - 1]);
}

/**
 * Quantize one normalized coordinate to the int16 grid.
 *
 * The clamp is a LAST-RESORT guard, not a range policy: callers reject any
 * coordinate past {@link SEQ_MAX_JOINT_N} (1.6 → 12800 units) before getting
 * here, so it can no longer fire. It used to be the only bound in the module,
 * and a saturated joint parked at ±32767 = ±4.096 body-heights is a
 * FABRICATED position — indistinguishable downstream from a measured one, and
 * the reason a mis-scaled capture drew two lines across the whole card.
 */
function quantize(v: number): number {
  const q = Math.round(v * SEQ_SCALE);
  return clamp(q, -32767, 32767);
}

/**
 * {@link FormSequence} plus the optional release marker. Mirrors the
 * `releaseFrame?: number` field the integrator adds to FormSequence in
 * src/core/types.ts (`v` stays 1 — the `data` packing is unchanged and old
 * decoders ignore the extra JSON key). Exported so consumers can read the
 * marker with type safety before/independent of that types.ts change.
 */
export type FormSequenceWithRelease = FormSequence & {
  /** 0-based OUTPUT-frame index nearest in time to the pose-gated release. */
  releaseFrame?: number;
};

/**
 * Core packer: takes raw (px) frames and produces a normalized, quantized
 * {@link FormSequence}. Exported so tests and any offline reprocessing can
 * build a sequence without the streaming buffer. Returns null on too-little
 * data.
 *
 * When `releaseT` (camera seconds) is a finite number, the output frame whose
 * sampled timestamp is nearest to it is marked as `releaseFrame` — but only
 * within {@link RELEASE_MATCH_SLACK_SEC}; otherwise the key is omitted
 * entirely (an absent marker is honest, a snapped-far one is not). The index
 * space is OUTPUT frames: all-missing rows still occupy an index and carry a
 * valid timestamp, so they participate in the nearest-match.
 */
export function buildSequence(
  rawFrames: readonly RawSeqFrame[],
  hand: ShootingHand,
  releaseT: number | null = null,
): FormSequence | null {
  if (rawFrames.length < 4) return null;
  const idx = pickIndices(rawFrames.length, SEQ_TARGET_FRAMES);
  const data: number[] = [];
  let kept = 0;
  /** An all-missing row: the timeline slot survives, the pose does not. */
  const pushMissingRow = () => {
    for (let k = 0; k < SEQ_STRIDE; k++) data.push(SEQ_MISSING);
  };
  for (const i of idx) {
    const f = rawFrames[i]!;
    const body = bodyFrameOf(f.pts);
    // A frame we can't anchor/scale — or that does not read as a standing
    // human at all — contributes an all-missing row so the timeline stays
    // evenly spaced (renderers skip missing points).
    if (!body) {
      pushMissingRow();
      continue;
    }
    const { center, height } = body;
    const row: number[] = [];
    let encoded = 0;
    for (const name of SEQ_KEYPOINT_ORDER) {
      const p = f.pts.get(name);
      if (!p) {
        row.push(SEQ_MISSING, SEQ_MISSING);
        continue;
      }
      const nx = (p.x - center.x) / height;
      const ny = (p.y - center.y) / height;
      // Further from the hip than any limb reaches ⇒ this joint was not
      // measured, it was mis-detected. Store MISSING, never a clamped value:
      // a fabricated coordinate is worse than an absent one, because the
      // renderer and every rule downstream would treat it as a measurement.
      if (Math.abs(nx) > SEQ_MAX_JOINT_N || Math.abs(ny) > SEQ_MAX_JOINT_N) {
        row.push(SEQ_MISSING, SEQ_MISSING);
        continue;
      }
      row.push(quantize(nx), quantize(ny));
      encoded++;
    }
    if (encoded < SEQ_MIN_FRAME_JOINTS) {
      pushMissingRow();
      continue;
    }
    kept++;
    for (const v of row) data.push(v);
  }
  if (kept < 4) return null;
  let releaseFrame: number | null = null;
  if (releaseT != null && Number.isFinite(releaseT)) {
    let bestK = -1;
    let bestD = Infinity;
    for (let k = 0; k < idx.length; k++) {
      const d = Math.abs(rawFrames[idx[k]!]!.t - releaseT);
      if (d < bestD) {
        bestD = d;
        bestK = k;
      }
    }
    if (bestK >= 0 && bestD <= RELEASE_MATCH_SLACK_SEC) releaseFrame = bestK;
  }
  const t0 = rawFrames[idx[0]!]!.t;
  const t1 = rawFrames[idx[idx.length - 1]!]!.t;
  const seq: FormSequence = {
    v: 1,
    hand,
    frames: idx.length,
    durationSec: Math.max(0, t1 - t0),
    data,
    // Conditional spread keeps the key entirely absent when unmatched, so a
    // two-arg call serializes byte-identically to the pre-marker output.
    ...(releaseFrame != null ? { releaseFrame } : {}),
  };
  // THE LAST GATE: read back exactly what we are about to ship and require it
  // to be a motion a human could have made. The per-frame gates above cannot
  // see a whole-motion failure — a capture that is a single vertical column in
  // every frame passes each frame's anatomy test and is still not a body. A
  // sequence that cannot be reconstructed is returned as NULL so the report
  // says "no motion" instead of the theater drawing a straight line and the
  // cue engine coaching a human being from it.
  return isReconstructibleMotion(decodeSequence(seq)) ? seq : null;
}

// ---------------------------------------------------------------------------
// Decoding — for renderers (Form Studio)
// ---------------------------------------------------------------------------

/** One decoded frame: keypoint → normalized {x,y} (missing keypoints absent). */
export type DecodedFrame = Partial<Record<PoseKeypointName, XY>>;

/**
 * Decode a {@link FormSequence} back to per-frame normalized keypoint maps
 * (body-relative units, +y down, hip-center origin). Missing keypoints and
 * malformed/short `data` are handled gracefully — a corrupt persisted blob
 * yields whatever frames decode cleanly, never a throw.
 */
export function decodeSequence(seq: FormSequence): DecodedFrame[] {
  const out: DecodedFrame[] = [];
  const total = seq.frames;
  for (let f = 0; f < total; f++) {
    const frame: DecodedFrame = {};
    const base = f * SEQ_STRIDE;
    if (base + SEQ_STRIDE > seq.data.length) break;
    for (let k = 0; k < SEQ_KEYPOINT_ORDER.length; k++) {
      const xi = seq.data[base + k * DIMS]!;
      const yi = seq.data[base + k * DIMS + 1]!;
      if (xi === SEQ_MISSING || yi === SEQ_MISSING) continue;
      frame[SEQ_KEYPOINT_ORDER[k]!] = { x: xi / SEQ_SCALE, y: yi / SEQ_SCALE };
    }
    out.push(frame);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reconstructibility — the gate between "we have data" and "we have a body"
// ---------------------------------------------------------------------------

/** Shape of a decoded motion, measured in body-heights. */
export interface SequenceGeometry {
  /** Frames carrying enough joints to read as a body. */
  bodyFrames: number;
  /** Widest single-frame horizontal extent over the motion. */
  lateralExtent: number;
  /** Widest single-frame vertical extent over the motion. */
  verticalExtent: number;
  /** Frames whose nose sits ABOVE the hip-center (decoded y < 0) — correct. */
  headAboveHip: number;
  /** Frames whose nose sits BELOW the hip-center — anatomically impossible. */
  headBelowHip: number;
}

/**
 * Measure a decoded motion's shape. Pure geometry — no verdict, so a caller
 * (or a test) can report the actual numbers rather than a bare boolean.
 */
export function sequenceGeometry(frames: readonly DecodedFrame[]): SequenceGeometry {
  let bodyFrames = 0;
  let lateralExtent = 0;
  let verticalExtent = 0;
  let headAboveHip = 0;
  let headBelowHip = 0;
  for (const frame of frames) {
    const pts = Object.values(frame) as XY[];
    if (pts.length < SEQ_MIN_FRAME_JOINTS) continue;
    bodyFrames++;
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const p of pts) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    lateralExtent = Math.max(lateralExtent, xMax - xMin);
    verticalExtent = Math.max(verticalExtent, yMax - yMin);
    // The origin IS the hip-center, so the nose's own sign is the test.
    const nose = frame.nose;
    if (nose) {
      if (nose.y < 0) headAboveHip++;
      else headBelowHip++;
    }
  }
  return { bodyFrames, lateralExtent, verticalExtent, headAboveHip, headBelowHip };
}

/**
 * Can this decoded motion honestly be shown as the shooter's body?
 *
 * The one predicate the whole product asks before drawing, lifting or scoring
 * a capture — used by {@link buildSequence} on what it is about to ship AND by
 * the report screen on what it reads back (including sequences persisted
 * BEFORE this gate existed, which is the only defence old degenerate rows have
 * against being drawn as a straight line).
 *
 * Refusals, in the order they bite:
 *  - fewer than two body frames: nothing to interpolate between;
 *  - no horizontal extent: the collapsed vertical column this bug shipped;
 *  - an implausible vertical extent: a mis-scaled / saturated figure;
 *  - a head below the hips in ANY frame: an inverted capture.
 */
export function isReconstructibleMotion(frames: readonly DecodedFrame[]): boolean {
  const g = sequenceGeometry(frames);
  return (
    g.bodyFrames >= 2 &&
    g.lateralExtent >= SEQ_MIN_LATERAL_N &&
    g.verticalExtent >= SEQ_MIN_VERTICAL_N &&
    g.verticalExtent <= SEQ_MAX_VERTICAL_N &&
    g.headBelowHip === 0
  );
}
