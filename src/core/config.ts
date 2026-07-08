/**
 * All pipeline tunables in one place.
 *
 * Values trace back to the July 2026 research pass over open-source shot
 * trackers (avishah3 cleaning gates, SwishAI cooldowns/classes, HomeCourt
 * patent-style net fusion) and Noah/HomeCourt published shooting metrics.
 * Adjust only with the labeled clip benchmark in place.
 */

export const DETECTION = {
  /** Detector input side (letterboxed square). 640 is the floor for a 20–40px ball. */
  inputSize: 640,
  /**
   * Ball confidence gate in open court. Lowered from 0.3 → 0.2 for YOLOX: the
   * ball is a small object and at the 416 letterboxed input the model scores it
   * in the ~0.2–0.35 band (vs the old 640 YOLO11 which sat higher), so 0.3 was
   * rejecting a real ball across most of its arc. 0.2 catches it; the Kalman
   * tracker + shot FSM (up-zone entry, trajectory shape) reject stray boxes so a
   * lower gate doesn't create phantom shots.
   */
  ballScoreMin: 0.2,
  /** Relaxed ball gate inside the hoop ROI (occlusion/blur near the rim). */
  ballScoreMinHoopRoi: 0.1,
  /**
   * Relaxed ball gate while a FRESH TRACK is being continued (the tracker
   * accepted a real ball within the last jumpWindowFrames). THE flight-
   * continuity fix: a small/fast/dark ball in mid-flight scores 0.12-0.19 —
   * real detections the 0.2 open-court gate was throwing away, which is why
   * flight tracking (release, comet, landing prediction) collapsed while
   * near-rim rescue still worked. Continuation is safe at this floor because
   * FOUR other defenses still vet every candidate: the jump gate (must be
   * near the prediction), the aspect gate, ballMaxSizeFraction, and the
   * Kalman's doubled measurement noise for sub-ballScoreMin samples. COLD
   * acquisition (no fresh track) still requires the full 0.2 — noise can
   * continue a track, never start one.
   */
  ballScoreMinTracking: 0.12,
  /**
   * COLD acquisition floor when the scene is genuinely DARK (the tracker's
   * light profile is 'dark' — see src/core/lightProfile.ts). In low light the
   * detector scores a REAL ball systematically lower (the exact regime
   * ballScoreMinTracking exists for mid-flight), so the 0.2 cold gate starts
   * rejecting the ball while it is still in the shooter's hands and no track
   * ever starts. 0.16 sits deliberately BETWEEN cold (0.2) and tracking
   * (0.12): a meaningful rescue in the dark, while staying above the
   * continuation floor so pure noise still can't start a track as easily as
   * it could continue one. TRACKER-side only — the parser's scoreMin is NOT
   * lowered (that would flood NMS with noise boxes); every other defense
   * (jump gate, aspect gate, ballMaxSizeFraction, doubled Kalman measurement
   * noise for sub-ballScoreMin samples) stays fully armed. 'dim' and
   * 'bright' scenes use ballScoreMin unchanged.
   */
  ballScoreMinDark: 0.16,
  /**
   * Frame-difference motion assist (src/ml/motionCandidate.ts): when the
   * detector misses the ball entirely, the strongest local mover on a coarse
   * luma grid is injected as a synthetic 'ball' candidate. score sits BETWEEN
   * the tracking gate (0.12) and cold acquisition (0.2) BY DESIGN: motion can
   * only continue a fresh track (jump-gate-vetted), never start one.
   */
  motionCandidate: {
    grid: 48,
    minCellDiff: 0.07,
    maxActiveFrac: 0.08,
    score: 0.13,
    /** Synthetic candidate radius as a fraction of the analysis side. */
    radiusFrac: 0.02,
  },
  /**
   * Rim confidence gate. The rim is a small, static, net-occluded object a nano
   * detector scores in the 0.3-0.5 band from a 15-30 ft side view — gating at
   * 0.5 discarded most of those frames and made the lock finicky. 0.35 lets that
   * real rim signal feed the lock; it's still cross-validated by 3-way spatial
   * consistency + the post-drift size-ratio guard, so a stray box can't lock.
   */
  rimScoreMin: 0.35,
  /** 'ball_in_basket' class gate. */
  ballInBasketScoreMin: 0.35,
  /** Person confidence gate. */
  personScoreMin: 0.4,
  /**
   * Reject a ball box larger than this fraction of the frame on either side.
   * A real ball is ~20-40px on the 640 analysis square (~0.03-0.06 of a side);
   * even a close-up drive stays well under 0.22. 0.5 was far too loose — it let
   * a half-frame box (r≈160px) through, which the overlay bloomed over the whole
   * screen. 0.22 caps the box at ~141px (r≈70px): above any real ball, far below
   * screen-covering.
   */
  ballMaxSizeFraction: 0.22,
  /**
   * Rim-anchored ROI ("digital zoom") SECOND detection pass. When the cheap
   * full-frame pass misses the small, net-occluded ball at the make/miss
   * instant, we crop the locked-rim region out of the tensor already computed,
   * upscale it to a full detector input, and run the SAME model again — turning
   * a ~15px ball into a ~50px one, the size band the detector reliably hits.
   * See the ROI block in useShotEngine.ts + src/ml/roiTransform.ts. Tune here
   * against a labeled-clip benchmark; the master on/off is the `roiZoom` setting.
   */
  roi: {
    /** Arm the pass on net motion even before the FSM has marked the shot live
     *  (covers the one-frame-late phase publish + the chicken-and-egg where a
     *  poor near-rim full frame never arms the FSM). */
    netMotionArm: 0.15,
    /**
     * Skip the pass whenever the PRIMARY inference EMA is above this (ms). The
     * second pass costs a full inference (same fixed-size model), so on a slow /
     * throttled phone (e.g. iPhone XR at 640 ≈ 77ms) it self-disables and the
     * app reverts exactly to single-pass behavior — no regression — while faster
     * phones (≲50ms/inference) get the recall boost.
     */
    skipIfAvgMsAbove: 50,
    /** Run at most one ROI pass per this multiple of the primary frame gate. */
    cadenceFactor: 2,
  },
} as const;

