import { weeklyAssignment } from '../coachEngine';
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
