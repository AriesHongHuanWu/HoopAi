import type { CoachingTip, ResolvedShot, ShotOutcome } from '../../../core/types';
import { EMPTY_CUE_MEMO, FORM_CUE_COOLDOWN_MS, pickFormCue, type FormCueMemo } from '../formCue';

function tip(
  metric: CoachingTip['metric'],
  severity: CoachingTip['severity'],
  title = `${metric} cue`,
): CoachingTip {
  return { metric, severity, title, message: `Fix ${metric}.` };
}

/**
 * Minimal fixture — the picker only reads `outcome` and `form.tips`, so the
 * partial is cast rather than constructing a full ResolvedShot/ShotSignals.
 */
function shotWith(outcome: ShotOutcome, tips?: CoachingTip[]): ResolvedShot {
  const partial = {
    id: 1,
    outcome,
    ...(tips != null ? { form: { metrics: {}, tips } } : {}),
  };
  return partial as unknown as ResolvedShot;
}

function memoAt(lastShownAtMs: number | null, lastMetric: string | null = null): FormCueMemo {
  return { lastShownAtMs, lastMetric };
}

describe('pickFormCue', () => {
  it('returns null when the shot has no form report or empty tips', () => {
    expect(pickFormCue(shotWith('miss'), 0, EMPTY_CUE_MEMO, 1_000)).toBeNull();
    expect(pickFormCue(shotWith('miss', []), 0, EMPTY_CUE_MEMO, 1_000)).toBeNull();
  });

  it('never coaches a heater: streakAfter >= 3 suppresses even a severity-3 tip', () => {
    const shot = shotWith('miss', [tip('releaseAngleDeg', 3)]);
    expect(pickFormCue(shot, 3, EMPTY_CUE_MEMO, 1_000)).toBeNull();
    expect(pickFormCue(shot, 7, EMPTY_CUE_MEMO, 1_000)).toBeNull();
    expect(pickFormCue(shot, 2, EMPTY_CUE_MEMO, 1_000)).toEqual(tip('releaseAngleDeg', 3));
  });

  it('picks the highest-severity tip regardless of order', () => {
    const shot = shotWith('miss', [
      tip('kneeFlexionDeg', 1),
      tip('releaseAngleDeg', 3),
      tip('setPointElbowDeg', 2),
    ]);
    expect(pickFormCue(shot, 0, EMPTY_CUE_MEMO, 1_000)).toEqual(tip('releaseAngleDeg', 3));
  });

  it('breaks severity ties by original order (coachingTips ranking)', () => {
    const first = tip('setPointElbowDeg', 2);
    const second = tip('kneeFlexionDeg', 2);
    const shot = shotWith('miss', [first, second]);
    expect(pickFormCue(shot, 0, EMPTY_CUE_MEMO, 1_000)).toEqual(first);
  });

  it('after a make, only a severity-3 headline earns a cue', () => {
    expect(pickFormCue(shotWith('make', [tip('releaseAngleDeg', 2)]), 0, EMPTY_CUE_MEMO, 1_000)).toBeNull();
    expect(pickFormCue(shotWith('make', [tip('releaseAngleDeg', 3)]), 0, EMPTY_CUE_MEMO, 1_000)).toEqual(
      tip('releaseAngleDeg', 3),
    );
  });

  it('misses and unsure shots surface any severity band', () => {
    expect(pickFormCue(shotWith('miss', [tip('setPointElbowDeg', 2)]), 0, EMPTY_CUE_MEMO, 1_000)).toEqual(
      tip('setPointElbowDeg', 2),
    );
    expect(pickFormCue(shotWith('unsure', [tip('kneeFlexionDeg', 1)]), 0, EMPTY_CUE_MEMO, 1_000)).toEqual(
      tip('kneeFlexionDeg', 1),
    );
  });

  it('enforces the cooldown with an inclusive boundary at FORM_CUE_COOLDOWN_MS', () => {
    const shot = shotWith('miss', [tip('releaseAngleDeg', 3)]);
    const memo = memoAt(0);
    expect(pickFormCue(shot, 0, memo, FORM_CUE_COOLDOWN_MS - 1)).toBeNull();
    expect(pickFormCue(shot, 0, memo, FORM_CUE_COOLDOWN_MS)).toEqual(tip('releaseAngleDeg', 3));
  });

  it('suppresses an immediate repeat of the same metric but not a different one', () => {
    const memo = memoAt(0, 'releaseAngleDeg');
    const now = FORM_CUE_COOLDOWN_MS + 1;
    expect(pickFormCue(shotWith('miss', [tip('releaseAngleDeg', 3)]), 0, memo, now)).toBeNull();
    expect(pickFormCue(shotWith('miss', [tip('kneeFlexionDeg', 3)]), 0, memo, now)).toEqual(
      tip('kneeFlexionDeg', 3),
    );
  });

  it('returns the candidate immediately with a fresh EMPTY_CUE_MEMO', () => {
    const shot = shotWith('miss', [tip('followThroughElbowDeg', 1)]);
    expect(pickFormCue(shot, 0, EMPTY_CUE_MEMO, 0)).toEqual(tip('followThroughElbowDeg', 1));
  });

  it('does not mutate the input tips array when sorting', () => {
    const tips = [tip('kneeFlexionDeg', 1), tip('releaseAngleDeg', 3)];
    const shot = shotWith('miss', tips);
    pickFormCue(shot, 0, EMPTY_CUE_MEMO, 1_000);
    expect(tips[0]!.metric).toBe('kneeFlexionDeg');
  });
});
