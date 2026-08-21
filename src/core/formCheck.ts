/**
 * Form Check — hoop-free, ball-free shooting-motion analysis.
 *
 * The Form Check screen (src/app/formcheck.tsx) points the camera at the
 * SHOOTER, not the hoop: no ball is ever tracked, so nothing here can — or
 * ever tries to — claim a make or a miss. A "rep" is a detected shooting
 * MOTION: the pose-only {@link FormMotionDetector} (wrist above the shoulder
 * + an upward wrist-velocity spike + elbow extension, debounced) fires on
 * the wrist-snap signature, and this module turns each event into pose-only
 * {@link FormMetrics} plus a packed {@link FormSequence} for the motion
 * theater.
 *
 * WHY NOT FormAnalyzer: its stage machine is structurally ball-gated — the
 * WAIT→PICKUP transition and checkRelease() both require a TrackedBall, so
 * without a ball it never leaves WAIT and finalize() returns all-null. This
 * module reuses its PRIMITIVES instead (OneEuroFilter, angleAtDeg, the
 * "dip = max filtered wrist y" semantics, the follow-through windows) so a
 * Form Check rep and a live-session form report read the same motion the
 * same way. The deliberately mirrored constants are documented inline.
 *
 * V2 — CALIBRATION: a session now opens in a short shadow-rep calibration
 * phase ({@link CalibrationPhase} 'collecting'). The shooter takes
 * {@link SHADOW_REPS_TARGET} practice motions that are NEVER scored; during
 * them the session watches BOTH arms to auto-detect handedness, gauges how
 * side-on the shooter stands, estimates camera roll, and (with a profile
 * height) derives a px→metres scale. EVERY new number is confidence-gated
 * and degrades to plain v1 behavior with an honest label:
 *  - auto-handedness abstains (handSource stays 'settings') when the two-arm
 *    vote is ambiguous — MoveNet mirror-ghosts at side view, so the vote
 *    must be allowed to refuse;
 *  - tilt compensation applies ONLY when the estimate is steady (std ≤
 *    {@link TILT_STD_MAX_DEG}) and small (≤ {@link TILT_MAX_COMP_DEG});
 *    otherwise metrics are reported uncompensated, never silently "fixed";
 *  - metres appear only with a stated profile height and a stable standing
 *    span; otherwise reps keep v1's normalized release height verbatim;
 *  - shadow baselines only ANNOTATE scored reps ({@link RepFlag}) — they
 *    never gate, fabricate, or modify a metric.
 *
 * HONESTY CONTRACT (enforced by construction, pinned by tests):
 *  - releaseAngleDeg / entryAngleDeg are ALWAYS null — they are ball-
 *    trajectory numbers this mode cannot see. Never fabricated.
 *  - releaseTimeMs is dip→release (the pickup needs the ball); the UI labels
 *    it "Dip → release", never HomeCourt's pickup→release.
 *  - Readiness refuses below MIN_POSE_FPS or without the full body + the
 *    shooting arm in frame — the same refuse-don't-guess contract Jump Lab
 *    ships (src/core/jumpLab.ts MIN_FPS). V2 adds a side-profile gate that
 *    degrades to PASS when unmeasurable (occlusion is not evidence of facing
 *    the camera).
 *  - Cross-rep consistency spreads need MIN_SPREAD_REPS measured reps; with
 *    fewer the stat is null with a reason, never a fabricated spread.
 *  - releaseHeightM is an ESTIMATE derived from the user's stated height and
 *    an anthropometric constant; it must never feed the spreads (those stay
 *    in normalized units so the verdict is scale-independent).
 *
 * V3 — DEMO HARDENING: the room a Form Check runs in is not a gym. Four
 * gates were tuned for a live-game shot and refused a deliberate, slow,
 * BALL-FREE demo motion outright; every relaxation below is paired with the
 * confidence consequence it carries, reported in the data so the screen can
 * say it out loud:
 *  - motion detection moved off the live-game {@link RELEASE} tuning onto
 *    {@link FORM_MOTION} ({@link FormMotionDetector}) — a slow arm rise and
 *    a 130° "push" that never fully extends now count. The trade is stated,
 *    not hidden: this is a deliberately SENSITIVE motion counter, and a
 *    raised arm can count as a rep. It still cannot fabricate a metric —
 *    every number stays computed from the captured window, or null.
 *  - the side-profile gate opens to {@link SIDE_PROFILE_MIN} (≈40° of
 *    tolerance); a rep captured below {@link SIDE_PROFILE_TRUSTED} carries
 *    the 'angledStance' reason, because 2D angles foreshorten when the
 *    shooter is turned toward the camera.
 *  - full-body visibility accepts ONE hip and knees-as-base; nothing is
 *    fabricated because every metric that needs the missing landmark
 *    (kneeFlexionDeg, the metre scale) is already null-gated.
 *  - the {@link MIN_POSE_FPS} floor gains an explicit, labeled override
 *    ({@link FormCheckSession.overrideFpsFloor}) instead of being lowered:
 *    reps counted under it carry the 'lowPoseFps' reason and the floor
 *    itself never moves.
 *  - the detector feed is latched for {@link READY_LATCH_SEC} so a keypoint
 *    dropout at the top of a motion cannot silently swallow the rep; a rep
 *    captured through a dropout carries the 'gateDropout' reason.
 * Reasons live on {@link FormCheckRep.lowConfidence} and are counted in
 * {@link FormCheckSessionReport.lowConfidence}. RELAXING A GATE IS ALLOWED;
 * CLAIMING A CLEAN CAPTURE THAT DID NOT HAPPEN IS NOT.
 *
 * V4 — MEASURE AT THE RIGHT FRAME, JUDGE AGAINST THE RIGHT BAND. V3 bought
 * back the ball-free demo motion; V4 stops mis-reporting it. Every item is a
 * SUPPRESSION or a re-aim of an existing comparison — none of them makes a
 * number easier to claim:
 *  - THE GATHER GATE ({@link dipGatherOf}): {@link findDip} is a global
 *    argmax, so on a rep that starts from rest it picks the HANGING ARM and
 *    reports a ~165° "set point" against FORM's 75-90° band. The three
 *    dip-frame numbers are now refused when that frame is not a plausible
 *    gather, each refusal carrying its reason ({@link MetricRefusal}).
 *  - the dip epsilon is body-relative ({@link dipEpsFor}) — a fixed 0.25 px
 *    confirms a dip off keypoint jitter on a ~130 px shooter.
 *  - the follow-through is judged against {@link FT_ELBOW_MIN_DEG}, the
 *    detector's own fire point, with a frame-resolution tolerance at both
 *    ends of the window ({@link followThroughHeldFull}). config.FORM.
 *    followThrough is untouched — the live pipeline still reads it.
 *  - the RE-ARM GATE: a held follow-through cannot mint a rep per debounce
 *    period any more; the wrist has to come back to the shoulder first.
 *  - {@link computePhaseTiming} takes the same tilt as the metrics, so both
 *    dips are found in one rotated space.
 *
 * V5 — AN ESCAPE FROM EVERY PAUSING GATE. A pausing gate with no override is
 * a dead end on stage: the room decides where the shooter is allowed to
 * stand, and "turn 90°" is not an instruction a demo floor can always
 * satisfy. The side-profile gate now has the same labeled escape the fps
 * floor has ({@link FormCheckSession.overrideSideFloor}), and the same price:
 *  - {@link SIDE_PROFILE_MIN} does NOT move. `readiness.sideOverridden` says
 *    the override is the only thing carrying the gate, and every rep caught
 *    under it carries the EXISTING 'angledStance' reason — a stance below
 *    {@link SIDE_PROFILE_TRUSTED} already meant exactly "these 2D angles are
 *    foreshortened", so the reason is extended to the relaxed gate rather
 *    than duplicated by a new one.
 *  - THE GATE MOVED; THE MATH DID NOT. Below {@link SIDE_PROFILE_MIN} the 2D
 *    joint angles are foreshortened past the point where the number means
 *    anything, so setPointElbowDeg, kneeFlexionDeg and BOTH follow-through
 *    readings are REFUSED ({@link MetricRefusalKind} 'stanceNotSideOn')
 *    instead of reported small. What survives is what a yaw cannot distort:
 *    the dip→release tempo, the release height, and the phase bars.
 *
 * Pure TypeScript: no I/O, no wall clock — time comes exclusively from the
 * camera timestamps on each {@link PoseFrame}.
 */
import { FORM } from './config';
import { coachingTips, OneEuroFilter } from './formAnalysis';
import {
  buildSequence,
  SEQ_WINDOW_SEC,
  type RawSeqFrame,
} from './formSequence';
import { angleAtDeg, clamp } from './geometry';
import { metersPerPxFromHeight } from './jumpLab';
import type {
  CoachingTip,
  FormMetrics,
  FormSequence,
  Point,
  PoseFrame,
  PoseKeypointName,
  ShootingHand,
} from './types';

// ---------------------------------------------------------------------------
// Tunables (local by design — coaching heuristics, not pipeline config)
// ---------------------------------------------------------------------------

/** Refuse to count reps below this pose rate (Jump Lab's MIN_FPS contract). */
export const MIN_POSE_FPS = 15;

/**
 * Floor the presenter's fps override still respects. Below it the override
 * buys nothing to override WITH: {@link MOTION_MAX_VY_GAP_SEC} (0.15 s)
 * rejects every velocity sample once frames are further apart than that, so
 * no motion can fire however open the gate is. 8 fps ⇒ dt 0.125 s, the last
 * rate where consecutive wrist samples still make a velocity.
 */
export const FPS_OVERRIDE_MIN = 8;

/**
 * How long the motion detector keeps being fed after the readiness gates
 * drop. The gates are trailing-window fractions, and the top of a shooting
 * motion is exactly when keypoints go missing (the raised wrist can leave
 * the analysis crop) — an ungated feed would stop mid-signature and the rep
 * would silently vanish. The latch feeds the detector THROUGH the dropout;
 * the banner, the chips and the calibration collector keep using the strict
 * verdict, and any rep captured across a latched frame is reported
 * 'gateDropout' rather than passed off as a clean capture.
 */
export const READY_LATCH_SEC = 1.0;

/**
 * Motion-detection tuning, Form-Check-local by design.
 *
 * {@link RELEASE} in config.ts is the LIVE-GAME release tuning: it assumes a
 * ball to push against and a shot at game speed (0.3 frame-heights/s of
 * upward wrist travel, a 150° elbow, a 1.5 s cooldown between shots). Form
 * Check points the camera at a shooter with NO ball, often a slow deliberate
 * demonstration motion, standing far enough away that the whole body is
 * ~130 px of the 192 analysis square — dip-to-overhead wrist travel is then
 * ~50-60 px, so a 1 s rise peaks near 50 px/s against a 57.6 px/s floor, and
 * a ball-free "push" routinely stops the elbow at 130-145°. Under the live
 * tuning that motion fires NOTHING while every readiness chip reads green.
 *
 * These values buy that motion back. The cost is stated plainly in the
 * module contract: this is a deliberately sensitive MOTION counter, not a
 * shot detector, and a raised arm can count. config.ts is deliberately NOT
 * touched — src/pipeline/shotPipeline.ts must keep the strict live tuning.
 */
export const FORM_MOTION = {
  /** Upward wrist-speed floor, frame-heights/sec (RELEASE's is 0.3). */
  minUpwardWristVyFracPerSec: 0.12,
  /** Elbow-extension floor, degrees (RELEASE's is 150). */
  minElbowExtensionDeg: 130,
  /**
   * Co-occurrence window, seconds. DELIBERATELY LEFT at RELEASE's 0.3 after
   * a widened 0.5 was tried and reverted: with the shortened debounce below,
   * a 0.5 s window lets the wrist-above-shoulder and elbow-extended
   * conditions left over from the END of one motion pair with the fresh
   * upward spike at the START of the next and mint a rep nobody performed.
   * Lowering the elbow floor makes extension land EARLIER in a slow rise,
   * not later, so the slow-motion fixtures co-occur comfortably inside
   * 0.3 s — the window was never what refused them.
   */
  windowSec: 0.3,
  /**
   * Minimum spacing between counted motions, seconds (RELEASE's is 1.5 — a
   * live-game shot cooldown). A presenter demonstrating for an audience
   * fires three or four motions in four seconds and the counter has to
   * move. MUST stay above {@link FOLLOW_TAIL_SEC}: an event arriving while
   * a rep is still pending its tail is dropped, so a shorter debounce would
   * silently swallow reps again — the exact bug this fixes.
   */
  debounceSec: 0.8,
} as const;

/** Trailing window the readiness gates are judged over, seconds. */
export const READINESS_WINDOW_SEC = 2.0;

/**
 * How often the readiness verdict is recomputed, seconds. Samples are still
 * collected and pruned every frame — only the summary is throttled, and a
 * verdict may therefore be up to this stale. 10 Hz against a 2 s window and
 * a 4 Hz UI poll: invisible to both, and it keeps a per-frame triple array
 * allocation off the JS thread on an old phone.
 */
const READINESS_POLL_SEC = 0.1;

/**
 * Fraction of trailing frames that must pass a visibility check for its gate
 * to read OK. 80%: a couple of dropped keypoints must not flap the gate, but
 * a shooter half out of frame must fail it fast.
 */
export const VISIBILITY_MIN_FRAC = 0.8;

/**
 * Pose window captured BEFORE the release, seconds. Tied to the packer's own
 * window (formSequence.SEQ_WINDOW_SEC = 1.2 s) so a Form Check sequence spans
 * exactly what a live-session capture spans: dip → release.
 */
export const PRE_RELEASE_SEC = SEQ_WINDOW_SEC;

/** Follow-through tail captured AFTER the release, seconds. */
export const FOLLOW_TAIL_SEC = 0.5;

/**
 * Rolling raw-frame retention, seconds. Must cover PRE_RELEASE_SEC +
 * FOLLOW_TAIL_SEC (1.7 s) — the oldest frame a rep needs is that old by the
 * time its tail completes. FormSequenceBuffer is NOT reused here because its
 * 1.2 s prune would have dropped the dip by then.
 *
 * 3.0, not the old 2.0: the prune runs on the CURRENT frame's timestamp, so
 * the 0.3 s of slack 2.0 left had to absorb the whole tail's worth of late
 * frames. One stalled delivery — the JS-thread hop has no backpressure — and
 * the window's oldest frames (the dip, the descent onset) are gone by
 * finalize time, which reads as a rep that silently lost its set point. The
 * cost is ~1 s more of a ≤17-entry Map ring; the dip is the one frame every
 * refusal in this module is judged against.
 */
export const REP_BUFFER_SEC = 3.0;

/** Minimum reps that must have measured a metric before a spread is real. */
export const MIN_SPREAD_REPS = 3;

/**
 * Consistency flag thresholds — coaching heuristics for the report's verdict
 * chips, NOT pipeline tunables (hence local, no config.ts edit). An elbow
 * set-point wobbling more than ±7° or a tempo varying more than ±150 ms
 * rep-to-rep is the classic "grooving two different shots" signature; knee
 * and release-height flags are scaled to the same spirit.
 */
export const ELBOW_SPREAD_FLAG_DEG = 7;
export const TEMPO_SPREAD_FLAG_MS = 150;
export const KNEE_SPREAD_FLAG_DEG = 8;
/** Release-height spread flag, in frame-height fractions (camera-relative). */
export const RELEASE_HEIGHT_SPREAD_FLAG = 0.04;

// — v2 calibration constants —

/** Shadow (unscored practice) reps that complete calibration. */
export const SHADOW_REPS_TARGET = 2;

/**
 * Side-profile gauge floor for the readiness side gate (0..1, 1 = side-on).
 * 0.35 ≈ 40° of tolerance off a true profile. It was 0.6 (≈24°), which in an
 * unknown room — where the shooter stands where the furniture allows —
 * pauses the whole session with no override and no way to comply. The gate
 * still fails a MEASURED face-on stance, and still passes when the gauge
 * cannot vote (occlusion is not evidence of facing the camera).
 *
 * V5: the value is also the floor the METRIC MATH respects. A measured
 * stance below it can now be counted through
 * {@link FormCheckSession.overrideSideFloor}, but every 2D joint angle read
 * there is refused ('stanceNotSideOn'), so relaxing the gate never turns
 * this threshold into a softer one — it only moves what the threshold is
 * allowed to pause.
 */
