/**
 * Player identity profile, persisted across launches via expo-sqlite's
 * key-value store (same zustand-persist pattern as settingsStore /
 * challengeStore / achievementsSeenStore).
 *
 * PRIVACY: every field is nullable and every question in the first-run wizard
 * is skippable — the app never forces personal data collection (App Store
 * guideline 5.1.1) and nothing here leaves the phone. The profile drives
 * personalized coaching copy and fair peer comparisons only; it is NOT health
 * data and carries no BMI / fitness claims.
 *
 * All the identity fields are separate keys so a partial profile (say, just a
 * nickname) persists cleanly and the "complete your profile" progress chip can
 * count exactly which of the tracked fields are still empty.
 */
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** How much basketball the player has under their belt. Drives coaching tone. */
export type Experience = 'rookie' | 'casual' | 'club' | 'veteran';

/** On-court role. Null until picked (skippable). */
export type Position = 'guard' | 'wing' | 'big';

/** Why they're here — sets the goal framing for coaching + comparisons. */
export type TrainingGoal = 'fun' | 'improve' | 'team' | 'pro';

/** Height slider bounds (cm). */
export const MIN_HEIGHT_CM = 120;
export const MAX_HEIGHT_CM = 220;
export const DEFAULT_HEIGHT_CM = 178;

/** Weight slider bounds (kg). Optional field. */
export const MIN_WEIGHT_KG = 30;
export const MAX_WEIGHT_KG = 150;
export const DEFAULT_WEIGHT_KG = 75;

/** Wingspan slider bounds (cm). Optional field. */
export const MIN_WINGSPAN_CM = 120;
export const MAX_WINGSPAN_CM = 240;

/** Birth-year bounds — a sane basketball-playing range around the era. */
export const MIN_BIRTH_YEAR = 1930;
/**
 * Newest allowed birth year: 5 years before now, so age can never derive to a
 * nonsensical toddler value. Derived from the current year at call time.
 */
export function maxBirthYear(nowYear = new Date().getFullYear()): number {
  return nowYear - 5;
}

export interface ProfileState {
  /** Display name / handle. Empty string counts as "not set". */
  nickname: string;
  heightCm: number | null;
  weightKg: number | null;
  /** Birth year — age is derived, never stored (stays correct as years pass). */
  birthYear: number | null;
  experience: Experience | null;
  position: Position | null;
  /** Sessions per week, 0–7. Null until answered. */
  playsPerWeek: number | null;
  trainingGoal: TrainingGoal | null;
  wingspanCm: number | null;
  /** Epoch ms the first-run wizard was finished/skipped. Null until then. */
  profileCompletedAt: number | null;

  /** Set one field. Mirrors settingsStore's typed setter. */
  set: <K extends keyof ProfileFields>(key: K, value: ProfileFields[K]) => void;
  /** Merge several fields at once (used by the wizard's Done step). */
  merge: (patch: Partial<ProfileFields>) => void;
  /** Stamp the wizard as finished (or skipped) — sets profileCompletedAt=now. */
  markComplete: (at?: number) => void;
  /** Wipe every identity field back to empty (Settings > clear profile). */
  reset: () => void;
}

/** The persisted data fields only (no actions) — used for typing set/merge. */
export type ProfileFields = Omit<
  ProfileState,
  'set' | 'merge' | 'markComplete' | 'reset'
>;

