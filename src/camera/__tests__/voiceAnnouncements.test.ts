/**
 * Spoken-line selection for the voice announcer — pure text logic only
 * (the TTS hook itself is device-bound and untestable in jest).
 */
import { announcementFor, streakCallout } from '../useVoiceAnnouncements';
import type { ResolvedShot, SessionStats, ShotOutcome } from '../../core/types';

function shot(outcome: ShotOutcome, entryAngleDeg: number | null = 44.4): ResolvedShot {
  return {
    id: 1,
    tStart: 0,
    tResolved: 1.5,
    outcome,
    signals: { geo: outcome === 'make', net: null, cls: false },
    rimBounce: false,
    xCross: outcome === 'make' ? 320 : null,
    entryAngleDeg,
    releaseAngleDeg: 52,
    releasePoint: { x: 100, y: 400 },
    originX: null,
    originY: null,
    trajectory: [],
  };
}

function stats(over: Partial<SessionStats> = {}): SessionStats {
  return {
    attempts: 10,
    makes: 7,
    misses: 3,
    unsure: 0,
    fgPct: 0.7,
    currentStreak: 1,
    bestStreak: 5,
    avgEntryAngleDeg: null,
    entryAngleStdDeg: null,
    avgReleaseAngleDeg: null,
    releaseAngleStdDeg: null,
    byZone: {} as SessionStats['byZone'],
    points: 14,
    twoPtMakes: 7,
    twoPtAttempts: 10,
    threePtMakes: 0,
    threePtAttempts: 0,
    twoPtPct: 0.7,
    threePtPct: 0,
    ...over,
  };
}

describe('streakCallout', () => {
  test('silent below 3, counts 3-4-6, milestones at 5/7/10+', () => {
    expect(streakCallout(1)).toBeNull();
    expect(streakCallout(2)).toBeNull();
    expect(streakCallout(3)).toBe("That's 3 straight!");
    expect(streakCallout(4)).toBe("That's 4 straight!");
    expect(streakCallout(5)).toBe('Heating up — 5 straight!');
    expect(streakCallout(6)).toBe("That's 6 straight!");
    expect(streakCallout(7)).toBe('On fire! 7 in a row!');
    expect(streakCallout(12)).toBe('On fire! 12 in a row!');
  });
});

describe('announcementFor', () => {
  test("'none' says nothing, even mid-heater", () => {
    expect(announcementFor('none', shot('make'), stats({ currentStreak: 9 }))).toBeNull();
  });

  test("'result' basics, and the streak callout REPLACES the plain make", () => {
    expect(announcementFor('result', shot('make'), stats())).toBe('Make!');
    expect(announcementFor('result', shot('miss'), stats())).toBe('Miss');
    expect(announcementFor('result', shot('unsure'), stats())).toBe('Unsure — tap to fix');
    expect(announcementFor('result', shot('make'), stats({ currentStreak: 5 }))).toBe(
      'Heating up — 5 straight!',
    );
  });

  test("'fgPct' keeps its number first, streak appended on hot makes only", () => {
    expect(announcementFor('fgPct', shot('make'), stats())).toBe('7 for 10');
    expect(announcementFor('fgPct', shot('make'), stats({ currentStreak: 3 }))).toBe(
      "7 for 10. That's 3 straight!",
    );
    // A miss never gets hype, whatever the (stale) streak field says.
    expect(announcementFor('fgPct', shot('miss'), stats({ currentStreak: 3 }))).toBe('7 for 10');
  });

  test("'entryAngle' stays silent with no angle — unless a streak make gives it something to say", () => {
    expect(announcementFor('entryAngle', shot('miss', null), stats())).toBeNull();
    expect(announcementFor('entryAngle', shot('make', 44.4), stats())).toBe('Make, 44 degrees');
    expect(
      announcementFor('entryAngle', shot('make', null), stats({ currentStreak: 4 })),
    ).toBe("That's 4 straight!");
  });
});