export const SIDE_PROFILE_MIN = 0.35;

/**
 * Above this the side view is square enough to trust 2D joint angles.
 * Between {@link SIDE_PROFILE_MIN} and here the session still counts reps —
 * refusing would brick a workable setup — but elbow and knee angles are
 * foreshortened and read SMALLER than truth, so those reps carry the
 * 'angledStance' reason and the UI must qualify them.
 */
export const SIDE_PROFILE_TRUSTED = 0.6;

/** Tilt estimates spread wider than this (deg, sample std) are unconfident. */
export const TILT_STD_MAX_DEG = 3;

/** Never compensate a roll larger than this — ask for a level phone instead. */
export const TILT_MAX_COMP_DEG = 15;

/**
 * Nose→ankle span as a fraction of full standing stature. Anthropometric:
 * the eye/nose line sits ~0.93–0.94 of stature and the ankle joint ~0.04
 * above the floor, so the nose→ankle span covers ~0.90 of stature. MoveNet's
 * nose ≠ head-top and ankle ≠ floor offsets are exactly why every metre this
 * scale produces is labeled an estimate (±5–10%).
 */
export const NOSE_TO_ANKLE_STATURE_FRAC = 0.9;

export type HandSource = 'settings' | 'auto' | 'manual';
export type CalibrationPhase = 'collecting' | 'done' | 'skipped';
export type RepFlag = 'shallowDip' | 'stanceDrift';

/**
 * Why a counted rep is LOW CONFIDENCE — the price of a relaxed gate, carried
 * in the data so the UI can state it instead of quietly presenting a relaxed
 * capture as a clean one. Never a reason to hide a rep: the rep was really
 * observed, its numbers were really computed, they are simply worth less.
 *  - 'lowPoseFps'   — the rep's own window ran under {@link MIN_POSE_FPS}, so
 *                     dip→release tempo and phase timing are coarse. Usually
 *                     the presenter's fps override, but NOT only that: this
 *                     is the median over the REP's window while the gate
 *                     reads the readiness window, so a brief dip the gate
 *                     never saw can still land here.
 *  - 'gateDropout'  — readiness dropped inside the rep's window and
 *                     {@link READY_LATCH_SEC} carried the detector through
 *                     it; some landmarks were missing while it was captured.
 *  - 'angledStance' — the shooter was measurably angled toward the camera
 *                     (< {@link SIDE_PROFILE_TRUSTED}), so 2D elbow and knee
 *                     angles are foreshortened and read small.
 */
export type RepConfidenceReason = 'lowPoseFps' | 'gateDropout' | 'angledStance';

/**
 * Runtime witness for {@link RepConfidenceReason}. Decoding a receipt out of
 * a stored blob must not promote arbitrary strings into the union.
 */
export const REP_CONFIDENCE_REASONS: readonly RepConfidenceReason[] = [
  'lowPoseFps',
  'gateDropout',
  'angledStance',
];

/**
 * MIRRORED from FormAnalyzer (private there): the wrist must rise this many
 * px past its running max before the dip is confirmed. Keeping the value in
 * lockstep keeps Form Check's dip the same dip a live session reports.
 */
export const DIP_EPS_PX = 0.25;

/** Body-relative dip epsilon: a real rise is ≥ 2% of the shooter's height. */
export const DIP_EPS_BODY_FRAC = 0.02;

/** Floor for the body-relative epsilon, px — never below the 1 px grid. */
export const DIP_EPS_MIN_PX = 1.0;

/**
 * The dip-confirmation epsilon for a shooter of this pixel height:
 * max(2% of the body, 1 px). Null body height (no estimate this window) ⇒
 * the mirrored {@link DIP_EPS_PX} default, unchanged.
 */
export function dipEpsFor(bodyHeightPx: number | null | undefined): number {
  if (bodyHeightPx == null || !Number.isFinite(bodyHeightPx) || bodyHeightPx <= 0) {
    return DIP_EPS_PX;
  }
  return Math.max(DIP_EPS_BODY_FRAC * bodyHeightPx, DIP_EPS_MIN_PX);
}

/**
 * Elbow ceiling for a plausible GATHER, degrees. FORM.elbowSetPoint bands a
 * real set point at 75-90°; 140 is deliberately far outside it so only an
 * ESSENTIALLY STRAIGHT arm is refused. An arm hanging at the side reads
 * 160-180°, which is what findDip's global argmax picks on a ball-free rep
 * that starts from rest — see {@link dipGatherOf}.
 */
export const GATHER_MAX_ELBOW_DEG = 140;

/**
 * How far below the hip the dip-frame wrist may sit and still be a gather,
 * as a fraction of body height. A low set point puts the wrist at hip level;
 * a hanging arm puts it at mid-thigh, ~0.15-0.2 body-heights lower.
 */
export const GATHER_WRIST_BELOW_HIP_FRAC = 0.05;

/** MIRRORED from FormAnalyzer (private FT_AVG_WINDOW_SEC): the follow-through
 *  elbow angle is averaged over this window after the release. */
const FT_AVG_WINDOW_SEC = 0.15;

/**
 * Form-Check-LOCAL follow-through elbow floor, degrees — the detector's OWN
 * fire point, by reference so the two can never drift apart.
 *
 * config.FORM.followThrough.elbowMinDeg is 155 and stays 155: the live shot
 * pipeline's FormAnalyzer reads it and must keep judging a game-speed
 * release. But Form Check COUNTS a rep at {@link FORM_MOTION}'s 130° push
 * (V3 bought that motion back deliberately), so judging that same rep's hold
 * against 155° reports "held 0 ms" on every ball-free rep — an ARM COLLAPSE
 * NOBODY WATCHED, and currently the top-priority spoken callout. A rep is
 * now judged against the extension that counted it: the hold is the time the
 * elbow stayed at least as open as the motion Form Check agreed to call a
 * rep.
 *
 * The stated cost: an arm that really does drop from 175° to 135° inside the
 * tail reads as HELD here, where a live-session FormAnalyzer would flag it.
 * Form Check cannot have it both ways — 155 makes the metric a constant 0
 * for the motion this mode exists to measure.
 */
export const FT_ELBOW_MIN_DEG = FORM_MOTION.minElbowExtensionDeg;

/**
 * Shoulder/hip x-separation (normalized by body height) of a shooter facing
 * the camera square-on. ~0.24 body-heights ≈ biacromial breadth / stature;
 * a true side profile reads near 0. The side gauge maps [0, 0.24] → [1, 0].
 */
const FRONT_SEP_N = 0.24;

/**
 * Fraction of trailing readiness frames that must carry a side-profile vote
 * (both shoulders scorable) before the gauge claims a value. Below it the
 * gauge reports null and the side gate PASSES: occlusion is not evidence of
 * facing the camera, and blocking on an unmeasurable gauge bricks good
 * setups.
 */
const SIDE_VOTE_MIN_FRAC = 0.4;

/** Minimum standing frames before a tilt estimate exists at all. */
const TILT_MIN_FRAMES = 10;

/** Minimum standing frames (nose + ankle) before a height scale exists. */
const HEIGHT_MIN_FRAMES = 10;

/** Standing-span jitter ceiling for the height scale (fraction of span). */
const HEIGHT_SPAN_STD_FRAC = 0.02;

/**
 * Two shadow release events from OPPOSITE arms within this window are ONE
 * motion double-fired by a mirror ghost (MoveNet hallucinates far joints on
 * near positions at side view) — resolved by keypoint-score comparison, or
 * an honest abstain.
 */
const GHOST_WINDOW_SEC = 0.3;

/** Mean-keypoint-score margin below which a ghost double-fire abstains. */
const GHOST_SCORE_TIE_FRAC = 0.1;

/** Winner-vs-loser wrist-travel ratio needed when both arms fired events. */
const HAND_TRAVEL_RATIO = 1.5;

/** Filtered-wrist speed ceiling for a "standing" frame, frame-heights/sec. */
const STANDING_WRIST_SPEED_FRAC = 0.1;

/** A still-wrist run must last this long before its frames count as standing. */
const STANDING_MIN_SEC = 0.5;

/** Standing-frame retention cap (memory bound; medians converge long before). */
const STANDING_FRAMES_CAP = 300;

/** A scored rep's dip stopping short of the shadow set point by more than
 *  this fraction of body height earns the 'shallowDip' flag. */
const SHALLOW_DIP_FRAC = 0.15;

/** Stance width deviating from the shadow baseline by more than this
 *  fraction earns the 'stanceDrift' flag. */
const STANCE_DRIFT_FRAC = 0.25;

// ---------------------------------------------------------------------------
// Readiness — the refuse-don't-guess gate
// ---------------------------------------------------------------------------

/** Per-frame visibility verdicts for the two readiness gates. */
export interface FrameVisibility {
  /** Head-or-shoulders AND a hip AND a lower-body base (ankle or knee). */
  fullBody: boolean;
  /** Shooting-side shoulder + elbow + wrist all visible. */
  arm: boolean;
}

/**
 * One trailing readiness sample (timestamp + that frame's visibility).
 * `sideness` is the frame's side-profile gauge ({@link sideProfileOf});
 * absent/null = the frame couldn't vote (missing shoulders) and abstains —
 * optional so pre-v2 call sites and fixtures still compile.
 */
export interface ReadinessSample extends FrameVisibility {
  t: number;
  sideness?: number | null;
}

export interface FormCheckReadiness {
  /** Median-dt pose rate over the trailing window, fps (0 with <2 frames). */
  fps: number;
  /** Fraction of trailing frames whose full body was visible, 0..1. */
  fullBodyFrac: number;
  /** Fraction of trailing frames whose shooting arm was visible, 0..1. */
  armFrac: number;
  /**
   * Trailing-window mean of the non-null side-profile votes, or null when
   * fewer than {@link SIDE_VOTE_MIN_FRAC} of the window's frames could vote
   * (the gauge honestly refuses rather than guessing from occlusion).
   */
  sideness: number | null;
  fpsOk: boolean;
  fullBodyOk: boolean;
  armOk: boolean;
  /** Side gate: sideness ≥ SIDE_PROFILE_MIN — PASSES when unmeasurable. */
  sideOk: boolean;
  /** All four gates pass — reps may be counted. */
  ready: boolean;
  /**
   * The measured rate is BELOW {@link MIN_POSE_FPS} and only the presenter's
   * explicit override is carrying `fpsOk`. The floor itself never moved:
   * timing numbers really are low-confidence here and the UI must say so.
   * Optional so existing readiness fixtures still compile — `readinessOf`
   * always sets it (the same idiom as {@link ReadinessSample.sideness}).
   */
  fpsOverridden?: boolean;
  /**
   * The stance is MEASURABLY below {@link SIDE_PROFILE_MIN} and only the
   * presenter's explicit override is carrying `sideOk`. The exact mirror of
   * {@link fpsOverridden}: the floor itself never moved, the measured
   * `sideness` stays in the verdict, and every rep counted here is worth
   * less than one shot in profile — the UI must say so. False whenever the
   * stance passes on its own, and false when the gauge could not vote (an
   * unmeasurable stance was never blocking, so nothing is being overridden).
   * Optional for the same fixture-compatibility reason as
   * {@link fpsOverridden}.
   */
  sideOverridden?: boolean;
  /**
   * The stance is square enough ({@link SIDE_PROFILE_TRUSTED}) for 2D joint
   * angles to be taken at face value. False with a measured-but-angled
   * stance — the session still counts, the angles just read small — and
   * ALSO false when `sideness` is null, because an unmeasurable stance is
   * not a trusted one; read `sideness` to tell the two apart. Optional for
   * the same fixture-compatibility reason as {@link fpsOverridden}.
   */
  sideTrusted?: boolean;
}

/** Score-gated keypoint lookup (FORM.keypointScoreMin, same gate app-wide). */
function visible(pose: PoseFrame, name: PoseKeypointName): boolean {
  const kp = pose.keypoints[name];
  return kp != null && kp.score >= FORM.keypointScoreMin;
}

/**
 * Visibility of one frame for the readiness gates. Full body = head OR a
 * shoulder, AND at least one hip, AND a lower-body base (an ankle, or a knee
 * when the ankles are out of frame). The arm gate watches the SHOOTING side
 * specifically: at a side view the far arm is routinely occluded, and metrics
 * from the wrong arm are plausible-looking garbage.
 *
 * V3 relaxation — this used to demand BOTH hips and an ANKLE, which two
 * ordinary room hazards break: at a true side profile the far hip routinely
 * scores under FORM.keypointScoreMin, and a cramped room may not have the
 * ~3 m of clear floor the centre-square analysis crop needs before head AND
 * feet both land inside it. Neither relaxation can fabricate anything: the
 * downstream primitives already degrade honestly — pairMid() falls back to a
 * single hip, bodyHeightOf() falls back to knees, computeRepMetrics returns
 * kneeFlexionDeg null without an ankle, and heightScaleOf refuses without
 * nose + ankle so metres simply stay off.
 */
export function frameVisibility(
  pose: PoseFrame,
  hand: ShootingHand,
): FrameVisibility {
  const head =
    visible(pose, 'nose') ||
    visible(pose, 'left_shoulder') ||
    visible(pose, 'right_shoulder');
  const hips = visible(pose, 'left_hip') || visible(pose, 'right_hip');
  const ankle =
    visible(pose, 'left_ankle') ||
    visible(pose, 'right_ankle') ||
    visible(pose, 'left_knee') ||
    visible(pose, 'right_knee');
  const arm =
    visible(pose, `${hand}_shoulder` as PoseKeypointName) &&
    visible(pose, `${hand}_elbow` as PoseKeypointName) &&
    visible(pose, `${hand}_wrist` as PoseKeypointName);
  return { fullBody: head && hips && ankle, arm };
}

/**
 * Median inter-frame dt → fps (the jumpLab.seriesFps idiom — the median is
 * robust to the odd dropped frame that would wreck a mean). 0 for a series
 * too short to have an interval.
 */
function medianFps(ts: readonly number[]): number {
  const dts: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i]! - ts[i - 1]!;
    if (dt > 0) dts.push(dt);
  }
  if (dts.length === 0) return 0;
  const medDt = median(dts);
  return medDt != null && medDt > 0 ? 1 / medDt : 0;
}

/** Median of a numeric list (null when empty). Does not mutate its input. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Pure readiness verdict over the trailing samples (caller prunes the window
 * to READINESS_WINDOW_SEC). Exported for tests and for any future consumer
 * that wants the same refuse-don't-guess gate.
 *
 * V2: samples may carry a `sideness` vote. The side gate fails only on a
 * MEASURED face-on stance; too few votes (< {@link SIDE_VOTE_MIN_FRAC} of
 * the window) degrade the gauge to null and the gate to PASS.
 *
 * V3: `opts.fpsFloorOverride` is the presenter's on-stage escape from a
 * pose rate the room cannot fix. It does NOT lower {@link MIN_POSE_FPS} —
 * the measured rate and the `fpsOverridden` flag both stay in the verdict so
 * every consumer can label the reps it produces. It refuses below
 * {@link FPS_OVERRIDE_MIN}, where no velocity sample survives anyway, and it
 * never manufactures readiness out of an empty window (fps 0 = no data yet,
 * not a slow camera).
 *
 * V5: `opts.sideFloorOverride` is the same escape for the side gate — the
 * one gate a shooter cannot always comply with, because the room decides
 * where they may stand. It does NOT lower {@link SIDE_PROFILE_MIN}: the
 * measured `sideness` and the `sideOverridden` flag both stay in the verdict,
 * `sideTrusted` stays false, and the reps it lets through are labeled. There
 * is deliberately no floor beneath it (the {@link FPS_OVERRIDE_MIN}
 * analogue): no yaw makes the wrist-snap signature unmeasurable, so a floor
 * here would be an invented number rather than a mechanical limit. What
 * protects the report instead is the metric refusal at the same threshold —
 * see 'stanceNotSideOn' in {@link MetricRefusalKind}.
 */
