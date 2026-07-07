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
   */
  matchToleranceSec: 2.0,
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
 * 4. Accept the FIRST offline resolve whose tResolved lands within
 *    ±matchToleranceSec of the original as this shot's verdict, reconciled
 *    conservatively (unsure→decided only).
 *
 * Net motion is not recomputed offline (no dense frame pairs at 6 fps), so the
 * net channel reads unavailable and the FSM's netless fusion applies — geometry
 * first, exactly the high-precision path.
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
  const fsm = new ShotFsm(rim, { width: deps.frameSize, height: deps.frameSize });
  let matched: { outcome: ShotOutcome; signals: ShotSignals } | null = null;
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
    if (
      matched === null &&
      result.resolved !== null &&
      Math.abs(result.resolved.tResolved - shot.tResolved) <= matchToleranceSec
    ) {
      matched = {
        outcome: result.resolved.outcome,
        signals: result.resolved.signals,
      };
      // FIRST matching resolve is the verdict — later window activity
      // (a rebound, the next attempt bleeding in) must not overwrite it.
      break;
    }
  }

  if (matched === null) {
    return { ...base, framesSampled: frames.length, reason: 'no-resolve' };
  }
  const verdict = reconcileOutcome(shot.outcome, matched.outcome);
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
