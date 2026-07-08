/**
 * Tests for the player-identity profile store (src/state/profileStore.ts):
 * the typed setter/merge, the complete-stamp, reset, and the pure selectors
 * (progress, completeness, missing fields, derived age). expo-sqlite/kv-store
 * is mocked to an in-memory map (persistence itself is zustand middleware, not
 * under test), matching challengeStore.test.ts.
 */
jest.mock('expo-sqlite/kv-store', () => {
  const mem = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => {
        mem.set(key, value);
      },
      removeItem: (key: string) => {
        mem.delete(key);
      },
    },
  };
});

import {
  ageFromBirthYear,
  maxBirthYear,
  missingProfileFields,
  profileCompleteness,
  profileProgress,
  PROFILE_FIELDS,
  useProfile,
  type ProfileFields,
} from '../profileStore';

/** A fully-empty profile snapshot (only the data fields). */
function emptyFields(): ProfileFields {
  return {
    nickname: '',
    heightCm: null,
    weightKg: null,
    birthYear: null,
    experience: null,
    position: null,
    playsPerWeek: null,
    trainingGoal: null,
    wingspanCm: null,
    profileCompletedAt: null,
  };
}

const initial = useProfile.getState();

beforeEach(() => {
  useProfile.getState().reset();
});

afterAll(() => {
  useProfile.setState(initial, true);
});

describe('profileStore state', () => {
  it('starts empty — every identity field null/blank, not completed', () => {
    const s = useProfile.getState();
    expect(s.nickname).toBe('');
    expect(s.heightCm).toBeNull();
    expect(s.weightKg).toBeNull();
    expect(s.birthYear).toBeNull();
    expect(s.experience).toBeNull();
    expect(s.position).toBeNull();
    expect(s.playsPerWeek).toBeNull();
    expect(s.trainingGoal).toBeNull();
    expect(s.wingspanCm).toBeNull();
    expect(s.profileCompletedAt).toBeNull();
  });

  it('set writes a single field without touching the others', () => {
    useProfile.getState().set('nickname', 'Splash');
    useProfile.getState().set('heightCm', 190);
    const s = useProfile.getState();
    expect(s.nickname).toBe('Splash');
    expect(s.heightCm).toBe(190);
    // Untouched fields stay empty.
    expect(s.weightKg).toBeNull();
    expect(s.experience).toBeNull();
  });

  it('merge writes several fields in one update', () => {
    useProfile.getState().merge({ experience: 'club', position: 'guard', playsPerWeek: 4 });
    const s = useProfile.getState();
    expect(s.experience).toBe('club');
    expect(s.position).toBe('guard');
    expect(s.playsPerWeek).toBe(4);
  });

  it('markComplete stamps a finish time', () => {
    expect(useProfile.getState().profileCompletedAt).toBeNull();
    useProfile.getState().markComplete(1_700_000_000_000);
    expect(useProfile.getState().profileCompletedAt).toBe(1_700_000_000_000);
  });

  it('markComplete defaults to now when no time is passed', () => {
    const before = Date.now();
    useProfile.getState().markComplete();
    const at = useProfile.getState().profileCompletedAt;
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThanOrEqual(before);
  });

  it('reset wipes every field back to empty', () => {
    useProfile.getState().merge({
      nickname: 'Splash',
      heightCm: 190,
      experience: 'veteran',
      profileCompletedAt: 123,
    });
    useProfile.getState().reset();
    expect(useProfile.getState()).toMatchObject(emptyFields());
  });
});

describe('profileProgress / completeness', () => {
  it('reports 0 filled on an empty profile', () => {
    const p = profileProgress(emptyFields());
    expect(p.filled).toBe(0);
    expect(p.total).toBe(PROFILE_FIELDS.length);
    expect(profileCompleteness(emptyFields())).toBe(0);
  });

  it('does NOT count a blank / whitespace-only nickname as filled', () => {
    expect(profileProgress({ ...emptyFields(), nickname: '' }).filled).toBe(0);
    expect(profileProgress({ ...emptyFields(), nickname: '   ' }).filled).toBe(0);
    expect(profileProgress({ ...emptyFields(), nickname: 'AW' }).filled).toBe(1);
  });

  it('counts filled fields and ignores profileCompletedAt', () => {
    const fields: ProfileFields = {
      ...emptyFields(),
      nickname: 'Splash',
      heightCm: 190,
      weightKg: 85,
      // profileCompletedAt is a lifecycle stamp, NOT a tracked identity field.
      profileCompletedAt: Date.now(),
    };
    const p = profileProgress(fields);
    expect(p.filled).toBe(3);
    expect(profileCompleteness(fields)).toBeCloseTo(3 / PROFILE_FIELDS.length);
  });

  it('reaches 100% when every tracked field is set', () => {
    const full: ProfileFields = {
      nickname: 'Splash',
      heightCm: 190,
      weightKg: 85,
      birthYear: 2000,
      experience: 'veteran',
      position: 'guard',
      playsPerWeek: 5,
      trainingGoal: 'pro',
      wingspanCm: 200,
      profileCompletedAt: 1,
    };
    expect(profileProgress(full).filled).toBe(PROFILE_FIELDS.length);
    expect(profileCompleteness(full)).toBe(1);
    expect(missingProfileFields(full)).toEqual([]);
  });
});

describe('missingProfileFields', () => {
  it('lists exactly the empty tracked fields, in canonical order', () => {
    const fields: ProfileFields = { ...emptyFields(), nickname: 'AW', heightCm: 180 };
    expect(missingProfileFields(fields)).toEqual([
      'weightKg',
      'birthYear',
      'experience',
      'position',
      'playsPerWeek',
      'trainingGoal',
      'wingspanCm',
    ]);
  });
});

describe('ageFromBirthYear', () => {
  it('derives whole-year age from the year only', () => {
    expect(ageFromBirthYear(2000, 2026)).toBe(26);
  });

  it('returns null for an unknown birth year', () => {
    expect(ageFromBirthYear(null)).toBeNull();
  });

  it('rejects a future birth year (negative age) as null', () => {
    expect(ageFromBirthYear(2030, 2026)).toBeNull();
  });
});

describe('maxBirthYear', () => {
  it('is five years before the given year (no toddler ages)', () => {
    expect(maxBirthYear(2026)).toBe(2021);
  });
});