export function readinessOf(
  samples: readonly ReadinessSample[],
  opts: { fpsFloorOverride?: boolean; sideFloorOverride?: boolean } = {},
): FormCheckReadiness {
  const n = samples.length;
  const fps = medianFps(samples.map((s) => s.t));
  let fullBody = 0;
  let arm = 0;
  let sideSum = 0;
  let sideN = 0;
  for (const s of samples) {
    if (s.fullBody) fullBody++;
    if (s.arm) arm++;
    if (s.sideness != null) {
      sideSum += s.sideness;
      sideN++;
    }
  }
  const fullBodyFrac = n > 0 ? fullBody / n : 0;
  const armFrac = n > 0 ? arm / n : 0;
  const sideness = n > 0 && sideN >= SIDE_VOTE_MIN_FRAC * n ? sideSum / sideN : null;
  const measuredFpsOk = fps >= MIN_POSE_FPS;
  const fpsOverridden =
    opts.fpsFloorOverride === true && !measuredFpsOk && fps >= FPS_OVERRIDE_MIN;
  const fpsOk = measuredFpsOk || fpsOverridden;
  const fullBodyOk = n > 0 && fullBodyFrac >= VISIBILITY_MIN_FRAC;
  const armOk = n > 0 && armFrac >= VISIBILITY_MIN_FRAC;
  const measuredSideOk = sideness == null || sideness >= SIDE_PROFILE_MIN;
  // Only ever true against a MEASURED sub-floor stance: an unmeasurable one
  // already passed, so there is nothing there to override.
  const sideOverridden = opts.sideFloorOverride === true && !measuredSideOk;
  const sideOk = measuredSideOk || sideOverridden;
  return {
    fps,
    fullBodyFrac,
    armFrac,
    sideness,
    fpsOk,
    fullBodyOk,
    armOk,
    sideOk,
    ready: fpsOk && fullBodyOk && armOk && sideOk,
    fpsOverridden,
    sideOverridden,
    sideTrusted: sideness != null && sideness >= SIDE_PROFILE_TRUSTED,
  };
}

// ---------------------------------------------------------------------------
// Motion detection — the Form-Check-tuned mirror of ReleaseDetector
// ---------------------------------------------------------------------------

/**
 * Max spacing between two wrist samples for a finite-difference velocity to
 * mean anything. MIRRORED from ReleaseDetector's private MAX_VY_GAP_SEC and
 * for the same reason: past a few dropped frames the wrist may have gone
 * down and back up between samples, and a Δy over half a second says nothing
 * about a rise. It also sets {@link FPS_OVERRIDE_MIN} — below 1/0.15 fps no
 * pair of frames is close enough to produce a velocity at all.
 */
export const MOTION_MAX_VY_GAP_SEC = 0.15;

/**
 * Streaming shooting-MOTION detector, one instance per watched arm.
 *
 * A deliberate mirror of {@link ReleaseDetector} (src/core/releaseDetector.ts)
 * — same three-condition signature, same raw (unfiltered) landmarks, same
 * co-occurrence-window logic, same score gate — running on {@link FORM_MOTION}
 * instead of config.ts's live-game RELEASE tuning. It is a copy rather than a
 * parameterization because RELEASE.* is shared with the live shot FSM
 * (src/pipeline/shotPipeline.ts), which must keep the strict values: a shot
 * detector that fires on a raised arm would mint fake attempts against a real
 * hoop. Form Check has no hoop and no ball and counts motions, so it can — and
 * for a slow ball-free demonstration MUST — be the sensitive one.
 *
 * The signature: within a trailing {@link FORM_MOTION.windowSec}, the wrist
 * (a) sits above the shoulder, (b) rises faster than
 * {@link FORM_MOTION.minUpwardWristVyFracPerSec} of the frame height per
 * second, and (c) the elbow opens past
 * {@link FORM_MOTION.minElbowExtensionDeg}. Each condition may land on a
 * different frame — a motion is a sequence, not a pose — but all three must
 * be recent together. At most one event per {@link FORM_MOTION.debounceSec},
 * and never two without the wrist dropping back to the shoulder in between
 * (the re-arm gate; see {@link FormMotionDetector.armed}).
 *
 * Missing landmarks (below FORM.keypointScoreMin) simply leave their
 * condition un-refreshed that frame: never a throw, never a stale emit.
 */
export class FormMotionDetector {
  private readonly hand: ShootingHand;
  private readonly frameHeight: number;

  /** Last VALID wrist sample (for the finite-difference vy). */
  private lastWrist: { x: number; y: number; t: number } | null = null;

  // Most recent time each signature condition held (-Infinity = never).
  private aboveShoulderT = -Infinity;
  private vySpikeT = -Infinity;
  private elbowExtendedT = -Infinity;

  /** Time of the last emitted event (debounce). */
  private lastEmitT = -Infinity;

  /**
   * RE-ARM GATE. After an event fires, the wrist must be seen at or below
   * the shoulder again before another one may. A presenter holding a
   * follow-through for the audience keeps conditions (a) and (c) true every
   * frame, so the tiniest hand tremor refreshes (b) and mints a rep per
   * debounce period — the over-count DEMO-RUNBOOK works around in prose
   * ("keep your arms down between reps"), encoded here instead.
   *
   * It cannot refuse a genuine shot: every real shot starts with the wrist
   * below the shoulder, and condition (a) already proves the wrist got
   * ABOVE it. Starts armed so the first rep of a session — including one
   * caught mid-motion — is never swallowed.
   */
  private armed = true;

  constructor(opts: { hand: ShootingHand; frameHeight: number }) {
    this.hand = opts.hand;
    this.frameHeight = opts.frameHeight;
  }

  /**
   * Feed one pose frame (camera-timestamp order). Returns the motion event
   * exactly on the completing frame, otherwise null.
   */
  push(pose: PoseFrame): MotionEvent | null {
    const t = pose.t;
    const side = this.hand;
    const wrist = this.keypoint(pose, `${side}_wrist` as PoseKeypointName);
    const elbow = this.keypoint(pose, `${side}_elbow` as PoseKeypointName);
    const shoulder = this.keypoint(pose, `${side}_shoulder` as PoseKeypointName);

    // (b) Upward velocity: finite difference between CONSECUTIVE valid wrist
    // samples only — a long detection gap makes Δy/Δt meaningless.
    if (wrist !== null) {
      const prev = this.lastWrist;
      if (prev !== null && t > prev.t && t - prev.t <= MOTION_MAX_VY_GAP_SEC) {
        const vy = (wrist.y - prev.y) / (t - prev.t); // +y down: rising < 0
        const floor =
          FORM_MOTION.minUpwardWristVyFracPerSec * this.frameHeight;
        if (vy <= -floor) this.vySpikeT = t;
      }
      this.lastWrist = { x: wrist.x, y: wrist.y, t };
    }

    // (a) Wrist above the shoulder (strictly: smaller y = higher).
    if (wrist !== null && shoulder !== null && wrist.y < shoulder.y) {
      this.aboveShoulderT = t;
    }

    // Re-arm: the wrist came back down to (or below) the shoulder line.
    if (wrist !== null && shoulder !== null && wrist.y >= shoulder.y) {
      this.armed = true;
    }

    // (c) Elbow opened past the extension floor.
    if (wrist !== null && elbow !== null && shoulder !== null) {
      const deg = angleAtDeg(shoulder, elbow, wrist);
      if (deg !== null && deg >= FORM_MOTION.minElbowExtensionDeg) {
        this.elbowExtendedT = t;
      }
    }

    // Fire when all three conditions co-occurred within the window. The
    // event needs a wrist THIS frame (its position is the payload) — with
    // the wrist missing the conditions cannot have refreshed anyway.
    const horizon = t - FORM_MOTION.windowSec;
    if (
      wrist === null ||
      this.aboveShoulderT < horizon ||
      this.vySpikeT < horizon ||
      this.elbowExtendedT < horizon
    ) {
      return null;
    }

    // A completed signature is CONSUMED whether or not it can be emitted.
    // ReleaseDetector does not need this — its 0.3 s window expires long
    // inside its 1.5 s cooldown — but at FORM_MOTION.debounceSec a set of
    // conditions left standing would re-fire the instant the debounce
    // lapsed, minting a rep off a wrist that had been still for 300 ms. A
    // debounced motion is dropped, never queued: a rep must be a signature
    // observed in full, on its own frames.
    this.aboveShoulderT = -Infinity;
    this.vySpikeT = -Infinity;
    this.elbowExtendedT = -Infinity;

    if (t - this.lastEmitT < FORM_MOTION.debounceSec) return null;
    // The arm never came back down since the last rep — one motion, not two.
    if (!this.armed) return null;
    this.lastEmitT = t;
    this.armed = false;
    return { t, wristX: wrist.x, wristY: wrist.y };
  }

  /** Score-gated keypoint lookup (below FORM.keypointScoreMin = missing). */
  private keypoint(
    pose: PoseFrame,
    name: PoseKeypointName,
  ): { x: number; y: number } | null {
    const kp = pose.keypoints[name];
    if (!kp || kp.score < FORM.keypointScoreMin) return null;
    return kp;
  }
}

/** A fired motion event (analysis-frame px / camera seconds). */
export interface MotionEvent {
  /** Camera time of the frame that completed the motion signature. */
  t: number;
  /** Shooting-hand wrist position on that frame. */
  wristX: number;
  wristY: number;
}

// ---------------------------------------------------------------------------
// Calibration gauges (pure)
// ---------------------------------------------------------------------------

interface XY {
  x: number;
  y: number;
}

/**
 * MIRRORED from formSequence's module-private bodyHeightPx: a robust per-
 * frame body-height estimate — head/shoulder → ankle/knee span, trunk × 2.5
 * fallback. Re-implemented locally (documented mirror) so the side gauge and
 * stance baselines normalize by the same body scale the sequence packer uses.
 */
function bodyHeightOf(pts: ReadonlyMap<PoseKeypointName, XY>): number | null {
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
    const h = Math.abs(bottom.y - top.y);
    if (h > 1) return h;
  }
  const shoulder = pts.get('left_shoulder') ?? pts.get('right_shoulder') ?? null;
  const hip = pts.get('left_hip') ?? pts.get('right_hip') ?? null;
  if (shoulder && hip) {
    const trunk = Math.abs(hip.y - shoulder.y);
    if (trunk > 1) return trunk * 2.5;
  }
  return null;
}

/** Midpoint of a left/right landmark pair (falls back to whichever exists). */
function pairMid(
  pts: ReadonlyMap<PoseKeypointName, XY>,
  left: PoseKeypointName,
  right: PoseKeypointName,
): XY | null {
  const l = pts.get(left);
  const r = pts.get(right);
  if (l && r) return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  return l ?? r ?? null;
}

/**
 * Side-profile gauge for one frame: 1 = perfect side-on, 0 = facing the
 * camera. Shoulder (and, when visible, hip) x-separation normalized by the
 * frame's body height, mapped through the front-facing separation
 * ({@link FRONT_SEP_N}). Null when either shoulder is missing or no body
 * height can be estimated — a frame that can't vote abstains, it never
 * guesses.
 */
export function sideProfileOf(pose: PoseFrame): number | null {
  const raw = toRawSeqFrame(pose);
  return raw == null ? null : sideProfileOfRaw(raw);
}

/**
 * {@link sideProfileOf} over an already score-gated {@link RawSeqFrame} —
 * lets the session's push() build ONE raw frame per camera frame and feed
 * both the side vote and the rolling buffer from it (the side vote runs at
 * camera rate for the whole session, so a second per-frame 17-entry Map
 * allocation is real JS-thread garbage).
 */
function sideProfileOfRaw(raw: RawSeqFrame): number | null {
  const pts = raw.pts;
  const ls = pts.get('left_shoulder');
  const rs = pts.get('right_shoulder');
  if (!ls || !rs) return null;
  const h = bodyHeightOf(pts);
  if (h == null) return null;
  let sepSum = Math.abs(ls.x - rs.x) / h;
  let sepN = 1;
  const lh = pts.get('left_hip');
  const rh = pts.get('right_hip');
  if (lh && rh) {
    sepSum += Math.abs(lh.x - rh.x) / h;
    sepN++;
  }
  return 1 - clamp(sepSum / sepN / FRONT_SEP_N, 0, 1);
}

export interface TiltEstimate {
  /** Mean apparent lean of the standing body vs image vertical, degrees.
   *  Signed: positive = the body's top leans toward +x in the image. */
  tiltDeg: number;
  /** Sample std of the per-frame angles, degrees. */
  stdDeg: number;
  /** Number of standing frames that voted. */
  frames: number;
  /** stdDeg ≤ TILT_STD_MAX_DEG AND |tiltDeg| ≤ TILT_MAX_COMP_DEG. */
  confident: boolean;
}

/** Signed angle of the bottom→top segment vs image vertical, degrees. */
function angleFromVerticalDeg(bottom: XY, top: XY): number | null {
  const dx = top.x - bottom.x;
  const up = bottom.y - top.y; // +y down ⇒ "up" is a positive span
  if (up <= 1) return null; // degenerate / inverted segment — can't vote
  return (Math.atan2(dx, up) * 180) / Math.PI;
}

/**
 * Camera-roll estimate over READY (standing) frames: per frame, the mean of
 * the ankleMid→hipMid and hipMid→shoulderMid angles vs image vertical; the
 * estimate is the mean of ≥ {@link TILT_MIN_FRAMES} frame votes with its
 * sample std. A standing body is vertical, so a consistent lean of BOTH
 * segments reads as the phone being rolled, not the shooter. Null with too
 * few voting frames. Compensation is applied elsewhere ONLY when
 * `confident` — an unsteady estimate is reported, never acted on.
 */
export function estimateTilt(
  readyFrames: readonly RawSeqFrame[],
): TiltEstimate | null {
  const angles: number[] = [];
  for (const f of readyFrames) {
    const shoulder = pairMid(f.pts, 'left_shoulder', 'right_shoulder');
    const hip = pairMid(f.pts, 'left_hip', 'right_hip');
    const ankle = pairMid(f.pts, 'left_ankle', 'right_ankle');
    if (!shoulder || !hip || !ankle) continue;
    const lower = angleFromVerticalDeg(ankle, hip);
    const upper = angleFromVerticalDeg(hip, shoulder);
    if (lower == null || upper == null) continue;
    angles.push((lower + upper) / 2);
  }
  if (angles.length < TILT_MIN_FRAMES) return null;
  let mean = 0;
  for (const a of angles) mean += a;
  mean /= angles.length;
  const stdDeg = sampleStd(angles);
  return {
    tiltDeg: mean,
    stdDeg,
    frames: angles.length,
    confident: stdDeg <= TILT_STD_MAX_DEG && Math.abs(mean) <= TILT_MAX_COMP_DEG,
  };
}

export interface HeightScale {
  /** Metres per analysis-frame pixel — an ESTIMATE (see the fn doc). */
  metersPerPx: number;
  /** Median standing nose→ankle span, analysis px. */
  standingSpanPx: number;
  /** The profile height the scale was derived from, cm. */
  heightCm: number;
}

/**
 * px→metres scale from the user's stated height and their standing nose→
 * ankle span over READY frames. Gated hard: needs a height, ≥
 * {@link HEIGHT_MIN_FRAMES} frames with nose + an ankle, and a span jitter
 * ≤ {@link HEIGHT_SPAN_STD_FRAC} of the span (a swaying/walking shooter
 * yields no scale rather than a wrong one). The span is expanded to full
 * stature via {@link NOSE_TO_ANKLE_STATURE_FRAC}; every metre derived from
 * the result is an estimate and must be labeled one.
 */
