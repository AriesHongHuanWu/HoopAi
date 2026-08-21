/**
 * Offline re-analysis of 'unsure' shots — the second pass that escapes the
 * real-time budget.
 *
 * The live pipeline analyses whatever frames the camera thread can afford and
 * sometimes resolves a shot as 'unsure'. When the session was RECORDED, the
 * decisive moment is still sitting in the video file — so after the session we
 * re-examine a ±few-second window around each unsure shot with an unconstrained
 * pass: sample frames at ~{@link RECHECK.fps} fps, run the full still-image
 * detector on each, and replay the samples through a FRESH BallTracker +
 * ShotFsm (the same deterministic core the live path uses — pure, camera-clock
 * time only, replayable by construction).
 *
 * PURE ORCHESTRATION: this module performs no I/O. Frame extraction + detection
 * are injected as `detectFrame(videoTimeSec) -> Detection[]`; the UI layer binds
 * that to expo-video-thumbnails + detectImageToBoxes (src/data/recheckRunner.ts).
 *
 * CONSERVATIVE RECONCILIATION: only an unsure→make or unsure→miss upgrade
 * counts. A shot the live pass already decided is never flipped, and when the
 * offline pass is also unsure (or resolves nothing near the original time) the
 * shot simply stays unsure. The offline pass can only ADD information, never
 * fight the user or the live call.
 *
 * THE REPLAY IS STRICTLY WEAKER THAN THE LIVE PASS, AND MUST NEVER OUT-CLAIM IT.
 * It sees {@link RECHECK.fps} = 6 fps instead of the camera rate, and it has no
 * net channel at all (net motion needs dense frame PAIRS). So the replay is
 * allowed to confirm what the live call could not decide — it is never allowed
 * to be more confident than the live pass on less evidence. Three rules enforce
 * that, and each one is a suppression:
 *   1. The replay FSM is constructed with the SAME guards the live app enables
 *      (depth veto / reappearance / rattle guard / settle window). Running them
 *      OFF made the offline FSM strictly more permissive than the live one.
 *   2. A netless make resting on 2D geometry ALONE is refused
 *      ({@link offlineMakeCorroborated}) — at 6 fps a "crossing pair" spans
 *      167 ms, which is not a look at the ball going through the hoop.
 *   3. The resolve CLOSEST to the live tResolved wins, inside a tolerance
 *      narrower than SHOT_FSM.shotCooldownSec, so a neighbouring rebound or
 *      put-back can never supply the verdict for the original attempt.
 *
 * Time bookkeeping: shot timestamps are engine-clock seconds; the recording
 * starts later (at rim lock). videoTime = cameraTime − recordingStartSec, and
 * samples are fed to the FSM at cameraTime so the offline resolve lands on the
 * same clock as the persisted shot.
 */
import { DETECTION } from './config';
import { BallTracker } from './ballTracker';
import { computeRimGeometry } from './rimLock';
import { ShotFsm } from './shotFsm';
import type { Box, Detection, ShotOutcome, ShotSignals } from './types';

/** Re-check tunables (see module doc). */
export const RECHECK = {
  /** Frame sampling rate across the re-check window, fps. */
  fps: 6,
  /** Window opens this many seconds before the shot's live tResolved. */
  windowBeforeSec: 3.5,
  /** Window closes this many seconds after the shot's live tResolved. */
  windowAfterSec: 1.5,
  /**
   * The offline resolve must land within this many seconds of the original
   * tResolved to be accepted as the SAME attempt — a resolve further away is
   * some other ball activity in the window and must not speak for this shot.
   *
   * MUST STAY BELOW SHOT_FSM.shotCooldownSec (1.5). At the old 2.0 the window
   * was WIDER than the FSM's own "this is a different attempt" cooldown, so a
   * rebound or put-back was inside the same-attempt window BY CONSTRUCTION and
   * could hand its verdict to the shot next to it. Pinned by an inequality
   * test rather than a magic number so the two can never drift apart again.
   */
  matchToleranceSec: 1.2,
} as const;

/**
 * Injected per-frame detector: run the app's detector on the recording at
 * `videoTimeSec` (seconds into the video file) and return detections in
 * ANALYSIS-FRAME pixels (the square {@link RecheckDeps.frameSize} space).
 * Returning an empty array for an unreadable timestamp is fine — the frame
 * simply contributes nothing.
 */
export type DetectFrameFn = (videoTimeSec: number) => Promise<Detection[]>;

/** The persisted shot fields the re-check needs. */
export interface RecheckShotRef {
  /** Caller's identifier for the shot (db row id) — passed through. */
  shotId: number;
  /** Live-resolve time, engine-clock seconds. */
  tResolved: number;
  /** Live outcome — anything but 'unsure' is refused (never flipped). */
  outcome: ShotOutcome;
}

