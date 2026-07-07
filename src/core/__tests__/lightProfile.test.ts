import { LIGHT, classifyLight } from '../lightProfile';
import { DETECTION } from '../config';

describe('LIGHT thresholds', () => {
  test('bands are ordered and the hysteresis is smaller than either band', () => {
    expect(LIGHT.darkMax).toBeLessThan(LIGHT.dimMax);
    expect(LIGHT.dimMax).toBeLessThan(1);
    // Hysteresis must never be able to merge two boundaries.
    expect(LIGHT.hysteresis).toBeLessThan(LIGHT.darkMax);
    expect(LIGHT.hysteresis).toBeLessThan(LIGHT.dimMax - LIGHT.darkMax);
  });

  test('the dark ball gate sits between tracking and cold acquisition', () => {
    // The whole point of the 'dark' profile: relax cold acquisition, but
    // never below the flight-continuation floor.
    expect(DETECTION.ballScoreMinDark).toBeGreaterThan(
      DETECTION.ballScoreMinTracking,
    );
    expect(DETECTION.ballScoreMinDark).toBeLessThan(DETECTION.ballScoreMin);
  });
});

describe('classifyLight (stateless — no previous profile)', () => {
  test('classifies plain bands', () => {
    expect(classifyLight(0.02)).toBe('dark');
    expect(classifyLight(LIGHT.darkMax - 0.001)).toBe('dark');
    expect(classifyLight(LIGHT.darkMax)).toBe('dim'); // boundary is exclusive
    expect(classifyLight(0.2)).toBe('dim');
    expect(classifyLight(LIGHT.dimMax - 0.001)).toBe('dim');
    expect(classifyLight(LIGHT.dimMax)).toBe('bright');
    expect(classifyLight(0.5)).toBe('bright');
    expect(classifyLight(1)).toBe('bright');
  });

  test('null previous profile behaves like the stateless call', () => {
    expect(classifyLight(0.1, null)).toBe('dark');
    expect(classifyLight(0.2, null)).toBe('dim');
    expect(classifyLight(0.5, null)).toBe('bright');
  });
});

describe('classifyLight hysteresis', () => {
  const h = LIGHT.hysteresis;

  test('leaving dark requires clearing darkMax by the margin', () => {
    // Just past the plain boundary: still dark (inside the hysteresis band).
    expect(classifyLight(LIGHT.darkMax + h - 0.001, 'dark')).toBe('dark');
    // Clear of the band: releases to dim.
    expect(classifyLight(LIGHT.darkMax + h, 'dark')).toBe('dim');
    // A big jump goes straight to bright — no forced intermediate step.
    expect(classifyLight(0.5, 'dark')).toBe('bright');
  });

  test('entering dark from dim requires dropping below darkMax by the margin', () => {
    expect(classifyLight(LIGHT.darkMax - h + 0.001, 'dim')).toBe('dim');
    expect(classifyLight(LIGHT.darkMax - h - 0.001, 'dim')).toBe('dark');
  });

  test('dim/bright boundary is sticky in both directions', () => {
    // From bright: dropping just under dimMax stays bright…
    expect(classifyLight(LIGHT.dimMax - h + 0.001, 'bright')).toBe('bright');
    // …but a real drop reads dim.
    expect(classifyLight(LIGHT.dimMax - h - 0.001, 'bright')).toBe('dim');
    // From dim: rising just past dimMax stays dim, clearing the band goes bright.
    expect(classifyLight(LIGHT.dimMax + h - 0.001, 'dim')).toBe('dim');
    expect(classifyLight(LIGHT.dimMax + h, 'dim')).toBe('bright');
  });

  test('entering dark from bright is immediate below the margin-shifted boundary', () => {
    expect(classifyLight(LIGHT.darkMax - h - 0.001, 'bright')).toBe('dark');
  });

  test('a luma oscillating tightly around a boundary never flaps the profile', () => {
    // ±0.01 around darkMax — well inside the ±0.02 hysteresis band. Whatever
    // profile the first sample picks must survive the whole oscillation.
    let profile = classifyLight(LIGHT.darkMax - 0.01);
    expect(profile).toBe('dark');
    for (let i = 0; i < 20; i++) {
      const luma = LIGHT.darkMax + (i % 2 === 0 ? 0.01 : -0.01);
      profile = classifyLight(luma, profile);
      expect(profile).toBe('dark');
    }
  });
});
