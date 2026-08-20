/**
 * Thermal governor — inference-time-based detection throttling.
 *
 * THE PROBLEM: sustained sessions heat the phone until the OS throttles the
 * chip; the app then burns battery fighting a slowdown it cannot win, and the
 * per-frame budget silently collapses. There is no thermal API available to
 * us without a native dependency (iron rule: none), but OS throttling makes
 * the SAME model run measurably slower — so the ratio of the current
 * inference time against a cool baseline is an honest thermal proxy.
 *
 * WHAT IT CONTROLS: the governor only sheds detection WORK, in cheapness
 * order — the ROI second pass first (L1), then a frame-rate cap (L2), then
 * the pose pass (L3). It NEVER touches judgment: all core gates are
 * time-based or scaleFrameGate-scaled, so a lower cadence is already safe
 * (pinned by the shotFsmLowFps / ballTrackerLowFps suites).
 *
 * BASELINE HONESTY: the cool baseline is seeded from a slow EMA over the
 * first {@link THERMAL.baselineSec} seconds, and afterwards may only drift
 * DOWN (a cooled chip lowers it). It can never inflate to hide heat — a
 * session that starts hot simply keeps its hot baseline and stays at L0,
 * which fails safe (no shedding).
 *
 * ANTI-OSCILLATION: a threshold must hold continuously for
 * {@link THERMAL.dwellSec} before the level moves, exits use a hysteresis
 * factor below the entry ratio, and every transition moves ONE step with the
 * dwell restarting per step — a ratio spike can never jump 0→3 in one tick,
 * and a ratio hovering on a threshold never flaps the level.
 *
 * Pure TypeScript, deterministic, no I/O; time comes in via `tSec` only.
 */

/** Throttle severity. 0 = cool / full work, 3 = maximum shedding. */
export type ThermalLevel = 0 | 1 | 2 | 3;

/** What the engine is allowed to spend this level. */
export interface ThermalDecision {
  level: ThermalLevel;
  /** Extra floor on the worklet frame gate, ms (0 = no cap beyond base). */
  minGateMs: number;
  /** Replaces the hardcoded 1.4 in effGate = max(gateMs, avgInferMs * multiplier). */
  inferMultiplier: number;
  /** ROI second pass allowed (sheds first — cheapest recall to sacrifice). */
  allowRoi: boolean;
  /** Pose/MoveNet pass allowed (sheds last — user opted into form analysis). */
  allowPose: boolean;
}

export const THERMAL = {
  baselineSec: 20, // seed the cool baseline over the first 20 s of samples
  minSamples: 30, // never judge before this many pushes
  enterRatios: [1.5, 2.0, 2.75] as const, // fastEma/baseline thresholds for L1/L2/L3
  exitFactor: 0.85, // exit level k when ratio <= enterRatios[k-1] * exitFactor
  dwellSec: 8, // a threshold must hold this long before the level changes
  fastAlpha: 0.15,
  slowAlpha: 0.02,
} as const;

/**
 * Per-level decision table. L1 drops the ROI pass; L2 additionally floors the
 * frame gate at 66 ms (~15 fps) and widens the inference multiplier; L3 caps
 * at 100 ms (~10 fps) and sheds pose. {@link ThermalGovernor.decision} hands
 * these objects out directly — do not mutate them.
 */
export const THERMAL_LEVELS: readonly ThermalDecision[] = [
  { level: 0, minGateMs: 0, inferMultiplier: 1.4, allowRoi: true, allowPose: true },
  { level: 1, minGateMs: 0, inferMultiplier: 1.6, allowRoi: false, allowPose: true },
  { level: 2, minGateMs: 66, inferMultiplier: 2.0, allowRoi: false, allowPose: true },
  { level: 3, minGateMs: 100, inferMultiplier: 2.6, allowRoi: false, allowPose: false },
];

/**
 * Consumes per-frame inference times and publishes a throttle
 * {@link ThermalDecision}.
 *
 * Level machine: from level L the ratio must satisfy
 * `ratio >= enterRatios[L]` continuously for dwellSec to step UP to L+1, or
 * `ratio <= enterRatios[L-1] * exitFactor` continuously for dwellSec to step
 * DOWN to L-1; anything in between holds L (hysteresis band). Each step
 * clears the dwell timer, so multi-level moves take one full dwell per step.
 */