/**
 * Reference capture rate the frame-COUNT tunables were originally authored
 * against. On a fast phone the pipeline hits this; an iPhone XR runs detection
 * at only ~8–15 fps, so any gate expressed as "N frames" silently changes its
 * WALL-CLOCK meaning as fps drops (5 frames = 167 ms at 30 fps but 625 ms at
 * 8 fps). The decision core therefore converts frame-count gates to a TIME
 * budget = frames / NOMINAL_FPS, then re-derives an effective frame count from
 * each consumer's own measured sample interval. By construction, at exactly
 * NOMINAL_FPS every such gate reproduces its original integer frame count, so
 * 30 fps behaviour is byte-identical and only slower devices see the fix.
 */
export const NOMINAL_FPS = 30;

/**
 * Half a nominal frame, in seconds — the tolerance used when a former
 * frame-COUNT gate is compared as a wall-clock window. A window derived as
 * `N / NOMINAL_FPS` must still treat the Nth nominal frame (whose elapsed time
 * is exactly `N / NOMINAL_FPS`, give or take floating-point accumulation) as
 * INSIDE the window, matching the old integer `≤ N` comparison. Comparing
 * against `window + GATE_EPS_SEC` puts the boundary at the unambiguous midpoint
 * between frame N and frame N+1, so float dust never flips a gate a frame early
 * or late. At NOMINAL_FPS this reproduces the original integer behaviour
 * exactly; at lower fps the half-frame slack is negligible against the window.
 */
export const GATE_EPS_SEC = 0.5 / NOMINAL_FPS;

/**
 * Convert a NOMINAL_FPS-authored frame count into an effective frame count for
 * a device whose measured mean sample interval is `dtSec`. Returns the time
 * budget (`frames / NOMINAL_FPS`) re-expressed in the device's own frames,
 * floored at `minFrames` so a statistically-meaningful sample count survives
 * even when the budget rounds below it. At dtSec = 1/NOMINAL_FPS the result is
 * exactly `frames` (rounding is a no-op), keeping 30 fps identical.
 *
 * `dtSec ≤ 0` (no interval measured yet) returns `frames` unchanged.
 */
export function scaleFrameGate(
  frames: number,
  dtSec: number,
  minFrames = 0,
): number {
  if (!(dtSec > 0)) return frames;
  const budgetSec = frames / NOMINAL_FPS;
  return Math.max(minFrames, Math.round(budgetSec / dtSec));
}