/** Injected dependencies + tunable overrides for one re-check run. */
export interface RecheckDeps {
  detectFrame: DetectFrameFn;
  /** Analysis-frame side, px (square) — the space `detectFrame` boxes live in. */
  frameSize: number;
  /** Engine-clock second the recording started (SessionRow.recordingStartSec). */
  recordingStartSec: number;
  /** Cooperative cancellation — checked between frames. */
  isCancelled?: () => boolean;
  fps?: number;
  windowBeforeSec?: number;
  windowAfterSec?: number;
  matchToleranceSec?: number;
}

/** Why a re-checked shot produced no verdict. */
export type RecheckSkipReason =
  /** The shot was already decided (or user-corrected) — never re-judged. */
  | 'not-unsure'
  /** The rim was never re-detected in the window — no geometry to judge by. */
  | 'no-rim'
  /** The offline FSM resolved nothing near the original time. */
  | 'no-resolve'
  /** The offline pass also came out unsure. */
  | 'offline-unsure'
  /**
   * The offline pass called a MAKE from 2D geometry alone — no net channel
   * exists offline and no 'ball_in_basket' fired — so the make was refused and
   * the shot stays unsure. See {@link offlineMakeCorroborated}.
   */
  | 'uncorroborated-make'
  /** The run was cancelled mid-shot. */
  | 'cancelled';

/** Outcome of re-checking one shot. */
export interface RecheckShotResult {
  shotId: number;
  /** The accepted upgrade, or null to keep the shot unchanged. */
  verdict: 'make' | 'miss' | null;
  /** Fusion signals from the matched offline resolve (confidence receipt). */
  signals: ShotSignals | null;
  /** Populated exactly when verdict is null. */
  reason?: RecheckSkipReason;
  /** Frames actually sampled + detected for this shot. */
  framesSampled: number;
}

/** Hooks for a multi-shot run (all side effects are the caller's). */
export interface RecheckRunHooks {
  /** Called as shot `index` (1-based) of `total` STARTS processing. */
  onProgress?: (index: number, total: number) => void;
  /** Called (and awaited) after each shot completes — persist here. */
  onResult?: (result: RecheckShotResult) => void | Promise<void>;
}

/** Summary of a sequential multi-shot run. */
export interface RecheckRunSummary {
  results: RecheckShotResult[];
  /** Shots fully re-analysed (excludes the cancelled tail). */
  checked: number;
  /** Shots upgraded to a decided outcome. */
  corrected: number;
  /** True when cancellation cut the run short. */
  cancelled: boolean;
}

/**
 * Conservative reconciliation: the offline outcome may upgrade an 'unsure'
 * live call to a decided one; everything else keeps the original.
 */
export function reconcileOutcome(
  original: ShotOutcome,
  offline: ShotOutcome,
): 'make' | 'miss' | null {
  if (original !== 'unsure') return null;
  if (offline === 'make' || offline === 'miss') return offline;
  return null;
}

/**
 * Whether an offline MAKE carries corroboration beyond 2D geometry.
 *
 * The live pass mints a netless geo-only make (fuse(): `net === null &&
 * geo === true`) because live geometry is sampled at the camera rate. The
 * offline replay runs at {@link RECHECK.fps} = 6 fps, where the two samples
 * either side of the rim plane are 167 ms apart — the ball travels most of a
 * rim width between them, and "it was above, then it was below, and the
 * interpolated x was inside the span" is an inference, not an observation.
 * That is exactly the reading the live pass declined to convict on, arriving
 * with LESS evidence, so the replay may not upgrade an unsure on it.
 *
 * Corroboration means a second, independent channel said the same thing:
 * `net === true` (never available offline today, kept so this stays correct if
 * a net channel is ever recomputed) or `cls === true` (a 'ball_in_basket'
 * detection at the hoop). Absence of both is not evidence of a miss either —
 * the shot simply stays unsure, with 'uncorroborated-make' on the receipt.
 */
export function offlineMakeCorroborated(signals: ShotSignals): boolean {
  return signals.net === true || signals.cls === true;
}

/**
 * Camera-clock sample times across the re-check window, at the configured
 * fps, skipping any instant before the recording began (videoTime < 0).
 */
export function sampleCameraTimes(
  tResolved: number,
  recordingStartSec: number,
  opts: { fps: number; windowBeforeSec: number; windowAfterSec: number },
): number[] {
  const start = tResolved - opts.windowBeforeSec;
  const end = tResolved + opts.windowAfterSec;
  const step = 1 / opts.fps;
  const times: number[] = [];
  for (let t = start; t <= end + 1e-9; t += step) {
    if (t < recordingStartSec) continue;
    times.push(t);
  }
  return times;
}

