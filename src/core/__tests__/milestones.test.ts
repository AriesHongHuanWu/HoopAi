import { detectMilestones } from '../milestones';

describe('detectMilestones', () => {
  test('fires on a make threshold crossed this session', () => {
    // 92 -> 104 crosses 100.
    const m = detectMilestones({ makesAfter: 104, makesGained: 12, sessionsAfter: 7 });
    expect(m.map((x) => `${x.kind}:${x.value}`)).toContain('makes:100');
  });

  test('does NOT fire when the threshold was already passed', () => {
    // 120 -> 130: 100 was already crossed before this session.
    const m = detectMilestones({ makesAfter: 130, makesGained: 10, sessionsAfter: 12 });
    expect(m.some((x) => x.kind === 'makes')).toBe(false);
  });

  test('does NOT fire when still short of the threshold', () => {
    const m = detectMilestones({ makesAfter: 96, makesGained: 8, sessionsAfter: 6 });
    expect(m.length).toBe(0);
  });

  test('fires a session milestone on the crossing session', () => {
    // 10th session (sessionsBefore 9 -> 10).
    const m = detectMilestones({ makesAfter: 40, makesGained: 5, sessionsAfter: 10 });
    expect(m.map((x) => `${x.kind}:${x.value}`)).toContain('sessions:10');
  });

  test('can cross multiple tiers at once (a huge session), biggest makes first', () => {
    // 40 -> 260 crosses both 50, 100, AND 250.
    const m = detectMilestones({ makesAfter: 260, makesGained: 220, sessionsAfter: 3 });
    const makes = m.filter((x) => x.kind === 'makes').map((x) => x.value);
    expect(makes).toEqual([250, 100, 50]); // sorted biggest-first
  });

  test('makes milestones come before session milestones', () => {
    const m = detectMilestones({ makesAfter: 100, makesGained: 60, sessionsAfter: 5 });
    // crosses makes:100 (40->100) and sessions:5 (4->5)
    expect(m[0]!.kind).toBe('makes');
    expect(m.some((x) => x.kind === 'sessions' && x.value === 5)).toBe(true);
  });

  test('gained clamped: a corrected/negative gain never produces a phantom crossing', () => {
    const m = detectMilestones({ makesAfter: 100, makesGained: -5, sessionsAfter: 8 });
    // makesBefore = 100 (gain clamped to 0), so 100 was NOT newly crossed.
    expect(m.some((x) => x.kind === 'makes')).toBe(false);
  });

  test('first-ever session with a big haul crosses the low make tier only', () => {
    const m = detectMilestones({ makesAfter: 55, makesGained: 55, sessionsAfter: 1 });
    // makes 0 -> 55 crosses 50; sessionsAfter 1 does NOT cross the 5 tier.
    expect(m.map((x) => `${x.kind}:${x.value}`)).toEqual(['makes:50']);
  });
});