export const TRACKER = {
  /** Ring-buffer length of accepted ball samples. */
  historyLen: 30,
  /**
   * Reject a detection that jumped more than `jumpDiameters` ball diameters
   * within the `jumpWindowSec` wall-clock window (avishah3 cleaning gate). The
   * window is now TIME-based, not a fixed frame count: at low fps 5 raw frames
   * would be 625 ms (vs 167 ms at 30 fps), holding the relaxed flight-
   * continuation score floor and the jump-gate lock open far too long. It is
   * derived from the historical 5-frame value so 30 fps is unchanged.
   */
  jumpDiameters: 4,
  /** @deprecated Kept for the derivation + any external reader; the live gate
   *  uses `jumpWindowSec`. 5 frames at NOMINAL_FPS. */
  jumpWindowFrames: 5,
  /** Wall-clock jump / flight-continuation window (5 frames at 30 fps). */
  jumpWindowSec: 5 / NOMINAL_FPS,
  /**
   * Max plausible ball speed in diameters/second (~9 m/s over a 0.24 m ball,
   * with margin). On slow devices detections arrive far apart, so the jump
   * gate's allowance must scale with elapsed TIME — the larger of the classic
   * `jumpDiameters` floor and `maxSpeedDiametersPerSec × Δt` wins.
   */
  maxSpeedDiametersPerSec: 40,
  /**
   * Reject clearly non-round boxes (width * 1.4 < height) — likely a body
   * part or netting — unless the sample is flagged as a motion-blur streak.
   */
  aspectWidthFactor: 1.4,
  /**
   * Occlusion bridge: keep emitting Kalman predictions through a gap of at most
   * this much WALL-CLOCK time. Time-based (not a fixed frame count) so the
   * bridge is device-INDEPENDENT: a 30 fps phone gets ~15 predicted frames and
   * a 15 fps phone ~7, i.e. the same ~0.5 s of real occlusion either way. 0.5 s
   * comfortably covers the ball being hidden by a defender or by the net/rim at
   * the basket (exactly when we most want the track alive to still call the
   * make), while staying short enough that a ball which has truly left never
   * coasts on as a ghost for long.
   */
  maxPredictedSec: 0.5,
  /**
   * Hard ceiling on predicted frames regardless of time: a safety net for an
   * unexpectedly fast pipeline (e.g. 60 fps) so `maxPredictedSec` stays the real
   * limiter on normal devices. Raised from the old fixed 8, which (being frame-
   * counted) made the bridge device-DEPENDENT: only ~0.27 s at 30 fps, so a ball
   * hidden behind a defender for a third of a second dropped the track.
   */
  maxPredictedFrames: 20,
  /**
   * Drop the track instead of emitting a predicted "ghost" ball once the Kalman
   * extrapolation leaves the frame by more than this fraction of the frame's
   * larger side. During occlusion the constant-velocity term marches the
   * prediction in a straight line; without this cull a ball that actually left
   * the frame coasts to an absurd off-screen position and can feed the shot FSM
   * a fabricated rim-plane crossing. A real ball is on-screen when it matters
   * for a make/miss call, so culling generously-off-frame predictions is pure
   * precision with no cost to legitimate near-edge arcs.
   */
  predictOffFrameMarginFrac: 0.6,
  /** Drop samples older than this from the live buffer (seconds). */
  staleSampleSec: 2.0,
  /** Gravity prior for the constant-acceleration Kalman filter, px/s². Set at runtime from rim size (px-per-meter estimate); this is the fallback. */
  gravityPxPerSec2Fallback: 900,
} as const;

