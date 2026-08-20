/**
 * Mode-catalog section taxonomy — pure data for the Train tab's picker layout.
 *
 * Sections are DERIVED here: {@link GameModeDef} and Drill carry no category
 * field, so gameModes.ts / drills.ts contracts stay untouched (byte-identical
 * catalogs). The Train tab renders sections in {@link MODE_SECTIONS} order:
 * Quick start (recommendation hero + Free Play), Games (the seven non-free
 * modes), Drills (the drill catalog), and Training tools (the nav tiles).
 * 'free' lives in Quick start — it is the default run and is always one tap
 * away, so it never appears in the Games section.
 *
 * Pure TS: no React, no I/O, no clock reads.
 */
import { GAME_MODES, type GameModeDef } from './gameModes';
import type { GameModeId } from './types';

export type ModeSectionId = 'quickStart' | 'games' | 'drills' | 'tools';

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
