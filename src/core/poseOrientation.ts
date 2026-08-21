/**
 * Pose orientation — decide whether the pose buffer reached the model the
 * right way up, and correct it AT THE PARSE BOUNDARY when it did not.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * On a real device the Form Check skeleton rendered with the HEAD AT THE
 * BOTTOM of the screen and the FEET AT THE TOP, left/right looking correct.
 * The overlay's own doc comment calls it presentation-only, which made a
 * drawing-side offset look like the safe fix. It is not. If the BUFFER is
 * rotated then MoveNet is being fed an upside-down person and EVERY
 * downstream number is computed on flipped coordinates: release height is
 * standing-ankle-y minus release-wrist-y (the difference changes SIGN), the
 * dip walks the filtered wrist y hunting a maximum (finds the wrong
 * extremum), knee flexion and the camera-roll estimate both read the
 * ankle→hip→shoulder line. A flipped buffer silently corrupts the ANALYSIS,
 * not just the drawing — so the correction belongs here, before any consumer
 * sees the keypoints, and the overlay and the metrics are then fixed by the
 * same single change.
 *
 * COORDINATE SPACE (what parseMoveNet emits)
 * ------------------------------------------
 * src/ml/poseParser.ts de-normalizes MoveNet's (y, x, score) triplets into
 * the SQUARE analysis frame the resizer produces: origin TOP-LEFT, +x RIGHT,
 * +y DOWN, x in [0, frameW], y in [0, frameH]. Form Check parses with
 * frameW = frameH = POSE_INPUT (192) — the 192-square cover-crop, NOT the
 * camera frame's width/height. That square side is what
 * {@link correctPoseFrame} must be handed as `size`; handing it the camera
 * frame's dimensions would translate the whole skeleton off the crop.
 *
 * WHAT "FLIPPED" MEANS, AND WHY THE CORRECTION TOUCHES BOTH AXES
 * -------------------------------------------------------------
 * Camera buffers do not arrive MIRRORED, they arrive ROTATED: the
 * physical-buffer-rotation path picks one of 0/90/180/270 from the interface
 * orientation, and the symptom above is the 180° case. Under a 180° image
 * rotation a body point that truly sits at (x, y) is reported at
 * (W − x, H − y) — BOTH axes move. So the correction is that same map,
 * (x, y) → (W − x, H − y). It is an involution: correcting twice returns the
 * original coordinates, which is pinned by a round-trip test.
 *
 * WHY THE SYMPTOM LOOKED LIKE Y ALONE — AND WHAT IS STILL UNPROVEN. It is
 * tempting to say the overlay's front-camera X mirror cancels the X half on
 * screen. It does not: that mirror flips the DRAWN point and the PREVIEW
 * together, so it cancels for correct data and DOUBLES the error for wrong
 * data. "Left and right looked fine" is therefore evidence about FRAMING,
 * not about the transform — a shooter standing near the horizontal centre of
 * the frame carries an X error of a few pixels under a 180° rotation, which
 * is invisible beside a head-down skeleton.
 *
 * Which means two hypotheses fit the report, and they disagree:
 *  - ROTATION (what this module assumes): truth is (W − x, H − y), so both
 *    axes must be undone. Correcting only y would leave the skeleton
 *    X-mirrored against truth — the labelled left arm on the wrong side of
 *    the body, the packed FormSequence compared mirrored against the
 *    reference forms.
 *  - A VERTICAL BUFFER FLIP: truth would be (x, H − y), and correcting x as
 *    well would INTRODUCE that mirror.
 * Rotation is the reading taken, on physical grounds: capture pipelines
 * rotate buffers and mirror them HORIZONTALLY; none of them flips a buffer
 * vertically, and `enablePhysicalBufferRotation` is a rotation by name and
 * by contract. Nothing in this repo observes a real buffer, so no test here
 * can settle it — it is settled ON DEVICE, by standing well off the
 * horizontal centre with a fired correction and checking the skeleton is not
 * mirrored about the frame's midline.
 *
 * BODY-SIDE LABELS ARE **NOT** SWAPPED. Under the rotation reading the image
 * is chirality-preserving (a rotation is two reflections); only a MIRROR
 * exchanges a person's apparent left and right. MoveNet labels anatomy from
 * appearance, and an upside-down person's anatomical left is still their
 * anatomical left, so the labels that come back are already correct — the
 * coordinates are the only thing wrong. Renaming left_* to right_* here
 * would corrupt the shooting-hand logic, which is a worse bug than the flip.
 * Pinned by tests.
 *
 * A related note on what the detector can and cannot see: the owner reports
 * a COHERENT inverted skeleton, i.e. MoveNet found the real head and put
 * `nose` on it. Had the model instead labelled the feet as the head, the
 * skeleton would have drawn upright and this module would read it as
 * upright. It judges the data it is given; it cannot audit the model. Nor
 * can it tell a rotated buffer from a person who is GENUINELY inverted: a
 * subject held head-below-feet, extended and motionless across a whole
 * agreement run commits 'flipped', correctly by its own anatomy rule. That
 * posture is not reachable in a shooting session, and the one-tap override
 * is the answer if it ever is.
 *
 * HOW THE VERDICT IS REACHED
 * --------------------------
 * From ANATOMY: a standing human's nose is above their ankles. Every gate is
 * deliberately conservative, because a wrong verdict flips every metric in
 * the session:
 *  - the nose AND at least one ankle must clear FORM.keypointScoreMin in the
 *    SAME frame (the app-wide keypoint gate, formAnalysis/formCheck idiom).
 *    On the real pipeline parseMoveNet has already dropped everything under
 *    that score, so this RE-APPLIES the app-wide gate rather than adding
 *    protection — it is load-bearing only for a caller that has not;
 *  - the body must be EXTENDED — |nose→ankle vertical span| >=
 *    {@link ORIENTATION_SPAN_TORSO_MIN} x torso length. Standing reads ≈3.0
 *    torsos; a crouch, a sit, or a body lying across the frame reads well
 *    under it and abstains;
 *  - that span must also be >= {@link ORIENTATION_SEPARATION_MIN_FRAC} of
 *    the frame's whole detected vertical extent, so a raised arm (mid
 *    shooting motion) or a partially framed body abstains instead of voting;
 *  - the body must be reasonably STILL — filtered anchor speed <=
 *    {@link ORIENTATION_STILL_MAX_SPANS_PER_SEC} spans/second, measured
 *    against the previous full-anatomy frame no more than
 *    {@link ORIENTATION_MAX_DT_SEC} old. No usable previous frame means
 *    stillness cannot be VERIFIED, and an unverifiable frame abstains (the
 *    same refuse-don't-guess rule formCheck's standing collector applies);
 *  - {@link ORIENTATION_AGREE_FRAMES} qualifying frames must agree in a row
 *    before anything is committed, and a gap longer than
 *    {@link ORIENTATION_VOTE_STALE_SEC} between qualifying frames restarts
 *    the run.
 * The verdict then LATCHES. Re-evaluating mid-session is not an improvement:
 * buffer orientation is fixed for a camera session, and a verdict that
 * flipped halfway through a capture would corrupt half the reps in a way
 * nobody could see. Call {@link PoseOrientationDetector.reset} when the
 * camera changes or a new session starts.
 *
 * HONESTY CONTRACT
 * ----------------
 *  - 'unknown' is returned until every gate has been met. It means NOT
 *    VERIFIED, never "probably fine": the caller must leave the keypoints
 *    untouched AND say the orientation is unverified.
 *  - A correction that fires must be surfaced in the UI — read
 *    {@link PoseOrientationDetector.state} for the badge — and
 *    {@link PoseOrientationDetector.override} exists so a wrong call can be
 *    corrected by a human instead of silently spoiling a session.
 *  - Nothing here invents a keypoint, a score, or a confidence.
 *
 * Pure TypeScript: no I/O and no wall clock — time comes exclusively from
 * the camera timestamps on each {@link PoseFrame}.
 */
