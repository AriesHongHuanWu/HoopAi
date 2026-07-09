/**
 * heatTier — pure streak → heat-tier mapping for the live scoreboard.
 *
 * Thresholds (3 / 5 / 10) deliberately mirror STREAKS.celebrateAt in
 * src/core/config.ts so sound, flash, and scoreboard escalate together —
 * the alignment test in __tests__/heatTier.test.ts pins this: retuning the
 * config without updating this ladder fails the test instead of silently
 * desyncing the ear from the eye.
 *
 * Stateless and deterministic — no timers, no React. Labels are always shown
 * as TEXT alongside color (colorblind rule: color never carries meaning alone).
 */

export type HeatTier = 0 | 1 | 2 | 3;

export interface HeatState {
  tier: HeatTier;
  /** Broadcast label for tiers 1+ — always shown as TEXT alongside color (colorblind rule). */
  label: string | null;
}

export function heatState(streak: number): HeatState {
  // Defensive: negative / NaN / anything below the first threshold is cold.
  if (!Number.isFinite(streak) || streak < 3) return { tier: 0, label: null };
  if (streak < 5) return { tier: 1, label: 'HOT' };
  if (streak < 10) return { tier: 2, label: 'ON FIRE' };
  return { tier: 3, label: 'UNCONSCIOUS' };
}
