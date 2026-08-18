/**
 * Body-data (anthropometric) archetype matching.
 *
 * Two jobs here: prove the ranking behaves the way the product promise claims
 * (frame sets the direction, wingspan RATIO is a real lever, refusal beats
 * guessing), and stand guard over the newly added `anthro` dataset so nobody
 * later drops in a physically impossible measurement.
 */
import {
  BODY_HEIGHT_MAX_CM,
  BODY_HEIGHT_MIN_CM,
  BODY_RATIO_MAX,
  BODY_RATIO_MIN,
  MEDIUM_CONFIDENCE_MIN_AFFINITY,
  RANGE_MAX_DISTANCE_M,
  RANGE_MIN_ATTEMPTS,
  RANGE_MIN_DISTANCE_M,
  bodyMatches,
  bodyPlan,
  rangeFromShots,
  styleDirection,
  type BodyInput,
} from '../bodyArchetype';
import { PLAYER_ARCHETYPES } from '../nbaBenchmarks';

/** A tall, long-levered frame (ratio ≈ 1.073). */
const TALL_LONG: BodyInput = { heightCm: 205, wingspanCm: 220 };
/** A small, even-levered guard frame (ratio ≈ 1.006). */
const SMALL_QUICK: BodyInput = { heightCm: 175, wingspanCm: 176 };

const nameOf = (b: { name: string }) => b.name;
const affinityOf = (list: { name: string; affinity: number }[], name: string) =>
  list.find((m) => m.name === name)!.affinity;

describe('anthro dataset integrity', () => {
  test('every published anthro block is physically sane', () => {
    const withAnthro = PLAYER_ARCHETYPES.filter((a) => a.anthro);
    expect(withAnthro.length).toBeGreaterThanOrEqual(7);
    for (const a of withAnthro) {
      const an = a.anthro!;
      expect(an.heightCm).toBeGreaterThanOrEqual(BODY_HEIGHT_MIN_CM);
      expect(an.heightCm).toBeLessThanOrEqual(BODY_HEIGHT_MAX_CM);
      // Pro basketball floor/ceiling — tighter than the app-wide profile range.
      expect(an.heightCm).toBeGreaterThan(170);
      expect(an.heightCm).toBeLessThan(230);
      const ratio = an.wingspanCm / an.heightCm;
      expect(ratio).toBeGreaterThan(BODY_RATIO_MIN);
      expect(ratio).toBeLessThan(BODY_RATIO_MAX);
      expect(an.source.trim().length).toBeGreaterThan(0);
      if (an.standingReachCm != null) {
        // Standing reach is always well above standing height, never absurd.
        expect(an.standingReachCm / an.heightCm).toBeGreaterThan(1.2);
        expect(an.standingReachCm / an.heightCm).toBeLessThan(1.45);
      }
      if (an.standingVertCm != null) {
        expect(an.standingVertCm).toBeGreaterThan(10);
        expect(an.standingVertCm).toBeLessThan(130);
      }
    }
  });

  test('unsourced players carry NO anthro rather than invented numbers', () => {
    const unsourced = ['Ray Allen', 'Reggie Miller', 'Steve Nash', 'Dirk Nowitzki', 'Luka Doncic', 'Tyrese Haliburton'];
    for (const name of unsourced) {
      const a = PLAYER_ARCHETYPES.find((p) => p.name === name)!;
      expect(a).toBeDefined();
      expect(a.anthro).toBeUndefined();
    }
  });

  test('Tyrese Haliburton is present with the full archetype shape', () => {
    const hali = PLAYER_ARCHETYPES.find((a) => a.name === 'Tyrese Haliburton')!;
    expect(hali).toBeDefined();
    expect(hali.motion).toBe('one-motion');
    // Quick trigger, flat-ish arc — consistent with the rest of the dataset's
    // physical invariant that entry angle sits below release angle.
    expect(hali.profile.releaseTimeMs).toBeLessThan(500);
    expect(hali.profile.entryAngleDeg).toBeLessThan(hali.profile.releaseAngleDeg);
    expect(hali.whatToCopy.length).toBeGreaterThan(0);
    expect(hali.idiosyncratic.length).toBeGreaterThan(0);
    expect(hali.mechanics.length).toBeGreaterThan(40);
  });

  test('existing archetype data is untouched', () => {
    const curry = PLAYER_ARCHETYPES.find((a) => a.name === 'Stephen Curry')!;
    expect(curry.profile).toEqual({
      releaseAngleDeg: 55,
      entryAngleDeg: 52,
      releaseTimeMs: 400,
      consistencyStdDeg: 1.2,
    });
    expect(curry.releaseHeightM).toBe(2.4);
    expect(PLAYER_ARCHETYPES.length).toBe(13);
  });
});

