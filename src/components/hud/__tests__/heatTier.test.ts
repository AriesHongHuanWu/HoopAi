/**
 * Pins the heat-tier ladder to STREAKS.celebrateAt so the scoreboard, the
 * celebration sounds, and the flash all escalate on the SAME streak lengths.
 * If someone retunes celebrateAt in core/config.ts without updating heatTier,
 * the alignment block below fails loudly.
 */
import { describe, expect, test } from '@jest/globals';

import { STREAKS } from '../../../core/config';
import { heatState } from '../heatTier';

describe('heatState', () => {
  test('boundary table', () => {
    // cold
    expect(heatState(0).tier).toBe(0);
    expect(heatState(1).tier).toBe(0);
    expect(heatState(2).tier).toBe(0);
    // tier 1
    expect(heatState(3)).toEqual({ tier: 1, label: 'HOT' });
    expect(heatState(4)).toEqual({ tier: 1, label: 'HOT' });
    // tier 2
    expect(heatState(5)).toEqual({ tier: 2, label: 'ON FIRE' });
    expect(heatState(9)).toEqual({ tier: 2, label: 'ON FIRE' });
    // tier 3
    expect(heatState(10)).toEqual({ tier: 3, label: 'UNCONSCIOUS' });
    expect(heatState(25)).toEqual({ tier: 3, label: 'UNCONSCIOUS' });
  });

  test('tiers align with STREAKS.celebrateAt — one story for ear, flash, scoreboard', () => {
    expect(STREAKS.celebrateAt).toHaveLength(3);
    expect(heatState(STREAKS.celebrateAt[0]).tier).toBe(1);
    expect(heatState(STREAKS.celebrateAt[1]).tier).toBe(2);
    expect(heatState(STREAKS.celebrateAt[2]).tier).toBe(3);
    // One below each threshold sits exactly one tier lower.
    expect(heatState(STREAKS.celebrateAt[0] - 1).tier).toBe(0);
    expect(heatState(STREAKS.celebrateAt[1] - 1).tier).toBe(1);
    expect(heatState(STREAKS.celebrateAt[2] - 1).tier).toBe(2);
  });

  test('labels: null when cold, exact broadcast strings when hot', () => {
    expect(heatState(0).label).toBeNull();
    expect(heatState(2).label).toBeNull();
    expect(heatState(3).label).toBe('HOT');
    expect(heatState(5).label).toBe('ON FIRE');
    expect(heatState(10).label).toBe('UNCONSCIOUS');
  });

  test('defensive: negative and non-finite streaks are cold', () => {
    expect(heatState(-1)).toEqual({ tier: 0, label: null });
    expect(heatState(Number.NaN)).toEqual({ tier: 0, label: null });
  });
});