/**
 * Per-component median of the given rim boxes (x, y, w, h independently) —
 * robust to the occasional jittered or outlier rim detection in a way a mean
 * is not. Null when the list is empty.
 */
export function medianRimBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const med = (vals: number[]): number => {
    vals.sort((a, b) => a - b);
    const mid = vals.length >> 1;
    return vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  };
  return {
    x: med(boxes.map((b) => b.x)),
    y: med(boxes.map((b) => b.y)),
    width: med(boxes.map((b) => b.width)),
    height: med(boxes.map((b) => b.height)),
  };
}

/** Highest-score detection of `cls` in a frame, or null. */
function bestOfClass(dets: readonly Detection[], cls: Detection['cls']): Detection | null {
  let best: Detection | null = null;
  for (const d of dets) {
    if (d.cls !== cls) continue;
    if (best === null || d.score > best.score) best = d;
  }
  return best;
}

/** Max 'ball_in_basket' score in a frame (0 when none). */
function maxClsScore(dets: readonly Detection[]): number {
  let m = 0;
  for (const d of dets) {
    if (d.cls === 'ball_in_basket' && d.score > m) m = d.score;
  }
  return m;
}

/** One sampled frame: camera-clock time + its detections. */
interface SampledFrame {
  t: number;
  detections: Detection[];
}

/**
 * Re-check ONE unsure shot against the recording.
 *
 * 1. Sample frames at ~{@link RECHECK.fps} fps across
 *    [tResolved − windowBeforeSec, tResolved + windowAfterSec] (video time via
 *    recordingStartSec) through the injected `detectFrame`.
 * 2. Re-derive rim geometry from the MEDIAN rim box across the sampled frames
 *    (the live session's lock isn't persisted; the rim is static so the median
 *    of the re-detections is the honest offline equivalent). No rim anywhere
 *    in the window ⇒ skip the shot — there is no geometry to judge by.
 * 3. Seed a fresh BallTracker + ShotFsm and feed the samples in timestamp
 *    order (camera clock, so units match the persisted shot).
 * 4. Of the offline resolves landing within ±matchToleranceSec of the
 *    original, take the one CLOSEST to it as this shot's verdict, reconciled
 *    conservatively (unsure→decided only).
 * 5. Refuse a make that rests on 2D geometry alone
 *    ({@link offlineMakeCorroborated}); the shot keeps its unsure outcome and
 *    the receipt records 'uncorroborated-make'.
 *
 * Net motion is not recomputed offline (no dense frame pairs at 6 fps), so the
 * net channel reads unavailable and the FSM's netless fusion applies. That
 * netless branch treats geometry ALONE as a make, which is why step 5 exists —
 * offline geometry at 6 fps is the weakest reading in the system, not the
 * high-precision path.
 */
