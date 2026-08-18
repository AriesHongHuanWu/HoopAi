/**
 * Mode-catalog section taxonomy — pure data for the Train tab's picker layout.
 *
 * Sections are DERIVED here: {@link GameModeDef} and Drill carry no category
 * field, so gameModes.ts / drills.ts contracts stay untouched (byte-identical
 * catalogs). The Train tab renders sections in {@link MODE_SECTIONS} order:
 * Quick start (recommendation hero + Free Play), Games (the seven non-free
 * modes), Challenges (this week's goal set + the friend board), Drills (the
 * drill catalog), and Training tools (the nav tiles). 'free' lives in Quick
 * start — it is the default run and is always one tap away, so it never
 * appears in the Games section.
 *
 * WHY 'challenges' is its own section and NOT folded into 'drills': the word
 * "challenge" was doing four unrelated jobs across three tabs (daily set,
 * weekly set, Ghost Challenge, friend board), so nothing named "Challenge"
 * predicted what tapping it would do. This section is the one place the word
 * means "a scored goal you can complete or share". 'drills' keeps its name
 * because what it holds really is drills — spot routines with make goals —
 * and renaming it would have moved the ambiguity rather than removed it.
 *
 * Pure TS: no React, no I/O, no clock reads.
 */
import { GAME_MODES, type GameModeDef } from './gameModes';
import type { GameModeId } from './types';

export type ModeSectionId = 'quickStart' | 'games' | 'challenges' | 'drills' | 'tools';

export interface ModeSectionDef {
  id: ModeSectionId;
  /** Section header title (rendered by ModeSectionHeader). */
  title: string;
  /** One-liner under the header when expanded; null = none. */
  lede: string | null;
  /** Whether the Train tab renders a collapse toggle for it. */
  collapsible: boolean;
}

/** The Train tab's sections, in render order. */
export const MODE_SECTIONS: readonly ModeSectionDef[] = [
  {
    id: 'quickStart',
    title: 'Quick start',
    lede: null,
    collapsible: false,
  },
  {
    id: 'games',
    title: 'Games',
    lede: 'Score-keeping games on the same automatic make/miss tracking.',
    collapsible: true,
  },
  {
    id: 'challenges',
    // Sits between Games and Drills: a challenge is a goal laid over whatever
    // you play, so it reads after the games it scores and before the routines
    // it is not.
    title: 'Challenges',
    lede: "This week's goals, and the friend board you can send a score to.",
    // Not collapsible: unlike Games (7 rows) and Drills (the whole catalog),
    // this section is one card plus one tile — a toggle would cost more taps
    // than the height it saves.
    collapsible: false,
  },
  {
    id: 'drills',
    title: 'Drills',
    // Copy matches the existing drill section lede in modes.tsx so nothing
    // reads as changed.
    lede: 'Guided spot-by-spot routines with make goals — the live view maps your next spot as you go.',
    collapsible: true,
  },
  {
    id: 'tools',
    title: 'Training tools',
    lede: null,
    collapsible: false,
  },
];

/** The one mode that lives in Quick start instead of the Games section. */
const QUICK_START_MODE: GameModeId = 'free';

/**
 * The modes rendered in the Games section: every catalog mode except 'free',
 * in catalog order ({@link GAME_MODES} order preserved).
 */
export function gameSectionModes(): readonly GameModeDef[] {
  return GAME_MODES.filter((m) => m.id !== QUICK_START_MODE);
}