const EMPTY: ProfileFields = {
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

export const useProfile = create<ProfileState>()(
  persist(
    (set) => ({
      ...EMPTY,
      set: (key, value) => set({ [key]: value } as Pick<ProfileFields, typeof key>),
      merge: (patch) => set(patch),
      markComplete: (at = Date.now()) => set({ profileCompletedAt: at }),
      reset: () => set({ ...EMPTY }),
    }),
    {
      name: 'hoopai-profile',
      storage: createJSONStorage(() => Storage),
      partialize: ({ set: _set, merge: _merge, markComplete: _mc, reset: _reset, ...rest }) =>
        rest,
      // See settingsStore.ts for the rationale on starting persisted schema
      // versioning at 1 rather than leaving it unset — every future rename/
      // removal then has a concrete "from version N" to migrate off of.
      version: 1,
      migrate: (persisted) => persisted as ProfileState,
    },
  ),
);

// ---------------------------------------------------------------------------
// Selectors — pure, so screens and tests share one source of truth.
// ---------------------------------------------------------------------------

/** Whether a field counts as filled in (empty nickname string = not filled). */
function isFilled<K extends keyof ProfileFields>(key: K, s: Pick<ProfileFields, K>): boolean {
  const v = s[key];
  if (key === 'nickname') return typeof v === 'string' && v.trim().length > 0;
  return v != null;
}

/**
 * The fields that count toward the "complete your profile" progress chip.
 * profileCompletedAt is deliberately excluded — it is a lifecycle stamp, not
 * a piece of identity the user fills in.
 */
export const PROFILE_FIELDS: readonly (keyof ProfileFields)[] = [
  'nickname',
  'heightCm',
  'weightKg',
  'birthYear',
  'experience',
  'position',
  'playsPerWeek',
  'trainingGoal',
  'wingspanCm',
] as const;

/** How many tracked fields are filled in, and out of how many. */
export function profileProgress(s: ProfileFields): { filled: number; total: number } {
  const total = PROFILE_FIELDS.length;
  const filled = PROFILE_FIELDS.reduce((n, k) => n + (isFilled(k, s) ? 1 : 0), 0);
  return { filled, total };
}

/** 0..1 completeness fraction for the progress ring / chip. */
export function profileCompleteness(s: ProfileFields): number {
  const { filled, total } = profileProgress(s);
  return total === 0 ? 0 : filled / total;
}

/** The tracked fields still empty — powers the "Complete your profile" nudge. */
export function missingProfileFields(s: ProfileFields): (keyof ProfileFields)[] {
  return PROFILE_FIELDS.filter((k) => !isFilled(k, s));
}

/**
 * Age in whole years derived from birthYear, or null when unknown. Uses the
 * YEAR only (we never collect a full birth date), so it's an approximation
 * that's correct to within a year — good enough for cohort comparisons and
 * never presented as anything more precise.
 */
export function ageFromBirthYear(
  birthYear: number | null,
  nowYear = new Date().getFullYear(),
): number | null {
  if (birthYear == null) return null;
  const age = nowYear - birthYear;
  return age >= 0 ? age : null;
}

/** Human label for the experience tiers (chips, wizard cards, profile header). */
export const EXPERIENCE_LABEL: Record<Experience, string> = {
  rookie: 'Rookie',
  casual: 'Casual',
  club: 'Club / rec league',
  veteran: 'Veteran',
};

/** One-line description of each experience tier for the wizard cards. */
export const EXPERIENCE_BLURB: Record<Experience, string> = {
  rookie: 'New to shooting — just getting the reps in.',
  casual: 'Weekend runs and pickup at the park.',
  club: 'Organized ball — rec league, school or club.',
  veteran: 'Years of competitive play under your belt.',
};

/** Human label for on-court positions. */
export const POSITION_LABEL: Record<Position, string> = {
  guard: 'Guard',
  wing: 'Wing / forward',
  big: 'Big',
};

/** Human label for the training goals. */
export const GOAL_LABEL: Record<TrainingGoal, string> = {
  fun: 'Just for fun',
  improve: 'Improve my shot',
  team: 'Make / help a team',
  pro: 'Chase the next level',
};

/** One-line description of each goal for the wizard cards. */
export const GOAL_BLURB: Record<TrainingGoal, string> = {
  fun: 'Keep it light — track the makes, share the heat.',
  improve: 'Build a more consistent, repeatable jumper.',
  team: 'Get game-ready for tryouts and the roster.',
  pro: 'Train like it matters — every rep counts.',
};