export async function recheckShot(
  shot: RecheckShotRef,
  deps: RecheckDeps,
): Promise<RecheckShotResult> {
  const base: Omit<RecheckShotResult, 'reason'> = {
    shotId: shot.shotId,
    verdict: null,
    signals: null,
    framesSampled: 0,
  };
  if (shot.outcome !== 'unsure') {
    return { ...base, reason: 'not-unsure' };
  }

  const fps = deps.fps ?? RECHECK.fps;
  const windowBeforeSec = deps.windowBeforeSec ?? RECHECK.windowBeforeSec;
  const windowAfterSec = deps.windowAfterSec ?? RECHECK.windowAfterSec;
  const matchToleranceSec = deps.matchToleranceSec ?? RECHECK.matchToleranceSec;

  const times = sampleCameraTimes(shot.tResolved, deps.recordingStartSec, {
    fps,
    windowBeforeSec,
    windowAfterSec,
  });

  // --- Phase 1: sample + detect (the expensive part, one model run per frame).
  const frames: SampledFrame[] = [];
  for (const t of times) {
    if (deps.isCancelled?.() === true) {
      return { ...base, framesSampled: frames.length, reason: 'cancelled' };
    }
    const detections = await deps.detectFrame(t - deps.recordingStartSec);
    frames.push({ t, detections });
  }

  // --- Phase 2: rim geometry from the median re-detected rim box.
  const rimBoxes: Box[] = [];
  for (const f of frames) {
    const rim = bestOfClass(f.detections, 'rim');
    if (rim !== null && rim.score >= DETECTION.rimScoreMin) rimBoxes.push(rim.box);
  }
  const rimBox = medianRimBox(rimBoxes);
  if (rimBox === null) {
    return { ...base, framesSampled: frames.length, reason: 'no-rim' };
  }
  const rim = computeRimGeometry(rimBox);

  // --- Phase 3: replay through a fresh tracker + FSM in timestamp order.
  const tracker = new BallTracker({});
  // Every guard the LIVE app enables via settingsStore -> adoptRim
  // (shotPipeline.adoptRim). config.ts ships them constructor-default FALSE as
  // the unit-test baseline, so passing no opts here ran the offline pass with
  // depth veto, reappearance, rattle guard and settle window ALL OFF — a
  // strictly MORE permissive FSM than the live one, on strictly less evidence.
  // All four are demote-or-corroborate by construction (config.ts documents
  // each: the depth veto is make->miss only, reappearance upgrades only with
  // net/cls agreement, the rattle guard only demotes to unsure, the settle
  // window only buys observation time) — none of them can mint a make — so
  // turning them on can only make the offline pass stricter.
  const fsm = new ShotFsm(
    rim,
    { width: deps.frameSize, height: deps.frameSize },
    {
      useDepthRatioVeto: true,
      useReappearance: true,
      useRattleGuard: true,
      useSettleWindow: true,
    },
  );
  let matched: { outcome: ShotOutcome; signals: ShotSignals; dt: number } | null = null;
  for (const f of frames) {
    const ball = tracker.step(
      {
        t: f.t,
        frameWidth: deps.frameSize,
        frameHeight: deps.frameSize,
        detections: f.detections,
      },
      rim.hoopRoi,
    );
    const person = bestOfClass(f.detections, 'person');
    const result = fsm.step({
      t: f.t,
      ball,
      ballInBasketScore: maxClsScore(f.detections),
      // Not recomputed offline — the FSM treats an all-zero net channel as
      // unavailable and judges via the netless (geometry-first) fusion.
      netMotionScore: 0,
      personBox:
        person !== null && person.score >= DETECTION.personScoreMin
          ? person.box
          : null,
    });
    // CLOSEST matching resolve wins, not the first one in sequence. The window
    // is ±(3.5, 1.5) s and can easily contain a rebound or a put-back; taking
    // whichever resolve happened to fire first let a NEIGHBOUR speak for this
    // attempt whenever it landed inside the tolerance. Nearest-in-time is the
    // only tie-break that identifies the shot we were asked about, so the whole
    // window is replayed (no early break) before the verdict is chosen.
    if (result.resolved !== null) {
      const dt = Math.abs(result.resolved.tResolved - shot.tResolved);
      if (dt <= matchToleranceSec && (matched === null || dt < matched.dt)) {
        matched = {
          outcome: result.resolved.outcome,
          signals: result.resolved.signals,
          dt,
        };
      }
    }
  }

  if (matched === null) {
    return { ...base, framesSampled: frames.length, reason: 'no-resolve' };
  }
  const verdict = reconcileOutcome(shot.outcome, matched.outcome);
  // A make with no second channel behind it is the offline pass out-claiming
  // the live one: same 2D geometry, six frames a second, no net. Keep the
  // shot unsure and say why on the receipt.
  if (verdict === 'make' && !offlineMakeCorroborated(matched.signals)) {
    return {
      ...base,
      framesSampled: frames.length,
      signals: matched.signals,
      reason: 'uncorroborated-make',
    };
  }
  return {
    ...base,
    framesSampled: frames.length,
    verdict,
    signals: matched.signals,
    ...(verdict === null ? { reason: 'offline-unsure' as const } : {}),
  };
}

/**
 * Re-check several shots SEQUENTIALLY (each shot costs ~30 detector runs, so
 * parallelism would only thrash the CPU) with progress + cancellation hooks.
 * All persistence happens in the caller's `onResult` hook.
 */
export async function recheckShots(
  shots: readonly RecheckShotRef[],
  deps: RecheckDeps,
  hooks: RecheckRunHooks = {},
): Promise<RecheckRunSummary> {
  const results: RecheckShotResult[] = [];
  let checked = 0;
  let corrected = 0;
  let cancelled = false;
  for (let i = 0; i < shots.length; i++) {
    if (deps.isCancelled?.() === true) {
      cancelled = true;
      break;
    }
    hooks.onProgress?.(i + 1, shots.length);
    const result = await recheckShot(shots[i], deps);
    results.push(result);
    if (result.reason === 'cancelled') {
      cancelled = true;
      break;
    }
    checked++;
    if (result.verdict !== null) corrected++;
    await hooks.onResult?.(result);
  }
  return { results, checked, corrected, cancelled };
}