import { FORM } from './config';
import { OneEuroFilter } from './formAnalysis';
import { SEQ_KEYPOINT_ORDER } from './formSequence';
import type { PoseFrame, PoseKeypoint, PoseKeypointName } from './types';

// ---------------------------------------------------------------------------
// Verdict + tunables
// ---------------------------------------------------------------------------

/**
 * Vertical orientation of the pose buffer.
 *  - 'upright' — the nose sits above the ankles; feed the keypoints through.
 *  - 'flipped' — the buffer arrived 180°-rotated; correct before use.
 *  - 'unknown' — NOT VERIFIED. Leave the data alone and say so.
 */
export type PoseOrientation = 'upright' | 'flipped' | 'unknown';

/** Who decided the latched verdict (the formCheck HandSource idiom). */
export type OrientationSource = 'auto' | 'manual';

/**
 * Why the most recent frame did not vote. DIAGNOSTIC VOCABULARY ONLY —
 * nothing branches on it; it exists so a detector that never commits can be
 * explained on-device instead of re-derived by hand.
 *  - 'noHead'        — no score-gated nose.
 *  - 'noAnkle'       — neither ankle score-gated.
 *  - 'noTorso'       — no shoulder or no hip, so there is no body scale.
 *  - 'degenerate'    — non-finite time, or a zero-length span/torso/extent.
 *  - 'notExtended'   — span/torso below the standing threshold (crouch, sit).
 *  - 'lowSeparation' — the span is a small part of the body's extent (raised
 *                      arm, partial framing) — too ambiguous to vote.
 *  - 'noBaseline'    — no previous full-anatomy frame within
 *                      {@link ORIENTATION_MAX_DT_SEC}: stillness is
 *                      unverifiable, so the frame abstains.
 *  - 'moving'        — measured motion above the stillness ceiling.
 */
