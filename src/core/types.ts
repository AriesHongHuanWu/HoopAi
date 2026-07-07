/**
 * Core domain types for the HoopAI realtime shot-tracking pipeline.
 *
 * COORDINATE CONVENTION
 * ---------------------
 * All geometry lives in "analysis frame" pixel space: the resized camera
 * frame fed to the detector (e.g. 640×640 letterboxed). Origin is top-left,
 * +x right, +y DOWN. A ball moving upward therefore has vy < 0.
 *
 * Angles reported to users (release angle, entry angle) are expressed in
 * degrees above the horizontal in real-world orientation, i.e. computed
 * after flipping the y axis. 0° = flat, 90° = straight up/down.
 *
 * Time `t` is in SECONDS, monotonic, sourced from camera frame timestamps
 * (never Date.now()) so events can be aligned with the video recording.
 */

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned box, x/y is the TOP-LEFT corner. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Classes produced by the object detector (custom 3-class model + person). */
export type DetClass = 'ball' | 'rim' | 'ball_in_basket' | 'person';

export interface Detection {
  cls: DetClass;
  /** Confidence 0..1 */
  score: number;
  box: Box;
}

/** On-device parser diagnostics (for the live debug panel). */
export interface FrameDebug {
  outputLen: number;
  rows: number;
  n: number;
  layout: 'channels-first' | 'channels-last';
  rawCount: number;
  maxScore: number;
  coordMax: number;
  /**
   * True when BOTH tensor layouts read as transpose-garbage (>5% of anchors
   * firing). A real frame never does this in both layouts — it only happens
   * when the inference delegate returned a CORRUPTED output tensor (the iOS
   * CoreML/Metal-on-YOLO failure mode). The engine watches this to auto-fall
   * back from a corrupting accelerator to the CPU delegate.
   */
  corrupt: boolean;
}

/** One analysed camera frame's raw detector output. */
export interface FrameDetections {
  /** Seconds, from camera frame timestamp. */
  t: number;
  frameWidth: number;
  frameHeight: number;
  detections: Detection[];
  /** Parser diagnostics, present when running a real model (not the mock). */
  debug?: FrameDebug;
}

// ---------------------------------------------------------------------------
// Ball tracking
// ---------------------------------------------------------------------------

/** A single accepted ball observation (possibly Kalman-predicted). */
export interface BallSample {
  /** Ball center. */
  cx: number;
  cy: number;
  /** Ball radius estimate in analysis-frame pixels. */
  r: number;
  /** Seconds. */
  t: number;
  /** Detector confidence of the underlying detection; 0 for pure predictions. */
  score: number;
  /** True when this sample came from Kalman prediction (no detection). */
  predicted: boolean;
}

/** Ball sample enriched with velocity estimates from the Kalman filter (px/s). */
export interface TrackedBall extends BallSample {
  vx: number;
  vy: number;
}

// ---------------------------------------------------------------------------
// Rim geometry (computed once per session from the locked rim box)
// ---------------------------------------------------------------------------

export interface RimGeometry {
  /** The locked (damped) rim bounding box. */
  box: Box;
  /** Rim center. */
  cx: number;
  cy: number;
  /** y of the rim plane (top edge of the rim box). Ball above ⇒ y < planeY. */
  planeY: number;
  /** Central span of the rim used for the crossing test (central 80%). */
  spanLeft: number;
  spanRight: number;
  /** y below which a live shot resolves (bottom of rim + margin). */
  belowY: number;
  /** Zone above the rim that arms the shot FSM. */
  upZone: Box;
  /** Relaxed-confidence zone around the hoop (ball conf gate drops here). */
  hoopRoi: Box;
  /** Region of the net, monitored for motion bursts. */
  netRoi: Box;
  /**
   * Rim box aspect ratio (width / height) — a rough camera-angle proxy. A rim
   * viewed from a normal side/elevated angle sits in a stable band; an EXTREME
   * aspect (very flat = camera near rim level, or near-square/tall = steep
   * top-down) means the horizontal rim-plane crossing test is geometrically
   * unreliable. Exposed for on-device diagnostics + future angle-aware fusion;
   * optional so callers/tests that build a geometry literal need not set it.
   */
  aspect?: number;
}

// ---------------------------------------------------------------------------
// Shot state machine
// ---------------------------------------------------------------------------

export type ShotPhase = 'IDLE' | 'SHOT_LIVE' | 'COOLDOWN';

export type ShotOutcome = 'make' | 'miss' | 'unsure';

/**
 * Point value of a made shot, from automatic 2/3-point estimation
 * (src/core/court.ts). This is an ESTIMATE derived from the rim box scale and
 * the shooter's foot position — not a calibrated court measurement.
 */
export type ShotValue = 2 | 3;