describe('bodyMatches ranking', () => {
  test('a tall long-levered frame ranks a tall long archetype above a small guard', () => {
    const res = bodyMatches(TALL_LONG);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]!.name).toBe('Kevin Durant');
    expect(affinityOf(res, 'Kevin Durant')).toBeGreaterThan(affinityOf(res, 'Stephen Curry'));
    expect(affinityOf(res, 'Kevin Durant')).toBeGreaterThan(affinityOf(res, 'Kyrie Irving'));
  });

  test('a small even-levered frame ranks a small guard above a tall long archetype', () => {
    const res = bodyMatches(SMALL_QUICK);
    expect(res[0]!.name).toBe('Stephen Curry');
    expect(affinityOf(res, 'Stephen Curry')).toBeGreaterThan(affinityOf(res, 'Kevin Durant'));
    expect(affinityOf(res, 'Stephen Curry')).toBeGreaterThan(affinityOf(res, 'Kawhi Leonard'));
  });

  test('results are sorted best-first and bounded 0..100', () => {
    const res = bodyMatches(TALL_LONG);
    for (let i = 1; i < res.length; i++) {
      expect(res[i - 1]!.affinity).toBeGreaterThanOrEqual(res[i]!.affinity);
    }
    for (const m of res) {
      expect(m.affinity).toBeGreaterThanOrEqual(0);
      expect(m.affinity).toBeLessThanOrEqual(100);
      expect(Number.isInteger(m.affinity)).toBe(true);
    }
  });

  test('archetypes without published measurements are skipped, never guessed', () => {
    const names = bodyMatches(TALL_LONG).map(nameOf);
    expect(names).not.toContain('Tyrese Haliburton');
    expect(names).not.toContain('Luka Doncic');
    expect(names).not.toContain('Dirk Nowitzki');
    expect(names.length).toBe(PLAYER_ARCHETYPES.filter((a) => a.anthro).length);
  });

  test('every match carries at least one reason', () => {
    for (const m of bodyMatches(SMALL_QUICK)) expect(m.reasons.length).toBeGreaterThan(0);
  });

  test('a big height gap produces a caution naming it', () => {
    const durant = bodyMatches(SMALL_QUICK).find((m) => m.name === 'Kevin Durant')!;
    expect(durant.caution.join(' ')).toContain('cm shorter');
  });

  test('an under-18 age adds a growth caution', () => {
    const teen = bodyMatches({ ...SMALL_QUICK, ageYears: 15 });
    expect(teen[0]!.caution.join(' ')).toContain('Still growing');
    const adult = bodyMatches({ ...SMALL_QUICK, ageYears: 30 });
    expect(adult[0]!.caution.join(' ')).not.toContain('Still growing');
  });
});

describe('wingspan-to-height RATIO is a real lever', () => {
  // Height is pinned at 188 cm for both cases, so the ratio is the ONLY thing
  // that can move the ranking.
  test('an even-levered 188 cm frame matches Curry over Lillard', () => {
    const res = bodyMatches({ heightCm: 188, wingspanCm: 191 });
    expect(res[0]!.name).toBe('Stephen Curry');
    expect(affinityOf(res, 'Stephen Curry')).toBeGreaterThan(affinityOf(res, 'Damian Lillard'));
  });

  test('a long-levered 188 cm frame flips the same ranking to Lillard', () => {
    const res = bodyMatches({ heightCm: 188, wingspanCm: 203 });
    expect(res[0]!.name).toBe('Damian Lillard');
    expect(affinityOf(res, 'Damian Lillard')).toBeGreaterThan(affinityOf(res, 'Stephen Curry'));
  });

  test('an exact frame match scores 100', () => {
    expect(bodyMatches({ heightCm: 188, wingspanCm: 191 })[0]!.affinity).toBe(100);
  });

  test('without wingspan the ranking is height-only, tie-broken deterministically', () => {
    const res = bodyMatches({ heightCm: 188, wingspanCm: null });
    // Curry and Lillard are both 188 cm ⇒ identical affinity, name breaks the tie.
    expect(affinityOf(res, 'Stephen Curry')).toBe(100);
    expect(affinityOf(res, 'Damian Lillard')).toBe(100);
    expect(res[0]!.name).toBe('Damian Lillard');
    expect(res[0]!.caution.join(' ')).toContain('Wingspan not set');
  });

  test('a standing vertical is skipped gracefully while no reference publishes one', () => {
    const withVert = bodyMatches({ ...TALL_LONG, standingVertCm: 80 });
    const without = bodyMatches(TALL_LONG);
    expect(JSON.stringify(withVert)).toBe(JSON.stringify(without));
  });
});