export type OrientationAbstain =
  | 'noHead'
  | 'noAnkle'
  | 'noTorso'
  | 'degenerate'
  | 'notExtended'
  | 'lowSeparation'
  | 'noBaseline'
  | 'moving';

/**
 * Qualifying frames that must agree in a row before the verdict latches. 8 is
 * long enough that no single mis-tracked frame can commit, short enough that
 * the verdict is settled during the shadow-rep calibration phase rather than
 * several reps into a session.
 *
 * It counts QUALIFYING frames, not elapsed time. Abstaining frames never
 * break a run (only a gap longer than {@link ORIENTATION_VOTE_STALE_SEC}
 * between two VOTING frames does), so 8 frames is ≈0.53 s only when the
 * shooter holds a clean standing pose right through them; in a session where
 * most frames abstain the same run can be stitched from observations several
 * seconds apart. That is deliberate — a keypoint dropout must not cost the
 * shooter their verdict — but it is a frame count, and the elapsed time it
 * represents is not bounded by this constant.
 */
export const ORIENTATION_AGREE_FRAMES = 8;

/**
 * Minimum |nose→ankle vertical span| / torso length for a body to count as
 * STANDING. Anthropometrically the nose→ankle span is ≈0.90 of stature
 * (formCheck.NOSE_TO_ANKLE_STATURE_FRAC) and the shoulder→hip torso ≈0.30,
 * so standing reads ≈3.0. A deep crouch folds that to ≈2.0 and a seated body
 * lower still. 2.2 keeps a comfortable margin under standing while refusing
 * every folded posture — and, because it compares a VERTICAL span against a
 * EUCLIDEAN torso, it also refuses a body lying across the frame (a 90°
 * buffer rotation), which this module must never pretend to fix.
 */
export const ORIENTATION_SPAN_TORSO_MIN = 2.2;