/** The three fused make/miss signals. null = signal unavailable that shot. */
export interface ShotSignals {
  /** Geometric rim-plane crossing test. */
  geo: boolean | null;
  /** Net-motion burst within the resolve window. */
  net: boolean | null;
  /** 'ball_in_basket' class fired during the live shot. */
  cls: boolean | null;
}

export interface ResolvedShot {
  /** Monotonic per-session shot number, starting at 1. */
  id: number;
  /** Seconds at which the FSM armed (ball entered up-zone). */
  tStart: number;
  /** Seconds at which the outcome was resolved. */
  tResolved: number;
  outcome: ShotOutcome;
  signals: ShotSignals;
  /** Ball re-ascended above the rim plane after touching the rim region. */
  rimBounce: boolean;
  /** Interpolated x at the rim plane crossing (analysis px), if it crossed. */
  xCross: number | null;
  /** Degrees above horizontal at the rim plane (typ. 30–60 for good arc). */
  entryAngleDeg: number | null;
  /** Degrees above horizontal over the first samples after release. */
  releaseAngleDeg: number | null;
  /** Where the ball was released (analysis px), if seen. */
  releasePoint: Point | null;
  /**
   * Shooter position at release: person-box foot midpoint, NORMALIZED 0..1
   * against the analysis frame. Null when no person was tracked.
   */
  originX: number | null;
  originY: number | null;
  /** Full trajectory of the live shot for drawing/replay. */
  trajectory: BallSample[];
  /** Set true when the user flips the outcome by hand. */
  corrected?: boolean;
  /**
   * Estimated point value (2 or 3) from {@link estimateShotValue}
   * (src/core/court.ts), attached by the pipeline before the shot is emitted.
   * Undefined when 2/3 estimation didn't run. An ESTIMATE — see court.ts.
   */
  shotValue?: ShotValue;
  /**
   * Shooter's image-plane ground distance to the point under the rim, expressed
   * in rim widths (the scale ref used for {@link shotValue}). Undefined when not
   * computed; can be present with a null origin (defaults to 0).
   */
  distanceRimWidths?: number;
  /**
   * METRIC shooter→hoop ground distance in meters, from the pinhole estimator
   * (courtGeometric, flagged) when it ran confidently. Undefined otherwise.
   */
  distanceM?: number;
  /**
   * Pose-based shooting-form report, attached by the pipeline when form
   * analysis is enabled (Settings) and a pose was tracked through the shot.
   * Undefined when form analysis was off or the pose was never seen.
   */
  form?: FormReport;
  /**
   * Depth-ratio parallax gate diagnostics (present only when the veto flag
   * ran for this shot). decision 'veto_front'/'veto_behind' means geo was
   * flipped to false; 'silent' means the gate measured but stayed quiet.
   */
  geoDepth?: {
    ratio: number;
    sigmaLn: number;
    snr: number;
    decision: 'silent' | 'veto_front' | 'veto_behind';
    disableReason?: string;
  };
  /**
   * Virtual-crossing diagnostics (present when the occluded-shot arc
   * projection produced a usable fit, whether or not it corroborated a
   * make). xCross/tCross are PROJECTED, not observed — the shot's own
   * xCross field stays null for an occluded crossing.
   */
  virtualCross?: { xCross: number; tCross: number; r2y: number };
  /**
   * Release-to-rim flight time in seconds: rim-plane crossing time (observed,
   * or the virtual projection when the crossing was occluded) minus the
   * pose-gated release event time. Present only when form analysis was
   * running, the ReleaseDetector fired for THIS attempt (staleness-capped by
   * RELEASE.maxReleaseToRimSec), and a crossing time exists.
   */
  releaseToRimSec?: number;
}

/** Pose-based form metrics + prioritized coaching cues for one shot. */
export interface FormReport {
  metrics: FormMetrics;
  tips: CoachingTip[];
  /**
   * Raw pose snapshot at the release instant (analysis-frame px), when the
   * analyzer detected a release. Powers the Shot Lab release-skeleton visual;
   * persisted with the shot (formJson).
   */
  releasePose?: PoseFrame;
}

/** Per-frame input to the shot FSM. All in analysis-frame space. */
export interface FsmFrameInput {
  t: number;
  ball: TrackedBall | null;
  /** Max 'ball_in_basket' score this frame (0 when none). */
  ballInBasketScore: number;
  /** Net-motion score 0..1 for this frame (0 when unavailable). */
  netMotionScore: number;
  /** Highest-confidence person box this frame, if any. */
  personBox: Box | null;
  /**
   * Camera time (seconds) at which the pose-gated ReleaseDetector fired,
   * set ONLY on the frame the event fired (the FSM latches it internally).
   * Fourth arm path: a release event arms a shot once a REAL ball sample
   * corroborates it in the upper frame within RELEASE.armWindowSec.
   */
  releaseEventT?: number;
}

