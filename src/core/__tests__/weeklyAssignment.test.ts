import { weeklyAssignment, weeklyPlan } from '../coachEngine';
import type { CoachFinding, FindingKind } from '../coachEngine';

function finding(id: FindingKind, severity: 1 | 2 | 3 = 2): CoachFinding {
  return {
    id,
    severity,
    title: `t:${id}`,
    evidence: 'e',
    prescription: 'p',
    trend: 'flat',
    strength: 1,
  };
}

describe('weeklyAssignment', () => {
  test('picks the top ranked finding that maps to a drill', () => {
    // entryAngleLow -> catchShoot10 (mapped); assumed already severity-ranked.
    const a = weeklyAssignment([finding('entryAngleLow'), finding('sideBias')]);
    expect(a).not.toBeNull();
    expect(a!.finding.id).toBe('entryAngleLow');
    expect(a!.drillId).toBe('catchShoot10');
  });

  test('skips non-drill findings and takes the next drillable one', () => {
    // unsureRate + improving have no drill; twoVsThree -> corners3.
    const a = weeklyAssignment([
      finding('unsureRate', 3),
      finding('improving', 3),
      finding('twoVsThree', 2),
    ]);
    expect(a!.finding.id).toBe('twoVsThree');
    expect(a!.drillId).toBe('corners3');
  });

  test('maps zone/side findings to the mid-range clock', () => {
    expect(weeklyAssignment([finding('zoneImbalance')])!.drillId).toBe('midClock');
    expect(weeklyAssignment([finding('sideBias')])!.drillId).toBe('midClock');
  });

  test('fatigue maps to the free-throw ladder', () => {
    expect(weeklyAssignment([finding('fatigue')])!.drillId).toBe('ftLadder');
  });

  test('returns null when no finding has a drill', () => {
    expect(
      weeklyAssignment([finding('unsureRate'), finding('volumeTrend'), finding('improving')]),
    ).toBeNull();
  });

  test('returns null for an empty list', () => {
    expect(weeklyAssignment([])).toBeNull();
  });
});

describe('weeklyPlan', () => {
  test('returns up to the top 3 drillable findings, in order', () => {
    const plan = weeklyPlan([
      finding('unsureRate', 3), // no drill -> skipped
      finding('entryAngleLow', 3),
      finding('twoVsThree', 2),
      finding('fatigue', 2),
      finding('sideBias', 1), // 4th drillable -> dropped by max=3
    ]);
    expect(plan.map((p) => p.finding.id)).toEqual(['entryAngleLow', 'twoVsThree', 'fatigue']);
    expect(plan[0]!.drillId).toBe('catchShoot10');
  });

  test('respects a custom max', () => {
    const plan = weeklyPlan([finding('entryAngleLow'), finding('twoVsThree')], 1);
    expect(plan).toHaveLength(1);
  });

  test('empty when nothing is drillable', () => {
    expect(weeklyPlan([finding('unsureRate'), finding('improving')])).toEqual([]);
  });
});