/**
 * The nose→ankle span must be at least this fraction of the frame's whole
 * detected vertical extent. Standing with the arms down reads ≈0.97 (the
 * eyes sit a hair above the nose); an arm raised into a shooting motion, or
 * a body only partly inside the analysis crop, drops it well below 0.85 and
 * the frame abstains rather than voting on an ambiguous silhouette.
 */
export const ORIENTATION_SEPARATION_MIN_FRAC = 0.85;

/**
 * Stillness ceiling in nose→ankle SPANS per second, measured on One-Euro
 * filtered anchors. Normalizing by the body's own span makes the number
 * camera-distance independent: 0.5 spans/s is ≈0.45 statures/s, i.e. ≈0.8
 * m/s for a 1.8 m shooter — under a walk, well under a jump take-off
 * (≈2.5 m/s), and far above the residual jitter the filter leaves on a
 * standing subject. The filter is what makes the number meaningful: RAW
 * MoveNet jitter alone can read several tenths of a span per second, which
 * is why formCheck's standing collector filters before measuring speed too.
 */
export const ORIENTATION_STILL_MAX_SPANS_PER_SEC = 0.5;

/**
 * Oldest previous full-anatomy frame a stillness measurement may reference.
 * 0.25 s ≈ 4 fps: past that, "how far did it move" says nothing about
 * whether the subject was still in between.
 */
export const ORIENTATION_MAX_DT_SEC = 0.25;

/**
 * Gap between two QUALIFYING frames that restarts the agreement run. Frames
 * that abstain never break a run — a keypoint dropout must not cost the
 * shooter their verdict — but a run stitched across a second of unobserved
 * time is not agreement, it is two separate observations.
 */
export const ORIENTATION_VOTE_STALE_SEC = 1.0;

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Snapshot of the detector for the UI and for on-device diagnostics.
 * Allocates — poll it at UI rate, never per camera frame.
 */
export interface PoseOrientationState {
  /** Latched verdict; 'unknown' until every gate has been met. */
  verdict: PoseOrientation;
  /** True once the verdict is latched (auto-committed or overridden). */
  committed: boolean;
  /** Who committed it; null while uncommitted. */
  source: OrientationSource | null;
  /** Orientation the current run is voting for; null when no run is open. */
  pending: 'upright' | 'flipped' | null;
  /** Qualifying frames currently agreeing on `pending`. */
  agreeing: number;
  /** Frames pushed since the last reset (frozen once committed). */
  frames: number;
  /** Qualifying (voting) frames since the last reset (frozen at commit). */
  qualified: number;
  /** Why the most recent frame did not vote; null when it did. */
  lastAbstain: OrientationAbstain | null;
}

/** Score-gated keypoint lookup (FORM.keypointScoreMin, same gate app-wide). */
function scored(pose: PoseFrame, name: PoseKeypointName): PoseKeypoint | null {
  const kp = pose.keypoints[name];
  if (kp == null || kp.score < FORM.keypointScoreMin) return null;
  if (!Number.isFinite(kp.x) || !Number.isFinite(kp.y)) return null;
  return kp;
}

/**
 * Vertical extent of every score-gated landmark in a frame (max y − min y),
 * or null when nothing is usable. Allocation-free: it walks the fixed
 * COCO-17 order rather than materializing the key list per frame.
 */