export const RIM = {
  /** Damping factor for the rim lock (EMA weight of the NEW observation). */
  lockAlpha: 0.05,
  /**
   * Seconds the rim must stay stably in view (a consistent cluster, no big
   * movement) before the lock commits — surfaced as a 3-2-1 countdown in the
   * live view so the user knows to hold the camera steady. 0 = lock the moment
   * the cluster forms (the default RimLock uses, so unit tests are unchanged);
   * the live pipeline passes this value.
   */
  lockHoldSec: 2.5,
  /**
   * Reject a rim box larger than this fraction of the frame side before it can
   * feed the lock cluster. Mirrors DETECTION.ballMaxSizeFraction: the ball added
   * a 0.22 cap for exactly the "half-frame box blooms over the whole screen"
   * symptom, but the rim had NO analogue — so a spurious ~half-frame 'rim' box
   * at score >= rimScoreMin could seed a lock that is then republished every
   * frame (shotPipeline caches lastRim), producing a HUGE, persistent phantom
   * reticle stuck wherever the junk box sat. A real 15-30 ft rim is tens of px
   * on the 640 square (well under 0.30*640 = 192 px); no legitimate close-up rim
   * approaches a third of the frame.
   */
  rimMaxSizeFraction: 0.3,
  /** Re-verify rim position every N seconds. */
  reverifySec: 5,
  /** A rim "moving" more than this × its diagonal in 5 frames is rejected. */
  maxDriftDiagFactor: 0.5,
  /**
   * LARGE-jump fast re-lock: a single strong-confidence rim detection whose
   * center is at least this × the locked rim's diagonal away is treated as a
   * probable camera PAN (new hoop), not shake. It flags drift immediately and
   * starts the re-verify cluster that frame instead of waiting for
   * DRIFT_REJECT_COUNT slow rejects. Well above maxDriftDiagFactor (0.5) so
   * ordinary jitter never trips it; a full cluster + size guard are still
   * required before it actually re-locks, so one stray far box can't re-lock.
   */
  largeJumpDiagFactor: 2.5,
  /** Min detector score for the large-jump fast path to fire (confident rim). */
  relockStrongScore: 0.6,
  /** Crossing span = central fraction of rim width. */
  spanFraction: 0.8,
  /** Up-zone size relative to rim box. */
  upZoneWidthFactor: 4,
  upZoneHeightFactor: 2,
  /** belowY = rim bottom + belowMarginFactor * rim height. */
  belowMarginFactor: 0.5,
  /** Hoop ROI (relaxed ball gate) size relative to rim box. */
  hoopRoiFactor: 2.5,
  /** Net ROI: rim width wide, this × rim height tall, hanging below the rim. */
  netRoiHeightFactor: 1.2,
  /** Rebound buffer: widen the crossing span by this many px on each side. */
  crossingBufferPx: 10,
  /**
   * Sanity bound for a post-drift re-lock: the new cluster's box width and
   * height must each be within this factor of the PRE-drift lock's
   * corresponding dimension (both `new/old` and `old/new` <= factor) to be
   * accepted as the same rim. Guards against silently re-locking onto a
   * differently-shaped/sized object (scoreboard, hole in signage, a
   * similarly dark circular decoy) that happens to produce 5 mutually
   * consistent detections during a drift window.
   */
  relockMaxSizeRatio: 1.8,
} as const;