export interface FsmStepResult {
  phase: ShotPhase;
  /** Trajectory of the in-flight shot (empty when IDLE). */
  liveTrajectory: readonly BallSample[];
  /** Non-null exactly on the frame a shot resolves. */
  resolved: ResolvedShot | null;
}

// ---------------------------------------------------------------------------
// Pose / form analysis
// ---------------------------------------------------------------------------

/** COCO-17 keypoint names (MoveNet / YOLO-pose ordering). */
export type PoseKeypointName =
  | 'nose'
  | 'left_eye'
  | 'right_eye'
  | 'left_ear'
  | 'right_ear'
  | 'left_shoulder'
  | 'right_shoulder'
  | 'left_elbow'
  | 'right_elbow'
  | 'left_wrist'
  | 'right_wrist'
  | 'left_hip'
  | 'right_hip'
  | 'left_knee'
  | 'right_knee'
  | 'left_ankle'
  | 'right_ankle';

export interface PoseKeypoint {
  x: number;
  y: number;
  score: number;
}

export interface PoseFrame {
  t: number;
  keypoints: Partial<Record<PoseKeypointName, PoseKeypoint>>;
}

export type FormPhase = 'PICKUP' | 'DIP' | 'RISE' | 'RELEASE' | 'FOLLOW_THROUGH';

/** Which side the shooter's dominant (shooting) arm is on. */
export type ShootingHand = 'left' | 'right';

export interface FormMetrics {
  /** angle(shoulder, elbow, wrist) at the set point / deepest dip. */
  setPointElbowDeg: number | null;
  /** angle(hip, knee, ankle) at the deepest dip. */
  kneeFlexionDeg: number | null;
  /** From ball trajectory right after release (NOT pose). */
  releaseAngleDeg: number | null;
  /** From ball trajectory at the rim plane. */
  entryAngleDeg: number | null;
  /** Dip (ball lowest) → release, milliseconds. */
  releaseTimeMs: number | null;
  /** How long the arm stayed extended (≥ threshold) after release, ms. */
  followThroughHeldMs: number | null;
  /** Elbow extension angle right after release. */
  followThroughElbowDeg: number | null;
  /** Wrist height at release, normalized 0..1 (1 = top of frame). */
  releaseHeightNorm: number | null;
}

export interface CoachingTip {
  metric: keyof FormMetrics | 'consistency';
  /** 1 = minor, 2 = notable, 3 = the one cue to fix first. */
  severity: 1 | 2 | 3;
  /** Short imperative headline, e.g. "Add arc". */
  title: string;
  /** One-sentence plain-language cue. */
  message: string;
}

// ---------------------------------------------------------------------------
// Session stats
// ---------------------------------------------------------------------------

/** Shot chart zone in camera space (v1: no court calibration). */
export type ChartZone = 'left' | 'center' | 'right';

export interface SessionStats {
  attempts: number;
  makes: number;
  misses: number;
  unsure: number;
  /** makes / (makes + misses); unsure excluded. 0 when no decided shots. */
  fgPct: number;
  currentStreak: number;
  bestStreak: number;
  avgEntryAngleDeg: number | null;
  /** Std-dev of entry angle — consistency proxy. */
  entryAngleStdDeg: number | null;
  avgReleaseAngleDeg: number | null;
  releaseAngleStdDeg: number | null;
  byZone: Record<ChartZone, { attempts: number; makes: number; fgPct: number }>;
  /**
   * Total points from made shots using the estimated {@link ShotValue}
   * (src/core/court.ts). A make with no shotValue counts as 2. Misses and
   * unsure shots contribute 0.
   */
  points: number;
  /** Made 2-pointers (shotValue !== 3). */
  twoPtMakes: number;
  /** Decided (make|miss) attempts estimated as 2-pointers. */
  twoPtAttempts: number;
  /** Made 3-pointers (shotValue === 3). */
  threePtMakes: number;
  /** Decided (make|miss) attempts estimated as 3-pointers. */
  threePtAttempts: number;
  /** twoPtMakes / twoPtAttempts; 0 when no 2-pt attempts. */
  twoPtPct: number;
  /** threePtMakes / threePtAttempts; 0 when no 3-pt attempts. */
  threePtPct: number;
}

// ---------------------------------------------------------------------------
// Game modes
// ---------------------------------------------------------------------------

/** The eight playable modes layered on top of the make/miss stream. */
export type GameModeId =
  | 'free'
  | 'aroundTheWorld'
  | 'spotShooting'
  | 'timed'
  | 'threePoint'
  | 'ftStreak'
  | 'horse'
  | 'ghost';

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export interface ClipPlan {
  shotId: number;
  outcome: ShotOutcome;
  /** Seconds into the session recording. */
  startSec: number;
  endSec: number;
}

// ---------------------------------------------------------------------------
// Audio / feedback events
// ---------------------------------------------------------------------------

export type SoundEvent = 'make' | 'miss' | 'streak3' | 'streak5' | 'streak10';