function verticalExtent(pose: PoseFrame): number | null {
  let min = Infinity;
  let max = -Infinity;
  for (const name of SEQ_KEYPOINT_ORDER) {
    const kp = scored(pose, name);
    if (kp == null) continue;
    if (kp.y < min) min = kp.y;
    if (kp.y > max) max = kp.y;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return max - min;
}

/**
 * Accumulator that decides the buffer's vertical orientation from a stream
 * of {@link PoseFrame}s. Feed it the RAW parser output (never a frame you
 * already corrected), then correct with {@link correctPoseFrame} using the
 * verdict it returns.
 *
 * Frames pushed before the verdict commits are, by contract, delivered to
 * consumers UNCORRECTED — which is why the detector should be running during
 * the pre-live / calibration phase, so the verdict is settled before any rep
 * is scored.
 *
 * THE COMMIT IS A COORDINATE-SPACE CHANGE, AND THE CALLER OWNS IT. On the
 * 'unknown' → 'flipped' edge (and on every {@link override} that turns the
 * correction on or off) the stream downstream of {@link correctPoseFrame}
 * starts arriving in a DIFFERENT space from the frames before it. Anything
 * the caller derived from the earlier frames — locked baselines, rolling
 * windows, scored reps — was measured in the old space and must be thrown
 * away, or it will be silently compared against the new one. Form Check
 * rebuilds its whole session on that edge; see src/app/formcheck.tsx.
 */
export class PoseOrientationDetector {
  private verdictValue: PoseOrientation = 'unknown';
  private sourceValue: OrientationSource | null = null;
  private pendingValue: 'upright' | 'flipped' | null = null;
  private agreeing = 0;
  private framesSeen = 0;
  private qualifiedFrames = 0;
  private lastAbstainValue: OrientationAbstain | null = null;
  /** Camera time of the most recent QUALIFYING frame (run staleness). */
  private lastVoteT: number | null = null;

  /**
   * Previous full-anatomy frame's filtered anchors — mutated in place so the
   * hot path allocates nothing per camera frame.
   */
  private prevT: number | null = null;
  private prevNoseX = 0;
  private prevNoseY = 0;
  private prevAnkleX = 0;
  private prevAnkleY = 0;
  private prevHipX = 0;
  private prevHipY = 0;

  /**
   * One-Euro channels for the three motion anchors (formCheck's standing
   * collector idiom: filter, then measure speed). They smooth the STILLNESS
   * measurement only — the orientation vote itself reads raw coordinates,
   * where a filter could only add lag to a sign test.
   */
  private readonly fNoseX = new OneEuroFilter(FORM.oneEuro);
  private readonly fNoseY = new OneEuroFilter(FORM.oneEuro);
  private readonly fAnkleX = new OneEuroFilter(FORM.oneEuro);
  private readonly fAnkleY = new OneEuroFilter(FORM.oneEuro);
  private readonly fHipX = new OneEuroFilter(FORM.oneEuro);
  private readonly fHipY = new OneEuroFilter(FORM.oneEuro);

  /** Latched verdict; 'unknown' until every gate has been met. */
  get verdict(): PoseOrientation {
    return this.verdictValue;
  }

  /** True once the verdict is latched (auto-committed or overridden). */
  get committed(): boolean {
    return this.verdictValue !== 'unknown';
  }

  /**
   * Feed one parsed pose frame and get the current verdict. Returns
   * 'unknown' until the agreement run completes; once it commits, every
   * later push is a cheap latched read that evaluates nothing.
   */
  push(pose: PoseFrame): PoseOrientation {
    if (this.verdictValue !== 'unknown') return this.verdictValue;
    this.framesSeen++;

    const t = pose.t;
    if (!Number.isFinite(t)) return this.abstain('degenerate');

    // — anatomy —
    const nose = scored(pose, 'nose');
    if (nose == null) return this.abstain('noHead');

    const la = scored(pose, 'left_ankle');
    const ra = scored(pose, 'right_ankle');
    if (la == null && ra == null) return this.abstain('noAnkle');
    const ankleX = la != null && ra != null ? (la.x + ra.x) / 2 : (la ?? ra)!.x;
    const ankleY = la != null && ra != null ? (la.y + ra.y) / 2 : (la ?? ra)!.y;

    const ls = scored(pose, 'left_shoulder');
    const rs = scored(pose, 'right_shoulder');
    const lh = scored(pose, 'left_hip');
    const rh = scored(pose, 'right_hip');
    if ((ls == null && rs == null) || (lh == null && rh == null)) {
      return this.abstain('noTorso');
    }
    const shX = ls != null && rs != null ? (ls.x + rs.x) / 2 : (ls ?? rs)!.x;
    const shY = ls != null && rs != null ? (ls.y + rs.y) / 2 : (ls ?? rs)!.y;
    const hipX = lh != null && rh != null ? (lh.x + rh.x) / 2 : (lh ?? rh)!.x;
    const hipY = lh != null && rh != null ? (lh.y + rh.y) / 2 : (lh ?? rh)!.y;

    const torso = Math.hypot(hipX - shX, hipY - shY);
    const span = ankleY - nose.y; // +y DOWN, so positive = ankles below nose
    const absSpan = Math.abs(span);
    if (!(torso > 0) || !(absSpan > 0)) return this.abstain('degenerate');

    // — stillness, measured against the previous full-anatomy frame —
    // Filter first (formCheck's standing collector does the same), and
    // update the baseline for EVERY full-anatomy frame whatever the posture
    // gates below decide: the next frame's stillness test needs a FRESH
    // reference more than it needs a well-posed one.
    const noseFX = this.fNoseX.filter(nose.x, t);
    const noseFY = this.fNoseY.filter(nose.y, t);
    const ankleFX = this.fAnkleX.filter(ankleX, t);
    const ankleFY = this.fAnkleY.filter(ankleY, t);
    const hipFX = this.fHipX.filter(hipX, t);
    const hipFY = this.fHipY.filter(hipY, t);

    const dt = this.prevT == null ? NaN : t - this.prevT;
    let motion: number | null = null;
    if (Number.isFinite(dt) && dt > 0 && dt <= ORIENTATION_MAX_DT_SEC) {
      const dNose = Math.hypot(noseFX - this.prevNoseX, noseFY - this.prevNoseY);
      const dAnkle = Math.hypot(
        ankleFX - this.prevAnkleX,
        ankleFY - this.prevAnkleY,
      );
      const dHip = Math.hypot(hipFX - this.prevHipX, hipFY - this.prevHipY);
      motion = Math.max(dNose, dAnkle, dHip) / dt / absSpan;
    }
    this.prevT = t;
    this.prevNoseX = noseFX;
    this.prevNoseY = noseFY;
    this.prevAnkleX = ankleFX;
    this.prevAnkleY = ankleFY;
    this.prevHipX = hipFX;
    this.prevHipY = hipFY;

    // — posture: standing, and unambiguously separated —
    if (absSpan < ORIENTATION_SPAN_TORSO_MIN * torso) {
      return this.abstain('notExtended');
    }
    const extent = verticalExtent(pose);
    if (extent == null || !(extent > 0)) return this.abstain('degenerate');
    if (absSpan < ORIENTATION_SEPARATION_MIN_FRAC * extent) {
      return this.abstain('lowSeparation');
    }

    if (motion == null) return this.abstain('noBaseline');
    if (motion > ORIENTATION_STILL_MAX_SPANS_PER_SEC) {
      return this.abstain('moving');
    }

    // — the vote —
    const dir: 'upright' | 'flipped' = span > 0 ? 'upright' : 'flipped';
    const stale =
      this.lastVoteT != null && t - this.lastVoteT > ORIENTATION_VOTE_STALE_SEC;
    if (stale || this.pendingValue !== dir) {
      this.pendingValue = dir;
      this.agreeing = 1;
    } else {
      this.agreeing++;
    }
    this.lastVoteT = t;
    this.qualifiedFrames++;
    this.lastAbstainValue = null;

    if (this.agreeing >= ORIENTATION_AGREE_FRAMES) {
      this.verdictValue = dir;
      this.sourceValue = 'auto';
    }
    return this.verdictValue;
  }

  /**
   * Latch a verdict by hand — the human escape hatch the honesty contract
   * requires, so a wrong automatic call can be overridden instead of quietly
   * spoiling a session. Passing 'unknown' is a {@link reset}: it clears the
   * latch and lets the detector start over.
   */
  override(verdict: PoseOrientation): void {
    if (verdict === 'unknown') {
      this.reset();
      return;
    }
    this.verdictValue = verdict;
    this.sourceValue = 'manual';
    // The run is CLEARED, not filled in. No frame voted for a manual verdict,
    // so reporting a full agreement run would be a fabricated count in a
    // module whose contract is that it invents nothing — `state().agreeing`
    // is a published diagnostic. `source: 'manual'` is what carries the
    // truth, and the latch is `verdictValue !== 'unknown'`, so push() returns
    // before either field is read again.
    this.pendingValue = null;
    this.agreeing = 0;
    this.lastAbstainValue = null;
  }

  /** Forget everything, latch included. Call on camera change / restart. */
  reset(): void {
    this.verdictValue = 'unknown';
    this.sourceValue = null;
    this.pendingValue = null;
    this.agreeing = 0;
    this.framesSeen = 0;
    this.qualifiedFrames = 0;
    this.lastAbstainValue = null;
    this.lastVoteT = null;
    this.prevT = null;
    this.prevNoseX = 0;
    this.prevNoseY = 0;
    this.prevAnkleX = 0;
    this.prevAnkleY = 0;
    this.prevHipX = 0;
    this.prevHipY = 0;
    this.fNoseX.reset();
    this.fNoseY.reset();
    this.fAnkleX.reset();
    this.fAnkleY.reset();
    this.fHipX.reset();
    this.fHipY.reset();
  }

  /** Snapshot for the UI badge and diagnostics. Allocates — poll at UI rate. */
  state(): PoseOrientationState {
    return {
      verdict: this.verdictValue,
      committed: this.verdictValue !== 'unknown',
      source: this.sourceValue,
      pending: this.pendingValue,
      agreeing: this.agreeing,
      frames: this.framesSeen,
      qualified: this.qualifiedFrames,
      lastAbstain: this.lastAbstainValue,
    };
  }

  private abstain(reason: OrientationAbstain): PoseOrientation {
    this.lastAbstainValue = reason;
    return this.verdictValue;
  }
}

// ---------------------------------------------------------------------------
// Correction
// ---------------------------------------------------------------------------

/**
 * Undo a 180° buffer rotation on one pose frame: (x, y) → (W − x, H − y) in
 * the analysis square the keypoints were parsed into (see the file header —
 * for Form Check that is POSE_INPUT x POSE_INPUT, not the camera frame).
 *
 * Body-side labels are deliberately left ALONE: a rotation preserves
 * chirality, so the anatomical left/right MoveNet reported is already right,
 * and swapping the names would corrupt the shooting-hand logic.
 *
 * Returns the SAME OBJECT REFERENCE when no correction applies — for an
 * 'upright' or 'unknown' verdict, and for a frame size that cannot define a
 * rotation (non-finite or non-positive). Callers can therefore detect a
 * no-op with `out === frame`, and must not read an identical reference back
 * as "corrected": with an unusable size the data is honestly left alone
 * rather than mangled.
 *
 * Pure: allocates exactly one new frame when it fires, and the transform is
 * its own inverse, so correcting a corrected frame restores the original.
 */
export function correctPoseFrame(
  frame: PoseFrame,
  verdict: PoseOrientation,
  size: { width: number; height: number },
): PoseFrame {
  if (verdict !== 'flipped') return frame;
  const { width, height } = size;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !(width > 0) ||
    !(height > 0)
  ) {
    return frame;
  }
  const keypoints: PoseFrame['keypoints'] = {};
  for (const name of SEQ_KEYPOINT_ORDER) {
    const kp = frame.keypoints[name];
    if (kp == null) continue;
    keypoints[name] = { x: width - kp.x, y: height - kp.y, score: kp.score };
  }
  return { t: frame.t, keypoints };
}
