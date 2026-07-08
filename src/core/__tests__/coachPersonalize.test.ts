/**
 * Coach personalization tests — the coach re-tunes emphasis + framing to the
 * player's profile WITHOUT fabricating or hiding findings. Pure-function
 * coverage of personalizeFindings, plus one runCoach integration proving the
 * profile actually threads through to the output.
 */
import {
  personalizeFindings,
  runCoach,
  type CoachFinding,
  type CoachProfile,
  type CoachSession,
  type FindingKind,
} from '../coachEngine';
import { emptyStats, applyShot } from '../stats';
import type { FormMetrics, ResolvedShot } from '../types';

function f(
  id: FindingKind,
  severity: 1 | 2 | 3,
  strength = 1,
  prescription = 'do the drill',
): CoachFinding {
  return { id, severity, title: `t:${id}`, evidence: 'e', prescription, trend: 'flat', strength };
}

describe('personalizeFindings', () => {
  test("goal 'fun' demotes training-load nags to gentle notes", () => {
    const out = personalizeFindings([f('fatigue', 3), f('volumeTrend', 2), f('unsureRate', 3)], {
      goal: 'fun',
    });
    expect(out.find((x) => x.id === 'fatigue')!.severity).toBe(1);
    expect(out.find((x) => x.id === 'volumeTrend')!.severity).toBe(1);
    expect(out.find((x) => x.id === 'unsureRate')!.severity).toBe(1);
  });

  test("goal 'fun' leaves shot-mechanics findings untouched", () => {
    const out = personalizeFindings([f('entryAngleLow', 3), f('sideBias', 2)], { goal: 'fun' });
    expect(out.find((x) => x.id === 'entryAngleLow')!.severity).toBe(3);
    expect(out.find((x) => x.id === 'sideBias')!.severity).toBe(2);
  });

  test("goal 'pro'/'team' promotes an off-pro-band finding", () => {
    expect(personalizeFindings([f('nbaBand', 1)], { goal: 'pro' })[0]!.severity).toBe(2);
    expect(personalizeFindings([f('nbaBand', 2)], { goal: 'team' })[0]!.severity).toBe(3);
  });

  test('nbaBand promotion is clamped at severity 3', () => {
    expect(personalizeFindings([f('nbaBand', 3)], { goal: 'pro' })[0]!.severity).toBe(3);
  });

  test('experience framing appends a level line to the top finding only', () => {
    const out = personalizeFindings([f('entryAngleLow', 3, 1, 'base'), f('sideBias', 2, 1, 'other')], {
      experience: 'rookie',
    });
    const top = out.find((x) => x.id === 'entryAngleLow')!;
    const other = out.find((x) => x.id === 'sideBias')!;
    expect(top.prescription.startsWith('base ')).toBe(true);
    expect(top.prescription).toMatch(/fundamentals compound/);
    expect(other.prescription).toBe('other'); // not the top finding — untouched
  });

  test('veteran and club get their own framing; casual/unset get none', () => {
    expect(personalizeFindings([f('entryAngleLow', 2, 1, 'p')], { experience: 'veteran' })[0]!.prescription).toMatch(
      /reps and discipline/,
    );
    expect(personalizeFindings([f('entryAngleLow', 2, 1, 'p')], { experience: 'club' })[0]!.prescription).toMatch(
      /show up in games/,
    );
    expect(personalizeFindings([f('entryAngleLow', 2, 1, 'p')], { experience: 'casual' })[0]!.prescription).toBe('p');
    expect(personalizeFindings([f('entryAngleLow', 2, 1, 'p')], {})[0]!.prescription).toBe('p');
  });

  test('framing lands on the NEW top after fun-damping re-ranks the list', () => {
    // fatigue starts as the sev-3 headline; 'fun' damps it to a note, so the
    // sev-2 arc finding becomes top and gets the rookie framing.
    const out = personalizeFindings([f('fatigue', 3, 5, 'fat'), f('entryAngleLow', 2, 1, 'arc')], {
      goal: 'fun',
      experience: 'rookie',
    });
    const fat = out.find((x) => x.id === 'fatigue')!;
    const arc = out.find((x) => x.id === 'entryAngleLow')!;
    expect(fat.severity).toBe(1);
    expect(fat.prescription).toBe('fat'); // damped, not framed
    expect(arc.prescription).toMatch(/fundamentals compound/); // framed as the new top
  });

  test('does not mutate its input', () => {
    const input = [f('nbaBand', 1, 1, 'p')];
    const out = personalizeFindings(input, { goal: 'pro', experience: 'rookie' });
    expect(input[0]!.severity).toBe(1);
    expect(input[0]!.prescription).toBe('p');
    expect(out[0]!.severity).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runCoach integration — the profile actually reaches the findings
// ---------------------------------------------------------------------------

const NULL_METRICS: FormMetrics = {
  setPointElbowDeg: null,
  kneeFlexionDeg: null,
  releaseAngleDeg: null,
  entryAngleDeg: null,
  releaseTimeMs: null,
  followThroughHeldMs: null,
  followThroughElbowDeg: null,
  releaseHeightNorm: null,
};

let nextId = 1;
function shotWithEntry(outcome: 'make' | 'miss', entry: number): ResolvedShot {
  return {
    id: nextId++,
    tStart: 0,
    tResolved: 1,
    outcome,
    signals: { geo: outcome === 'make', net: null, cls: null },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: entry,
    releaseAngleDeg: null,
    releasePoint: null,
    originX: null,
    originY: null,
    trajectory: [],
  };
}

function flatEntrySession(entry: number, pairs: number): CoachSession {
  const shots: ResolvedShot[] = [];
  for (let i = 0; i < pairs; i++) {
    shots.push(shotWithEntry('make', entry), shotWithEntry('miss', entry));
  }
  let st = emptyStats();
  for (const s of shots) st = applyShot(st, s);
  return { id: 1, startedAt: Date.UTC(2026, 6, 6, 12), shots, stats: st };
}

describe('runCoach with a profile', () => {
  const session = flatEntrySession(34, 6); // 12 decided shots, chronically flat arc

  test('omitting the profile is unchanged from before', () => {
    const base = runCoach([session]);
    const withEmpty = runCoach([session], {} as CoachProfile);
    expect(withEmpty).toEqual(base); // an empty profile is a no-op
    expect(base.some((x) => x.id === 'entryAngleLow')).toBe(true);
  });

  test('a rookie profile threads framing onto the flat-arc finding', () => {
    const base = runCoach([session]);
    const rookie = runCoach([session], { experience: 'rookie' });
    const b = base.find((x) => x.id === 'entryAngleLow')!;
    const r = rookie.find((x) => x.id === 'entryAngleLow')!;
    expect(r.prescription.startsWith(b.prescription)).toBe(true);
    expect(r.prescription).toMatch(/fundamentals compound/);
  });
});