export function heightScaleOf(
  readyFrames: readonly RawSeqFrame[],
  heightCm: number | null,
): HeightScale | null {
  if (heightCm == null || !(heightCm > 0)) return null;
  const spans: number[] = [];
  for (const f of readyFrames) {
    const nose = f.pts.get('nose');
    const ankle = pairMid(f.pts, 'left_ankle', 'right_ankle');
    if (!nose || !ankle) continue;
    const span = ankle.y - nose.y;
    if (span > 1) spans.push(span);
  }
  if (spans.length < HEIGHT_MIN_FRAMES) return null;
  const standingSpanPx = median(spans)!;
  if (sampleStd(spans) > HEIGHT_SPAN_STD_FRAC * standingSpanPx) return null;
  const statureSpanPx = standingSpanPx / NOSE_TO_ANKLE_STATURE_FRAC;
  const metersPerPx = metersPerPxFromHeight(heightCm, statureSpanPx);
  if (metersPerPx == null) return null;
  return { metersPerPx, standingSpanPx, heightCm };
}

/**
 * Frozen calibration receipt. Every field is null when its gauge could not
 * measure (or calibration was skipped) — the UI renders the honest absence,
 * the engine falls back to v1 behavior.
 */
export interface CalibrationState {
  phase: CalibrationPhase;
  /** Shadow reps collected so far, 0..SHADOW_REPS_TARGET. */
  shadowReps: number;
  /** Effective watched arm. */
  hand: ShootingHand;
  handSource: HandSource;
  /** Mean side-profile gauge over the collection window, or null. */
  sidenessAvg: number | null;
  /** Camera-roll estimate; compensation applied ONLY when tilt.confident. */
  tilt: TiltEstimate | null;
  scale: HeightScale | null;
  /** Median filtered shooting-wrist y while standing, analysis px. */
  standingWristY: number | null;
  /** Ankle x-separation / body height while standing. */
  stanceWidthN: number | null;
  /** Deepest shadow-rep dip (max filtered wrist y), analysis px. */
  setPointWristY: number | null;
}

// ---------------------------------------------------------------------------
// Per-rep metrics (pure)
// ---------------------------------------------------------------------------

/** The six shooting-side landmarks the metrics are computed from. */
function sideNames(hand: ShootingHand): PoseKeypointName[] {
  return [
    `${hand}_shoulder`,
    `${hand}_elbow`,
    `${hand}_wrist`,
    `${hand}_hip`,
    `${hand}_knee`,
    `${hand}_ankle`,
  ] as PoseKeypointName[];
}

/**
 * One-Euro filter each present landmark across the window (missing frames
 * simply do not feed the filter — same as FormAnalyzer's landmark()).
 * Extracted from computeRepMetrics VERBATIM so metrics and phase timing read
 * the exact same filtered motion.
 */
function filterSeries(
  frames: readonly RawSeqFrame[],
  names: readonly PoseKeypointName[],
): Map<PoseKeypointName, Point>[] {
  const filters = new Map<
    PoseKeypointName,
    { fx: OneEuroFilter; fy: OneEuroFilter }
  >();
  for (const name of names) {
    filters.set(name, {
      fx: new OneEuroFilter(FORM.oneEuro),
      fy: new OneEuroFilter(FORM.oneEuro),
    });
  }
  const series: Map<PoseKeypointName, Point>[] = [];
  for (const f of frames) {
    const out = new Map<PoseKeypointName, Point>();
    for (const name of names) {
      const p = f.pts.get(name);
      if (!p) continue;
      const ch = filters.get(name)!;
      out.set(name, { x: ch.fx.filter(p.x, f.t), y: ch.fy.filter(p.y, f.t) });
    }
    series.push(out);
  }
  return series;
}

/**
 * Dip = max filtered wrist y at/before the release (>= keeps the LAST frame
 * of a held set point, matching FormAnalyzer's running-max update), confirmed
 * only when the wrist later rises more than DIP_EPS_PX past it before the
 * release. Extracted from computeRepMetrics VERBATIM.
 */
function findDip(
  frames: readonly RawSeqFrame[],
  series: readonly Map<PoseKeypointName, Point>[],
  wristName: PoseKeypointName,
  releaseT: number,
  dipEpsPx: number = DIP_EPS_PX,
): { dipIdx: number; dipMaxY: number; dipConfirmed: boolean } {
  let dipIdx = -1;
  let dipMaxY = -Infinity;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]!.t > releaseT + 1e-9) break;
    const w = series[i]!.get(wristName);
    if (w && w.y >= dipMaxY) {
      dipMaxY = w.y;
      dipIdx = i;
    }
  }
  let dipConfirmed = false;
  if (dipIdx >= 0) {
    for (let i = dipIdx + 1; i < frames.length; i++) {
      if (frames[i]!.t > releaseT + 1e-9) break;
      const w = series[i]!.get(wristName);
      if (w && dipMaxY - w.y > dipEpsPx) {
        dipConfirmed = true;
        break;
      }
    }
  }
  return { dipIdx, dipMaxY, dipConfirmed };
}

/**
 * THE GATHER GATE. {@link findDip} is a global argmax of filtered wrist y —
 * it returns the LOWEST the wrist ever was before the release, whatever the
 * shooter was doing at that instant. On a rep that starts from rest (the
 * ball-free demo motion this mode exists for) that frame is the arm HANGING
 * AT THE SIDE, and the set point then reads ~165° against FORM's 75-90°
 * band: a headline "lower your set point" cue generated off a frame nobody
 * would call a gather.
 *
 * The argmax is kept — the dip really is the lowest wrist. What is added is
 * the REFUSAL: a dip frame that is not a plausible gather yields no
 * dip-frame number at all. Two independent checks, each of which may only
 * REFUSE:
 *  - the dip-frame elbow is flexed (≤ {@link GATHER_MAX_ELBOW_DEG});
 *  - the dip-frame wrist is at or above the hip line (within
 *    {@link GATHER_WRIST_BELOW_HIP_FRAC} of body height).
 * A check whose landmarks are missing abstains — but if NEITHER could run,
 * the gather is unverified and that refuses too. Nothing here can make a
 * metric appear; it can only take one away, with its reason attached.
 */
function dipGatherOf(
  dipFrame: RawSeqFrame,
  dipSeries: ReadonlyMap<PoseKeypointName, Point>,
  hand: ShootingHand,
): { gathered: boolean; reason: string | null } {
  // The elbow test reads the FILTERED series — it has to judge the very
  // angle it is refusing. The hip line reads the RAW frame: the hip is a
  // near-static landmark on this window and filtering it buys nothing.
  const s = dipSeries.get(`${hand}_shoulder` as PoseKeypointName);
  const e = dipSeries.get(`${hand}_elbow` as PoseKeypointName);
  const w = dipSeries.get(`${hand}_wrist` as PoseKeypointName);
  const elbowDeg = s && e && w ? angleAtDeg(s, e, w) : null;
  if (elbowDeg != null && elbowDeg > GATHER_MAX_ELBOW_DEG) {
    return {
      gathered: false,
      reason: `dip frame is not a gather — elbow ${Math.round(elbowDeg)}°, arm was extended`,
    };
  }

  const rawWrist = dipFrame.pts.get(`${hand}_wrist` as PoseKeypointName);
  const rawHip = dipFrame.pts.get(`${hand}_hip` as PoseKeypointName);
  let hipChecked = false;
  if (rawWrist && rawHip) {
    hipChecked = true;
    const body = bodyHeightOf(dipFrame.pts);
    const slack = body != null ? GATHER_WRIST_BELOW_HIP_FRAC * body : 0;
    // +y down: a wrist BELOW the hip has the larger y.
    if (rawWrist.y > rawHip.y + slack) {
      return {
        gathered: false,
        reason: 'dip frame is not a gather — wrist below the hip line, arm was hanging',
      };
    }
  }

  if (elbowDeg == null && !hipChecked) {
    return {
      gathered: false,
      reason: 'dip frame gather unverified — no elbow angle and no hip on that frame',
    };
  }
  return { gathered: true, reason: null };
}

/**
 * Follow-through over the post-release tail (FormAnalyzer's windows):
 * FT_AVG_WINDOW_SEC mean elbow angle + the unbroken ≥ {@link FT_ELBOW_MIN_DEG}
 * streak capped at holdSec. Extracted from computeRepMetrics VERBATIM; the
 * elbow floor is the ONE divergence and it is documented on the constant.
 */
function followThroughOf(
  frames: readonly RawSeqFrame[],
  series: readonly Map<PoseKeypointName, Point>[],
  shoulderName: PoseKeypointName,
  elbowName: PoseKeypointName,
  wristName: PoseKeypointName,
  releaseT: number,
): { followThroughElbowDeg: number | null; followThroughHeldMs: number | null } {
  const holdMs = FORM.followThrough.holdSec * 1000;
  const ftT: number[] = [];
  const ftDeg: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const t = frames[i]!.t;
    if (t < releaseT - 1e-9) continue;
    if (t - releaseT > FORM.followThrough.holdSec + 1e-9) break;
    const s = series[i]!.get(shoulderName);
    const e = series[i]!.get(elbowName);
    const w = series[i]!.get(wristName);
    if (!s || !e || !w) continue;
    const deg = angleAtDeg(s, e, w);
    if (deg != null) {
      ftT.push(t);
      ftDeg.push(deg);
    }
  }
  let followThroughElbowDeg: number | null = null;
  let followThroughHeldMs: number | null = null;
  if (ftT.length > 0) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < ftT.length; i++) {
      if (ftT[i]! - releaseT <= FT_AVG_WINDOW_SEC + 1e-9) {
        sum += ftDeg[i]!;
        n++;
      }
    }
    if (n > 0) followThroughElbowDeg = sum / n;

    // FRAME-RESOLUTION TOLERANCE AT THE START. The release fires on the RAW
    // elbow crossing the extension floor, while this streak reads the
    // ONE-EURO-FILTERED angle — which is still a frame or so behind it at
    // exactly that instant. On a ball-free push that crosses the floor near
    // the top of the motion, the very first tail sample therefore lands a
    // degree or two short and the streak breaks before it starts: 0 ms,
    // reported as an arm collapse nobody watched. The streak may begin one
    // median frame period late; the hold is then measured FROM WHERE IT
    // ACTUALLY STARTED, never from the release, so no millisecond is claimed
    // across an interval that was not observed extended. A real post-release
    // collapse lasts far longer than one frame and still reports short.
    let medDt = 0;
    if (ftT.length > 1) {
      const dts: number[] = [];
      for (let i = 1; i < ftT.length; i++) {
        const dt = ftT[i]! - ftT[i - 1]!;
        if (dt > 0) dts.push(dt);
      }
      medDt = median(dts) ?? 0;
    }
    let start = 0;
    while (
      start < ftT.length &&
      ftDeg[start]! < FT_ELBOW_MIN_DEG &&
      ftT[start]! - releaseT <= medDt + 1e-9
    ) {
      start++;
    }
    let heldStart: number | null = null;
    let heldEnd: number | null = null;
    for (let i = start; i < ftT.length; i++) {
      if (ftDeg[i]! < FT_ELBOW_MIN_DEG) break;
      if (heldStart == null) heldStart = ftT[i]!;
      heldEnd = ftT[i]!;
    }
    followThroughHeldMs =
      heldEnd == null || heldStart == null
        ? 0
        : Math.min((heldEnd - heldStart) * 1000, holdMs);
  }
  return { followThroughElbowDeg, followThroughHeldMs };
}

/**
 * Did the follow-through hold the FULL window, at this rep's own frame
 * resolution?
 *
 * followThroughHeldMs is the last SAMPLED instant the elbow was still
 * extended, so it lands on a frame boundary: at 30 fps a hold that really
 * ran the whole 300 ms window reports at most 300 − 33 ms, at 15 fps 300 −
 * 67, at 8 fps 300 − 125. Compared against a bare 300 the metric therefore
 * reads "collapsed" on every rep at the 15-21 fps the runbook accepts on
 * stage — a systematic quantization bias, not a shooter's fault.
 *
 * The tolerance widens the COMPARISON by one median frame period. It does
 * NOT touch the number: inventing the missing milliseconds would report a
 * hold across an interval nobody sampled. `poseFps` ≤ 0 (unknown rate) ⇒ no
 * tolerance, the strict old test.
 */
export function followThroughHeldFull(
  heldMs: number | null,
  poseFps: number,
): boolean {
  if (heldMs == null) return false;
  const holdMs = FORM.followThrough.holdSec * 1000;
  const tolMs = poseFps > 0 ? 1000 / poseFps : 0;
  return heldMs >= holdMs - tolMs - 1e-6;
}

/**
 * Rotate every frame's keypoints by `deg` about the analysis-frame center.
 * The analysis frame is the square MoveNet input, so the center is
 * (frameHeight/2, frameHeight/2). Used exclusively for confident camera-tilt
 * compensation: joint-interior angles are rotation-invariant, so only
 * y-derived numbers (release height, dip geometry) change.
 */
function rotateFrames(
  frames: readonly RawSeqFrame[],
  deg: number,
  frameHeight: number,
): RawSeqFrame[] {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const c = frameHeight / 2;
  return frames.map((f) => {
    const pts = new Map<PoseKeypointName, XY>();
    for (const [name, p] of f.pts) {
      const dx = p.x - c;
      const dy = p.y - c;
      pts.set(name, { x: c + dx * cos - dy * sin, y: c + dx * sin + dy * cos });
    }
    return { t: f.t, pts };
  });
}

/**
 * Pose-only {@link FormMetrics} for one rep window (frames spanning
 * [releaseT − PRE_RELEASE_SEC, releaseT + FOLLOW_TAIL_SEC]).
 *
 * Mirrors FormAnalyzer's semantics wherever both can measure:
 *  - the six shooting-side landmarks are One-Euro filtered (FORM.oneEuro);
 *  - the DIP is the max filtered wrist y before the release, confirmed only
 *    when the wrist later rises more than DIP_EPS_PX past it;
 *  - set-point elbow / knee flexion are angleAtDeg at the dip frame;
 *  - follow-through elbow is averaged over FT_AVG_WINDOW_SEC after release,
 *    and the hold is the unbroken ≥ {@link FT_ELBOW_MIN_DEG} streak capped
 *    at FORM.followThrough.holdSec.
 *
 * DIVERGES where the ball is required, honestly:
 *  - releaseTimeMs is dip→release (no ball, no pickup) — the UI relabels it;
 *  - releaseAngleDeg / entryAngleDeg are null BY CONSTRUCTION.
 *
 * V2 — `opts.tiltDeg`: a CONFIDENT camera-roll estimate rotates the
 * keypoints by −tiltDeg about the frame center BEFORE filtering. null / 0 /
 * absent produces output identical to v1 (regression-pinned): the frames
 * pass through untouched, not through an identity rotation.
 *
 * V4 — the three DIP-FRAME numbers (set point, knee, tempo) are refused when
 * that frame is not a plausible gather ({@link dipGatherOf}); the reason
 * rides on {@link computeRepMetricsDetailed}. `opts.dipEpsPx` defaults to
 * the mirrored {@link DIP_EPS_PX}; live call sites pass {@link dipEpsFor}.
 *
 * V5 — `opts.sideness`: this window's measured side-profile gauge. Below
 * {@link SIDE_PROFILE_MIN} every 2D joint angle is refused
 * ({@link SIDE_REFUSED_METRICS}). Absent / null ⇒ output identical to V4, so
 * no existing call site or fixture changes behavior by adding nothing.
 *
 * Anything unmeasurable (missing landmarks, no dip, empty tail) is null —
 * never NaN.
 */
export function computeRepMetrics(
  frames: readonly RawSeqFrame[],
  opts: {
    hand: ShootingHand;
    frameHeight: number;
    releaseT: number;
    tiltDeg?: number | null;
    /** Dip-confirmation epsilon, px. Default: the mirrored DIP_EPS_PX. */
    dipEpsPx?: number;
    /** Window side-profile gauge (0..1); null/absent = no stance refusal. */
    sideness?: number | null;
  },
): FormMetrics {
  return computeRepMetricsDetailed(frames, opts).metrics;
}