export class ThermalGovernor {
  /** Fast EMA of inference time — "how slow are we right now". */
  private fastEma = 0;
  /** Slow EMA of inference time — feeds the baseline, smooths out bursts. */
  private slowEma = 0;
  /** Cool reference inference time; 0 until the first sample. */
  private baseline = 0;
  /** True once the baselineSec seeding window has elapsed. */
  private baselineFormed = false;
  /** Camera-clock time (s) of the first accepted sample. */
  private firstT = 0;
  /** Accepted sample count (inferMs <= 0 is ignored). */
  private samples = 0;

  private level: ThermalLevel = 0;
  /** Armed transition direction (+1 raise / -1 lower / 0 idle). */
  private pendingDir: -1 | 0 | 1 = 0;
  /** Camera-clock time (s) the pending direction became continuously true. */
  private pendingSince = 0;

  /**
   * Feeds one inference-time sample.
   *
   * @param inferMs Wall time of this frame's model inference, ms. Values <= 0
   *   are ignored (frames where inference was skipped report no signal).
   * @param tSec Frame timestamp in seconds (camera clock).
   */
  push(inferMs: number, tSec: number): void {
    if (inferMs <= 0) return;
    if (this.samples === 0) {
      this.firstT = tSec;
      this.fastEma = inferMs;
      this.slowEma = inferMs;
      this.baseline = inferMs;
    } else {
      this.fastEma += THERMAL.fastAlpha * (inferMs - this.fastEma);
      this.slowEma += THERMAL.slowAlpha * (inferMs - this.slowEma);
    }
    this.samples++;

    if (!this.baselineFormed && tSec - this.firstT < THERMAL.baselineSec) {
      // Seeding window: the baseline tracks the slow EMA in both directions.
      this.baseline = this.slowEma;
    } else {
      this.baselineFormed = true;
      // Formed: cooling may lower it; heating can never inflate it.
      if (this.slowEma < this.baseline) this.baseline = this.slowEma;
    }

    this.stepLevel(tSec);
  }

  /** Current throttle decision (a shared THERMAL_LEVELS row; no allocation). */
  get decision(): ThermalDecision {
    return THERMAL_LEVELS[this.level];
  }

  /**
   * Diagnostic fastEma/baseline ratio; 1 while the baseline is unformed or
   * fewer than minSamples samples have been pushed (the governor is not
   * judging yet).
   */
  get ratio(): number {
    if (!this.judging) return 1;
    return this.fastEma / this.baseline;
  }

  /** Back to level 0 with an unformed baseline — call on model reload. */
  reset(): void {
    this.fastEma = 0;
    this.slowEma = 0;
    this.baseline = 0;
    this.baselineFormed = false;
    this.firstT = 0;
    this.samples = 0;
    this.level = 0;
    this.pendingDir = 0;
    this.pendingSince = 0;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** True once there is enough signal to trust the ratio at all. */
  private get judging(): boolean {
    return (
      this.baselineFormed &&
      this.samples >= THERMAL.minSamples &&
      this.baseline > 0
    );
  }

  /** Runs the dwell + hysteresis level machine for this push. */
  private stepLevel(tSec: number): void {
    const r = this.ratio; // 1 while not judging → both conditions stay idle
    const lv = this.level; // `!==` (not `<`) so TS narrows the tuple index
    let dir: -1 | 0 | 1 = 0;
    if (lv !== 3 && r >= THERMAL.enterRatios[lv]) {
      dir = 1;
    } else if (
      lv !== 0 &&
      r <= THERMAL.enterRatios[lv - 1] * THERMAL.exitFactor
    ) {
      dir = -1;
    }

    if (dir === 0) {
      this.pendingDir = 0;
      return;
    }
    if (dir !== this.pendingDir) {
      // Condition just became true (or flipped direction) — start the dwell.
      this.pendingDir = dir;
      this.pendingSince = tSec;
      return;
    }
    if (tSec - this.pendingSince >= THERMAL.dwellSec) {
      this.level = (this.level + dir) as ThermalLevel;
      // One step per dwell: the next step re-arms against the NEW level on the
      // following push, so even a huge spike walks 0→3 one dwell at a time.
      this.pendingDir = 0;
    }
  }
}