export const SHOT_FSM = {
  /** Resolve an armed shot if the ball has been lost this long (occlusion). */
  lostBallResolveSec: 1.5,
  /** Min seconds between two shot attempts (SwishAI). */
  shotCooldownSec: 1.5,
  /** Min seconds between two scored baskets (SwishAI). */
  basketCooldownSec: 2.0,
  /** Net motion score threshold for the 'net' signal. */
  netMotionThreshold: 0.25,
  /** Threshold multiplier when the ball bounced on the rim (patent-style). */
  netMotionRimBounceFactor: 1.5,
  /** Net burst must occur within this many seconds of the plane crossing. */
  netWindowSec: 0.35,
  /** Samples used for the release-angle fit right after release. */
  releaseAngleSamples: 5,
  /** Max seconds a shot may stay live before force-resolving as unsure. */
  maxLiveSec: 4.0,
  /**
   * Layup-arm velocity gate: max downward ball speed (rim WIDTHS/sec, +y
   * down) tolerated when arming the layup path. Rejects phantom arms from a
   * ball that is clearly falling fast (rebound, pass, loose ball dropping
   * past a player boxing out/retrieving it) rather than being carried/laid
   * up near the hoop. Soft layups routinely have the ball drifting down
   * gently in the hand right before the lay-in motion takes over, so the
   * allowance is generous — a sanity backstop against clearly-falling
   * balls, not a tight gate. Scaled by rim WIDTH (not height): the rim box
   * height varies ~2.4× across the supported side-view aspect band, which
   * made the height-scaled gate collapse on flat side views; width is the
   * scale-stable reference (0.45 m regardless of camera pitch), as COURT
   * and DEPTH_GATE already use.
   */
  layupMaxFallVyRimWidthsPerSec: 5,
  /**
   * Layup arming is BALL-FIRST: the ball's center must sit inside the hoopRoi
   * inflated by this factor about its center. This replaced the old
   * "person box ∩ hoopRoi" requirement — the ball being AT the hoop is direct
   * evidence of a layup/putback attempt, while YOLO person boxes were
   * unreliable both ways (missed shooter ⇒ missed layup; hallucinated edge
   * boxes ⇒ false arms).
   */
  layupHoopRoiInflate: 1.5,
  /**
   * Layup arming needs a REAL ball (never a Kalman-predicted coast). A single
   * frame arms at ≥ layupArmMinBallScore; below that, PERSISTENCE substitutes
   * for confidence: layupArmLowScorePersistFrames consecutive real in-zone
   * samples at ≥ layupArmLowScore also arm. Rationale: a ball at the rim is
   * routinely occluded/blurred and scores 0.12–0.19 (the same regime
   * DETECTION.ballScoreMinHoopRoi exists for), so a hard 0.2 gate silently
   * dropped the most common real layup presentation — while one-frame noise
   * still can't start an attempt.
   */
  layupArmMinBallScore: 0.2,
  layupArmLowScore: 0.12,
  layupArmLowScorePersistFrames: 3,
  /**
   * Putback guard: after a resolve with rimBounce=true, arming is refused for
   * this long (extends shotCooldownSec) so a tip-in doesn't double-count or
   * inherit the first attempt's stale state.
   */
  putbackWindowSec: 2.0,
  /**
   * Stationary-ball suppressor (wedged/resting ball). A ball stuck ON the
   * rim — center just above the plane, inside the layup zone, |v| ≈ 0,
   * often high score — re-satisfies the ball-at-hoop arm every IDLE frame,
   * producing an arm → maxLiveSec timeout → 'unsure' → cooldown → re-arm
   * loop that emits a junk review shot every ~5.5 s until dislodged. Once a
   * REAL ball has sat inside the layup zone below the speed floor for
   * minStillSec (tracked across ALL phases, so the stillness observed
   * during the doomed first attempt already covers the post-timeout
   * re-arm), arming is refused until a real sample OUTSIDE the zone shows
   * the ball actually left — so the dislodging poke that finally drops it
   * through the net cannot read as a fresh make either. Movement alone does
   * NOT lift the suppression; leaving the zone does, and a long detection
   * gap (clearAfterGapSec) does, so a stale flag cannot outlive the wedged
   * ball and block a later real attempt.
   */
  stationaryBall: {
    /** Speed (rim WIDTHS/sec) below which an in-zone ball counts as resting. */
    maxSpeedRimWidthsPerSec: 0.75,
    /** In-zone rest time (sec) before arming is suppressed. */
    minStillSec: 1.0,
    /** Suppression lapses after this long without any real ball sample. */
    clearAfterGapSec: 2.0,
  },
  /**
   * Descending-entry arming (floater/runner rescue). A 2–4 m floater rises
   * OUTSIDE the up-zone's x-range, peaks above the layup band, and re-enters
   * the hoop region descending at 3–5 m/s — over the layup branch's
   * fall-speed gate — so it armed via NEITHER branch and a made floater
   * produced net+cls with no attempt recorded. This branch arms
   * RETROACTIVELY: a real, confident ball inside the hoop ROI, descending,
   * whose recent samples fit a clean gravity parabola that ORIGINATED
   * outside the layup zone (a ball popping up off the rim originates inside
   * it) arms and seeds the live trajectory from the FSM's rolling pre-arm
   * buffer, so the plane crossing a few frames later is scored with full
   * approach geometry. Resolve-side, a descend-armed geo-only "make" is
   * demoted to unsure exactly like the layup branch (pass-through guard) —
   * a lob sailing through the rim's 2D projection still cannot mint a make.
   */
  descendingArm: {
    /** Min detector score — arming on a FALLING ball demands real confidence. */
    minBallScore: 0.3,
    /** Min REAL pre-arm samples required for the approach fit. */
    minRealSamples: 5,
    /** Vertical-fit R² floor — the approach must be cleanly ballistic. */
    minR2y: 0.85,
    /**
     * Floor on the fitted quadratic ya (≈ g/2 in px/s²), in rim WIDTHS/s².
     * Physical is ~11 (g/2 · rimWidthPx / 0.45 m); 2 tolerates heavy camera
     * foreshortening while still rejecting linear (non-ballistic) drift,
     * whose fitted ya sits near 0.
     */
    minYaRimWidthsPerSec2: 2,
    /** Sanity cap on downward speed at arming, rim WIDTHS/sec. */
    maxFallVyRimWidthsPerSec: 12,
    /** Rolling pre-arm sample window seeding the trajectory, seconds. */
    seedWindowSec: 1.0,
  },
  /**
   * Virtual-crossing corroborator (occlusion inference). The net/rim hides
   * the ball at exactly the decisive moment, so an armed shot often dies
   * ABOVE the plane with no observed crossing → geo null → 'unsure'. When
   * the trailing REAL samples form a confident descending parabola ending
   * in the layup zone, project it to the rim plane and treat the projected
   * crossing like the reappearance corroborator: it may upgrade geo
   * null→true ONLY with net/cls agreement, never as sole evidence, never
   * flipping an explicit geo=false. (The DIY-app failure mode — naive
   * projection minting fake makes on short misses — is exactly what the
   * corroboration requirement blocks.)
   */
  virtualCross: {
    /** Trailing real, descending, above-plane samples required for the fit. */
    minRealSamples: 5,
    /** Vertical-fit R² floor — the tail must be cleanly ballistic. */
    minR2y: 0.9,
    /** Max seconds past the last real sample the crossing may be projected. */
    maxProjectSec: 0.6,
    /**
     * The track must die within this many rim WIDTHS above the plane (net/
     * backboard occlusion starts a little above the rim) and horizontally
     * inside the layup zone — a ball lost far from the hoop is a dropout,
     * not an occlusion, and must not be projected.
     */
    maxAbovePlaneRimWidths: 1.5,
  },
  /**
   * KILL-SWITCHES for the depth-aware judgment mechanisms. All ship FALSE:
   * the code lands fully tested but inert, and flips only after the labeled-
   * clip benchmark passes (see the depth-aware research spec). The FSM reads
   * these as constructor defaults — tests override per-instance.
   */
  useDepthRatioVeto: false,
  useReappearance: false,
  useViewBandRouting: false,
} as const;