describe('refusal paths', () => {
  test('no height ⇒ no matches and no direction', () => {
    expect(bodyMatches({ heightCm: null, wingspanCm: 200 })).toEqual([]);
    expect(styleDirection({ heightCm: null, wingspanCm: 200 })).toBeNull();
  });

  test('an implausible height is refused rather than matched', () => {
    expect(bodyMatches({ heightCm: 40, wingspanCm: 45 })).toEqual([]);
    expect(bodyMatches({ heightCm: 400, wingspanCm: 420 })).toEqual([]);
    expect(bodyMatches({ heightCm: Number.NaN, wingspanCm: 190 })).toEqual([]);
  });

  test('an implausible wingspan degrades to height-only instead of poisoning the ratio', () => {
    const res = bodyMatches({ heightCm: 188, wingspanCm: 400 });
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]!.caution.join(' ')).toContain('Wingspan not set');
  });
});

describe('styleDirection', () => {
  test('a tall long frame is pointed over the top', () => {
    const d = styleDirection(TALL_LONG)!;
    expect(d).not.toBeNull();
    expect(d.label).toBe('Over-the-top pull-up tower');
    expect(d.archetype).toBe('Kevin Durant');
    expect(d.play.length).toBeGreaterThan(0);
    expect(d.avoid.length).toBeGreaterThan(0);
  });

  test('a small even-levered frame is pointed at creating separation', () => {
    const d = styleDirection(SMALL_QUICK)!;
    expect(d.label).toBe('Handle-first separation game');
  });

  test('a small long-levered frame is pointed at the quick-release pull-up', () => {
    const d = styleDirection({ heightCm: 175, wingspanCm: 190 })!;
    expect(d.label).toBe('Quick-release pull-up');
  });

  test("confidence never exceeds 'medium'", () => {
    const bodies: BodyInput[] = [
      TALL_LONG,
      SMALL_QUICK,
      { heightCm: 188, wingspanCm: 191 },
      { heightCm: 188, wingspanCm: 203 },
      { heightCm: 198, wingspanCm: 206 },
      { heightCm: 160, wingspanCm: 158 },
      { heightCm: 225, wingspanCm: 235 },
      { heightCm: 180, wingspanCm: null },
    ];
    for (const b of bodies) {
      const d = styleDirection(b);
      if (!d) continue;
      expect(['low', 'medium']).toContain(d.confidence);
    }
  });

  test('a close match with a wingspan earns medium; a missing wingspan never does', () => {
    const exact = styleDirection({ heightCm: 188, wingspanCm: 191 })!;
    expect(exact.confidence).toBe('medium');
    expect(bodyMatches({ heightCm: 188, wingspanCm: 191 })[0]!.affinity).toBeGreaterThanOrEqual(
      MEDIUM_CONFIDENCE_MIN_AFFINITY,
    );
    const noSpan = styleDirection({ heightCm: 188, wingspanCm: null })!;
    expect(noSpan.confidence).toBe('low');
    expect(noSpan.blurb).toContain('Wingspan is not set');
  });

  test('is deterministic', () => {
    expect(JSON.stringify(styleDirection(TALL_LONG))).toBe(JSON.stringify(styleDirection(TALL_LONG)));
    expect(JSON.stringify(bodyMatches(SMALL_QUICK))).toBe(JSON.stringify(bodyMatches(SMALL_QUICK)));
  });
});

