/**
 * formCue — pure picker deciding whether a resolved shot earns a live form-cue
 * toast, and which single tip it shows.
 *
 * The pipeline already attaches `shot.form?.tips` (coachingTips(), max 3, one
 * severity-3 headline) when form analysis is on; this module only *reads* that
 * data. The rules exist to keep the toast quiet: never coach a heater, only
 * headline-band cues after a make, a hard 20 s cooldown, and no back-to-back
 * repeats of the same metric. Pure and deterministic — time comes in as a
 * parameter, never Date.now().
 */
import type { CoachingTip, ResolvedShot } from '../../core/types';

/** Throttle memo the caller owns (a ref in FormCueToast). */
export interface FormCueMemo {
  lastShownAtMs: number | null;
  lastMetric: string | null;
}

export const EMPTY_CUE_MEMO: FormCueMemo = { lastShownAtMs: null, lastMetric: null };

/** Minimum gap between two cues — a session should feel coached, not nagged. */
export const FORM_CUE_COOLDOWN_MS = 20_000;

export function pickFormCue(
  shot: ResolvedShot,
  /** Current streak AFTER this shot folded into stats (live.tsx's `streak`). */
  streakAfter: number,
  memo: FormCueMemo,
  nowMs: number,
): CoachingTip | null {
  // (1) No form data (analysis off, pose never seen) or no tips → nothing to say.
  const tips = shot.form?.tips ?? [];
  if (tips.length === 0) return null;

  // (2) Never coach a heater — a player on a 3+ streak gets left alone.
  if (streakAfter >= 3) return null;

  // (3) Candidate = highest-severity tip. Array.prototype.sort is stable, so
  // ties keep coachingTips' own ranking (original order).
  const candidate = [...tips].sort((a, b) => b.severity - a.severity)[0]!;

  // (4) After a make, only the worst-band headline (severity 3) earns a cue.
  if (shot.outcome === 'make' && candidate.severity < 3) return null;

  // (5) Cooldown: at most one cue per FORM_CUE_COOLDOWN_MS.
  if (memo.lastShownAtMs != null && nowMs - memo.lastShownAtMs < FORM_CUE_COOLDOWN_MS) return null;

  // (6) No immediate repeats of the same metric — vary the coaching.
  if (candidate.metric === memo.lastMetric) return null;

  return candidate;
}