/**
 * Pose-gated release detection (src/core/releaseDetector.ts) and its two
 * consumers: the shot FSM's 'release' arm path and the ball tracker's
 * wrist-seeded reacquisition.
 *
 * WHY THIS EXISTS: the FSM's three ball-kinematic arm paths (jump / layup /
 * descend) all require the BALL to be detected at the decisive moment. A
 * dark or small ball is routinely invisible to the detector exactly at
 * release — so a real attempt produces no arm at all and the shot silently
 * disappears. The shooter's BODY, however, is a far larger detection target:
 * the release MOTION (wrist snapping up past the shoulder on an extending
 * arm) is visible to the pose model even when the ball is not. The detector
 * turns that motion into a timestamped event; the tracker uses the wrist
 * position as a spatial prior to reacquire the faint ball, and the FSM arms
 * off the event once a REAL ball corroborates it.
 */
export const RELEASE = {
  /**
   * The three signature conditions (wrist above shoulder, upward wrist
   * velocity spike, elbow extended) must all have occurred within this
   * trailing window. A real release snap completes in ~0.10–0.25 s from set
   * point to full extension; 0.3 s covers slow-motion form shooters while
   * staying short enough that an unrelated arm raise plus a later wrist
   * flick can't merge into a false signature.
   */
  windowSec: 0.3,
  /**
   * angle(shoulder, elbow, wrist) past which the arm counts as extended.
   * Full extension reads 160–180°, but pose jitter routinely shaves 10–20°
   * off a genuinely straight arm; 150° catches real releases while a
   * bent-arm dribble/gather (~90–120°) stays well below. Deliberately a few
   * degrees under FORM.followThrough.elbowMinDeg (155) — that gate judges a
   * HELD extension over many filtered frames, this one a single raw instant.
   */
  minElbowExtensionDeg: 150,
  /**
   * Wrist upward-speed floor, as a FRACTION of frame height per second
   * (+y down, so rising = negative vy; expressed scale-free so one number
   * serves any analysis resolution). A release snap drives the wrist up
   * ~0.5 m in ~0.2 s; with the shooter typically 1/3–1/2 of the frame tall
   * that is ≳0.4 frame-heights/s. Deliberately raising an arm (calling for
   * a pass, celebrating) sits well under 0.2. 0.3 splits the two regimes.
   */
  minUpwardWristVyFracPerSec: 0.3,
  /**
   * At most one event per this interval. Matches SHOT_FSM.shotCooldownSec:
   * two real attempts can never be closer than the FSM's own cooldown, so a
   * tighter debounce would only pass follow-through jitter as new events.
   */
  debounceSec: 1.5,
  /**
   * FSM arming guard: a REAL (never Kalman-predicted) ball sample must be
   * seen within this many seconds AFTER the event before the release path
   * arms. The seeded tracker typically reacquires the just-released ball
   * within a few frames; 0.7 s covers a slow reacquisition while keeping a
   * pose-only event (pump fake, pass, celebration) from arming off an
   * unrelated ball that wanders in later.
   */
  armWindowSec: 0.7,
  /**
   * The corroborating ball must sit in the upper fraction of the frame
   * (cy < this × frameH). A just-released ball climbs immediately toward
   * the rim (upper half in any framing where make/miss is judgeable); a
   * dribble, a ball at the chest, or floor bounces live in the lower frame.
   */
  armUpperFrameFrac: 0.6,
  /**
   * Tracker reacquisition window after the event (~15 frames at 30 fps).
   * The wrist prior is only meaningful in the first few frames of flight —
   * after half a second a 9 m/s ball is metres from the release point and
   * the prior is stale. Same scale as TRACKER.maxPredictedSec by design.
   */
  seedWindowSec: 0.5,
  /**
   * Acceptance radius around the released wrist, as a fraction of the
   * larger frame side. In the frames the window is FOR (right after
   * release) the ball is within roughly an arm's length (~0.1 frame) of
   * the wrist; 0.15 adds margin for wrist-keypoint error without opening a
   * court-wide hole in the low-score gate.
   */
  seedRadiusFrac: 0.15,
  /**
   * Staleness cap when stamping ResolvedShot.releaseToRimSec: a real
   * release→rim flight is ~0.5–1.5 s (typical jumper arcs). Past 2.5 s the
   * latched event belongs to some earlier motion, not this shot's release,
   * so no metric is emitted rather than a wrong one.
   */
  maxReleaseToRimSec: 2.5,
} as const;

