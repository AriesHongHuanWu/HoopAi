/**
 * Acquisition funnel — the diagnostic layer that finally distinguishes
 * "ball seen" from "ball tracked" from "shot armed".
 *
 * A ball can be drawn by the debug overlay yet never produce a trail or a
 * judged shot: every stage of the chain (score floor, size cap, aspect gate,
 * jump gate, rim lock, arm branches, dribble gate, arc suppression) can kill
 * it silently, and until now NOTHING reported which stage did. This module
 * defines the per-frame counters each stage fills in so one COPY DIAG paste
 * from the field pinpoints the dying gate.
 *
 * RECORDING ONLY, judgment-untouched: nothing here feeds the FSM, arms a
 * shot, or flips an outcome — the funnel observes the pipeline, it never
 * steers it.
 *
 * Threading contract (see the round-2 design): the assembled FrameFunnel
 * rides OverlayState (written once per frame by the JS-thread onFrame
 * publish), NOT EngineDebug — EngineDebug is worklet-written every frame and
 * a JS-side write would race/clobber it.
 *
 * Pure TypeScript: no I/O, no wall clock, no module-level mutable state.
 */
import { DETECTION } from './config';
// Type-only import: no runtime dependency, no cycle — shotFsm never imports
// this module. ArmRefusal is the FSM's own arm-refusal telemetry vocabulary
// (FsmStepResult.armRefusal); re-exported here so funnel consumers can type
// against one module.
import type { ArmRefusal } from './shotFsm';

export type { ArmRefusal } from './shotFsm';

/** Which score-floor relaxation the ACCEPTED candidate used this frame. */
export type GateUsed = 'hoopRoi' | 'tracking' | 'cold' | 'none';

/** The gate that produced the LAST rejection this frame (null = none). */
export type TrackReject = 'score' | 'size' | 'aspect' | 'jump' | null;

/**
 * Per-step BallTracker telemetry: how many ball-class detections were seen
 * and exactly which gate rejected the ones that died. Reset every step;
 * read via BallTracker.lastStepStats().
 */
export interface TrackerStepStats {
  /** Ball-class detections offered to the tracker this step. */
  ballDets: number;
  /** The ACTIVE cold-acquisition score floor (per-model / light-profile). */
  floor: number;
  /** Relaxation used by the accepted candidate ('none' when none accepted). */
  gate: GateUsed;
  /** Rejections by the score floor. */
  rejScore: number;
  /** Rejections by the max-size cap. */
  rejSize: number;
  /** Rejections by the round-aspect gate. */
  rejAspect: number;
  /** Rejections by the teleport (jump) gate. */
  rejJump: number;
  /** The most recent rejection reason this step, null if none. */
  lastReject: TrackReject;
  /** True when a candidate was accepted this step. */
  accepted: boolean;
  /** True when the accepted candidate came via the persistence rescue. */
  rescued: boolean;
}

/**
 * The full per-frame acquisition funnel, assembled by ShotPipeline from the
 * tracker stats plus track/FSM/dribble/arc state. Published on OverlayState.
 */
export interface FrameFunnel extends TrackerStepStats {
  /** Raw ball-class detections in the frame (pre-tracker, post-parser). */
  rawBall: number;
  /** Track state: real detection, Kalman coast, or no live track. */
  track: 'real' | 'coast' | 'none';
  /** FSM arm verdict this frame; 'no-rim' when the FSM does not exist yet. */
  armRefusal: ArmRefusal | 'no-rim';
  /** True while the dribble gate's suppression latch is held. */
  dribbleLatch: boolean;
  /** Vertical R² of the current flight-arc fit, null when no fit. */
  arcR2y: number | null;
  /** True when the full-flight path is suppressed this frame. */
  arcSuppressed: boolean;
}

/** Inert funnel for frames before any pipeline output exists. Frozen. */
export const EMPTY_FUNNEL: FrameFunnel = Object.freeze({
  ballDets: 0,
  // The open-court default; the tracker overwrites it with the ACTIVE floor
  // (per-model / light-profile) on the first real step.
  floor: DETECTION.ballScoreMin,
  gate: 'none',
  rejScore: 0,
  rejSize: 0,
  rejAspect: 0,
  rejJump: 0,
  lastReject: null,
  accepted: false,
  rescued: false,
  rawBall: 0,
  track: 'none',
  armRefusal: 'no-rim',
  dribbleLatch: false,
  arcR2y: null,
  arcSuppressed: false,
} as FrameFunnel);

/** arcR2y at its 2-decimal DISPLAY precision (null-aware), for comparisons. */
function r2Display(v: number | null): string {
  return v == null ? 'null' : v.toFixed(2);
}

/**
 * Two fixed-format diagnostic lines for the debug panel / COPY DIAG paste.
 *
 * Line 1 (`gates:`) — the tracker step: active floor + relaxation used,
 * raw ball detections, and per-reason reject counters
 * (s=score, a=aspect, j=jump, z=size), e.g.
 *   `gates: floor 0.35 cold · ball 3 · rej s12 a3 j1 z0`
 *
 * Line 2 (`arm:`) — the FSM/visual layer: arm refusal, dribble-latch state
 * (only when the latch is held or the arc is suppressed) and the arc fit
 * (only when a fit exists), e.g.
 *   `arm: no-branch · dribble latched · arc r2 0.72 SUPPRESSED`
 */
export function formatFunnelDiag(f: FrameFunnel): [string, string] {
  const line1 =
    `gates: floor ${f.floor.toFixed(2)} ${f.gate}` +
    ` · ball ${f.rawBall}` +
    ` · rej s${f.rejScore} a${f.rejAspect} j${f.rejJump} z${f.rejSize}`;

  const segs: string[] = [`arm: ${f.armRefusal}`];
  if (f.dribbleLatch || f.arcSuppressed) {
    // 'dribble clear' with arcSuppressed=true tells the field reader the
    // suppression came from the apex rule, NOT a held dribble latch.
    segs.push(f.dribbleLatch ? 'dribble latched' : 'dribble clear');
  }
  if (f.arcR2y != null) {
    segs.push(
      `arc r2 ${f.arcR2y.toFixed(2)}${f.arcSuppressed ? ' SUPPRESSED' : ''}`,
    );
  }
  return [line1, segs.join(' · ')];
}

/**
 * True when the two funnels differ at DISPLAY precision — floats are
 * compared at the 2 decimals the panel shows (mirrors DebugPanel's
 * debugChanged pattern), so a jittering 4th decimal never forces a
 * re-render every tick.
 */
export function funnelChanged(a: FrameFunnel, b: FrameFunnel): boolean {
  return (
    a.ballDets !== b.ballDets ||
    a.floor.toFixed(2) !== b.floor.toFixed(2) ||
    a.gate !== b.gate ||
    a.rejScore !== b.rejScore ||
    a.rejSize !== b.rejSize ||
    a.rejAspect !== b.rejAspect ||
    a.rejJump !== b.rejJump ||
    a.lastReject !== b.lastReject ||
    a.accepted !== b.accepted ||
    a.rescued !== b.rescued ||
    a.rawBall !== b.rawBall ||
    a.track !== b.track ||
    a.armRefusal !== b.armRefusal ||
    a.dribbleLatch !== b.dribbleLatch ||
    r2Display(a.arcR2y) !== r2Display(b.arcR2y) ||
    a.arcSuppressed !== b.arcSuppressed
  );
}
