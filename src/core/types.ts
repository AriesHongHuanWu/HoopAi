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

/**
 * Which estimator decided a shot's 2/3 value — the provenance the detection
 * receipt surfaces so the call is auditable, not a black box.
 *   'court'     — court-registration homography (corner-accurate, any placement)
 *   'metric'    — pinhole real-meters estimator (courtGeometric)
 *   'heuristic' — rim-widths image-plane estimator (court.ts), the fallback
 *   'manual'    — the user's Settings court-range override
 */
export type ShotValueSource = 'court' | 'metric' | 'heuristic' | 'manual';

/** The three fused make/miss signals. null = signal unavailable that shot. */
export interface ShotSignals {
  /** Geometric rim-plane crossing test. */
  geo: boolean | null;
  /** Net-motion burst within the resolve window. */
  net: boolean | null;
  /** 'ball_in_basket' class fired during the live shot. */
  cls: boolean | null;
  /**
   * Depth-illusion ("錯視") veto outcome — set only when the parallax guard
   * flipped a would-be geo make to a miss because the ball's apparent size
   * showed it crossed the 2D rim line while in FRONT of ('front') or BEHIND
   * ('behind') the hoop. Absent when the veto stayed silent or was off.
   * Diagnostic only: the miss it caused is already reflected in `geo` — this
   * just lets the receipt explain WHY (persists inside signalsJson, so old
   * rows simply lack it).
   */
  illusion?: 'front' | 'behind';
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
   * Which estimator decided {@link shotValue} — the provenance the detection
   * receipt shows. Undefined when 2/3 estimation didn't run.
   */
  valueSource?: ShotValueSource;
  /**
   * 0..1 confidence in the 2/3 call from whichever source won. Undefined when
   * not computed. Rendered on one shared confidence scale (see evidence.ts).
   */
  valueConfidence?: number;
  /**
   * Shooter's mapped court-plane position (meters, basket origin), present ONLY
   * when court registration placed the shot — powers the placement map and the
   * corner/arc receipt line. Undefined for the metric/heuristic paths.
   */
  courtPos?: { x: number; y: number };
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
  /**
   * Persisted flight-arc snapshot, present only when a confident full-flight
   * fit existed at resolve time (useFlightArc on + the r2y/curvature gates in
   * the pipeline passed). Persisted in shots.arcJson (db v9); old rows simply
   * lack it. VISUAL-ONLY — see {@link PersistedFlightArc}.
   */
  flightArc?: PersistedFlightArc;
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
  /**
   * Compact quantized keypoint SEQUENCE over the shot window (dip →
   * follow-through), captured by {@link FormAnalyzer} when form analysis is
   * enabled and a pose was tracked. Powers the Form Studio motion-comparison
   * theater (animated skeletons vs an NBA reference form). Additive/optional:
   * pre-existing formJson rows and no-sequence shots simply lack it. Serialized
   * as int16-grid ints inside formJson — see {@link FormSequence} for the size
   * budget. NOTE: this is 2D MoveNet data; true 2D→3D lifting is a future
   * upgrade (the studio only *illustrates* depth via limb layering).
   */
  sequence?: FormSequence;
}

/**
 * A compact, size-normalized keypoint SEQUENCE for one shot window.
 *
 * ENCODING (kept small so formJson stays a few KB):
 * - Coordinates are normalized to a body-relative frame: origin at the
 *   hip-center, axes scaled by the shooter's body height so absolute pixel
 *   size cancels (a tall player and a short player overlay directly). +y is
 *   DOWN, matching analysis-frame convention.
 * - Each coordinate is quantized to a signed int16 grid at {@link SEQ_SCALE}
 *   units per body-height (so ~[-2, 2] body-heights maps into int16 range).
 *   A missing keypoint in a frame is encoded as the sentinel
 *   {@link SEQ_MISSING}.
 * - `data` is a flat row-major int array of length `frames * 17 * 2`
 *   (frame, then COCO-17 keypoint in {@link SEQ_KEYPOINT_ORDER}, then x,y).
 *   Flat ints keep the JSON compact (no per-point object keys).
 */
export interface FormSequence {
  /** Schema version — bump if the packing changes. */
  v: 1;
  /** 'left' | 'right' shooting arm this sequence was captured for. */
  hand: ShootingHand;
  /** Number of frames (downsampled, typically ~24). */
  frames: number;
  /** Duration the frames span, seconds (dip → follow-through, ~1.2 s). */
  durationSec: number;
  /**
   * Flat int16-grid coordinates, length `frames * 17 * 2`. See the interface
   * doc for the exact layout and the sentinel for missing keypoints.
   */
  data: number[];
  /**
   * 0-based index into the DOWNSAMPLED output frames nearest the pose-gated
   * release event, matched within 0.2 s slack (formSequence's
   * RELEASE_MATCH_SLACK_SEC). Absent when the ReleaseDetector did not fire
   * for the shot or no sampled frame fell inside the slack. ADDITIVE — the
   * data packing is unchanged, so `v` stays 1.
   */
  releaseFrame?: number;
}

/**
 * Persisted flight-arc snapshot (shots.arcJson, db v9): the confidence-gated
 * full-flight parabola frozen at the resolve frame, in ANALYSIS-FRAME px
 * (+y DOWN) with ABSOLUTE-TIME coefficients (camera seconds). VISUAL-ONLY by
 * contract: it powers replay thumbnails and the 3D replay theater and must
 * never feed make/miss, recheck, or 2/3 estimation (drawing != judging).
 * `path` carries at most 17 sampled points (34 flat numbers); the whole JSON
 * blob stays within a ~700-byte budget. See src/core/arcSnapshot.ts for the
 * encode/decode + validation rules.
 */
export interface PersistedFlightArc {
  v: 1;
  /**
   * Absolute-time parabola: y(t) = ya*t² + yb*t + yc, x(t) = xm*t + xq,
   * valid over the observed window [tMin, tMax]; r2y = vertical-fit R².
   */
  fit: {
    ya: number;
    yb: number;
    yc: number;
    xm: number;
    xq: number;
    r2y: number;
    tMin: number;
    tMax: number;
  };
  /** Flat [x0,y0,x1,y1,...] samples over the observed window (≤ 34 numbers). */
  path: number[];
  /** Rim box at resolve (analysis px) — a defensive copy, never an alias. */
  rimBox: Box;
  frameW: number;
  frameH: number;
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
  /**
   * When true, the FSM must not ARM a new attempt this frame (multi-ball
   * warmup scene, or the rim lock is drift-stale after a camera bump). It
   * never affects an attempt that is already live, and it can only SUPPRESS
   * calls — it can never create one. Absent = false. recheck/offline replay
   * never sets it, so default behavior is byte-identical.
   */
  armLockout?: boolean;
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