export const FORM = {
  /** One-Euro filter defaults for pose landmarks. */
  oneEuro: { minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 },
  /** Elbow set-point band, degrees. */
  elbowSetPoint: { min: 75, max: 90, flagBelow: 60, flagAbove: 100 },
  /** Knee flexion band at deepest dip, degrees. */
  kneeFlexion: { min: 100, max: 130, flagStiff: 150, flagDeep: 95 },
  /** Release angle bands, degrees. */
  releaseAngle: { min: 45, max: 55, flagLow: 45, flagHigh: 58 },
  /** Entry angle optimal band (Noah), degrees. */
  entryAngle: { min: 43, max: 47 },
  /** Release-time bins, seconds (HomeCourt definition: pickup → release). */
  releaseTime: { elite: 0.4, nbaAvg: 0.54, good: 0.7, typical: 1.0 },
  /** Follow-through: elbow ≥ this angle held ≥ holdSec after release. */
  followThrough: { elbowMinDeg: 155, holdSec: 0.3 },
  /** Flag consistency when σ(release angle) exceeds this, degrees. */
  releaseAngleStdFlagDeg: 4,
  /** Keypoint score gate below which a landmark is treated as missing. */
  keypointScoreMin: 0.3,
} as const;

export const CLIPS = {
  /** Clip window around a resolved shot, seconds. */
  preRollSec: 6,
  postRollSec: 2,
  /** Merge two clips when they overlap or sit closer than this, seconds. */
  mergeGapSec: 0.5,
} as const;

export const STREAKS = {
  /** Streak lengths that trigger celebration stingers. */
  celebrateAt: [3, 5, 10] as readonly number[],
} as const;

/**
 * Automatic 2/3-point estimation (src/core/court.ts). No manual court
 * calibration — the model already marks the rim and the shooter's foot, and we
 * use the detected rim box width in pixels as a real-world scale reference
 * (regulation rim inner diameter ≈ 0.45 m).
 *
 * A regulation NBA 3-point arc is ~6.75 m at the top; 6.75 / 0.45 ≈ 15 rim
 * widths. But the shooter distance we can measure is the ground gap between the
 * person's foot and the point under the rim IN THE IMAGE PLANE, which is
 * foreshortened by camera angle and perspective — a true 6.75 m shot rarely
 * measures a full 15 rim widths on screen. The default threshold is tuned lower
 * so realistic 3-pt setups classify correctly; treat every result as an
 * ESTIMATE, adjustable per session via {@link adjust3ptThreshold} in court.ts.
 */
export const COURT = {
  /** Regulation rim inner diameter, meters (scale reference). */
  rimDiameterM: 0.45,
  /** NBA 3-pt arc distance at the top, meters (documentation only). */
  threePtDistanceM: 6.75,
  /**
   * Distance (in rim widths, image-plane) at/above which a shot is a 3.
   * Perspective-tuned default — see COURT doc.
   */
  default3ptRimWidths: 9,
  /** Clamp bounds when a session adjusts its 3-pt threshold. */
  min3ptRimWidths: 4,
  max3ptRimWidths: 20,
} as const;

/** Exposed constant: default rim-width distance that classifies a shot as a 3. */
export const DEFAULT_3PT_RIMWIDTHS = COURT.default3ptRimWidths;