describe('rangeFromShots', () => {
  const bands = (pct: number, attempts: number) => [{ band: 'mid', pct, attempts }];

  test('refuses without a median distance', () => {
    expect(rangeFromShots({ medianDistanceM: null, makePctByBand: bands(50, 40) })).toBeNull();
  });

  test('refuses below the minimum attempt count', () => {
    expect(
      rangeFromShots({ medianDistanceM: 5, makePctByBand: bands(50, RANGE_MIN_ATTEMPTS - 1) }),
    ).toBeNull();
    expect(rangeFromShots({ medianDistanceM: 5 })).toBeNull();
    expect(rangeFromShots({ medianDistanceM: 5, makePctByBand: null })).toBeNull();
  });

  test('a strong make rate steps the band out', () => {
    const r = rangeFromShots({ medianDistanceM: 5, makePctByBand: bands(52, 40) })!;
    expect(r.recommendedBandM).toEqual([5, 6]);
    expect(r.rationale).toContain('40 logged attempts');
    expect(r.rationale).toContain('step the practice band out');
  });

  test('a weak make rate pulls the band in', () => {
    const r = rangeFromShots({ medianDistanceM: 5, makePctByBand: bands(20, 40) })!;
    expect(r.recommendedBandM).toEqual([4, 5]);
  });

  test('a middling make rate holds the band where they shoot', () => {
    const r = rangeFromShots({ medianDistanceM: 5, makePctByBand: bands(36, 40) })!;
    expect(r.recommendedBandM).toEqual([4.5, 5.5]);
  });

  test('make rate is attempt-weighted across bands', () => {
    const r = rangeFromShots({
      medianDistanceM: 5,
      makePctByBand: [
        { band: 'near', pct: 60, attempts: 30 },
        { band: 'far', pct: 10, attempts: 10 },
      ],
    })!;
    // (0.6*30 + 0.1*10) / 40 = 47.5% ⇒ push out.
    expect(r.rationale).toContain('48%');
    expect(r.recommendedBandM).toEqual([5, 6]);
  });

  test('the band stays inside the court clamps and never collapses', () => {
    const far = rangeFromShots({ medianDistanceM: 8.8, makePctByBand: bands(60, 40) })!;
    expect(far.recommendedBandM[1]).toBeLessThanOrEqual(RANGE_MAX_DISTANCE_M);
    expect(far.recommendedBandM[1] - far.recommendedBandM[0]).toBeGreaterThanOrEqual(0.5);
    const near = rangeFromShots({ medianDistanceM: 1, makePctByBand: bands(10, 40) })!;
    expect(near.recommendedBandM[0]).toBeGreaterThanOrEqual(RANGE_MIN_DISTANCE_M);
    expect(near.recommendedBandM[1] - near.recommendedBandM[0]).toBeGreaterThanOrEqual(0.5);
  });

  test('is deterministic', () => {
    const input = { medianDistanceM: 6.1, makePctByBand: bands(41, 33) };
    expect(JSON.stringify(rangeFromShots(input))).toBe(JSON.stringify(rangeFromShots(input)));
  });
});

describe('bodyPlan', () => {
  const goodShots = { medianDistanceM: 5, makePctByBand: [{ band: 'mid', pct: 50, attempts: 40 }] };

  test('body sets the direction and shots set the distance', () => {
    const plan = bodyPlan(TALL_LONG, goodShots);
    expect(plan.direction!.label).toBe('Over-the-top pull-up tower');
    expect(plan.range!.recommendedBandM).toEqual([5, 6]);
    expect(plan.summary).toContain('5-6 m');
    expect(plan.summary).toContain('not a personalised model');
  });

  test('a direction without enough shots says so instead of inventing a distance', () => {
    const plan = bodyPlan(TALL_LONG, { medianDistanceM: 5, makePctByBand: [] });
    expect(plan.direction).not.toBeNull();
    expect(plan.range).toBeNull();
    expect(plan.summary).toContain(`fewer than ${RANGE_MIN_ATTEMPTS} logged attempts`);
  });

  test('shots without a body profile still give a distance and ask for the body data', () => {
    const plan = bodyPlan({ heightCm: null, wingspanCm: null }, goodShots);
    expect(plan.direction).toBeNull();
    expect(plan.range).not.toBeNull();
    expect(plan.summary).toContain('Add your height and wingspan');
  });

  test('neither half available ⇒ an explicit "nothing yet"', () => {
    const plan = bodyPlan({ heightCm: null, wingspanCm: null }, { medianDistanceM: null });
    expect(plan.direction).toBeNull();
    expect(plan.range).toBeNull();
    expect(plan.summary).toContain('Nothing to recommend yet');
  });

  test('is deterministic', () => {
    expect(JSON.stringify(bodyPlan(TALL_LONG, goodShots))).toBe(
      JSON.stringify(bodyPlan(TALL_LONG, goodShots)),
    );
  });
});