/**
 * Why a metric was refused, in the data — never only in the copy layer.
 *  - 'dipNotGather'    — the dip frame is not a plausible gather, so nothing
 *                        read off it describes a set point.
 *  - 'stanceNotSideOn' — the stance was measured below
 *                        {@link SIDE_PROFILE_MIN}, where a 2D joint angle is
 *                        a projection of an arm pointing at the lens. Only
 *                        reachable through
 *                        {@link FormCheckSession.overrideSideFloor}: without
 *                        it such a stance produces no rep at all.
 */
export type MetricRefusalKind = 'dipNotGather' | 'stanceNotSideOn';

/** One refusal: which metrics it took away, and the reason to show. */
export interface MetricRefusal {
  kind: MetricRefusalKind;
  /**
   * {@link FormMetrics} keys this refusal nulled. Two refusals may name the
   * same key — each states an independent reason that number is absent, and
   * neither is implied by the other.
   */
  metrics: readonly (keyof FormMetrics)[];
  /** Stated reason, ready to render. Never empty. */
  reason: string;
}

/**
 * The metrics a sub-{@link SIDE_PROFILE_MIN} stance takes away. All four are
 * read from a 2D interior joint angle — shoulder→elbow→wrist and
 * hip→knee→ankle — which is the projection of a limb whose long axis is
 * swinging toward the lens at that yaw. It does not read "a bit small"; it
 * reads whatever the projection happens to be, and a follow-through judged
 * against {@link FT_ELBOW_MIN_DEG} in that space reports an arm collapse
 * nobody watched. Everything a yaw cannot distort survives untouched:
 * releaseTimeMs (a duration), releaseHeightNorm / releaseHeightM (vertical),
 * and the dip / rise / release phase bars (vertical + temporal).
 */
const SIDE_REFUSED_METRICS: readonly (keyof FormMetrics)[] = [
  'setPointElbowDeg',
  'kneeFlexionDeg',
  'followThroughElbowDeg',
  'followThroughHeldMs',
];

/**
 * Is this window's stance too square for a 2D joint angle to mean anything?
 * Null sideness (the gauge could not vote) abstains — the same
 * refuse-don't-guess contract the gate itself keeps: occlusion is not
 * evidence of facing the camera.
 */
function anglesForeshortened(sideness: number | null | undefined): boolean {
  return sideness != null && Number.isFinite(sideness) && sideness < SIDE_PROFILE_MIN;
}

/** The stated reason on a 'stanceNotSideOn' refusal. */
function sideRefusalReason(sideness: number): string {
  return `stance was ${Math.round(sideness * 100)}% side-on — 2D joint angles are foreshortened below ${Math.round(SIDE_PROFILE_MIN * 100)}%`;
}

/** {@link computeRepMetrics} plus the refusals that shaped it. */
export interface RepMetricsResult {
  metrics: FormMetrics;
  /** Empty = every metric that is null was simply never measurable. */
  refusals: readonly MetricRefusal[];
}

/**
 * {@link computeRepMetrics} with its refusals attached. Same math, same
 * output — the plain form is a thin wrapper so no existing call site has to
 * change and no refusal can be dropped on the floor by accident.
 */
export function computeRepMetricsDetailed(
  frames: readonly RawSeqFrame[],
  opts: {
    hand: ShootingHand;
    frameHeight: number;
    releaseT: number;
    tiltDeg?: number | null;
    dipEpsPx?: number;
    sideness?: number | null;
  },
): RepMetricsResult {
  const { hand, frameHeight, releaseT } = opts;
  const tilt = opts.tiltDeg;
  const work =
    tilt != null && Number.isFinite(tilt) && tilt !== 0
      ? rotateFrames(frames, -tilt, frameHeight)
      : frames;
  const names = sideNames(hand);
  const series = filterSeries(work, names);

  const wristName = `${hand}_wrist` as PoseKeypointName;
  const elbowName = `${hand}_elbow` as PoseKeypointName;
  const shoulderName = `${hand}_shoulder` as PoseKeypointName;
  const hipName = `${hand}_hip` as PoseKeypointName;
  const kneeName = `${hand}_knee` as PoseKeypointName;
  const ankleName = `${hand}_ankle` as PoseKeypointName;

  const { dipIdx, dipConfirmed } = findDip(
    work,
    series,
    wristName,
    releaseT,
    opts.dipEpsPx,
  );

  const refusals: MetricRefusal[] = [];
  let setPointElbowDeg: number | null = null;
  let kneeFlexionDeg: number | null = null;
  let releaseTimeMs: number | null = null;
  if (dipConfirmed && dipIdx >= 0) {
    const dip = series[dipIdx]!;
    // THE GATHER GATE: all three dip-frame numbers stand or fall together —
    // they are all read off this one frame, so if the frame is not a gather
    // none of them describes a set point.
    const gather = dipGatherOf(work[dipIdx]!, dip, hand);
    if (!gather.gathered) {
      refusals.push({
        kind: 'dipNotGather',
        metrics: ['setPointElbowDeg', 'kneeFlexionDeg', 'releaseTimeMs'],
        reason: gather.reason!,
      });
    } else {
      const s = dip.get(shoulderName);
      const e = dip.get(elbowName);
      const w = dip.get(wristName);
      if (s && e && w) setPointElbowDeg = angleAtDeg(s, e, w);
      const hp = dip.get(hipName);
      const kn = dip.get(kneeName);
      const an = dip.get(ankleName);
      if (hp && kn && an) kneeFlexionDeg = angleAtDeg(hp, kn, an);
      releaseTimeMs = (releaseT - work[dipIdx]!.t) * 1000;
    }
  }

  // ── Release height: filtered wrist at the frame nearest releaseT. The
  // event timestamp IS a frame timestamp, so the nearest frame is normally
  // exact; a stale match (beyond the packer's own slack) yields null.
  let releaseHeightNorm: number | null = null;
  {
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i < work.length; i++) {
      const d = Math.abs(work[i]!.t - releaseT);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    if (bestI >= 0 && bestD <= 0.2) {
      const w = series[bestI]!.get(wristName);
      if (w && frameHeight > 0) releaseHeightNorm = 1 - w.y / frameHeight;
    }
  }

  let { followThroughElbowDeg, followThroughHeldMs } = followThroughOf(
    work,
    series,
    shoulderName,
    elbowName,
    wristName,
    releaseT,
  );

  // THE STANCE GATE. Applied LAST, as a suppression pass over numbers that
  // were really computed — it can only take a metric away, never produce
  // one, and it never disturbs the refusals above it (a dip that was not a
  // gather is still not a gather; both reasons are true and both are
  // reported). Only reachable via FormCheckSession.overrideSideFloor: with
  // the gate at its default there is no rep here to refuse anything on.
  if (anglesForeshortened(opts.sideness)) {
    setPointElbowDeg = null;
    kneeFlexionDeg = null;
    followThroughElbowDeg = null;
    followThroughHeldMs = null;
    refusals.push({
      kind: 'stanceNotSideOn',
      metrics: SIDE_REFUSED_METRICS,
      reason: sideRefusalReason(opts.sideness!),
    });
  }

  return {
    metrics: {
      setPointElbowDeg,
      kneeFlexionDeg,
      // Ball-derived, ALWAYS null in Form Check — the mode cannot see the
      // ball and never fabricates a trajectory number. The UI renders "not
      // measured".
      releaseAngleDeg: null,
      entryAngleDeg: null,
      releaseTimeMs,
      followThroughHeldMs,
      followThroughElbowDeg,
      releaseHeightNorm,
    },
    refusals,
  };
}

// ---------------------------------------------------------------------------
// Per-phase timing (pure)
// ---------------------------------------------------------------------------

/** Per-rep phase durations, each independently nullable (never interpolated). */
export interface RepPhaseTiming {
  /** Descent onset → deepest dip, ms. */
  dipMs: number | null;
  /** Dip → wrist crossing above the shoulder, ms. */
  riseMs: number | null;
  /** Shoulder crossing → the release event, ms. */
  releaseMs: number | null;
  /** The existing follow-through hold (≥ {@link FT_ELBOW_MIN_DEG} streak), ms. */
  followMs: number | null;
}

/**
 * Phase timing for one rep window. All four events are derived from data the
 * rep already carries — nothing new is sensed:
 *  - dip = the same max-filtered-wrist-y dip computeRepMetrics finds;
 *  - dip ONSET = scanning back from the dip through the held set point and
 *    then the strictly-descending wrist run, the earliest frame still ≥
 *    DIP_EPS_PX above the dip depth. A window that opens with the wrist
 *    already at dip depth has no observed descent ⇒ dipMs null, never
 *    guessed;
 *  - shoulder cross = the first post-dip frame whose RAW wrist sits above
 *    the RAW shoulder (the exact gate the ReleaseDetector fires on);
 *  - followMs = the same follow-through hold computeRepMetrics reports.
 * Unmeasured segments are null; the UI renders gaps, not interpolations.
 *
 * V4 — `opts.tiltDeg` / `opts.frameHeight` mirror computeRepMetrics EXACTLY:
 * without them the two findDip calls ran in different coordinate spaces and
 * at 15° of roll could land on different frames, so the phase bars described
 * one frame while the numbers above them described another. Same rotation,
 * same dip. `opts.dipEpsPx` defaults to DIP_EPS_PX (pins unchanged), and the
 * same gather gate applies: a dip frame that is not a gather yields no
 * dip / rise / release segment, only the follow-through it really observed.
 *
 * V5 — `opts.sideness` mirrors {@link computeRepMetrics}: below
 * {@link SIDE_PROFILE_MIN} `followMs` is refused, because it is the same
 * elbow-angle streak the metric refuses and the bar must not draw a hold the
 * number above it declined to report. dip / rise / release are vertical and
 * temporal — a yaw cannot distort them — so they stand.
 */
export function computePhaseTiming(
  frames: readonly RawSeqFrame[],
  opts: {
    hand: ShootingHand;
    releaseT: number;
    /** Confident camera roll, degrees — rotate by −tiltDeg before filtering. */
    tiltDeg?: number | null;
    /** Analysis-square side; required for the rotation's center. */
    frameHeight?: number;
    /** Dip-confirmation epsilon, px. Default: the mirrored DIP_EPS_PX. */
    dipEpsPx?: number;
    /** Window side-profile gauge (0..1); null/absent = no stance refusal. */
    sideness?: number | null;
  },
): RepPhaseTiming {
  const { hand, releaseT } = opts;
  const tilt = opts.tiltDeg;
  const frameHeight = opts.frameHeight;
  const work =
    tilt != null &&
    Number.isFinite(tilt) &&
    tilt !== 0 &&
    frameHeight != null &&
    frameHeight > 0
      ? rotateFrames(frames, -tilt, frameHeight)
      : frames;
  const wristName = `${hand}_wrist` as PoseKeypointName;
  const elbowName = `${hand}_elbow` as PoseKeypointName;
  const shoulderName = `${hand}_shoulder` as PoseKeypointName;
  const series = filterSeries(work, [shoulderName, elbowName, wristName]);

  const { dipIdx, dipMaxY, dipConfirmed } = findDip(
    work,
    series,
    wristName,
    releaseT,
    opts.dipEpsPx,
  );

  let dipMs: number | null = null;
  let riseMs: number | null = null;
  let releaseMs: number | null = null;

  const gathered =
    dipConfirmed && dipIdx >= 0
      ? dipGatherOf(work[dipIdx]!, series[dipIdx]!, hand).gathered
      : false;

  if (gathered && dipIdx >= 0) {
    const tDip = work[dipIdx]!.t;

    // ── Descent onset: walk back through frames still at dip depth (the
    // held set point, within the dip epsilon of the max), then through the
    // strictly-descending run; a missing wrist or a reversal ends the scan.
    const eps = opts.dipEpsPx ?? DIP_EPS_PX;
    const wy = (i: number): number | null => series[i]!.get(wristName)?.y ?? null;
    let i = dipIdx - 1;
    while (i >= 0) {
      const y = wy(i);
      if (y == null || y <= dipMaxY - eps) break;
      i--;
    }
    let onset: number | null = null;
    let prevY = i + 1 <= dipIdx ? wy(i + 1) : null;
    while (i >= 0 && prevY != null) {
      const y = wy(i);
      if (y == null || y >= prevY) break;
      if (y <= dipMaxY - eps) onset = i;
      prevY = y;
      i--;
    }
    if (onset != null) dipMs = (tDip - work[onset]!.t) * 1000;

    // ── Shoulder cross: first post-dip frame with the RAW wrist above the
    // RAW shoulder (smaller y = higher; the ReleaseDetector's own gate).
    // "Raw" = unfiltered, in the SAME (possibly un-rolled) space as the dip.
    for (let k = dipIdx + 1; k < work.length; k++) {
      const t = work[k]!.t;
      if (t > releaseT + 1e-9) break;
      const w = work[k]!.pts.get(wristName);
      const s = work[k]!.pts.get(shoulderName);
      if (w && s && w.y < s.y) {
        riseMs = (t - tDip) * 1000;
        releaseMs = (releaseT - t) * 1000;
        break;
      }
    }
  }

  const { followThroughHeldMs } = followThroughOf(
    work,
    series,
    shoulderName,
    elbowName,
    wristName,
    releaseT,
  );

  return {
    dipMs,
    riseMs,
    releaseMs,
    followMs: anglesForeshortened(opts.sideness) ? null : followThroughHeldMs,
  };
}

// ---------------------------------------------------------------------------
// Cross-rep consistency
// ---------------------------------------------------------------------------

/** One consistency spread: a sample std, or an honest reason it is absent. */
export interface SpreadStat {
  /** Sample standard deviation across measured reps, or null. */
  value: number | null;
  /** How many reps actually measured this metric. */
  measured: number;
  /** Why value is null; null when a value is present. */
  reason: string | null;
}

export interface FormCheckSpreads {
  setPointElbowSpreadDeg: SpreadStat;
  /** Frame-height fractions — camera-relative, NOT centimetres. */
  releaseHeightSpread: SpreadStat;
  tempoSpreadMs: SpreadStat;
  kneeSpreadDeg: SpreadStat;
}

/** Sample standard deviation (n−1 denominator; 0 for a single value). */
function sampleStd(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let ss = 0;
  for (const v of values) ss += (v - mean) * (v - mean);
  return Math.sqrt(ss / (n - 1));
}

/**
 * Cross-rep spreads, gated at {@link MIN_SPREAD_REPS} measured reps PER
 * METRIC (a rep can measure the elbow but miss the knee, so the gates are
 * independent). Exported pure so the report math is testable without a
 * session. Deliberately consumes releaseHeightNorm, never releaseHeightM —
 * spreads stay in normalized units so the verdict is scale-independent.
 */
export function sessionSpreads(
  reps: readonly FormCheckRep[],
): FormCheckSpreads {
  const stat = (pick: (m: FormMetrics) => number | null): SpreadStat => {
    const vals: number[] = [];
    for (const r of reps) {
      const v = pick(r.metrics);
      if (v != null) vals.push(v);
    }
    if (vals.length < MIN_SPREAD_REPS) {
      return {
        value: null,
        measured: vals.length,
        reason: `measured on ${vals.length} of ${reps.length} reps — needs at least ${MIN_SPREAD_REPS}`,
      };
    }
    return { value: sampleStd(vals), measured: vals.length, reason: null };
  };
  return {
    setPointElbowSpreadDeg: stat((m) => m.setPointElbowDeg),
    releaseHeightSpread: stat((m) => m.releaseHeightNorm),
    tempoSpreadMs: stat((m) => m.releaseTimeMs),
    kneeSpreadDeg: stat((m) => m.kneeFlexionDeg),
  };
}

// ---------------------------------------------------------------------------
// Best rep (pure)
// ---------------------------------------------------------------------------

export interface BestRep {
  /** 1-based rep index (FormCheckRep.index) of the winner. */
  index: number;
  /** One-line reason assembled from the winner's REAL numbers. */
  reason: string;
}