/**
 * Official ball OUTER diameters by size, meters (FIBA circumference specs:
 * size 7 749-780mm, size 6 ~724-737mm, size 5 ~690-710mm). The user picks
 * their ball in Settings > Player; a mis-set size shifts the depth ratio by
 * ~±10% — half the far-range discrimination signal — so this is load-bearing.
 */
export const BALL_SIZES_M: Record<7 | 6 | 5, number> = {
  7: 0.243,
  6: 0.23,
  5: 0.22,
};

/**
 * Depth-ratio parallax gate (src/core/depthRatioGate.ts): the size-based
 * "is the ball at the rim's depth at the crossing instant" VETO. Focal length
 * cancels in the ratio; only the ball-size setting + pixel measurements are
 * needed. All thresholds are the POST-adversarial-verification numbers from
 * the depth-aware research pass; they are analytically derived and must be
 * re-fit on labeled clips before the flag flips on.
 */
export const DEPTH_GATE = {
  /** Sigma multiplier for the veto rule. */
  k: 2.5,
  /** Residual motion-blur bias allowance AFTER the aspect filter, ln space. */
  blurAllowanceLn: Math.log(1.05),
  /** Ball radius measurement noise, px (1σ). */
  sigmaBallRadiusPx: 1.0,
  /** Locked rim width noise, px (1σ). */
  sigmaRimWidthPx: 2.0,
  /** Widened rim σ when the lock's box aspect looks contaminated. */
  sigmaRimWidthContaminatedPx: 4.0,
  /**
   * Averaging noise divisor over N samples: systematic blur bias floors the
   * reduction at ~0.72·√N (NOT √N — the errors are partially correlated).
   */
  avgNoiseDivisor: (n: number): number => Math.max(1, 0.72 * Math.sqrt(n)),
  /** Pixel-size enablement floors (replace any metric max-distance rule —
   *  framing-dependent; these self-select the verified-working regimes). */
  minRimWidthPx: 40,
  minBallDiaPx: 16,
  /** Min surviving real samples in the pre-crossing average. */
  minRealSamples: 3,
  /** Max samples averaged (last N real detections before rim overlap). */
  avgWindow: 5,
  /** Blur rejection: box aspect deviation from round beyond this is dropped. */
  blurAspectRejectFrac: 0.15,
  /** Make-zone half-width: z = clamp(makeZoneScaleM / Z_est, lo, hi). */
  makeZoneScaleM: 0.3,
  makeZoneClampLo: 0.03,
  makeZoneClampHi: 0.08,
  /** f prior (px) used ONLY to shape the make zone, never in the ratio. */
  focalPxDefault: 850,
} as const;

/**
 * Gap-crossing reappearance corroborator (src/core/reappearance.ts): judge
 * the shot through a detection dropout at the rim. Demoted by verification to
 * a CORROBORATOR — it may upgrade an occluded crossing only when net or
 * persistent cls agrees; it never mints a make alone.
 */
export const REAPPEAR = {
  /** Min real pre-gap detections for a trustworthy parabola fit. */
  minRealSamplesPreGap: 5,
  /** Min vertical-fit R² before the cached arc is used. */
  minArcR2y: 0.5,
  /** Baseline max dropout the corroborator will bridge, seconds. */
  maxGapSec: 1.0,
  /** Extended window while net motion stays elevated (net-hang), seconds. */
  maxGapNetHangSec: 2.0,
  /** Trap hard-clears this long after the predicted crossing, seconds. */
  ttlAfterPredictedCrossSec: 0.7,
  /** Reappearance must sit within this of the arc's predicted y, px. */
  yResidualMaxPx: 40,
  /** Span test widening (net deflection alone is ~21px at 6m). */
  spanWidenFrac: 0.15,
  /** Post-gap samples that must be descending. */
  vyDownSamples: 2,
} as const;

/**
 * View-band routing (src/core/viewBand.ts): which mechanisms are valid from
 * which camera placement, classified from rim-box aspect + IMU pitch (aspect
 * alone cannot separate under-hoop from overhead). Boundaries expected to
 * move ±0.2-0.5 from telemetry before the routing flag flips.
 */
export const VIEW = {
  /** Aspect range where planeY geo + depth gate are PRIMARY (real side views). */
  bandGeoPrimaryAspect: [2.5, 6.0] as readonly [number, number],
  /** Below this aspect the view is under-hoop or overhead (pitch decides). */
  bandUnderOverAspect: 1.5,
  /** Above this aspect the geometry is degraded (warn + net/cls only). */
  bandDegradedAspect: 6.5,
  /** Pitch-up beyond this = under-hoop (vs overhead looking down). */
  underHoopPitchDeg: 25,
} as const;
