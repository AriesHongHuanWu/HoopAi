/**
 * Clip planner: turns resolved shots into video trim plans for the session
 * recording. Pure functions, no I/O — the actual trimming/export happens
 * elsewhere. Times are seconds into the session recording (camera-timestamp
 * aligned, see types.ts).
 */
import { CLIPS } from './config';
import { clamp } from './geometry';
import type { ClipPlan, ResolvedShot } from './types';

/** Options controlling which shots become clips and how they are windowed. */
export interface ClipOptions {
  /**
   * Which shots to keep:
   * - 'makes'   → only outcome === 'make'
   * - 'decided' → makes and misses (excludes 'unsure')
   * - 'all'     → every resolved shot
   */
  keep: 'makes' | 'all' | 'decided';
  /** Seconds of video kept before tResolved. Default: CLIPS.preRollSec. */
  preRollSec?: number;
  /** Seconds of video kept after tResolved. Default: CLIPS.postRollSec. */
  postRollSec?: number;
  /** Total length of the session recording, seconds. Windows clamp to it. */
  sessionDurationSec: number;
}

/**
 * Plan trim windows for the given resolved shots.
 *
 * Each kept shot yields the window [tResolved − preRoll, tResolved + postRoll],
 * clamped to [0, sessionDurationSec]. Windows that overlap or sit closer than
 * CLIPS.mergeGapSec are merged into one clip; the merged clip keeps the
 * FIRST (earliest-starting) shot's id, and its outcome is 'make' when ANY
 * merged shot was a make (otherwise the first shot's outcome).
 *
 * Shots the user corrected (`corrected === true`) are filtered by their
 * CURRENT `outcome` field — the correction has already flipped it.
 *
 * @returns Clip plans sorted by startSec.
 */
export function planClips(
  shots: readonly ResolvedShot[],
  opts: ClipOptions,
): ClipPlan[] {
  const preRoll = opts.preRollSec ?? CLIPS.preRollSec;
  const postRoll = opts.postRollSec ?? CLIPS.postRollSec;
  const duration = opts.sessionDurationSec;

  // 1. Filter by keep mode (corrected shots already carry their current outcome).
  const windows: ClipPlan[] = [];
  for (const shot of shots) {
    if (opts.keep === 'makes' && shot.outcome !== 'make') continue;
    if (opts.keep === 'decided' && shot.outcome === 'unsure') continue;
    windows.push({
      shotId: shot.id,
      outcome: shot.outcome,
      startSec: clamp(shot.tResolved - preRoll, 0, duration),
      endSec: clamp(shot.tResolved + postRoll, 0, duration),
    });
  }
  if (windows.length === 0) return windows;

  // 2. Sort by start time so merging is a single linear pass.
  windows.sort((a, b) => a.startSec - b.startSec);

  // 3. Merge overlapping / near-adjacent windows.
  const merged: ClipPlan[] = [windows[0]];
  for (let i = 1; i < windows.length; i++) {
    const next = windows[i];
    const cur = merged[merged.length - 1];
    if (next.startSec - cur.endSec < CLIPS.mergeGapSec) {
      cur.endSec = Math.max(cur.endSec, next.endSec);
      if (next.outcome === 'make') cur.outcome = 'make';
    } else {
      merged.push(next);
    }
  }
  return merged;
}

/**
 * Total duration in seconds covered by the given clip plans.
 * Assumes plans are non-overlapping (as produced by planClips).
 */
export function totalClipSeconds(plans: readonly ClipPlan[]): number {
  let total = 0;
  for (const p of plans) total += p.endSec - p.startSec;
  return total;
}

/**
 * Build a filesystem-safe file name for a clip:
 * "<sessionLabel>_shot<id>_<outcome>.mp4", with whitespace runs collapsed to
 * single dashes and everything lowercased.
 *
 * @example formatClipName(plan, 'Morning Session') → "morning-session_shot3_make.mp4"
 */
export function formatClipName(plan: ClipPlan, sessionLabel: string): string {
  const raw = `${sessionLabel}_shot${plan.shotId}_${plan.outcome}.mp4`;
  return raw.trim().replace(/\s+/g, '-').toLowerCase();
}