/**
 * Pick the session's best rep: the one landing the most metrics inside the
 * FORM coaching bands (elbow set point, knee flexion, follow-through hold),
 * ties broken by the tempo closest to the session median. Gated: null under
 * 2 reps, or when the winner measured fewer than 2 of the candidate metrics
 * — a "best" rep must be best AT something measured, never by default.
 */
export function pickBestRep(
  reps: readonly FormCheckRep[],
  spreads: FormCheckSpreads,
): BestRep | null {
  if (reps.length < 2) return null;

  const tempos: number[] = [];
  for (const r of reps) {
    if (r.metrics.releaseTimeMs != null) tempos.push(r.metrics.releaseTimeMs);
  }
  const medTempo = median(tempos);

  const E = FORM.elbowSetPoint;
  const K = FORM.kneeFlexion;

  interface Scored {
    rep: FormCheckRep;
    inBand: number;
    measured: number;
    tempoDist: number;
    parts: string[];
  }
  const scored: Scored[] = reps.map((rep) => {
    const m = rep.metrics;
    const parts: string[] = [];
    let inBand = 0;
    let measured = 0;
    if (m.setPointElbowDeg != null) {
      measured++;
      if (m.setPointElbowDeg >= E.min && m.setPointElbowDeg <= E.max) {
        inBand++;
        parts.push(`elbow ${Math.round(m.setPointElbowDeg)}° in band`);
      }
    }
    if (m.kneeFlexionDeg != null) {
      measured++;
      if (m.kneeFlexionDeg >= K.min && m.kneeFlexionDeg <= K.max) {
        inBand++;
        parts.push(`knee ${Math.round(m.kneeFlexionDeg)}° in band`);
      }
    }
    if (m.followThroughHeldMs != null) {
      measured++;
      if (followThroughHeldFull(m.followThroughHeldMs, rep.poseFps)) {
        inBand++;
        parts.push(`follow-through held ${Math.round(m.followThroughHeldMs)} ms`);
      }
    }
    let tempoDist = Infinity;
    if (m.releaseTimeMs != null) {
      measured++;
      if (medTempo != null) tempoDist = Math.abs(m.releaseTimeMs - medTempo);
    }
    return { rep, inBand, measured, tempoDist, parts };
  });

  let best: Scored | null = null;
  for (const s of scored) {
    if (
      best == null ||
      s.inBand > best.inBand ||
      (s.inBand === best.inBand && s.tempoDist < best.tempoDist)
    ) {
      best = s;
    }
  }
  if (best == null || best.measured < 2) return null;

  // Tempo line only when the winner genuinely sits closest to the median
  // (and a median across ≥2 measured tempos exists — spreads carry the
  // measured count the report already shows).
  if (
    Number.isFinite(best.tempoDist) &&
    spreads.tempoSpreadMs.measured >= 2 &&
    scored.every((s) => s === best || s.tempoDist >= best!.tempoDist)
  ) {
    best.parts.push('tempo closest to your median');
  }
  if (best.parts.length === 0) {
    // Nothing in band, no tempo claim — still name what was real.
    best.parts.push(`${best.measured} metrics measured`);
  }
  return { index: best.rep.index, reason: best.parts.join(' · ') };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** One detected rep: the motion window's sequence, metrics and coaching. */
export interface FormCheckRep {
  /** 1-based rep number in this session. */
  index: number;
  /** Camera time of the pose-gated release event, seconds. */
  releaseT: number;
  /** Packed motion sequence (dip → follow-through), or null when too thin. */
  sequence: FormSequence | null;
  /** Pose-only metrics — releaseAngleDeg/entryAngleDeg are always null. */
  metrics: FormMetrics;
  /** Per-phase timing, each segment independently nullable. */
  phases: RepPhaseTiming;
  /**
   * Metric release height above the standing ankle line — an ESTIMATE, only
   * when calibration produced a height scale; null keeps v1's normalized
   * height as the only number.
   */
  releaseHeightM: number | null;
  /** Shadow-baseline annotations. Flags never gate or modify metrics. */
  flags: readonly RepFlag[];
  tips: CoachingTip[];
  /** Median pose rate across this rep's window, fps. */
  poseFps: number;
  /**
   * Empty = every gate was clean while this rep was captured. Non-empty =
   * the rep is real but was caught under a relaxed gate; the UI must qualify
   * it. Optional so existing rep fixtures still compile (the same idiom as
   * {@link ReadinessSample.sideness}) — a session-produced rep ALWAYS
   * carries the array.
   */
  lowConfidence?: readonly RepConfidenceReason[];
  /**
   * Metrics this rep REFUSED to report, each with its reason. Different from
   * {@link lowConfidence}: that qualifies numbers the rep DID produce, this
   * says why a number is absent. Empty = every null in `metrics` is simply
   * an unmeasurable landmark. Optional so existing rep fixtures compile; a
   * session-produced rep always carries the array.
   */
  refusals?: readonly MetricRefusal[];
}

export interface FormCheckSessionReport {
  repCount: number;
  /** Median of the reps' window pose rates, fps (0 with no reps). */
  medianPoseFps: number;
  spreads: FormCheckSpreads;
  best: BestRep | null;
  /** Frozen calibration receipt snapshot. */
  calibration: CalibrationState;
  /** Hero ring numbers: spreads at/below their flag / spreads measured. */
  verdict: { steady: number; measured: number };
  /**
   * How much of the session was caught under a relaxed gate: `reps` counts
   * reps carrying at least one reason, `reasons` is the de-duplicated union.
   * `reps: 0` means every counted rep had a clean capture. Optional so
   * existing report fixtures still compile; finalizeSession always sets it.
   */
  lowConfidence?: {
    reps: number;
    reasons: readonly RepConfidenceReason[];
  };
}

/**
 * The relaxed-gate receipt as it survives PERSISTENCE.
 *
 * WHY it lives in core: the Form Check screen writes it into a saved
 * session's summaryJson and the Coach card reads it back, so the shape has
 * to be owned by something both sides import. Without it, a session caught
 * under a relaxed gate reappears in history looking exactly as certain as a
 * clean one — which is the one thing a relaxation is never allowed to do.
 *
 * `reps` is 0 when the count could not be recovered (an older row, or a
 * corrupt blob). It is never invented; the label just omits the count.
 */
export interface SavedLowConfidence {
  reps: number;
  reasons: readonly RepConfidenceReason[];
}

/**
 * Decode a SAVED session's relaxed-gate receipt, or null when there is
 * nothing to qualify.
 *
 * `medianPoseFps` is a second, INDEPENDENT witness: it is its own persisted
 * column, so a row written before the receipt existed — or one whose
 * summaryJson is corrupt — is still marked when the session plainly ran
 * under {@link MIN_POSE_FPS}. A missing receipt is never read as evidence of
 * a clean capture; it just cannot add anything beyond what fps already says.
 */
export function savedLowConfidenceOf(row: {
  summaryJson: string;
  medianPoseFps: number;
}): SavedLowConfidence | null {
  let reps = 0;
  const reasons = new Set<RepConfidenceReason>();
  try {
    const lc = (JSON.parse(row.summaryJson) as { lowConfidence?: unknown }).lowConfidence;
    if (lc != null && typeof lc === 'object') {
      const raw = lc as { reps?: unknown; reasons?: unknown };
      if (typeof raw.reps === 'number' && Number.isFinite(raw.reps)) {
        reps = Math.max(0, Math.floor(raw.reps));
      }
      if (Array.isArray(raw.reasons)) {
        for (const r of raw.reasons) {
          if (REP_CONFIDENCE_REASONS.includes(r as RepConfidenceReason)) {
            reasons.add(r as RepConfidenceReason);
          }
        }
      }
    }
  } catch {
    // Corrupt blob: fall through to the fps witness rather than throwing.
  }
  if (row.medianPoseFps > 0 && row.medianPoseFps < MIN_POSE_FPS) reasons.add('lowPoseFps');
  if (reps <= 0 && reasons.size === 0) return null;
  return { reps, reasons: [...reasons] };
}

/** Per-shadow-motion stats, captured for BOTH arms at event time (the
 *  rolling buffer will have pruned the window by lock time). */
interface ShadowMotion {
  t: number;
  /** Resolved vote; null = ghost double-fire abstained. */
  votedArm: ShootingHand | null;
  travel: { left: number | null; right: number | null };
  visFrac: { left: number; right: number };
  meanScore: { left: number | null; right: number | null };
  dipMaxY: { left: number | null; right: number | null };
}

/** Streaming per-arm wrist state for the standing (READY-frame) detector. */
interface WristTrack {
  fy: OneEuroFilter;
  y: number | null;
  t: number;
}

/**
 * Max spacing between wrist samples for the standing-speed finite difference
 * (mirrors the ReleaseDetector's own MAX_VY_GAP_SEC rationale).
 */
const STANDING_MAX_GAP_SEC = 0.15;

/**
 * Streaming Form Check session. Feed every analysed pose frame (timestamp
 * order) via {@link push}; it returns a {@link FormCheckRep} exactly when a
 * rep's follow-through tail completes, else null. Call
 * {@link finalizeSession} once at the end for the cross-rep report.
 *
 * V2 lifecycle: unless constructed with `calibrate: false`, the session
 * opens in calibration phase 'collecting'. Detected motions count as SHADOW
 * reps (push always returns null); after {@link SHADOW_REPS_TARGET} of them
 * — or {@link completeCalibration} after at least one, or
 * {@link skipCalibration} — the session arms and scores normally.
 */
export class FormCheckSession {
  private handSide: ShootingHand;
  private readonly frameHeight: number;
  private readonly heightCm: number | null;
  private detector: FormMotionDetector;

  private readonly readySamples: ReadinessSample[] = [];
  private cachedReadiness: FormCheckReadiness = readinessOf([]);
  /** Camera time of the last readiness recompute (see READINESS_POLL_SEC). */
  private lastReadinessT = -Infinity;
  /** Presenter's labeled escape from the MIN_POSE_FPS floor. */
  private fpsFloorOverride = false;
  /** Presenter's labeled escape from the SIDE_PROFILE_MIN floor. */
  private sideFloorOverride = false;

  /** Last frame on which the STRICT readiness verdict passed (latch anchor). */
  private lastStrictReadyT = -Infinity;
  /** Last frame fed to the detector THROUGH the latch (gates were down). */
  private lastLatchedFeedT = -Infinity;

  /** Rolling raw window (REP_BUFFER_SEC) the rep capture slices from. */
  private buffer: RawSeqFrame[] = [];

  /** Release event awaiting its FOLLOW_TAIL_SEC of further frames. */
  private pendingReleaseT: number | null = null;

  private readonly repsList: FormCheckRep[] = [];

  // — calibration state —
  private calibPhase: CalibrationPhase;
  private handSourceState: HandSource = 'settings';
  /** A manual hand choice wins for the whole session; auto never overrides. */
  private manualLock = false;

  /** Dual shadow detectors (both arms) — allocated only while collecting. */
  private shadowDetectors: { left: FormMotionDetector; right: FormMotionDetector } | null =
    null;
  private shadowMotions: ShadowMotion[] = [];
  /** Ghost-merge settle horizon after the target shadow rep, camera secs. */
  private lockAtT: number | null = null;

  /** Per-frame raw mean arm scores (shoulder+elbow+wrist), collecting only. */
  private scoreSamples: { t: number; left: number | null; right: number | null }[] =
    [];

  /** Standing (READY-frame) collector state. */
  private standingFrames: RawSeqFrame[] = [];
  private standingRun: RawSeqFrame[] = [];
  private wristTracks: { left: WristTrack; right: WristTrack } | null = null;

  /** All non-null side-profile votes over the collection window. */
  private calibSideSum = 0;
  private calibSideN = 0;

  // — locked calibration results (null until lock, or when unmeasurable) —
  private lockedSidenessAvg: number | null = null;
  private lockedTilt: TiltEstimate | null = null;
  private lockedScale: HeightScale | null = null;
  private lockedStandingWristY: number | null = null;
  private lockedStanceWidthN: number | null = null;
  private lockedSetPointWristY: number | null = null;
  /** Standing ankle line for releaseHeightM (same space as the metrics). */
  private standingAnkleY: number | null = null;
  /** Median standing body height, px — the flags' normalizer. */
  private baselineBodyHeightPx: number | null = null;

  // Only the frame HEIGHT matters here (the detector's vertical-velocity and
  // release-height math is height-normalized); a width option would be dead
  // weight, so there deliberately isn't one.
  constructor(opts: {
    hand: ShootingHand;
    frameHeight?: number;
    /** Profile height (profileStore.heightCm) for the metre scale, or null. */
    heightCm?: number | null;
    /** Default true. false ⇒ phase 'skipped': pure v1 behavior, armed now. */
    calibrate?: boolean;
  }) {
    this.handSide = opts.hand;
    this.frameHeight = opts.frameHeight ?? 192;
    this.heightCm = opts.heightCm ?? null;
    this.detector = new FormMotionDetector({
      hand: opts.hand,
      frameHeight: this.frameHeight,
    });
    this.calibPhase = opts.calibrate === false ? 'skipped' : 'collecting';
    if (this.calibPhase === 'collecting') this.startCollecting();
  }

  get hand(): ShootingHand {
    return this.handSide;
  }

  get readiness(): FormCheckReadiness {
    return this.cachedReadiness;
  }

  get reps(): readonly FormCheckRep[] {
    return this.repsList;
  }

  /** Live calibration snapshot (a defensive copy — safe to hold across frames). */
  get calibration(): CalibrationState {
    return {
      phase: this.calibPhase,
      shadowReps: Math.min(this.shadowMotions.length, SHADOW_REPS_TARGET),
      hand: this.handSide,
      handSource: this.handSourceState,
      sidenessAvg: this.lockedSidenessAvg,
      tilt: this.lockedTilt ? { ...this.lockedTilt } : null,
      scale: this.lockedScale ? { ...this.lockedScale } : null,
      standingWristY: this.lockedStandingWristY,
      stanceWidthN: this.lockedStanceWidthN,
      setPointWristY: this.lockedSetPointWristY,
    };
  }

  /** Scoring armed — calibration finished or skipped. */
  get armed(): boolean {
    return this.calibPhase !== 'collecting';
  }

  /** Whether the fps-floor override is currently switched on. */
  get fpsFloorOverridden(): boolean {
    return this.fpsFloorOverride;
  }

  /**
   * Count reps even though the measured pose rate is under
   * {@link MIN_POSE_FPS} — the presenter's one-tap escape from a room and a
   * phone that cannot make the floor (a dim room stretches exposure, an old
   * phone thermally throttles, and "more light" is not an instruction anyone
   * can follow on stage). The floor is NOT lowered: `readiness.fpsOverridden`
   * stays true for as long as the override is doing the work, and every rep
   * captured under it carries the 'lowConfidence' reason 'lowPoseFps'. It
   * still refuses below {@link FPS_OVERRIDE_MIN}, where no rep could fire
   * anyway. Takes effect on the next pushed frame.
   */
  overrideFpsFloor(on = true): void {
    this.fpsFloorOverride = on;
    // Force a recompute so the strip flips on the very next frame instead of
    // waiting out the readiness poll.
    this.lastReadinessT = -Infinity;
  }

  /** Whether the side-profile override is currently switched on. */
  get sideFloorOverridden(): boolean {
    return this.sideFloorOverride;
  }

  /**
   * Count reps even though the shooter is measurably squarer to the camera
   * than {@link SIDE_PROFILE_MIN} — the presenter's one-tap escape from a
   * room that will not let anyone stand side-on. "Turn 90°" is not an
   * instruction a demo floor can always satisfy: the furniture, the wall and
   * the audience decide where the shooter may stand, and without this the
   * screen pauses everything — scoring AND calibration — with nothing on it
   * that can help.
   *
   * The floor is NOT lowered, in either of the two senses that matter:
   *  - `readiness.sideOverridden` stays true for as long as the override is
   *    doing the work, `readiness.sideness` keeps reporting the measured
   *    stance, `sideTrusted` stays false, and every rep captured under it
   *    carries the 'lowConfidence' reason 'angledStance';
   *  - the METRICS still refuse. Every 2D joint angle read below
   *    {@link SIDE_PROFILE_MIN} is dropped with a 'stanceNotSideOn'
   *    {@link MetricRefusal} rather than reported foreshortened, so the
   *    escape buys a rep COUNT and the numbers a yaw cannot distort — never
   *    a set-point or follow-through claim the camera could not see.
   *
   * Unlike {@link overrideFpsFloor} there is no floor beneath it: no stance
   * makes the wrist-snap signature unmeasurable, so a cutoff here would be
   * invented. It is a no-op against a stance the gauge cannot measure (that
   * one already passes). Takes effect on the next pushed frame.
   */
  overrideSideFloor(on = true): void {
    this.sideFloorOverride = on;
    // Same as the fps override: flip the strip on the next frame rather than
    // waiting out the readiness poll.
    this.lastReadinessT = -Infinity;
  }

  /**
   * Switch the watched shooting arm (the live screen's tap-to-flip chip).
   * Resets the detector and any pending rep — a half-captured rep from the
   * other arm would be garbage — but keeps completed reps (each rep's
   * sequence already recorded the hand it was captured with).
   *
   * `source` defaults to 'manual': a manual choice wins permanently for the
   * session and disables the auto-handedness vote (the chip must then read
   * the arm as chosen, never "detected").
   */
  setHand(hand: ShootingHand, source: HandSource = 'manual'): void {
    this.handSourceState = source;
    if (source === 'manual') this.manualLock = true;
    if (hand === this.handSide) return;
    this.handSide = hand;
    this.detector = new FormMotionDetector({
      hand,
      frameHeight: this.frameHeight,
    });
    this.pendingReleaseT = null;
  }

  /**
   * Arm scoring NOW with every calibration field null — pure v1 behavior.
   * The receipt reads phase 'skipped'; nothing collected so far is used.
   */
  skipCalibration(): void {
    if (this.calibPhase !== 'collecting') return;
    this.calibPhase = 'skipped';
    // A skip locks NOTHING — an 'auto' left over from an earlier lock no
    // longer has a live vote behind it, so the chip/receipt must fall back
    // to ASSUMED. A manual pick stays: the user chose it, no vote involved.
    if (!this.manualLock) this.handSourceState = 'settings';
    this.shadowMotions = [];
    this.clearCollectors();
  }

  /**
   * Finish calibration early (the "Start scoring" tap after ≥1 shadow rep).
   * No-op with zero shadow reps — there is nothing honest to lock yet.
   */
  completeCalibration(): void {
    if (this.calibPhase !== 'collecting') return;
    if (this.shadowMotions.length === 0) return;
    this.lockCalibration();
  }

  /**
   * Re-enter 'collecting': shadow counters and gauges restart, scored reps
   * are KEPT (they were honest when scored), and a manual hand choice stays
   * locked. Previously locked calibration fields are discarded — the new
   * lock will re-measure them.
   */
  recalibrate(): void {
    this.calibPhase = 'collecting';
    this.pendingReleaseT = null;
    // The old auto vote is discarded with the other locked fields: until the
    // NEW lock re-votes (and it may abstain), the arm is merely assumed —
    // the chip must read ASSUMED, never a stale "detected". The watched arm
    // itself keeps its current side (it was honest when detected), and a
    // manual pick stays locked.
    if (!this.manualLock) this.handSourceState = 'settings';
    this.lockedSidenessAvg = null;
    this.lockedTilt = null;
    this.lockedScale = null;
    this.lockedStandingWristY = null;
    this.lockedStanceWidthN = null;
    this.lockedSetPointWristY = null;
    this.standingAnkleY = null;
    this.baselineBodyHeightPx = null;
    this.startCollecting();
  }

  /**
   * Feed one pose frame (camera-timestamp order). Returns the finalized rep
   * exactly on the frame that completes its follow-through tail, else null.
   * While calibration is collecting, detected motions advance the SHADOW
   * counter and this ALWAYS returns null — shadow reps are never scored.
   */
  push(pose: PoseFrame): FormCheckRep | null {
    const t = pose.t;

    // 0. ONE score-gated raw frame per push — the side vote, the rolling
    // buffer, and calibration collection all read this single allocation
    // (a second toRawSeqFrame here would be per-camera-frame garbage).
    const raw = toRawSeqFrame(pose);

    // 1. Readiness over the trailing window (always tracked, ready or not —
    // the strip must know when the gates recover). V2 adds the per-frame
    // side-profile vote (null = abstain).
    const vis = frameVisibility(pose, this.handSide);
    const side = raw != null ? sideProfileOfRaw(raw) : null;
    this.readySamples.push({ t, fullBody: vis.fullBody, arm: vis.arm, sideness: side });
    const rCut = t - READINESS_WINDOW_SEC;
    while (this.readySamples.length > 0 && this.readySamples[0]!.t < rCut) {
      this.readySamples.shift();
    }
    // readinessOf allocates three arrays per call to summarize a 2 s window
    // the UI reads 4×/s; at camera rate that is a steady young-gen GC source
    // on an A12, and the jank lands exactly where the skeleton should look
    // smooth. Recomputing at READINESS_POLL_SEC is still 2.5× the UI poll and
    // vastly faster than the window it summarizes.
    if (t - this.lastReadinessT >= READINESS_POLL_SEC) {
      this.lastReadinessT = t;
      this.cachedReadiness = readinessOf(this.readySamples, {
        fpsFloorOverride: this.fpsFloorOverride,
        sideFloorOverride: this.sideFloorOverride,
      });
    }

    // 2. Raw window (always buffered — capture gating lives on the trigger).
    if (raw != null) {
      this.buffer.push(raw);
      const bCut = t - REP_BUFFER_SEC;
      let drop = 0;
      while (drop < this.buffer.length && this.buffer[drop]!.t < bCut) drop++;
      // splice, not slice: in place, no per-frame array allocation. Nothing
      // else retains this.buffer (finalizeRep copies via .filter).
      if (drop > 0) this.buffer.splice(0, drop);
    }

    // 3. Calibration collection owns the frame while 'collecting' — the
    // scoring trigger and pending-rep pipeline stay idle, so a shadow motion
    // can never leak into the scored list.
    if (this.calibPhase === 'collecting') {
      this.collectCalibration(pose, raw, side, t);
      return null;
    }

    // 4. A pending rep finalizes once its follow-through tail is on record.
    let rep: FormCheckRep | null = null;
    if (
      this.pendingReleaseT != null &&
      t - this.pendingReleaseT >= FOLLOW_TAIL_SEC - 1e-9
    ) {
      rep = this.finalizeRep(this.pendingReleaseT);
      this.pendingReleaseT = null;
    }

    // 5. The rep TRIGGER. The gates decide when capture is honest, but they
    // are trailing-window fractions and the TOP of a motion is exactly when
    // keypoints go missing — a hard gate here stops feeding the detector
    // mid-signature and the rep vanishes with no trace on screen. So the
    // feed is LATCHED for READY_LATCH_SEC past the last strictly-ready
    // frame; reps captured across a latched frame are reported
    // 'gateDropout'. The strip, the chips and the calibration collector keep
    // reading the strict verdict — the screen must not go green on a capture
    // it did not have. FORM_MOTION.debounceSec exceeds the tail, so a
    // pending rep always completes before the next event can fire.
    const strictReady = this.cachedReadiness.ready;
    if (strictReady) this.lastStrictReadyT = t;
    const latched = !strictReady && t - this.lastStrictReadyT <= READY_LATCH_SEC;
    if (strictReady || latched) {
      if (latched) this.lastLatchedFeedT = t;
      const ev = this.detector.push(pose);
      if (ev != null && this.pendingReleaseT == null) {
        this.pendingReleaseT = ev.t;
      }
    }

    return rep;
  }

  /**
   * End the session: flush a still-pending rep with whatever tail exists
   * (its follow-through metrics only claim what was observed), then compute
   * the cross-rep report. A session ended while still collecting locks
   * nothing — the receipt honestly reads phase 'collecting'.
   */
  finalizeSession(): FormCheckSessionReport {
    if (this.pendingReleaseT != null) {
      this.finalizeRep(this.pendingReleaseT);
      this.pendingReleaseT = null;
    }
    const fpsList = this.repsList.map((r) => r.poseFps);
    const medianPoseFps = fpsList.length > 0 ? median(fpsList)! : 0;
    const spreads = sessionSpreads(this.repsList);

    let steady = 0;
    let measured = 0;
    const gauge = (stat: SpreadStat, flag: number) => {
      if (stat.value == null) return;
      measured++;
      if (stat.value <= flag) steady++;
    };
    gauge(spreads.setPointElbowSpreadDeg, ELBOW_SPREAD_FLAG_DEG);
    gauge(spreads.tempoSpreadMs, TEMPO_SPREAD_FLAG_MS);
    gauge(spreads.kneeSpreadDeg, KNEE_SPREAD_FLAG_DEG);
    gauge(spreads.releaseHeightSpread, RELEASE_HEIGHT_SPREAD_FLAG);

    // Relaxed-gate receipt for the whole session — the report must be able
    // to say how much of it was caught under a relaxed gate, and why.
    let lowConfidenceReps = 0;
    const reasonSet = new Set<RepConfidenceReason>();
    for (const r of this.repsList) {
      const reasons = r.lowConfidence ?? [];
      if (reasons.length === 0) continue;
      lowConfidenceReps++;
      for (const reason of reasons) reasonSet.add(reason);
    }

    return {
      repCount: this.repsList.length,
      medianPoseFps,
      spreads,
      best: pickBestRep(this.repsList, spreads),
      calibration: this.calibration,
      verdict: { steady, measured },
      lowConfidence: {
        reps: lowConfidenceReps,
        reasons: [...reasonSet],
      },
    };
  }

  // -------------------------------------------------------------------------
  // Calibration internals
  // -------------------------------------------------------------------------

  private startCollecting(): void {
    this.shadowDetectors = {
      left: new FormMotionDetector({ hand: 'left', frameHeight: this.frameHeight }),
      right: new FormMotionDetector({ hand: 'right', frameHeight: this.frameHeight }),
    };
    this.wristTracks = {
      left: { fy: new OneEuroFilter(FORM.oneEuro), y: null, t: 0 },
      right: { fy: new OneEuroFilter(FORM.oneEuro), y: null, t: 0 },
    };
    this.shadowMotions = [];
    this.scoreSamples = [];
    this.standingFrames = [];
    this.standingRun = [];
    this.calibSideSum = 0;
    this.calibSideN = 0;
    this.lockAtT = null;
  }

  private clearCollectors(): void {
    this.shadowDetectors = null;
    this.wristTracks = null;
    this.scoreSamples = [];
    this.standingFrames = [];
    this.standingRun = [];
    this.lockAtT = null;
  }

  /** One frame of shadow-rep + gauge collection (phase 'collecting' only). */
  private collectCalibration(
    pose: PoseFrame,
    raw: RawSeqFrame | null,
    side: number | null,
    t: number,
  ): void {
    if (side != null) {
      this.calibSideSum += side;
      this.calibSideN++;
    }

    // Raw per-arm keypoint-score samples for the mirror-ghost tiebreak.
    this.scoreSamples.push({
      t,
      left: armMeanScore(pose, 'left'),
      right: armMeanScore(pose, 'right'),
    });
    const sCut = t - REP_BUFFER_SEC;
    let drop = 0;
    while (drop < this.scoreSamples.length && this.scoreSamples[drop]!.t < sCut) {
      drop++;
    }
    // splice, not slice — calibration is the most expensive per-frame path
    // on the screen and it runs in the first seconds on stage.
    if (drop > 0) this.scoreSamples.splice(0, drop);

    // Standing (READY-frame) collector for tilt / height / baselines.
    if (raw != null) this.trackStanding(raw, t);

    // Shadow detection: gated on fps + full body + side profile, but NOT on
    // the arm gate — the watched arm is exactly what calibration is trying
    // to determine, so a wrong Settings hand must not brick the vote. The
    // committed vote carries its own per-arm visibility gate instead.
    const r = this.cachedReadiness;
    if (r.fpsOk && r.fullBodyOk && r.sideOk && this.shadowDetectors != null) {
      const evL = this.shadowDetectors.left.push(pose);
      const evR = this.shadowDetectors.right.push(pose);
      if (evL != null) this.onShadowEvent('left', evL.t);
      if (evR != null) this.onShadowEvent('right', evR.t);
    }

    // Lock after the ghost-merge horizon settles past the target rep.
    if (this.lockAtT != null && t >= this.lockAtT) this.lockCalibration();
  }

  /** Handle one shadow release event (either arm). */
  private onShadowEvent(arm: ShootingHand, t: number): void {
    const last = this.shadowMotions[this.shadowMotions.length - 1];
    if (
      last != null &&
      t - last.t <= GHOST_WINDOW_SEC &&
      last.votedArm != null &&
      last.votedArm !== arm
    ) {
      // Mirror-ghost double-fire: ONE motion, two detectors. The vote goes
      // to the arm whose keypoints actually scored higher over the window;
      // a near-tie abstains — auto-handedness must be allowed to refuse.
      const sl = last.meanScore.left;
      const sr = last.meanScore.right;
      if (sl != null && sr != null) {
        const hi = Math.max(sl, sr);
        last.votedArm =
          hi > 0 && Math.abs(sl - sr) / hi > GHOST_SCORE_TIE_FRAC
            ? sl > sr
              ? 'left'
              : 'right'
            : null;
      } else {
        last.votedArm = null;
      }
      return;
    }

    // New shadow motion: capture BOTH arms' window stats now — the rolling
    // buffer will have pruned this window long before lock time.
    const lo = t - PRE_RELEASE_SEC - 1e-9;
    const window = this.buffer.filter((f) => f.t >= lo && f.t <= t + 1e-9);
    const statsL = armWindowStats(window, 'left');
    const statsR = armWindowStats(window, 'right');
    let scoreL: number | null = null;
    let scoreR: number | null = null;
    {
      let sumL = 0;
      let nL = 0;
      let sumR = 0;
      let nR = 0;
      for (const s of this.scoreSamples) {
        if (s.t < lo || s.t > t + 1e-9) continue;
        if (s.left != null) {
          sumL += s.left;
          nL++;
        }
        if (s.right != null) {
          sumR += s.right;
          nR++;
        }
      }
      scoreL = nL > 0 ? sumL / nL : null;
      scoreR = nR > 0 ? sumR / nR : null;
    }
    this.shadowMotions.push({
      t,
      votedArm: arm,
      travel: { left: statsL.travel, right: statsR.travel },
      visFrac: { left: statsL.visFrac, right: statsR.visFrac },
      meanScore: { left: scoreL, right: scoreR },
      dipMaxY: { left: statsL.dipMaxY, right: statsR.dipMaxY },
    });
    if (this.shadowMotions.length >= SHADOW_REPS_TARGET && this.lockAtT == null) {
      // Settle one ghost window before locking so a trailing mirror double-
      // fire can still merge into (and possibly abstain) the final vote.
      this.lockAtT = t + GHOST_WINDOW_SEC;
    }
  }

  /** Standing detector: contiguous ≥ STANDING_MIN_SEC runs of a still,
   *  below-shoulder wrist on every visible arm feed the READY-frame pool. */
  private trackStanding(raw: RawSeqFrame, t: number): void {
    const tracks = this.wristTracks;
    if (tracks == null) return;
    const speedMax = STANDING_WRIST_SPEED_FRAC * this.frameHeight;

    let sawWrist = false;
    let standing = true;
    for (const arm of ['left', 'right'] as const) {
      const wrist = raw.pts.get(`${arm}_wrist` as PoseKeypointName);
      const track = tracks[arm];
      if (!wrist) continue;
      sawWrist = true;
      const shoulder = raw.pts.get(`${arm}_shoulder` as PoseKeypointName);
      // Below the shoulder (+y down ⇒ larger y); an unverifiable arm
      // (missing shoulder) disqualifies the frame — refuse, don't guess.
      if (!shoulder || wrist.y <= shoulder.y) standing = false;
      const fy = track.fy.filter(wrist.y, t);
      if (track.y != null && t > track.t && t - track.t <= STANDING_MAX_GAP_SEC) {
        const speed = Math.abs(fy - track.y) / (t - track.t);
        if (speed >= speedMax) standing = false;
      } else {
        // No usable previous sample — stillness can't be verified yet.
        standing = false;
      }
      track.y = fy;
      track.t = t;
    }
    if (!sawWrist) standing = false;

    if (standing) {
      // Memory bound: the flush only ever takes STANDING_FRAMES_CAP frames
      // from the FRONT of a run, so frames past the cap could never be
      // consumed — drop them here rather than letting a shooter who props
      // the phone up and stands still grow the run unbounded at camera rate.
      if (this.standingRun.length < STANDING_FRAMES_CAP) {
        this.standingRun.push(raw);
      }
    } else {
      this.flushStandingRun();
    }
  }

  private flushStandingRun(): void {
    const run = this.standingRun;
    if (run.length >= 2) {
      const dur = run[run.length - 1]!.t - run[0]!.t;
      if (dur >= STANDING_MIN_SEC) {
        for (const f of run) {
          if (this.standingFrames.length >= STANDING_FRAMES_CAP) break;
          this.standingFrames.push(f);
        }
      }
    }
    this.standingRun = [];
  }

  /** Freeze the collected gauges into the calibration receipt and arm. */
  private lockCalibration(): void {
    this.flushStandingRun();

    // — auto-handedness vote —
    if (!this.manualLock) {
      const votes: Record<ShootingHand, ShadowMotion[]> = { left: [], right: [] };
      for (const m of this.shadowMotions) {
        if (m.votedArm != null) votes[m.votedArm].push(m);
      }
      const meanTravel = (arm: ShootingHand): number | null => {
        const vals: number[] = [];
        for (const m of this.shadowMotions) {
          const v = m.travel[arm];
          if (v != null) vals.push(v);
        }
        if (vals.length === 0) return null;
        let sum = 0;
        for (const v of vals) sum += v;
        return sum / vals.length;
      };
      let winner: ShootingHand | null = null;
      const lv = votes.left.length;
      const rv = votes.right.length;
      if (lv > 0 && rv === 0) winner = 'left';
      else if (rv > 0 && lv === 0) winner = 'right';
      else if (lv > 0 && rv > 0) {
        const lt = meanTravel('left');
        const rt = meanTravel('right');
        if (lt != null && rt != null) {
          if (lt >= HAND_TRAVEL_RATIO * rt) winner = 'left';
          else if (rt >= HAND_TRAVEL_RATIO * lt) winner = 'right';
        }
      }
      if (winner != null) {
        let visSum = 0;
        for (const m of votes[winner]) visSum += m.visFrac[winner];
        const visFrac = votes[winner].length > 0 ? visSum / votes[winner].length : 0;
        if (visFrac >= VISIBILITY_MIN_FRAC) {
          // Commit: the chip may say the arm was detected, not assumed.
          if (winner !== this.handSide) {
            this.handSide = winner;
            this.detector = new FormMotionDetector({
              hand: winner,
              frameHeight: this.frameHeight,
            });
            this.pendingReleaseT = null;
          }
          this.handSourceState = 'auto';
        }
        // Gate failed ⇒ handSource stays 'settings' — the chip must read
        // "ASSUMED", never "detected".
      }
    }

    // — gauges over the standing pool —
    this.lockedSidenessAvg =
      this.calibSideN > 0 ? this.calibSideSum / this.calibSideN : null;
    this.lockedTilt = estimateTilt(this.standingFrames);
    this.lockedScale = heightScaleOf(this.standingFrames, this.heightCm);

    const hand = this.handSide;
    const wristName = `${hand}_wrist` as PoseKeypointName;
    {
      // Median FILTERED standing wrist y (fresh filter over the pool).
      const fy = new OneEuroFilter(FORM.oneEuro);
      const ys: number[] = [];
      for (const f of this.standingFrames) {
        const w = f.pts.get(wristName);
        if (w) ys.push(fy.filter(w.y, f.t));
      }
      this.lockedStandingWristY = median(ys);
    }
    {
      const widths: number[] = [];
      const heights: number[] = [];
      const ankleYs: number[] = [];
      for (const f of this.standingFrames) {
        const la = f.pts.get('left_ankle');
        const ra = f.pts.get('right_ankle');
        const h = bodyHeightOf(f.pts);
        if (h != null) heights.push(h);
        if (la && ra && h != null) widths.push(Math.abs(la.x - ra.x) / h);
        const mid = pairMid(f.pts, 'left_ankle', 'right_ankle');
        if (mid) ankleYs.push(mid.y);
      }
      this.lockedStanceWidthN = median(widths);
      this.baselineBodyHeightPx = median(heights);
      // The ankle line lives in the same (possibly tilt-rotated) space the
      // metrics report their release wrist in.
      const rawAnkleY = median(ankleYs);
      if (rawAnkleY == null) {
        this.standingAnkleY = null;
      } else if (this.lockedTilt?.confident && this.lockedTilt.tiltDeg !== 0) {
        const rotYs: number[] = [];
        const rot = rotateFrames(
          this.standingFrames,
          -this.lockedTilt.tiltDeg,
          this.frameHeight,
        );
        for (const f of rot) {
          const mid = pairMid(f.pts, 'left_ankle', 'right_ankle');
          if (mid) rotYs.push(mid.y);
        }
        this.standingAnkleY = median(rotYs);
      } else {
        this.standingAnkleY = rawAnkleY;
      }
    }
    {
      const dips: number[] = [];
      for (const m of this.shadowMotions) {
        const d = m.dipMaxY[hand];
        if (d != null) dips.push(d);
      }
      this.lockedSetPointWristY = dips.length > 0 ? Math.max(...dips) : null;
    }

    this.calibPhase = 'done';
    this.clearCollectors();
  }

  // -------------------------------------------------------------------------
  // Rep finalization
  // -------------------------------------------------------------------------

  /** Median per-frame body height over a window, px (null when none votes). */
  private windowBodyHeightPx(window: readonly RawSeqFrame[]): number | null {
    const hs: number[] = [];
    for (const f of window) {
      const h = bodyHeightOf(f.pts);
      if (h != null) hs.push(h);
    }
    return median(hs);
  }

  private finalizeRep(releaseT: number): FormCheckRep {
    const lo = releaseT - PRE_RELEASE_SEC - 1e-9;
    const hi = releaseT + FOLLOW_TAIL_SEC + 1e-9;
    const window = this.buffer.filter((f) => f.t >= lo && f.t <= hi);
    const tiltDeg =
      this.lockedTilt != null && this.lockedTilt.confident
        ? this.lockedTilt.tiltDeg
        : null;
    // Body-relative dip epsilon from THIS rep's own window — a fixed 0.25 px
    // is a noise crossing on a shooter who is ~130 px tall, so the dip would
    // confirm off jitter. Median over the window (not the calibration
    // baseline) so a skipped calibration is no worse off.
    const dipEpsPx = dipEpsFor(this.windowBodyHeightPx(window));
    // The stance this rep was actually captured at, measured over the rep's
    // OWN window — the receipt AND the metric refusal below are decided from
    // it, never from the session-wide override switch. A window that cannot
    // vote abstains and nothing is refused; that is not a loophole, because
    // the buffer this window is sliced from is a SUBSET of the frames the
    // readiness gate votes over, so a rep window too occluded to vote could
    // never have belonged to a session whose side gate was failing.
    const sideness = this.windowSideness(window);
    const { metrics, refusals } = computeRepMetricsDetailed(window, {
      hand: this.handSide,
      frameHeight: this.frameHeight,
      releaseT,
      tiltDeg,
      dipEpsPx,
      sideness,
    });

    // Metric release height — an ESTIMATE, only with a calibration scale
    // and a standing ankle line. Never feeds spreads or metrics.
    let releaseHeightM: number | null = null;
    if (
      this.lockedScale != null &&
      this.standingAnkleY != null &&
      metrics.releaseHeightNorm != null &&
      this.frameHeight > 0
    ) {
      const releaseWristY = (1 - metrics.releaseHeightNorm) * this.frameHeight;
      releaseHeightM =
        (this.standingAnkleY - releaseWristY) * this.lockedScale.metersPerPx;
    }

    const poseFps = medianFps(window.map((f) => f.t));
    const rep: FormCheckRep = {
      index: this.repsList.length + 1,
      releaseT,
      sequence: buildSequence(window, this.handSide, releaseT),
      metrics,
      phases: computePhaseTiming(window, {
        hand: this.handSide,
        releaseT,
        // Same rotation, same epsilon, same dip, same stance as the metrics.
        tiltDeg,
        frameHeight: this.frameHeight,
        dipEpsPx,
        sideness,
      }),
      releaseHeightM,
      flags: this.repFlags(window, releaseT, dipEpsPx),
      tips: [],
      poseFps,
      lowConfidence: this.repConfidence(poseFps, lo, sideness),
      refusals,
    };
    // coachingTips already skips null metrics, so the ball-derived nulls
    // simply produce no ball tips — never a fabricated one.
    rep.tips = coachingTips(rep.metrics);
    this.repsList.push(rep);
    return rep;
  }

  /**
   * What this rep's capture cost in confidence — the relaxed-gate receipt.
   * Reported, never hidden and never used to suppress the rep: the motion
   * happened and its numbers were measured, they are simply worth less than
   * a clean capture's. Each reason is decided from what was actually
   * observed over the rep's own window, not from a session-wide setting.
   */
  private repConfidence(
    poseFps: number,
    windowStartT: number,
    sideness: number | null,
  ): RepConfidenceReason[] {
    const reasons: RepConfidenceReason[] = [];

    // The floor itself never moved, so a rep here really did run on coarse
    // timing. Usually the presenter's override — but this median is over the
    // REP's window while the gate reads the readiness window, so a dip the
    // gate never saw (READY_LATCH_SEC carried it) also lands here.
    if (poseFps > 0 && poseFps < MIN_POSE_FPS) reasons.push('lowPoseFps');

    // The latch fed the detector through a gate dropout inside this window.
    if (this.lastLatchedFeedT >= windowStartT) reasons.push('gateDropout');

    // Measurably angled toward the camera ⇒ foreshortened 2D angles. An
    // unmeasurable stance abstains (occlusion is not evidence of anything).
    //
    // A rep captured under the side override lands here BY CONSTRUCTION —
    // the override only engages against a stance measured below
    // SIDE_PROFILE_MIN, which is below SIDE_PROFILE_TRUSTED. The reason is
    // EXTENDED to it rather than duplicated by a second one: 'angledStance'
    // already says the one thing that is true of both, and a report reading
    // the union of reasons must not have to learn two words for it. What
    // separates the two cases in the data is the rep's REFUSALS — a
    // sub-floor rep carries 'stanceNotSideOn' and has no joint angle to
    // qualify, an angled-but-passing rep carries the angles with this
    // caveat on them.
    if (sideness != null && sideness < SIDE_PROFILE_TRUSTED) {
      reasons.push('angledStance');
    }
    return reasons;
  }

  /**
   * Mean side-profile gauge over a rep window, or null when too few of its
   * frames could vote ({@link SIDE_VOTE_MIN_FRAC}) — the same abstain rule
   * {@link readinessOf} applies to the live window, so a rep is judged the
   * way the gate that let it through was judged.
   */
  private windowSideness(window: readonly RawSeqFrame[]): number | null {
    let sum = 0;
    let n = 0;
    for (const f of window) {
      const s = sideProfileOfRaw(f);
      if (s != null) {
        sum += s;
        n++;
      }
    }
    return n > 0 && n >= SIDE_VOTE_MIN_FRAC * window.length ? sum / n : null;
  }

  /**
   * Shadow-baseline annotations for one scored rep. ANNOTATE-ONLY by
   * contract: flags never gate, fabricate, or modify metrics. Both flags
   * compare in raw (untilted) pixel space — the same space the shadow
   * baselines were captured in.
   */
  private repFlags(
    window: readonly RawSeqFrame[],
    releaseT: number,
    dipEpsPx: number,
  ): RepFlag[] {
    const flags: RepFlag[] = [];
    if (this.calibPhase !== 'done') return flags;
    const hand = this.handSide;
    const wristName = `${hand}_wrist` as PoseKeypointName;

    if (this.lockedSetPointWristY != null && this.baselineBodyHeightPx != null) {
      const series = filterSeries(window, [wristName]);
      const { dipMaxY, dipConfirmed } = findDip(
        window,
        series,
        wristName,
        releaseT,
        dipEpsPx,
      );
      if (
        dipConfirmed &&
        this.lockedSetPointWristY - dipMaxY >
          SHALLOW_DIP_FRAC * this.baselineBodyHeightPx
      ) {
        flags.push('shallowDip');
      }
    }

    if (this.lockedStanceWidthN != null && this.lockedStanceWidthN > 0) {
      const widths: number[] = [];
      for (const f of window) {
        const la = f.pts.get('left_ankle');
        const ra = f.pts.get('right_ankle');
        const h = bodyHeightOf(f.pts);
        if (la && ra && h != null) widths.push(Math.abs(la.x - ra.x) / h);
      }
      const w = median(widths);
      if (
        w != null &&
        Math.abs(w - this.lockedStanceWidthN) / this.lockedStanceWidthN >
          STANCE_DRIFT_FRAC
      ) {
        flags.push('stanceDrift');
      }
    }
    return flags;
  }
}

/** Mean raw keypoint score of one arm's shoulder+elbow+wrist (no score
 *  floor — the mirror-ghost tiebreak needs the low scores too). Null when
 *  none of the three landmarks exists on the frame. */
function armMeanScore(pose: PoseFrame, arm: ShootingHand): number | null {
  let sum = 0;
  let n = 0;
  for (const part of ['shoulder', 'elbow', 'wrist'] as const) {
    const kp = pose.keypoints[`${arm}_${part}` as PoseKeypointName];
    if (kp != null && Number.isFinite(kp.score)) {
      sum += kp.score;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

/** Filtered-wrist travel + dip + visibility for one arm over a window. */
function armWindowStats(
  window: readonly RawSeqFrame[],
  arm: ShootingHand,
): { travel: number | null; dipMaxY: number | null; visFrac: number } {
  const wristName = `${arm}_wrist` as PoseKeypointName;
  const elbowName = `${arm}_elbow` as PoseKeypointName;
  const shoulderName = `${arm}_shoulder` as PoseKeypointName;
  const fy = new OneEuroFilter(FORM.oneEuro);
  let minY = Infinity;
  let maxY = -Infinity;
  let samples = 0;
  let visCount = 0;
  for (const f of window) {
    const w = f.pts.get(wristName);
    if (w) {
      const y = fy.filter(w.y, f.t);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      samples++;
      if (f.pts.get(elbowName) && f.pts.get(shoulderName)) visCount++;
    }
  }
  return {
    travel: samples >= 2 ? maxY - minY : null,
    dipMaxY: samples >= 1 ? maxY : null,
    visFrac: window.length > 0 ? visCount / window.length : 0,
  };
}

/**
 * Score-gated {@link RawSeqFrame} for the rolling window (mirrors
 * FormSequenceBuffer.push, which is private to its class). Returns null for
 * a frame with no usable landmarks at all.
 */
function toRawSeqFrame(pose: PoseFrame): RawSeqFrame | null {
  const pts = new Map<PoseKeypointName, { x: number; y: number }>();
  for (const [name, kp] of Object.entries(pose.keypoints) as [
    PoseKeypointName,
    { x: number; y: number; score: number },
  ][]) {
    if (
      kp &&
      kp.score >= FORM.keypointScoreMin &&
      Number.isFinite(kp.x) &&
      Number.isFinite(kp.y)
    ) {
      pts.set(name, { x: kp.x, y: kp.y });
    }
  }
  if (pts.size === 0) return null;
  return { t: pose.t, pts };
}
